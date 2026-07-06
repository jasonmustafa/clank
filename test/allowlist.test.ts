import { describe, expect, it } from "vitest";
import { checkAllowlist, isChannelAllowed } from "../src/config/allowlist.js";
import type { ClankConfig } from "../src/config/env.js";

function cfg(overrides: Partial<ClankConfig> = {}): ClankConfig {
  return {
    discordToken: "token",
    allowedUserIds: new Set(["u1"]),
    allowedGuildIds: new Set(["g1"]),
    allowedChannelIds: new Set(["c1"]),
    allowDms: true,
    allowGuildChannelMessages: false,
    commandPrefixes: ["!"],
    piAgentDir: "/opt/clank/pi-agent",
    piSessionDir: "/opt/clank/pi-sessions",
    workspaceRoot: "/opt/clank/workspaces",
    clankAppDir: "/opt/clank/app",
    allowedRootDirs: ["/opt/clank/workspaces", "/opt/clank/app", "/opt/clank/pi-agent"],
    stateDir: "/opt/clank/state",
    tempDir: "/opt/clank/tmp",
    maxAttachmentBytes: 1,
    previewThrottleMs: 1,
    destructiveConfirmTimeoutMs: 1,
    defaultRunner: "sdk",
    ...overrides,
  };
}

describe("allowlist", () => {
  it("requires an allowed user", () => {
    expect(checkAllowlist({ userId: "u2", isDm: true }, cfg()).allowed).toBe(false);
  });

  it("allows DMs from allowed users when enabled", () => {
    expect(checkAllowlist({ userId: "u1", isDm: true }, cfg()).allowed).toBe(true);
  });

  it("checks parent channel IDs for threads", () => {
    expect(isChannelAllowed("thread", "c1", cfg())).toBe(true);
  });

  it("requires allowed guild and channel for guild messages", () => {
    expect(checkAllowlist({ userId: "u1", guildId: "g1", channelId: "c2", isDm: false }, cfg()).allowed).toBe(false);
    expect(checkAllowlist({ userId: "u1", guildId: "g1", channelId: "c1", isDm: false }, cfg()).allowed).toBe(true);
  });
});
