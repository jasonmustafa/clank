import type { DiscordRequest, DiscordTransport } from "./router.js";

export interface CasualPiSession { prompt(prompt: string): Promise<string>; dispose(): Promise<void>; }
export interface CasualPiFactory { create(): Promise<CasualPiSession>; }
export interface RateLimit { requests: number; windowMs: number; }
export interface CasualRoutingPolicy {
  allowedGuildIds: readonly string[];
  allowedChannelIds: readonly string[];
  superuserIds: readonly string[];
  continuationTtlMs: number;
  maxContinuationTurns: number;
  userRateLimit: RateLimit;
  guildRateLimit: RateLimit;
}
export interface CasualRouteResult { kind: "ignored" | "completed" | "rate-limited"; }

interface Conversation { userId: string; guildId: string; channelId: string; session: CasualPiSession; expiresAt: number; turnsRemaining: number; }

class SlidingWindowLimiter {
  readonly #entries = new Map<string, number[]>();
  consume(limits: readonly { key: string; limit: RateLimit }[], now: number): { allowed: boolean; retryMs: number } {
    const active = limits.map(({ key, limit }) => ({ key, limit, entries: (this.#entries.get(key) ?? []).filter((time) => now - time < limit.windowMs) }));
    const blocked = active.filter(({ entries, limit }) => entries.length >= limit.requests);
    if (blocked.length > 0) return { allowed: false, retryMs: Math.max(...blocked.map(({ entries, limit }) => limit.windowMs - (now - (entries[0] ?? now)))) };
    for (const { key, entries } of active) this.#entries.set(key, [...entries, now]);
    return { allowed: true, retryMs: 0 };
  }
}

export class CasualRequestRouter {
  readonly #conversations = new Map<string, Conversation>();
  readonly #limiter = new SlidingWindowLimiter();
  constructor(readonly policy: CasualRoutingPolicy, readonly discord: DiscordTransport, readonly pi: CasualPiFactory, readonly now: () => number = Date.now) {}

  async route(request: DiscordRequest): Promise<CasualRouteResult> {
    this.#prune();
    if (request.authorIsBot || request.webhookId !== null || request.location !== "guild" || request.guildId === null || request.threadId !== null || !this.policy.allowedGuildIds.includes(request.guildId) || !this.policy.allowedChannelIds.includes(request.channelId)) return { kind: "ignored" };
    const prior = request.replyToMessageId === null ? undefined : this.#conversations.get(request.replyToMessageId);
    const continuation = prior !== undefined && prior.userId === request.userId && prior.guildId === request.guildId && prior.channelId === request.channelId && prior.expiresAt > this.now() && prior.turnsRemaining > 0 ? prior : undefined;
    if (!request.mentionsApplication && continuation === undefined) return { kind: "ignored" };
    if (!this.policy.superuserIds.includes(request.userId)) {
      const result = this.#limiter.consume([{ key: `user:${request.userId}`, limit: this.policy.userRateLimit }, { key: `guild:${request.guildId}`, limit: this.policy.guildRateLimit }], this.now());
      if (!result.allowed) { await this.discord.send(request.channelId, `Casual chat rate limit reached. Try again in ${String(Math.max(1, Math.ceil(result.retryMs / 1_000)))} second${result.retryMs > 1_000 ? "s" : ""}.`, { kind: "status" }); return { kind: "rate-limited" }; }
    }
    const session = continuation?.session ?? await this.pi.create();
    const prompt = stripMention(request.content).trim();
    if (continuation !== undefined && request.replyToMessageId !== null) this.#conversations.delete(request.replyToMessageId);
    try {
      const response = await session.prompt(prompt || "Hello");
      const replyId = await this.discord.send(request.channelId, response || "I could not produce a response.", { kind: "final" });
      const turnsRemaining = continuation === undefined ? this.policy.maxContinuationTurns : continuation.turnsRemaining - 1;
      if (typeof replyId === "string" && turnsRemaining > 0) this.#conversations.set(replyId, { userId: request.userId, guildId: request.guildId, channelId: request.channelId, session, expiresAt: this.now() + this.policy.continuationTtlMs, turnsRemaining });
      else await session.dispose();
      return { kind: "completed" };
    } catch (error) { await session.dispose(); throw error; }
  }

  async shutdown(): Promise<void> { const sessions = new Set([...this.#conversations.values()].map(({ session }) => session)); this.#conversations.clear(); await Promise.all([...sessions].map((session) => session.dispose())); }
  #prune(): void { const now = this.now(); for (const [id, conversation] of this.#conversations) if (conversation.expiresAt <= now) { this.#conversations.delete(id); void conversation.session.dispose(); } }
}
function stripMention(content: string): string { return content.replace(/<@!?[^>]+>/gu, ""); }
