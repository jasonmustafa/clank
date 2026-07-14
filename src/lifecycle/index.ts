import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Job } from "../jobs/index.js";
import type { PiRunner } from "../pi-runners/index.js";

interface PoolEntry<T extends PiRunner> { runner: T; timer: NodeJS.Timeout; }

/** An in-memory runner cache. Session files and job metadata remain after eviction. */
export class RunnerPool<T extends PiRunner = PiRunner> {
  readonly #entries = new Map<string, PoolEntry<T>>();
  constructor(
    private readonly create: (job: Job) => T,
    private readonly idleTtlMs: number,
    private readonly onDisposeError: (error: unknown, jobId: string) => void = (error, jobId) => { console.error(`Failed to dispose runner for job ${jobId}:`, error); },
  ) {
    if (!Number.isInteger(idleTtlMs) || idleTtlMs <= 0) throw new Error("Runner idle TTL must be a positive integer");
  }
  get(job: Job): T {
    const existing = this.#entries.get(job.id);
    if (existing !== undefined) { this.#schedule(job.id, existing); return existing.runner; }
    const entry = { runner: this.create(job), timer: undefined as unknown as NodeJS.Timeout };
    this.#entries.set(job.id, entry);
    this.#schedule(job.id, entry);
    return entry.runner;
  }
  peek(jobId: string): T | undefined { return this.#entries.get(jobId)?.runner; }
  async disposeAll(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    entries.forEach(({ timer }) => { clearTimeout(timer); });
    await Promise.all(entries.map(async ({ runner }) => runner.dispose()));
  }
  #schedule(jobId: string, entry: PoolEntry<T>): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.#expire(jobId, entry).catch((error: unknown) => { this.onDisposeError(error, jobId); }); }, this.idleTtlMs);
    entry.timer.unref();
  }
  async #expire(jobId: string, entry: PoolEntry<T>): Promise<void> {
    if (this.#entries.get(jobId) !== entry) return;
    if (entry.runner.status().state !== "idle") { this.#schedule(jobId, entry); return; }
    this.#entries.delete(jobId);
    await entry.runner.dispose();
  }
}

export interface CleanupOptions { workspaceRoot: string; temporaryRoot: string; retentionMs: number; now?: () => Date; }

/** Removes retained artifacts only when both status and path ownership are safe. */
export async function cleanupCompletedJobs(jobs: readonly Job[], options: CleanupOptions): Promise<string[]> {
  if (!Number.isInteger(options.retentionMs) || options.retentionMs <= 0) throw new Error("Cleanup retention must be a positive integer");
  const now = (options.now ?? (() => new Date()))().getTime();
  const removed: string[] = [];
  for (const job of jobs) {
    const updatedAt = Date.parse(job.updatedAt);
    if (job.status !== "completed" || !Number.isFinite(updatedAt) || now - updatedAt < options.retentionMs) continue;
    const workspace = join(options.workspaceRoot, "jobs", job.id);
    const temporary = join(options.temporaryRoot, job.id);
    if (job.workspacePath !== workspace || !safeChild(workspace, join(options.workspaceRoot, "jobs")) || !safeChild(temporary, options.temporaryRoot)) continue;
    await rm(workspace, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
    removed.push(job.id);
  }
  return removed;
}

function safeChild(path: string, root: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}
