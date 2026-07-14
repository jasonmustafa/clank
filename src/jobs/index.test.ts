import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager, JobStore, type Job } from "./index.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clank-jobs-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    profile: "normal",
    threadName: "job-1-fix-the-build",
    status: "running",
    sessionPath: "/sessions/job-1",
    workspacePath: "/workspaces/job-1",
    requesterId: "worker",
    guildId: "guild",
    channelId: "work-channel",
    threadId: "thread-1",
    createdAt: "2026-07-12T10:00:00.000Z",
    updatedAt: "2026-07-12T10:00:00.000Z",
    ...overrides,
  };
}

describe("JobStore", () => {
  it("atomically persists all job and Discord mapping fields", async () => {
    const directory = await temporaryDirectory();
    const store = new JobStore(directory);

    await store.save([job()]);

    await expect(store.load()).resolves.toEqual([job()]);
    expect(JSON.parse(await readFile(join(directory, "jobs.json"), "utf8"))).toEqual({ version: 1, jobs: [job()] });
    expect(await readdir(directory)).toEqual(["jobs.json"]);
  });
});

describe("JobManager", () => {
  it("maps a created thread to its job", async () => {
    const manager = await JobManager.open(new JobStore(await temporaryDirectory()));
    await manager.create(job());

    expect(manager.findByThreadId("thread-1")).toEqual(job());
  });

  it("serializes concurrent changes so an older atomic write cannot replace newer state", async () => {
    const directory = await temporaryDirectory();
    let releaseFirstWrite: () => void = () => undefined;
    const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    class ControlledStore extends JobStore {
      writesStarted = 0;

      override async save(jobs: readonly Job[]): Promise<void> {
        this.writesStarted += 1;
        if (this.writesStarted === 1) await firstWriteGate;
        await super.save(jobs);
      }
    }
    const store = new ControlledStore(directory);
    const manager = await JobManager.open(store);

    const first = manager.create(job());
    const second = manager.create(job({ id: "job-2", threadId: "thread-2" }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.writesStarted).toBe(1);
    releaseFirstWrite();
    await Promise.all([first, second]);
    expect((await store.load()).map(({ id }) => id)).toEqual(["job-1", "job-2"]);
  });

  it("reloads jobs and marks running jobs interrupted", async () => {
    const directory = await temporaryDirectory();
    const store = new JobStore(directory);
    await store.save([job(), job({ id: "done", threadId: "thread-2", status: "completed" })]);

    const manager = await JobManager.open(store, () => new Date("2026-07-12T11:00:00.000Z"));

    expect(manager.findByThreadId("thread-1")?.status).toBe("interrupted");
    expect(manager.findByThreadId("thread-1")?.updatedAt).toBe("2026-07-12T11:00:00.000Z");
    expect(manager.findByThreadId("thread-2")?.status).toBe("completed");
    expect(manager.recoveredJobs().map(({ id }) => id)).toEqual(["job-1"]);
    await expect(store.load()).resolves.toEqual(manager.list());
  });
});
