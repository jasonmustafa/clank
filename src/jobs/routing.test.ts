import { describe, expect, it } from "vitest";
import { FakePiRunner } from "../pi-runners/index.js";
import { JobController } from "./routing.js";
import type { Job } from "./index.js";

function job(overrides: Partial<Job> = {}): Job {
  return { id: "j1", threadName: "j1-work", status: "running", sessionPath: "/s/j1", workspacePath: "/w/j1", requesterId: "u1", guildId: "g1", channelId: "work", threadId: "t1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides };
}

describe("JobController", () => {
  it("routes thread follow-ups to the same runner and explicitly steers", async () => {
    const runner = new FakePiRunner();
    runner.setState("running");
    const controller = new JobController([job()], () => runner);
    await controller.message({ channelKind: "thread", channelId: "t1", userId: "u1", content: "next" });
    await controller.message({ channelKind: "thread", channelId: "t1", userId: "u1", content: "steer: change course" });
    expect(runner.received).toEqual([{ text: "next", behavior: "followUp" }, { text: "change course", behavior: "steer" }]);
  });

  it("passes attachment paths and images to Pi and returns queued output files", async () => {
    const runner = new FakePiRunner({ final: "Done." });
    const controller = new JobController([job()], () => runner, undefined, undefined, () => ["/w/j1/report.txt"]);
    const result = await controller.message({
      channelKind: "thread", channelId: "t1", userId: "u1", content: "inspect",
      promptSuffix: "\n\nLocal Discord attachments:\n- /tmp/jobs/j1/attachments/photo.png (image/png)",
      images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
    });
    expect(runner.received[0]?.text).toContain("/tmp/jobs/j1/attachments/photo.png");
    expect(runner.received[0]?.behavior).toBe("prompt");
    expect(runner.received[0]?.images).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
    expect(result.files).toEqual(["/w/j1/report.txt"]);
  });

  it("stops a job, clears its queues, and reports concise status", async () => {
    const runner = new FakePiRunner();
    const controller = new JobController([job()], () => runner);
    expect((await controller.command("stop", { channelKind: "thread", channelId: "t1", userId: "u1" })).content).toContain("stopped");
    expect(runner.status().state).toBe("idle");
    expect(controller.get("j1")?.status).toBe("stopped");
    expect((await controller.command("status", { channelKind: "thread", channelId: "t1", userId: "u1" })).content).toContain("queue 0");
  });

  it("rejects compaction while busy", async () => {
    const runner = new FakePiRunner();
    runner.setState("running");
    const controller = new JobController([job()], () => runner);
    expect((await controller.command("compact", { channelKind: "thread", channelId: "t1", userId: "u1" })).content).toContain("idle");
  });

  it("routes DMs to the latest recent job belonging to that user", async () => {
    const oldRunner = new FakePiRunner();
    const recentRunner = new FakePiRunner();
    const controller = new JobController([
      job({ id: "old", guildId: "", channelId: "dm", threadId: "", updatedAt: "2026-01-01T00:00:00Z" }),
      job({ id: "recent", guildId: "", channelId: "dm", threadId: "", updatedAt: "2026-02-01T00:00:00Z" }),
    ], (value) => value.id === "old" ? oldRunner : recentRunner);
    await controller.message({ channelKind: "dm", channelId: "dm", userId: "u1", content: "continue" });
    expect(recentRunner.received[0]).toEqual({ text: "continue", behavior: "prompt" });
    expect(oldRunner.received).toEqual([]);
  });
});
