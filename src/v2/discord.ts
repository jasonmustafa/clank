import { Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import { chunkDiscordMessage } from "../formatting/index.js";
import { SuperuserRequestRouter, type DiscordRequest, type DiscordTransport, type SuperuserPiFactory, type SuperuserRoutingPolicy } from "./router.js";
import type { TaskStore } from "./task-store.js";

export interface DiscordMessageLike {
  id: string; author: { id: string; bot: boolean }; channelId: string; guildId: string | null; content: string; webhookId: string | null;
  channel: { isThread(): boolean; parentId?: string | null }; inGuild(): boolean;
}
export function normalizeDiscordMessage(message: DiscordMessageLike): DiscordRequest {
  const inGuild = message.inGuild(); const threadId = message.channel.isThread() ? message.channelId : null;
  return { id: message.id, userId: message.author.id, channelId: threadId === null ? message.channelId : (message.channel.parentId ?? message.channelId), threadId,
    guildId: inGuild ? message.guildId : null, location: inGuild ? "guild" : "dm", content: message.content, authorIsBot: message.author.bot, webhookId: message.webhookId };
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
  async send(channelId: string, content: string, options?: { kind?: "preview" | "status" | "final" }): Promise<void> {
    if (options?.kind === "final") { const preview = this.#previews.get(channelId); this.#previews.delete(channelId); await preview?.delete().catch(() => undefined); }
    const channel = await this.#textChannel(channelId);
    for (const chunk of chunkDiscordMessage(content)) await channel.send(chunk);
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
  async #textChannel(channelId: string): Promise<{ send(content: string): Promise<Message>; sendTyping(): Promise<unknown> }> {
    const channel = await this.#client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased() || !("send" in channel) || !("sendTyping" in channel)) throw new Error(`Discord channel ${channelId} cannot receive task output`);
    return channel as unknown as { send(content: string): Promise<Message>; sendTyping(): Promise<unknown> };
  }
}
export function createV2DiscordClient(): Client { return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] }); }
export interface V2DiscordGateway { client: Client; shutdown(): Promise<void>; }
export async function startV2DiscordGateway(discordToken: string, policy: SuperuserRoutingPolicy, pi: SuperuserPiFactory, store?: TaskStore): Promise<V2DiscordGateway> {
  const client = createV2DiscordClient(); const transport = new DiscordJsTransport(client); const router = new SuperuserRequestRouter(policy, transport, pi, store);
  client.on("messageCreate", (message) => {
    transport.register(message);
    void router.route(normalizeDiscordMessage(message)).catch((error: unknown) => { console.error(`Failed to route v2 Discord message ${message.id}: ${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { transport.unregister(message.id); });
  });
  await client.login(discordToken); await router.initialize();
  return { client, async shutdown() { await router.shutdown(); await client.destroy(); } };
}
