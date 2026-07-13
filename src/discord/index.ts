import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
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

export const CLANK_COMMAND = new SlashCommandBuilder()
  .setName("clank")
  .setDescription("Control Clank and get context-aware help")
  .addSubcommand((command) => command.setName("help").setDescription("Show commands available here"));

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

export function attachInteractionRouter(client: Client, policy: DiscordPolicy): void {
  client.on("interactionCreate", (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const response = routeCommand(policy, toCommandRequest(interaction));
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

export async function startDiscordGateway(
  discordToken: string,
  policy: DiscordPolicy,
  workMessages?: WorkMessageDependencies,
): Promise<Client> {
  const client = createDiscordClient();
  attachInteractionRouter(client, policy);
  if (workMessages !== undefined) attachWorkMessageRouter(client, policy, workMessages);
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
        send: async (content: string) => {
          await thread.send(content);
        },
      };
    },
  };
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
