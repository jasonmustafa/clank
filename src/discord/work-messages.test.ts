import { describe, expect, it, vi } from "vitest";
import type { DiscordPolicy } from "../config/index.js";
import { JobManager, JobStore } from "../jobs/index.js";
import { FakeRunner } from "../pi-runners/index.js";
import { handleWorkMessage, type WorkMessage } from "./work-messages.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const policy: DiscordPolicy = {
  applicationId: "app",
  guildId: "guild",
  ownerUserIds: ["owner"],
  workUserIds: ["worker"],
  workRoleIds: ["work-role"],
  privilegedApproverUserIds: [],
  workChannelIds: ["work-channel"],
  elevatedChannelIds: [],
  casualGuildIds: [],
};

async function fixture(userId = "worker") {
  const directory = await mkdtemp(join(tmpdir(), "clank-work-message-"));
  const manager = await JobManager.open(new JobStore(directory));
  const send = vi.fn<(content: string) => Promise<void>>(() => Promise.resolve());
  const startThread = vi.fn<(name: string) => Promise<{ id: string; name: string; send: typeof send }>>(
    (name) => Promise.resolve({ id: "thread-1", name, send }),
  );
  const message: WorkMessage = {
    content: "Fix the build",
    access: {
      userId,
      roleIds: [],
      guildId: "guild",
      channelId: "work-channel",
      isBot: false,
      isDm: false,
    },
    startThread,
  };
  return { directory, manager, message, startThread, send };
}

describe("work-channel messages", () => {
  it("creates a public thread, persists its job mapping, and sends the fake final reply", async () => {
    const context = await fixture();

    const result = await handleWorkMessage(policy, context.message, {
      jobs: context.manager,
      runner: new FakeRunner({ chunks: ["Working..."], final: "Fixed." }),
      workspaceRoot: "/workspaces",
      sessionRoot: "/sessions",
      createJobId: () => "job-1",
      now: () => new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result).toEqual({ handled: true, jobId: "job-1" });
    expect(context.startThread).toHaveBeenCalledWith("job-1-fix-the-build");
    expect(context.manager.findByThreadId("thread-1")).toMatchObject({
      id: "job-1",
      threadName: "job-1-fix-the-build",
      status: "completed",
      sessionPath: "/sessions/job-1",
      workspacePath: "/workspaces/job-1",
      requesterId: "worker",
      guildId: "guild",
      channelId: "work-channel",
      threadId: "thread-1",
    });
    expect(context.send.mock.calls).toEqual([["Working..."], ["Fixed."]]);
    await rm(context.directory, { recursive: true, force: true });
  });

  it("ignores unauthorized messages without creating a thread or job", async () => {
    const context = await fixture("stranger");

    const result = await handleWorkMessage(policy, context.message, {
      jobs: context.manager,
      runner: new FakeRunner(),
      workspaceRoot: "/workspaces",
      sessionRoot: "/sessions",
      createJobId: () => "job-1",
    });

    expect(result).toEqual({ handled: false });
    expect(context.startThread).not.toHaveBeenCalled();
    expect(context.manager.list()).toEqual([]);
    await rm(context.directory, { recursive: true, force: true });
  });
});
