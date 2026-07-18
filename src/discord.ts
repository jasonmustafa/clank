import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, Partials, type Message, type MessageCreateOptions } from "discord.js";
import { chunkDiscordMessage } from "./formatting/index.js";
import { SuperuserRequestRouter, type DiscordRequest, type DiscordTransport, type SuperuserPiFactory, type SuperuserRoutingPolicy } from "./router.js";
import type { TaskStore } from "./task-store.js";
import type { TaskAttachmentBridge } from "./attachments.js";
import { CasualRequestRouter, type CasualPiFactory, type CasualRoutingPolicy } from "./casual.js";

export interface DiscordMessageLike {
  id: string; author: { id: string; bot: boolean }; channelId: string; guildId: string | null; content: string; webhookId: string | null;
  channel: { isThread(): boolean; parentId?: string | null }; attachments: ReadonlyMap<string, { name: string; url: string; size: number; contentType?: string | null }>; reference?: { messageId?: string | null | undefined } | null; inGuild(): boolean;
}
export function normalizeDiscordMessage(message: DiscordMessageLike, applicationId = ""): DiscordRequest {
  const inGuild = message.inGuild(); const threadId = message.channel.isThread() ? message.channelId : null;
  return { id: message.id, userId: message.author.id, channelId: threadId === null ? message.channelId : (message.channel.parentId ?? message.channelId), threadId,
    guildId: inGuild ? message.guildId : null, location: inGuild ? "guild" : "dm", content: message.content, attachments: [...message.attachments.values()].map(({ name, url, size, contentType }) => ({ name, url, size, contentType: contentType ?? null })), authorIsBot: message.author.bot, webhookId: message.webhookId, replyToMessageId: message.reference?.messageId ?? null, mentionsApplication: applicationId !== "" && new RegExp(`<@!?${applicationId}>`, "u").test(message.content) };
}

class DiscordJsTransport implements DiscordTransport {
  readonly #messages = new Map<string, Message>();
  readonly #previews = new Map<string, Message>();
  readonly #typingTimers = new Map<string, NodeJS.Timeout>();
  readonly #client: Client;
  constructor(client: Client) { this.#client = client; }
  register(message: Message): void { this.#messages.set(message.id, message); }
  unregister(messageId: string): void { this.#messages.delete(messageId); }
  async createThread(requestId: string, name: string): Promise<string> {
    const message = this.#messages.get(requestId); if (message === undefined) throw new Error(`Discord request ${requestId} is no longer available`);
    if (!message.inGuild() || message.channel.isThread()) throw new Error("A task thread can only start from a guild text channel");
    const thread = await message.startThread({ name, autoArchiveDuration: 1440 }); return thread.id;
  }
  async send(channelId: string, content: string, options?: { kind?: "preview" | "status" | "final"; files?: readonly string[]; approval?: { id: string; taskId: string; command: string } }): Promise<string | undefined> {
    if (options?.kind === "final") { const preview = this.#previews.get(channelId); this.#previews.delete(channelId); await preview?.delete().catch(() => undefined); }
    const channel = await this.#textChannel(channelId);
    const chunks = chunkDiscordMessage(content); let last: Message | undefined; for (const [index, chunk] of chunks.entries()) { const finalChunk = index === chunks.length - 1; const payload: MessageCreateOptions = { content: chunk, ...(finalChunk && (options?.files?.length ?? 0) > 0 ? { files: [...(options?.files ?? [])] } : {}), ...(finalChunk && options?.approval !== undefined ? { components: [approvalButtons(options.approval.id)] } : {}) }; last = await channel.send(payload); } return last?.id;
  }
  async updatePreview(channelId: string, content: string): Promise<void> {
    const preview = this.#previews.get(channelId); const visible = content === "" ? "…" : content;
    if (preview === undefined) { const channel = await this.#textChannel(channelId); this.#previews.set(channelId, await channel.send(visible)); }
    else await preview.edit(visible);
  }
  async setTyping(channelId: string, active: boolean): Promise<void> {
    const oldTimer = this.#typingTimers.get(channelId); if (oldTimer !== undefined) clearInterval(oldTimer);
    this.#typingTimers.delete(channelId); if (!active) return;
    const channel = await this.#textChannel(channelId); await channel.sendTyping();
    this.#typingTimers.set(channelId, setInterval(() => { void channel.sendTyping().catch(() => undefined); }, 8_000));
  }
  async #textChannel(channelId: string): Promise<{ send(content: string | MessageCreateOptions): Promise<Message>; sendTyping(): Promise<unknown> }> {
    const channel = await this.#client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased() || !("send" in channel) || !("sendTyping" in channel)) throw new Error(`Discord channel ${channelId} cannot receive task output`);
    return channel as unknown as { send(content: string | MessageCreateOptions): Promise<Message>; sendTyping(): Promise<unknown> };
  }
}
export function createDiscordClient(): Client { return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] }); }
export interface DiscordGateway { client: Client; shutdown(): Promise<void>; }
export async function startDiscordGateway(discordToken: string, applicationId: string, policy: SuperuserRoutingPolicy, pi: SuperuserPiFactory, casualPolicy: CasualRoutingPolicy, casualPi: CasualPiFactory, store?: TaskStore, attachments?: TaskAttachmentBridge): Promise<DiscordGateway> {
  const client = createDiscordClient(); const transport = new DiscordJsTransport(client); const router = new SuperuserRequestRouter(policy, transport, pi, store, attachments); const casual = new CasualRequestRouter(casualPolicy, transport, casualPi);
  client.on("interactionCreate", (interaction) => { if (!interaction.isButton() || !interaction.customId.startsWith("clank-approval:")) return; const [, decision, approvalId] = interaction.customId.split(":"); if ((decision !== "approve" && decision !== "deny") || approvalId === undefined) return; void router.handleApprovalAction({ approvalId, userId: interaction.user.id, decision }).then(async (result) => { await interaction.reply({ content: approvalInteractionMessage(result), ephemeral: true }); }).catch((error: unknown) => { console.error(`Failed to decide approval ${approvalId}: ${error instanceof Error ? error.message : String(error)}`); }); });
  client.on("messageCreate", (message) => {
    transport.register(message);
    const request = normalizeDiscordMessage(message, applicationId);
    void (async () => { const result = await router.route(request); if (result.kind === "ignored") await casual.route(request); })().catch((error: unknown) => { console.error(`Failed to route Discord message ${message.id}: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { transport.unregister(message.id); });
  });
  await client.login(discordToken); await router.initialize();
  return { client, async shutdown() { await router.shutdown(); await casual.shutdown(); await client.destroy(); } };
}
function approvalButtons(approvalId: string): ActionRowBuilder<ButtonBuilder> { return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`clank-approval:approve:${approvalId}`).setLabel("Approve").setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`clank-approval:deny:${approvalId}`).setLabel("Deny").setStyle(ButtonStyle.Secondary)); }
function approvalInteractionMessage(result: "approved" | "denied" | "unauthorized" | "unavailable"): string { switch (result) { case "approved": return "Command approved."; case "denied": return "Command denied."; case "unauthorized": return "Only a configured owner can decide this approval."; case "unavailable": return "This approval is expired, already used, or unavailable."; } }
