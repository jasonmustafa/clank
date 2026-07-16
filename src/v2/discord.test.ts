import { describe, expect, it } from "vitest";
import { normalizeDiscordMessage } from "./discord.js";

describe("v2 Discord normalization", () => {
  it("copies immutable identity and origin fields from a guild message", () => {
    expect(normalizeDiscordMessage({
      id: "message-id",
      author: { id: "user-id", bot: false },
      channelId: "channel-id",
      guildId: "guild-id",
      content: "hello",
      webhookId: "webhook-id",
      inGuild: () => true,
    })).toEqual({
      id: "message-id",
      userId: "user-id",
      channelId: "channel-id",
      guildId: "guild-id",
      location: "guild",
      content: "hello",
      authorIsBot: false,
      webhookId: "webhook-id",
    });
  });

  it("normalizes a DM independently of display names and guild metadata", () => {
    const normalized = normalizeDiscordMessage({
      id: "dm-message",
      author: { id: "owner-id", bot: false },
      channelId: "dm-id",
      guildId: null,
      content: "do work",
      webhookId: null,
      inGuild: () => false,
    });

    expect(normalized.location).toBe("dm");
    expect(normalized.guildId).toBeNull();
    expect(normalized.userId).toBe("owner-id");
  });
});
