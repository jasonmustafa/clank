import { join } from "node:path";
import { canAccessWork, type DiscordAccessSubject, type DiscordPolicy } from "../config/index.js";
import { type Job, type JobManager } from "../jobs/index.js";
import { type FakeRunner } from "../pi-runners/index.js";
import { type AttachmentIngestor, type DiscordAttachment } from "../attachments/index.js";

export interface WorkThread {
  id: string;
  name: string;
  send(content: string, files?: readonly string[]): Promise<void>;
}

export interface WorkMessage {
  content: string;
  attachments?: readonly DiscordAttachment[];
  access: DiscordAccessSubject & { guildId: string; channelId: string };
  startThread(name: string): Promise<WorkThread>;
}

export interface WorkMessageDependencies {
  jobs: JobManager;
  runner: FakeRunner;
  runnerForJob?: (job: Job) => FakeRunner;
  workspaceRoot: string;
  sessionRoot: string;
  createJobId?: () => string;
  now?: () => Date;
  onJobCreated?: (job: Job) => void;
  attachmentIngestor?: AttachmentIngestor;
  takeAttachments?: (job: Job) => readonly string[];
  prepareWorkspace?: (jobId: string, request: string) => Promise<string>;
}

export type WorkMessageResult = { handled: false } | { handled: true; jobId: string };

export async function handleWorkMessage(
  policy: DiscordPolicy,
  message: WorkMessage,
  dependencies: WorkMessageDependencies,
): Promise<WorkMessageResult> {
  if ((message.content.trim() === "" && (message.attachments?.length ?? 0) === 0) || !canAccessWork(policy, message.access)) return { handled: false };

  const id = dependencies.createJobId?.() ?? crypto.randomUUID();
  const now = dependencies.now ?? (() => new Date());
  const threadName = makeThreadName(id, message.content);
  const thread = await message.startThread(threadName);
  const timestamp = now().toISOString();
  const workspacePath = dependencies.prepareWorkspace === undefined
    ? join(dependencies.workspaceRoot, id)
    : await dependencies.prepareWorkspace(id, message.content);
  const job: Job = {
    id,
    threadName: thread.name,
    status: "running",
    sessionPath: join(dependencies.sessionRoot, id),
    workspacePath,
    requesterId: message.access.userId,
    guildId: message.access.guildId,
    channelId: message.access.channelId,
    threadId: thread.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await dependencies.jobs.create(job);
  dependencies.onJobCreated?.(job);

  try {
    const runner = dependencies.runnerForJob?.(job) ?? dependencies.runner;
    const ingested = dependencies.attachmentIngestor === undefined || message.attachments === undefined
      ? undefined
      : await dependencies.attachmentIngestor.ingest(job.id, message.attachments);
    const prompt = `${message.content}${ingested?.prompt ?? ""}`;
    for (const error of ingested?.errors ?? []) await thread.send(error);
    const final = await runner.run(prompt, async (text) => thread.send(text));
    const outputFiles = dependencies.takeAttachments?.(job);
    if (outputFiles === undefined || outputFiles.length === 0) await thread.send(final);
    else await thread.send(final, outputFiles);
    await dependencies.jobs.setStatus(id, "completed");
  } catch (error) {
    await dependencies.jobs.setStatus(id, "failed");
    throw error;
  }

  return { handled: true, jobId: id };
}

export function makeThreadName(jobId: string, content: string): string {
  const summary = content.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 70);
  return `${jobId}-${summary || "work"}`.slice(0, 100);
}
