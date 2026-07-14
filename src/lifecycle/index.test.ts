import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../jobs/index.js";
import { FakePiRunner } from "../pi-runners/index.js";
import { cleanupCompletedJobs, RunnerPool } from "./index.js";

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function job(id: string, status: Job["status"] = "completed", updatedAt = "2026-01-01T00:00:00.000Z"): Job { return { id, threadName: id, status, sessionPath: `/sessions/${id}`, workspacePath: `/unused/${id}`, requesterId: "u", guildId: "g", channelId: "c", threadId: `t-${id}`, createdAt: updatedAt, updatedAt }; }

describe("RunnerPool", () => {
  it("disposes idle runners after TTL and recreates them without deleting metadata", async () => {
    vi.useFakeTimers();
    const created: FakePiRunner[] = [];
    const pool = new RunnerPool<FakePiRunner>(() => { const runner = new FakePiRunner(); created.push(runner); return runner; }, 1_000);
    expect(pool.get(job("one"))).toBe(created[0]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created[0]?.status().state).toBe("disposed");
    expect(pool.peek("one")).toBeUndefined();
    expect(pool.get(job("one"))).not.toBe(created[0]);
  });

  it("does not dispose a busy runner and starts TTL when it becomes idle", async () => {
    vi.useFakeTimers();
    const runner = new FakePiRunner();
    const pool = new RunnerPool(() => runner, 1_000);
    pool.get(job("one")); runner.setState("running");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner.status().state).toBe("running");
    runner.setState("idle");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner.status().state).toBe("disposed");
  });
});

describe("cleanupCompletedJobs", () => {
  it("removes only old completed job workspace and tmp directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "clank-cleanup-")); dirs.push(root);
    const workspaces = join(root, "workspaces"); const temporary = join(root, "tmp");
    for (const id of ["old", "active", "interrupted", "recent"]) { await mkdir(join(workspaces, "jobs", id), { recursive: true }); await mkdir(join(temporary, id), { recursive: true }); }
    const jobs = [job("old"), job("active", "running"), job("interrupted", "interrupted"), job("recent", "completed", "2026-07-13T23:30:00.000Z")]
      .map((item) => ({ ...item, workspacePath: join(workspaces, "jobs", item.id) }));
    const removed = await cleanupCompletedJobs(jobs, { workspaceRoot: workspaces, temporaryRoot: temporary, retentionMs: 60 * 60_000, now: () => new Date("2026-07-14T00:00:00.000Z") });
    expect(removed).toEqual(["old"]);
    await expect(stat(join(workspaces, "jobs", "old"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(temporary, "old"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const id of ["active", "interrupted", "recent"]) await expect(stat(join(workspaces, "jobs", id))).resolves.toBeDefined();
  });
});
