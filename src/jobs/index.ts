import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobProfile } from "../safety/index.js";

export type JobStatus = "running" | "completed" | "failed" | "interrupted" | "stopped";

export interface Job {
  id: string;
  profile: JobProfile;
  threadName: string;
  status: JobStatus;
  sessionPath: string;
  workspacePath: string;
  requesterId: string;
  guildId: string;
  channelId: string;
  threadId: string;
  createdAt: string;
  updatedAt: string;
}

interface JobState {
  version: 1;
  jobs: Job[];
}

export class JobStore {
  readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, "jobs.json");
  }

  async load(): Promise<Job[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isJobState(value)) throw new Error("Unsupported jobs state format");
      return value.jobs.map((job) => {
        const legacy = job as Omit<Job, "profile"> & { profile?: JobProfile };
        return { ...legacy, profile: legacy.profile ?? "normal" };
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async save(jobs: readonly Job[]): Promise<void> {
    const directory = join(this.path, "..");
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.path}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

function isJobState(value: unknown): value is JobState {
  return typeof value === "object"
    && value !== null
    && "version" in value
    && value.version === 1
    && "jobs" in value
    && Array.isArray(value.jobs);
}

export class JobManager {
  readonly #jobs: Map<string, Job>;
  readonly #recoveredJobIds: readonly string[];
  #operations: Promise<void> = Promise.resolve();

  private constructor(
    private readonly store: JobStore,
    jobs: readonly Job[],
    private readonly now: () => Date,
    recoveredJobIds: readonly string[] = [],
  ) {
    this.#jobs = new Map(jobs.map((job) => [job.id, job]));
    this.#recoveredJobIds = [...recoveredJobIds];
  }

  static async open(store: JobStore, now: () => Date = () => new Date()): Promise<JobManager> {
    const jobs = await store.load();
    const timestamp = now().toISOString();
    const recoveredJobIds = jobs.filter((job) => job.status === "running").map((job) => job.id);
    const recovered = jobs.map((job) => job.status === "running"
      ? { ...job, status: "interrupted" as const, updatedAt: timestamp }
      : job);
    if (recoveredJobIds.length > 0) await store.save(recovered);
    return new JobManager(store, recovered, now, recoveredJobIds);
  }

  list(): Job[] {
    return [...this.#jobs.values()];
  }

  recoveredJobs(): Job[] {
    const ids = new Set(this.#recoveredJobIds);
    return this.list().filter((job) => ids.has(job.id));
  }

  findByThreadId(threadId: string): Job | undefined {
    return this.list().find((job) => job.threadId === threadId);
  }

  async create(job: Job): Promise<void> {
    await this.enqueue(async () => {
      if (this.#jobs.has(job.id)) throw new Error(`Job ${job.id} already exists`);
      if (this.findByThreadId(job.threadId) !== undefined) throw new Error(`Thread ${job.threadId} already has a job`);
      this.#jobs.set(job.id, job);
      await this.persist(() => this.#jobs.delete(job.id));
    });
  }

  async setStatus(id: string, status: JobStatus): Promise<void> {
    const existing = this.#jobs.get(id);
    if (existing === undefined) throw new Error(`Job ${id} does not exist`);
    await this.update({ ...existing, status, updatedAt: this.now().toISOString() });
  }

  async update(job: Job): Promise<void> {
    await this.enqueue(async () => {
      const existing = this.#jobs.get(job.id);
      if (existing === undefined) throw new Error(`Job ${job.id} does not exist`);
      this.#jobs.set(job.id, job);
      await this.persist(() => this.#jobs.set(job.id, existing));
    });
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => undefined);
    await result;
  }

  private async persist(rollback: () => void): Promise<void> {
    try {
      await this.store.save(this.list());
    } catch (error) {
      rollback();
      throw error;
    }
  }
}
