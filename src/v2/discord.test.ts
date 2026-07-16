import { describe, expect, it } from "vitest";
import { normalizeDiscordMessage } from "./discord.js";

describe("v2 Discord normalization", () => {
  it("copies immutable identity and origin fields from a guild message", () => {
    expect(normalizeDiscordMessage({ id: "message-id", author: { id: "user-id", bot: false }, channelId: "channel-id", guildId: "guild-id", content: "hello", attachments: new Map(), webhookId: "webhook-id", channel: { isThread: () => false }, inGuild: () => true })).toEqual({
      id: "message-id", userId: "user-id", channelId: "channel-id", threadId: null, guildId: "guild-id", location: "guild", content: "hello", attachments: [], authorIsBot: false, webhookId: "webhook-id", replyToMessageId: null, mentionsApplication: false,
    });
  });
  it("identifies a thread and retains its parent channel", () => {
    const normalized = normalizeDiscordMessage({ id: "reply", author: { id: "owner-id", bot: false }, channelId: "thread-id", guildId: "guild", content: "continue", attachments: new Map(), webhookId: null, channel: { isThread: () => true, parentId: "private-channel" }, inGuild: () => true });
    expect(normalized.threadId).toBe("thread-id"); expect(normalized.channelId).toBe("private-channel"); expect(normalized.userId).toBe("owner-id");
  });
});
