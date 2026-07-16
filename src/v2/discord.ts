import { Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import { chunkDiscordMessage } from "../formatting/index.js";
import { SuperuserRequestRouter, type DiscordRequest, type DiscordTransport, type SuperuserPiFactory, type SuperuserRoutingPolicy } from "./router.js";

export interface DiscordMessageLike {
  id: string;
  author: { id: string; bot: boolean };
  channelId: string;
  guildId: string | null;
  content: string;
  webhookId: string | null;
  inGuild(): boolean;
}

export function normalizeDiscordMessage(message: DiscordMessageLike): DiscordRequest {
  const inGuild = message.inGuild();
  return {
    id: message.id,
    userId: message.author.id,
    channelId: message.channelId,
    guildId: inGuild ? message.guildId : null,
    location: inGuild ? "guild" : "dm",
    content: message.content,
    authorIsBot: message.author.bot,
    webhookId: message.webhookId,
  };
}

class DiscordJsTransport implements DiscordTransport {
  readonly #messages = new Map<string, Message>();

  register(message: Message): void {
    this.#messages.set(message.id, message);
  }

  unregister(messageId: string): void {
    this.#messages.delete(messageId);
  }

  async send(requestId: string, content: string): Promise<void> {
    const message = this.#messages.get(requestId);
    if (message === undefined) throw new Error(`Discord request ${requestId} is no longer available`);
    for (const chunk of chunkDiscordMessage(content)) await message.reply(chunk);
  }
}

export function createV2DiscordClient(): Client {
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

export async function startV2DiscordGateway(
  discordToken: string,
  policy: SuperuserRoutingPolicy,
  pi: SuperuserPiFactory,
): Promise<Client> {
  const client = createV2DiscordClient();
  const transport = new DiscordJsTransport();
  const router = new SuperuserRequestRouter(policy, transport, pi);
  client.on("messageCreate", (message) => {
    transport.register(message);
    void router.route(normalizeDiscordMessage(message))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`Failed to route v2 Discord message ${message.id}: ${detail}`);
      })
      .finally(() => { transport.unregister(message.id); });
  });
  await client.login(discordToken);
  return client;
}
