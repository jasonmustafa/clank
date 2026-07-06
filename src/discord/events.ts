import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Client, Message } from "discord.js";
import type { ClankConfig } from "../config/env.js";
import { checkAllowlist } from "../config/allowlist.js";
import { sendChunked, type SendableChannel } from "../format/discord.js";
import type { JobManager } from "../jobs/jobManager.js";
import type { ConfirmationManager } from "../safety/confirmation.js";
import { routeThread } from "./threadRouter.js";
import { CommandRouter } from "./commands.js";

function stripBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`^<@!?${botUserId}>\\s*`), "").trim();
}

function startsWithPrefix(text: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => text.trim().startsWith(prefix));
}

function messageMentionsBot(message: Message, botUserId: string): boolean {
  return message.mentions.users.has(botUserId) || new RegExp(`^<@!?${botUserId}>`).test(message.content.trim());
}

function debugLogPath(): string {
  return process.env.CLANK_ROUTE_DEBUG_LOG || `${process.env.CLANK_STATE_DIR || "/opt/clank/state"}/message-route-debug.log`;
}

function routeDebugEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.CLANK_ROUTE_DEBUG ?? "").trim().toLowerCase());
}

function writeRouteDebug(entry: Record<string, unknown>): void {
  if (!routeDebugEnabled()) return;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  console.log(line);
  try {
    const path = debugLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, "utf8");
  } catch (error) {
    console.error("clank-route-debug-file-write-failed", error);
  }
}

function debugMessageRoute(stage: string, message: Message, details: Record<string, unknown> = {}): void {
  if (!routeDebugEnabled()) return;
  const content = message.content.replace(/\s+/g, " ").trim();
  writeRouteDebug({
    scope: "clank-message-route-debug",
    stage,
    messageId: message.id,
    authorId: message.author.id,
    guildId: message.guildId,
    channelId: message.channel.id,
    isDm: message.channel.isDMBased(),
    isThread: message.channel.isThread(),
    parentChannelId: message.channel.isThread() ? message.channel.parentId : undefined,
    mentionIds: [...message.mentions.users.keys()],
    contentPreview: content.slice(0, 300),
    ...details,
  });
}

export function registerDiscordEvents(client: Client, config: ClankConfig, jobs: JobManager, confirmations: ConfirmationManager): void {
  client.once("ready", (readyClient) => {
    console.log(`Clank connected as ${readyClient.user.tag}`);
    writeRouteDebug({ scope: "clank-message-route-debug", stage: "ready", botId: readyClient.user.id, botTag: readyClient.user.tag });
  });

  client.on("messageCreate", (message) => {
    void handleMessage(message, client, config, jobs, confirmations).catch((error) => {
      console.error("message handler failed", error);
      void (message.channel as SendableChannel).send(`Clank error: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
    });
  });
}

async function handleMessage(message: Message, client: Client, config: ClankConfig, jobs: JobManager, confirmations: ConfirmationManager): Promise<void> {
  if (message.author.bot) return;
  const botUserId = client.user?.id;
  if (!botUserId) {
    debugMessageRoute("ignored-no-bot-user", message);
    return;
  }

  const isDm = message.channel.isDMBased();
  const isThread = message.channel.isThread();
  const parentChannelId = isThread ? message.channel.parentId : undefined;
  const knownThreadRecord = isThread ? jobs.findRecordByThread(message.channel.id) : undefined;
  const allow = checkAllowlist(
    {
      userId: message.author.id,
      guildId: message.guildId,
      channelId: message.channel.id,
      parentChannelId,
      isDm,
      isKnownJobThread: Boolean(knownThreadRecord),
    },
    config,
  );
  if (!allow.allowed) {
    debugMessageRoute("ignored-allowlist", message, { reason: allow.reason, botUserId });
    return;
  }

  const isMention = messageMentionsBot(message, botUserId);
  const isPrefixed = startsWithPrefix(message.content, config.commandPrefixes);
  const channelMessageAllowed = config.allowGuildChannelMessages;
  const canTreatAsInput = isDm || Boolean(knownThreadRecord) || isMention || isPrefixed || channelMessageAllowed;
  if (!canTreatAsInput) {
    debugMessageRoute("ignored-not-input", message, { botUserId, isMention, isPrefixed, channelMessageAllowed, knownThread: Boolean(knownThreadRecord) });
    return;
  }

  const route = routeThread(
    { channelId: message.channel.id, parentChannelId, isThread, userId: message.author.id },
    jobs.storeView,
  );
  const commandJobId = route.type === "existing-job" || route.type === "latest-channel-job" ? route.jobId : undefined;
  const cleanedText = stripBotMention(message.content, botUserId);
  debugMessageRoute("accepted-input", message, {
    botUserId,
    isMention,
    isPrefixed,
    channelMessageAllowed,
    knownThread: Boolean(knownThreadRecord),
    routeType: route.type,
    commandJobId,
    cleanedPreview: cleanedText.replace(/\s+/g, " ").trim().slice(0, 300),
  });

  const commands = new CommandRouter({ config, jobs, confirmations, botUserId });
  if (await commands.handle({ message, text: cleanedText, jobId: commandJobId })) {
    debugMessageRoute("handled-command", message, { commandJobId });
    return;
  }

  const promptText = cleanedText.trim() || "Please inspect the attached Discord file(s).";

  if (route.type === "existing-job") {
    debugMessageRoute("route-existing-job", message, { jobId: route.jobId });
    await jobs.sendToJob(route.jobId, promptText, message.attachments.values(), "immediate", message.channel as SendableChannel);
    return;
  }

  if (isDm && route.type === "latest-channel-job") {
    debugMessageRoute("route-latest-dm-job", message, { jobId: route.jobId });
    await jobs.sendToJob(route.jobId, promptText, message.attachments.values(), "immediate", message.channel as SendableChannel);
    return;
  }

  debugMessageRoute("create-job-start", message, { promptPreview: promptText.replace(/\s+/g, " ").slice(0, 300) });
  const record = await jobs.createJob({
    ownerUserId: message.author.id,
    guildId: message.guildId ?? undefined,
    sourceMessage: message,
    initialText: promptText,
  });

  debugMessageRoute("create-job-done", message, { jobId: record.id, threadId: record.threadId, cwd: record.cwd, kind: record.kind });

  if (!record.threadId && !isDm) {
    await sendChunked(message.channel as SendableChannel, `Created job \`${record.id}\`. I could not create a Discord thread, so replies in this channel may start new jobs unless you use \`new\`/\`jobs\` explicitly.`);
  }
}
