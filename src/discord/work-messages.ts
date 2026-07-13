import { join } from "node:path";
import { canAccessWork, type DiscordAccessSubject, type DiscordPolicy } from "../config/index.js";
import { type Job, type JobManager } from "../jobs/index.js";
import { type FakeRunner } from "../pi-runners/index.js";

export interface WorkThread {
  id: string;
  name: string;
  send(content: string): Promise<void>;
}

export interface WorkMessage {
  content: string;
  access: DiscordAccessSubject & { guildId: string; channelId: string };
  startThread(name: string): Promise<WorkThread>;
}

export interface WorkMessageDependencies {
  jobs: JobManager;
  runner: FakeRunner;
  workspaceRoot: string;
  sessionRoot: string;
  createJobId?: () => string;
  now?: () => Date;
}

export type WorkMessageResult = { handled: false } | { handled: true; jobId: string };

export async function handleWorkMessage(
  policy: DiscordPolicy,
  message: WorkMessage,
  dependencies: WorkMessageDependencies,
): Promise<WorkMessageResult> {
  if (message.content.trim() === "" || !canAccessWork(policy, message.access)) return { handled: false };

  const id = dependencies.createJobId?.() ?? crypto.randomUUID();
  const now = dependencies.now ?? (() => new Date());
  const threadName = makeThreadName(id, message.content);
  const thread = await message.startThread(threadName);
  const timestamp = now().toISOString();
  const job: Job = {
    id,
    threadName: thread.name,
    status: "running",
    sessionPath: join(dependencies.sessionRoot, id),
    workspacePath: join(dependencies.workspaceRoot, id),
    requesterId: message.access.userId,
    guildId: message.access.guildId,
    channelId: message.access.channelId,
    threadId: thread.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await dependencies.jobs.create(job);

  try {
    const final = await dependencies.runner.run(message.content, async (text) => thread.send(text));
    await thread.send(final);
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
