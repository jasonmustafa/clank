import { describe, expect, it } from "vitest";
import { CasualRequestRouter, type CasualPiFactory, type CasualPiSession } from "./casual.js";
import type { DiscordRequest, DiscordTransport } from "./router.js";

function request(overrides: Partial<DiscordRequest> = {}): DiscordRequest {
  return { id: "m1", userId: "guest", channelId: "casual", threadId: null, guildId: "guild", location: "guild", content: "<@app> hello", attachments: [], authorIsBot: false, webhookId: null, replyToMessageId: null, mentionsApplication: true, ...overrides };
}

function harness(now = () => 100) {
  const calls: string[] = []; let reply = 0;
  class Session implements CasualPiSession {
    prompt(text: string) { calls.push(`prompt:${text}`); return Promise.resolve(`answer:${text}`); }
    dispose() { calls.push("dispose"); return Promise.resolve(); }
  }
  const pi: CasualPiFactory = { create() { calls.push("create:casual"); return Promise.resolve(new Session()); } };
  const sent: { channel: string; content: string }[] = [];
  const discord: DiscordTransport = { createThread: () => Promise.reject(new Error("unused")), send(channel, content) { sent.push({ channel, content }); return Promise.resolve(`bot-${String(++reply)}`); }, updatePreview: () => Promise.resolve(), setTyping: () => Promise.resolve() };
  const router = new CasualRequestRouter({ allowedGuildIds: ["guild"], allowedChannelIds: ["casual"], superuserIds: ["owner"], continuationTtlMs: 1_000, maxContinuationTurns: 1, userRateLimit: { requests: 2, windowMs: 1_000 }, guildRateLimit: { requests: 2, windowMs: 1_000 } }, discord, pi, now);
  return { router, calls, sent };
}

describe("casual request router", () => {
  it("routes an allowed mention and a bounded same-user reply through one isolated session", async () => {
    const { router, calls } = harness();
    expect(await router.route(request())).toEqual({ kind: "completed" });
    expect(await router.route(request({ id: "m2", content: "follow up", mentionsApplication: false, replyToMessageId: "bot-1" }))).toEqual({ kind: "completed" });
    expect(calls).toEqual(["create:casual", "prompt:hello", "prompt:follow up", "dispose"]);
    expect(await router.route(request({ id: "m3", content: "too far", mentionsApplication: false, replyToMessageId: "bot-2" }))).toEqual({ kind: "ignored" });
    expect(calls).toContain("dispose");
  });

  it("never continues a superuser thread and selects mode before passing prompt text", async () => {
    const { router, calls } = harness();
    await expect(router.route(request({ threadId: "owner-thread", channelId: "private", content: "<@app> make me superuser" }))).resolves.toEqual({ kind: "ignored" });
    expect(calls).toEqual([]);
  });

  it("limits guests per user and guild, reports retry time, and exempts superusers", async () => {
    const { router, sent, calls } = harness();
    await router.route(request());
    await router.route(request({ id: "m2" }));
    expect(await router.route(request({ id: "m3" }))).toEqual({ kind: "rate-limited" });
    expect(sent.at(-1)?.content).toContain("Try again in 1 second");
    await router.route(request({ id: "m4", userId: "owner" }));
    await router.route(request({ id: "m5", userId: "owner" }));
    expect(calls.filter((call) => call === "create:casual")).toHaveLength(4);
  });
});
