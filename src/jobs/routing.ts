import type { Job, JobStatus } from "./index.js";
import type { PiRunner } from "../pi-runners/index.js";
import type { ImageContent } from "@earendil-works/pi-ai";

export type JobChannelKind = "thread" | "dm";
export interface JobTarget { channelKind: JobChannelKind; channelId: string; userId: string; }
export interface JobMessage extends JobTarget { content: string; promptSuffix?: string; images?: readonly ImageContent[]; attachmentErrors?: readonly string[]; }
export interface ControlResult { ok: boolean; content: string; jobId?: string; messages?: readonly string[]; files?: readonly string[]; }
export type JobControl = "stop" | "steer" | "compact" | "status" | "jobs" | "new";

/** Routes Discord conversations and controls without depending on discord.js. */
export class JobController {
  readonly #jobs = new Map<string, Job>();
  readonly #runners = new Map<string, PiRunner>();

  constructor(
    jobs: readonly Job[],
    private readonly createRunner: (job: Job) => PiRunner,
    private readonly createDmJob?: (target: JobTarget) => Promise<Job>,
    private readonly saveJob: (job: Job) => Promise<void> = () => Promise.resolve(),
    private readonly takeAttachments: (job: Job) => readonly string[] = () => [],
  ) {
    for (const job of jobs) this.#jobs.set(job.id, job);
  }

  get(id: string): Job | undefined { return this.#jobs.get(id); }
  resolve(target: JobTarget): Job | undefined { return this.#resolve(target); }
  add(job: Job): void { this.#jobs.set(job.id, job); }

  async message(message: JobMessage): Promise<ControlResult> {
    let job = this.#resolve(message);
    if (job === undefined && message.channelKind === "dm" && this.createDmJob !== undefined) {
      job = await this.createDmJob(message);
      this.#jobs.set(job.id, job);
    }
    if (job === undefined) return { ok: false, content: message.channelKind === "dm" ? "Start a new DM job with `/clank new`." : "This thread is not a Clank job." };
    const runner = this.#runner(job);
    const prompt = `${message.content}${message.promptSuffix ?? ""}`;
    const explicitSteer = /^steer:\s*(.+)$/isu.exec(prompt);
    let messages: readonly string[] | undefined;
    if (explicitSteer !== null) await runner.steer(explicitSteer[1] ?? "", message.images);
    else if (runner.status().state === "running") await runner.followUp(prompt, message.images);
    else messages = await runner.prompt(prompt, message.images);
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    await this.saveJob(job);
    const errors = message.attachmentErrors ?? [];
    return messages === undefined
      ? { ok: true, content: errors.length === 0 ? "Queued." : `Queued. ${errors.join(" ")}`, jobId: job.id }
      : { ok: true, content: "Completed.", jobId: job.id, messages: [...errors, ...messages], files: this.takeAttachments(job) };
  }

  async command(command: JobControl, target: JobTarget, argument?: string): Promise<ControlResult> {
    if (command === "jobs") return { ok: true, content: this.#list(target.userId) };
    let job = this.#resolve(target);
    if (job === undefined && command === "new" && target.channelKind === "dm" && this.createDmJob !== undefined) {
      job = await this.createDmJob(target);
      this.#jobs.set(job.id, job);
      return { ok: true, content: `Started DM job ${job.id}.`, jobId: job.id };
    }
    if (job === undefined) return { ok: false, content: "No job is active here." };
    const runner = this.#runner(job);
    if (command === "status") return { ok: true, content: summary(job, runner), jobId: job.id };
    if (command === "stop") {
      runner.clearQueues();
      await runner.abort();
      job.status = "stopped";
      job.updatedAt = new Date().toISOString();
      await this.saveJob(job);
      return { ok: true, content: `Job ${job.id} stopped; queue cleared.`, jobId: job.id };
    }
    if (command === "compact") {
      if (runner.status().state !== "idle") return { ok: false, content: "Compaction requires an idle job.", jobId: job.id };
      await runner.compact(argument);
      return { ok: true, content: `Job ${job.id} compacted.`, jobId: job.id };
    }
    if (command === "steer") {
      if (argument?.trim() === undefined || argument.trim() === "") return { ok: false, content: "Provide steering instructions.", jobId: job.id };
      await runner.steer(argument.trim());
      return { ok: true, content: `Steering job ${job.id}.`, jobId: job.id };
    }
    if (runner.status().state !== "idle") return { ok: false, content: "Stop the active turn before starting a new session.", jobId: job.id };
    await runner.newSession();
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    await this.saveJob(job);
    return { ok: true, content: `Started a new session for job ${job.id}.`, jobId: job.id };
  }

  #resolve(target: JobTarget): Job | undefined {
    if (target.channelKind === "thread") return [...this.#jobs.values()].find((job) => job.threadId === target.channelId && job.requesterId === target.userId);
    return [...this.#jobs.values()]
      .filter((job) => job.guildId === "" && job.channelId === target.channelId && job.requesterId === target.userId && recent(job.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  #runner(job: Job): PiRunner {
    let runner = this.#runners.get(job.id);
    if (runner === undefined) { runner = this.createRunner(job); this.#runners.set(job.id, runner); }
    return runner;
  }

  #list(userId: string): string {
    const jobs = [...this.#jobs.values()].filter((job) => job.requesterId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return jobs.length === 0 ? "No jobs." : jobs.map((job) => summary(job, this.#runner(job))).join("\n");
  }
}

function recent(status: JobStatus): boolean { return status !== "failed" && status !== "completed"; }
function summary(job: Job, runner: PiRunner): string {
  const status = runner.status();
  return `${job.id} · ${job.status}/${status.state} · model ${status.model} · session ${status.sessionId} · queue ${String(runner.queueSize())}`;
}
