import { describe, expect, it } from "vitest";
import { FakePiRunner, jobSessionDir, resourceLoaderPaths, RpcPiRunner, type PiRunnerEvent } from "./index.js";

describe("FakePiRunner", () => {
  it("implements the runner lifecycle and emits streamed and final events", async () => {
    const runner = new FakePiRunner({ chunks: ["Work", "ing"], final: "Working" });
    const events: PiRunnerEvent[] = [];
    const unsubscribe = runner.onEvent((event) => { events.push(event); });

    await expect(runner.prompt("do it")).resolves.toEqual(["Working"]);
    expect(runner.status()).toEqual({ state: "idle", sessionId: "fake-session-1", model: "fake/model" });
    expect(events.map((event) => event.type)).toEqual([
      "status", "text_delta", "text_delta", "final", "status",
    ]);

    await runner.compact();
    await runner.newSession();
    expect(runner.status().sessionId).toBe("fake-session-2");
    await runner.abort();
    unsubscribe();
    await runner.dispose();
    expect(runner.status().state).toBe("disposed");
  });
});

describe("trusted runner resources", () => {
  it("snapshots each resource category for a newly created runner", () => {
    const configured = { skills: ["/repo/skill"], prompts: ["/repo/prompt.md"], extensions: ["/repo/ext.ts"] };
    const paths = resourceLoaderPaths(configured);
    configured.skills.push("/repo/later");
    expect(paths).toEqual({
      additionalSkillPaths: ["/repo/skill"],
      additionalPromptTemplatePaths: ["/repo/prompt.md"],
      additionalExtensionPaths: ["/repo/ext.ts"],
    });
  });
});

describe("jobSessionDir", () => {
  it("keeps opaque job IDs beneath the session root", () => {
    expect(jobSessionDir("/sessions", "job-123")).toBe("/sessions/job-123");
    expect(() => jobSessionDir("/sessions", "../escape")).toThrow("path segment");
    expect(() => jobSessionDir("/sessions", "nested/job")).toThrow("path segment");
  });
});

describe("RpcPiRunner", () => {
  it("clearly reports that it is not implemented", async () => {
    const runner = new RpcPiRunner();
    await expect(runner.prompt("hello")).rejects.toThrow("RpcPiRunner is not implemented");
  });
});
