import { describe, expect, it } from "vitest";
import { routeThread } from "../src/discord/threadRouter.js";
import type { JobRecord } from "../src/jobs/jobStore.js";

const record: JobRecord = {
  id: "job1",
  title: "test",
  ownerUserId: "u1",
  channelId: "dm1",
  threadId: "t1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  workspaceDir: "/opt/clank/workspaces/job1",
  cwd: "/opt/clank/workspaces/job1",
  kind: "standard",
  status: "idle",
  runnerKind: "sdk",
};

describe("routeThread", () => {
  it("routes known Discord threads to existing jobs", () => {
    const route = routeThread(
      { channelId: "t1", isThread: true, userId: "u1" },
      { findByThread: () => record, findLatestForChannel: () => undefined },
    );
    expect(route).toEqual({ type: "existing-job", jobId: "job1" });
  });

  it("routes unknown threads to a new job", () => {
    const route = routeThread(
      { channelId: "t2", isThread: true, userId: "u1" },
      { findByThread: () => undefined, findLatestForChannel: () => undefined },
    );
    expect(route).toEqual({ type: "new-job" });
  });

  it("routes non-thread channels to the latest channel job when available", () => {
    const route = routeThread(
      { channelId: "dm1", isThread: false, userId: "u1" },
      { findByThread: () => undefined, findLatestForChannel: () => record },
    );
    expect(route).toEqual({ type: "latest-channel-job", jobId: "job1" });
  });
});
