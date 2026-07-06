import { describe, expect, it } from "vitest";
import { determineJobTarget } from "../src/jobs/jobTarget.js";
import type { ClankConfig } from "../src/config/env.js";

const config: ClankConfig = {
  discordToken: "token",
  allowedUserIds: new Set(["u1"]),
  allowedGuildIds: new Set(),
  allowedChannelIds: new Set(),
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
};

describe("determineJobTarget", () => {
  it("routes Clank improvement requests to the app repo", () => {
    expect(determineJobTarget("improve the Discord bridge", config)).toMatchObject({
      kind: "self-improvement",
      cwd: "/opt/clank/app",
    });
  });

  it("routes Pi resource requests to the Pi agent dir", () => {
    expect(determineJobTarget("create a Pi skill for Obsidian", config)).toMatchObject({
      kind: "pi-agent",
      cwd: "/opt/clank/pi-agent",
    });
  });

  it("routes read-only Clank repo requests to the app repo", () => {
    expect(determineJobTarget("what is currently in the gitignore of the clank repo?", config)).toMatchObject({
      kind: "self-improvement",
      cwd: "/opt/clank/app",
    });
  });

  it("leaves ordinary tasks in the standard workspace", () => {
    expect(determineJobTarget("summarize this attachment", config).kind).toBe("standard");
  });
});
