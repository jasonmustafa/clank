import type { Message } from "discord.js";
import type { ClankConfig } from "../config/env.js";
import { sendChunked, type SendableChannel } from "../format/discord.js";
import { ConfirmationManager } from "../safety/confirmation.js";
import type { JobManager } from "../jobs/jobManager.js";

export interface CommandRouterOptions {
  config: ClankConfig;
  jobs: JobManager;
  confirmations: ConfirmationManager;
  botUserId: string;
}

export interface CommandContext {
  message: Message;
  text: string;
  jobId?: string;
}

const COMMANDS = new Set(["help", "stop", "status", "jobs", "new", "compact", "steer", "confirm", "deny", "deploy"]);

function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`^<@!?${botUserId}>\\s*`), "").trim();
}

function stripPrefix(text: string, prefixes: string[]): { text: string; hadPrefix: boolean } {
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) return { text: text.slice(prefix.length).trim(), hadPrefix: true };
  }
  return { text, hadPrefix: false };
}

export function parseCommand(rawText: string, config: ClankConfig, botUserId: string): { name: string; args: string; explicit: boolean } | undefined {
  const withoutMention = stripMention(rawText.trim(), botUserId);
  const prefixed = stripPrefix(withoutMention, config.commandPrefixes);
  const [nameRaw, ...rest] = prefixed.text.split(/\s+/);
  if (!nameRaw) return undefined;
  const name = nameRaw.toLowerCase();
  if (!COMMANDS.has(name)) return undefined;
  if (!prefixed.hadPrefix && !["help", "stop", "status", "jobs", "new", "compact", "steer", "confirm", "deny", "deploy"].includes(name)) return undefined;
  return { name, args: rest.join(" ").trim(), explicit: prefixed.hadPrefix };
}

export class CommandRouter {
  constructor(private readonly options: CommandRouterOptions) {}

  async handle(ctx: CommandContext): Promise<boolean> {
    const command = parseCommand(ctx.text, this.options.config, this.options.botUserId);
    if (!command) return false;

    const { message } = ctx;
    const channel = message.channel as SendableChannel;

    if (command.name === "confirm" || command.name === "deny") {
      const code = command.args.split(/\s+/)[0];
      if (!code) {
        await channel.send("Usage: `confirm <code>` or `deny <code>`.");
        return true;
      }
      const ok = this.options.confirmations.resolve(code, command.name === "confirm");
      await channel.send(ok ? `${command.name === "confirm" ? "✅ Confirmed" : "🚫 Denied"} ${code}.` : `No pending confirmation for ${code}.`);
      return true;
    }

    if (command.name === "help") {
      await sendChunked(
        channel,
        [
          "**Clank usage**",
          "DM me, mention me, or use an allowed channel to start a job.",
          "In a job thread, send normal messages for follow-ups. Busy jobs queue follow-ups by default.",
          "Commands: `help`, `status`, `jobs`, `stop`, `new [request]`, `compact [notes]`, `steer <message>`, `deploy` (placeholder only).",
          "Confirm privileged/destructive operations with `confirm <code>` or `deny <code>`.",
        ].join("\n"),
      );
      return true;
    }

    if (command.name === "deploy") {
      await channel.send({ content: "Deployment is intentionally manual for MVP. If Clank changed its own code, run the reviewed deploy/restart steps on the VPS. Future automation must use only a fixed approved script such as `/usr/local/sbin/deploy-clank`, never arbitrary sudo.", allowedMentions: { parse: [] } });
      return true;
    }

    if (command.name === "jobs") {
      await sendChunked(channel, this.options.jobs.listJobs(10));
      return true;
    }

    if (command.name === "status") {
      await sendChunked(channel, await this.options.jobs.status(ctx.jobId, channel));
      return true;
    }

    if (command.name === "stop") {
      if (!ctx.jobId) {
        await channel.send("No current job in this channel/thread.");
        return true;
      }
      await this.options.jobs.stopJob(ctx.jobId, channel);
      return true;
    }

    if (command.name === "compact") {
      if (!ctx.jobId) {
        await channel.send("No current job in this channel/thread.");
        return true;
      }
      await this.options.jobs.compactJob(ctx.jobId, command.args || undefined, channel);
      return true;
    }

    if (command.name === "steer") {
      if (!ctx.jobId) {
        await channel.send("No current job in this channel/thread.");
        return true;
      }
      if (!command.args) {
        await channel.send("Usage: `steer <message>`.");
        return true;
      }
      await this.options.jobs.sendToJob(ctx.jobId, command.args, message.attachments.values(), "steer", channel);
      return true;
    }

    if (command.name === "new") {
      if (!command.args && ctx.jobId) {
        await this.options.jobs.newSession(ctx.jobId, channel);
        return true;
      }
      if (!command.args) {
        await channel.send("Usage: `new <request>` (or in a job thread, `new` to reset that job's Pi session).");
        return true;
      }
      await this.options.jobs.createJob({
        ownerUserId: message.author.id,
        guildId: message.guildId ?? undefined,
        sourceMessage: message,
        initialText: command.args,
      });
      return true;
    }

    return false;
  }
}
