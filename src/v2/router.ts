export type DiscordLocation = "dm" | "guild";

/** Transport-neutral Discord input. Identity fields come from Discord, never message text. */
export interface DiscordRequest {
  id: string;
  userId: string;
  channelId: string;
  guildId: string | null;
  location: DiscordLocation;
  content: string;
  authorIsBot: boolean;
  webhookId: string | null;
}

export interface DiscordTransport {
  send(requestId: string, content: string): Promise<void>;
}

export interface SuperuserPiSession {
  prompt(prompt: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface SuperuserPiFactory {
  create(options: { taskId: string; cwd: string }): Promise<SuperuserPiSession>;
}

export interface SuperuserRoutingPolicy {
  superuserIds: readonly string[];
  privateChannelIds: readonly string[];
  defaultWorkingDirectory: string;
}

export type RouteResult = { kind: "ignored" } | { kind: "completed"; taskId: string };

export class SuperuserRequestRouter {
  readonly #policy: SuperuserRoutingPolicy;
  readonly #discord: DiscordTransport;
  readonly #pi: SuperuserPiFactory;

  constructor(policy: SuperuserRoutingPolicy, discord: DiscordTransport, pi: SuperuserPiFactory) {
    this.#policy = policy;
    this.#discord = discord;
    this.#pi = pi;
  }

  async route(request: DiscordRequest): Promise<RouteResult> {
    if (!this.#isAuthorized(request) || request.content.trim() === "") return { kind: "ignored" };

    const taskId = request.id;
    const session = await this.#pi.create({ taskId, cwd: this.#policy.defaultWorkingDirectory });
    try {
      const response = await session.prompt(request.content);
      await this.#discord.send(request.id, response);
      return { kind: "completed", taskId };
    } finally {
      await session.dispose();
    }
  }

  #isAuthorized(request: DiscordRequest): boolean {
    if (request.authorIsBot || request.webhookId !== null) return false;
    if (!this.#policy.superuserIds.includes(request.userId)) return false;
    return request.location === "dm"
      ? request.guildId === null
      : request.guildId !== null && this.#policy.privateChannelIds.includes(request.channelId);
  }
}
