import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type Attachment,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import {
  canAccessCasual,
  canAccessElevated,
  canAccessWork,
  isOwner,
  type DiscordAccessSubject,
  type DiscordPolicy,
} from "../config/index.js";
import { handleWorkMessage, type WorkMessageDependencies } from "./work-messages.js";
import { type JobControl, type JobController } from "../jobs/routing.js";
import { AttachmentIngestor, type DiscordAttachment } from "../attachments/index.js";

export const CLANK_COMMAND = new SlashCommandBuilder()
  .setName("clank")
  .setDescription("Control Clank and get context-aware help")
  .addSubcommand((command) => command.setName("help").setDescription("Show commands available here"))
  .addSubcommand((command) => command.setName("stop").setDescription("Stop the active job and clear its queue"))
  .addSubcommand((command) => command.setName("steer").setDescription("Steer the active job").addStringOption((option) => option.setName("instructions").setDescription("New instructions").setRequired(true)))
  .addSubcommand((command) => command.setName("compact").setDescription("Compact an idle job"))
  .addSubcommand((command) => command.setName("status").setDescription("Show the current job status"))
  .addSubcommand((command) => command.setName("jobs").setDescription("List your jobs"))
  .addSubcommand((command) => command.setName("new").setDescription("Start a new session"));

export type ChannelKind = "guild" | "thread" | "dm";

export interface CommandRequest {
  commandName: string;
  subcommand: string;
  userId: string;
  roleIds: readonly string[];
  guildId: string | null;
  channelId: string;
  parentChannelId: string | null;
  channelKind: ChannelKind;
  isJobThread: boolean;
  isBot: boolean;
}

export interface CommandResponse {
  allowed: boolean;
  content: string;
  ephemeral: boolean;
}

type CommandHandler = (policy: DiscordPolicy, request: CommandRequest) => CommandResponse;

const commandHandlers: Readonly<Record<string, CommandHandler>> = {
  help: routeHelp,
};

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
}

export function routeCommand(policy: DiscordPolicy, request: CommandRequest): CommandResponse {
  if (request.commandName !== "clank") return denial();
  const handler = commandHandlers[request.subcommand];
  return handler?.(policy, request) ?? {
    allowed: false,
    content: "That Clank command isn't available yet.",
    ephemeral: true,
  };
}

export function attachInteractionRouter(client: Client, policy: DiscordPolicy, jobs?: JobController): void {
  client.on("interactionCreate", (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const request = toCommandRequest(interaction);
    const control = request.subcommand as JobControl;
    if (jobs !== undefined && isJobControl(control) && canAccessWork(policy, accessSubject(request))) {
      const argument = control === "steer" ? interaction.options.getString("instructions") ?? undefined : undefined;
      void jobs.command(control, { channelKind: request.channelKind === "dm" ? "dm" : "thread", channelId: request.channelId, userId: request.userId }, argument)
        .then(async (result) => interaction.reply({ content: result.content, ephemeral: true }))
        .catch(async (error: unknown) => interaction.reply({ content: `Job control failed: ${error instanceof Error ? error.message : String(error)}`, ephemeral: true }));
      return;
    }
    const response = routeCommand(policy, request);
    void interaction.reply({ content: response.content, ephemeral: response.ephemeral });
  });
}

export function attachWorkMessageRouter(
  client: Client,
  policy: DiscordPolicy,
  dependencies: WorkMessageDependencies,
): void {
  client.on("messageCreate", (message) => {
    if (!message.inGuild() || message.channel.isThread()) return;
    void handleWorkMessage(policy, toWorkMessage(message), dependencies).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Failed to handle work message ${message.id}: ${detail}`);
    });
  });
}

export interface JobAttachmentDependencies { ingestor: AttachmentIngestor; }

export function attachJobMessageRouter(client: Client, policy: DiscordPolicy, jobs: JobController, attachments?: JobAttachmentDependencies): void {
  client.on("messageCreate", (message) => {
    const isDm = !message.inGuild();
    const isThread = message.inGuild() && message.channel.isThread();
    if ((!isDm && !isThread) || message.author.bot || (message.content.trim() === "" && message.attachments.size === 0)) return;
    const channelId = isThread ? message.channel.parentId : message.channelId;
    const access: DiscordAccessSubject = {
      userId: message.author.id,
      roleIds: message.inGuild() && message.member !== null ? [...message.member.roles.cache.keys()] : [],
      guildId: message.guildId,
      channelId,
      isBot: false,
      isDm,
    };
    if (!canAccessWork(policy, access)) return;
    const target = { channelKind: isDm ? "dm" as const : "thread" as const, channelId: message.channelId, userId: message.author.id };
    void (async () => {
      const job = jobs.resolve(target);
      const ingested = attachments === undefined || job === undefined || message.attachments.size === 0
        ? undefined
        : await attachments.ingestor.ingest(job.id, [...message.attachments.values()].map(toAttachment));
      return jobs.message({ ...target, content: message.content, ...(ingested === undefined ? {} : { promptSuffix: ingested.prompt, images: ingested.images, attachmentErrors: ingested.errors }) });
    })().then(async (result) => {
      if (result.messages === undefined) await message.reply(result.content);
      else for (const [index, content] of result.messages.entries()) await message.reply(index === result.messages.length - 1 && result.files !== undefined && result.files.length > 0 ? { content, files: [...result.files] } : content);
    })
      .catch((error: unknown) => {
        console.error(`Failed to route job message ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
  });
}

export async function startDiscordGateway(
  discordToken: string,
  policy: DiscordPolicy,
  workMessages?: WorkMessageDependencies,
  jobs?: JobController,
  attachments?: JobAttachmentDependencies,
): Promise<Client> {
  const client = createDiscordClient();
  attachInteractionRouter(client, policy, jobs);
  if (workMessages !== undefined) attachWorkMessageRouter(client, policy, workMessages);
  if (jobs !== undefined) attachJobMessageRouter(client, policy, jobs, attachments);
  await client.login(discordToken);
  return client;
}

function routeHelp(policy: DiscordPolicy, request: CommandRequest): CommandResponse {
  const subject = accessSubject(request);
  if (isOwner(policy, request.userId)) {
    return help("Owner commands", "You can manage work jobs and owner-only operations. More commands are added as Clank is configured.");
  }
  if (request.channelKind === "dm" && canAccessWork(policy, subject)) {
    return help("Direct message", "Use this DM for private work with Clank. Job controls will appear here when available.");
  }
  if (request.channelKind === "thread" && request.isJobThread && canAccessWork(policy, subject)) {
    return help("Job thread", "Continue the current job here. Job controls will appear here when available.");
  }
  if (canAccessWork(policy, subject) || canAccessElevated(policy, subject)) {
    return help("Work channel", "Start work in this channel. Clank will keep each job in its own thread.");
  }
  if (canAccessCasual(policy, subject)) {
    return help("Casual chat", "Mention Clank for a no-tools conversation. Work and owner commands are unavailable here.");
  }
  return denial();
}

function isJobControl(value: string): value is JobControl {
  return value === "stop" || value === "steer" || value === "compact" || value === "status" || value === "jobs" || value === "new";
}

function accessSubject(request: CommandRequest): DiscordAccessSubject {
  return {
    userId: request.userId,
    roleIds: request.roleIds,
    channelId: request.channelKind === "thread" ? request.parentChannelId : request.channelId,
    guildId: request.guildId,
    isBot: request.isBot,
    isDm: request.channelKind === "dm",
  };
}

function help(heading: string, detail: string): CommandResponse {
  return { allowed: true, content: `**${heading}**\n${detail}`, ephemeral: true };
}

function denial(): CommandResponse {
  return { allowed: false, content: "You aren't authorized to use Clank here.", ephemeral: true };
}

function toWorkMessage(message: Message<true>) {
  return {
    content: message.content,
    attachments: [...message.attachments.values()].map(toAttachment),
    access: {
      userId: message.author.id,
      roleIds: message.member === null ? [] : [...message.member.roles.cache.keys()],
      guildId: message.guildId,
      channelId: message.channelId,
      isBot: message.author.bot,
      isDm: false,
    },
    startThread: async (name: string) => {
      const thread = await message.startThread({ name });
      return {
        id: thread.id,
        name: thread.name,
        send: async (content: string, files?: readonly string[]) => {
          await thread.send(files === undefined || files.length === 0 ? content : { content, files: [...files] });
        },
      };
    },
  };
}

function toAttachment(attachment: Attachment): DiscordAttachment {
  return { name: attachment.name, url: attachment.url, size: attachment.size, contentType: attachment.contentType };
}

function toCommandRequest(interaction: ChatInputCommandInteraction): CommandRequest {
  const channel = interaction.channel;
  const isDm = interaction.guildId === null;
  const isThread = channel?.isThread() ?? false;
  const memberRoles = interaction.member?.roles;
  const roleIds = memberRoles === undefined || Array.isArray(memberRoles)
    ? []
    : [...memberRoles.cache.keys()];

  return {
    commandName: interaction.commandName,
    subcommand: interaction.options.getSubcommand(false) ?? "help",
    userId: interaction.user.id,
    roleIds,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    parentChannelId: channel?.isThread() === true ? channel.parentId : null,
    channelKind: isDm ? "dm" : isThread ? "thread" : "guild",
    isJobThread: channel?.isThread() === true && channel.ownerId === interaction.client.user.id,
    isBot: interaction.user.bot,
  };
}
