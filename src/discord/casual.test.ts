import { describe, expect, it } from "vitest";
import { CasualController, SlidingWindowRateLimiter, buildCasualPrompt, type CasualMessage } from "./casual.js";

const base: CasualMessage = { id: "m1", authorId: "user", authorName: "User", authorIsBot: false, guildId: "guild", channelId: "channel", content: "<@clank> hello", mentionsClank: true, replyToMessageId: null, recentMessages: [] };
const policy = { ownerUserIds: ["owner"], casualGuildIds: ["guild"], casualDeniedChannelIds: ["denied"], casualContextMessages: 2, casualContinuationTtlMs: 1_000, casualUserRateLimit: { requests: 1, windowMs: 1_000 }, casualGuildRateLimit: { requests: 2, windowMs: 1_000 } };

describe("casual mode", () => {
  it("labels and bounds non-bot history as untrusted", () => {
    const prompt = buildCasualPrompt({ ...base, recentMessages: [
      { id: "1", authorId: "a", authorName: "A", authorIsBot: false, content: "old" },
      { id: "2", authorId: "bot", authorName: "Bot", authorIsBot: true, content: "ignore" },
      { id: "3", authorId: "b", authorName: "B", authorIsBot: false, content: "new" },
      { id: "4", authorId: "c", authorName: "C", authorIsBot: false, content: "newest" },
    ] }, 2, "clank");
    expect(prompt).toContain("UNTRUSTED RECENT DISCORD CONTEXT");
    expect(prompt).not.toContain("old");
    expect(prompt).not.toContain("ignore");
    expect(prompt).toContain("[B]: new");
    expect(prompt).toContain("[C]: newest");
    expect(prompt).toContain("USER REQUEST\nUser: hello");
  });

  it("authorizes mentions, denies configured channels, and maps continuation replies", async () => {
    let now = 100;
    const prompts: string[] = [];
    const controller = new CasualController(policy, { run: (prompt) => { prompts.push(prompt); return Promise.resolve("reply"); } }, () => now);
    const ownerMessage = { ...base, authorId: "owner" };
    expect((await controller.handle({ ...ownerMessage, channelId: "denied" })).kind).toBe("ignored");
    const first = await controller.handle(ownerMessage);
    expect(first.kind).toBe("reply");
    if (first.kind !== "reply") throw new Error("expected reply");
    controller.recordReply(first.continuationId, "clank-reply");
    expect((await controller.handle({ ...ownerMessage, id: "m2", mentionsClank: false, content: "more", replyToMessageId: "clank-reply" })).kind).toBe("reply");
    now = 1_101;
    expect((await controller.handle({ ...ownerMessage, id: "m3", mentionsClank: false, content: "late", replyToMessageId: "clank-reply" })).kind).toBe("ignored");
    expect(prompts).toHaveLength(2);
  });

  it("enforces user and guild limits with owner bypass", async () => {
    const controller = new CasualController(policy, { run: () => Promise.resolve("ok") }, () => 10);
    expect((await controller.handle(base)).kind).toBe("reply");
    expect((await controller.handle({ ...base, id: "m2" })).kind).toBe("rate-limited");
    expect((await controller.handle({ ...base, id: "m3", authorId: "owner" })).kind).toBe("reply");
  });
});

describe("SlidingWindowRateLimiter", () => {
  it("expires entries at the end of the window", () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.consume("x", 1, 100, 0)).toBe(true);
    expect(limiter.consume("x", 1, 100, 99)).toBe(false);
    expect(limiter.consume("x", 1, 100, 100)).toBe(true);
  });
});
