import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type JobStatus = "idle" | "busy" | "queued" | "done" | "stopped" | "error";
export type JobKind = "standard" | "self-improvement" | "pi-agent";

export interface JobRecord {
  id: string;
  title: string;
  ownerUserId: string;
  guildId?: string;
  channelId: string;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
  workspaceDir: string;
  cwd: string;
  kind: JobKind;
  sessionFile?: string;
  status: JobStatus;
  runnerKind: string;
}

interface StoreFile {
  jobs: JobRecord[];
}

export class JobStore {
  private records = new Map<string, JobRecord>();
  private loaded = false;

  constructor(private readonly stateDir: string) {}

  private get filePath(): string {
    return join(this.stateDir, "clank-jobs.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8")) as StoreFile;
      for (const record of data.jobs ?? []) {
        record.cwd ??= record.workspaceDir;
        record.kind ??= "standard";
        this.records.set(record.id, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async save(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const jobs = Array.from(this.records.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeFile(this.filePath, JSON.stringify({ jobs }, null, 2) + "\n", "utf8");
  }

  async upsert(record: JobRecord): Promise<void> {
    this.records.set(record.id, record);
    await this.save();
  }

  get(jobId: string): JobRecord | undefined {
    return this.records.get(jobId);
  }

  findByThread(threadId: string): JobRecord | undefined {
    return Array.from(this.records.values()).find((record) => record.threadId === threadId);
  }

  findLatestForChannel(channelId: string, ownerUserId: string): JobRecord | undefined {
    return Array.from(this.records.values())
      .filter((record) => record.channelId === channelId && record.ownerUserId === ownerUserId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  list(limit = 10): JobRecord[] {
    return Array.from(this.records.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }
}
