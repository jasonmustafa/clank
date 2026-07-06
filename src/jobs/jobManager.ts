import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AttachmentBuilder,
  Message,
  type MessageCreateOptions,
  ThreadAutoArchiveDuration,
} from "discord.js";
import type { Attachment } from "discord.js";
import type { ClankConfig } from "../config/env.js";
import { downloadDiscordAttachments, formatAttachmentPrompt } from "../attachments/attachments.js";
import { chunkText, previewText } from "../format/chunk.js";
import { formatError, formatJobTitle, formatToolStatus, NO_MENTIONS, sendChunked, type SendableChannel } from "../format/discord.js";
import { ConfirmationManager } from "../safety/confirmation.js";
import { SdkPiRunner } from "../pi/sdkRunner.js";
import { ContainerRpcRunner, MicroVmRpcRunner, RpcPiRunner } from "../pi/rpcRunner.js";
import type { PiPromptRequest, PiRunner, PiRunnerEvent } from "../pi/runner.js";
import { JobStore, type JobRecord, type JobStatus } from "./jobStore.js";
import { determineJobTarget, jobKindDescription } from "./jobTarget.js";
import { newId } from "../utils/ids.js";
import { isAllowedByRoots, uniqueResolvedPaths } from "../safety/pathProtection.js";

interface ActiveJob {
  record: JobRecord;
  runner: PiRunner;
  channel: SendableChannel;
  unsubscribe: () => void;
  previewMessage?: Message;
  previewText: string;
  toolLines: string[];
  flushTimer?: NodeJS.Timeout;
}

export interface CreateJobOptions {
  ownerUserId: string;
  guildId?: string;
  sourceMessage: Message;
  initialText: string;
}

function summarizeAllowedRoots(roots: readonly string[], max = 3): string {
  const shown = roots.slice(0, max).map((root) => `\`${root}\``).join(", ");
  const more = roots.length > max ? ` (+${roots.length - max} more)` : "";
  return `${shown}${more}`;
}

export class JobManager {
  private readonly active = new Map<string, ActiveJob>();

  constructor(
    private readonly config: ClankConfig,
    private readonly store: JobStore,
    private readonly confirmations: ConfirmationManager,
  ) {}

  async init(): Promise<void> {
    await this.store.load();
    await mkdir(this.config.piAgentDir, { recursive: true });
    await mkdir(this.config.workspaceRoot, { recursive: true });
    await mkdir(this.config.piSessionDir, { recursive: true });
    await mkdir(this.config.tempDir, { recursive: true });
  }

  get storeView(): JobStore {
    return this.store;
  }

  findRecordByThread(threadId: string): JobRecord | undefined {
    return this.store.findByThread(threadId);
  }

  async createJob(options: CreateJobOptions): Promise<JobRecord> {
    const id = newId("job");
    const title = formatJobTitle(options.initialText);
    const workspaceDir = join(this.config.workspaceRoot, id);
    await mkdir(workspaceDir, { recursive: true });
    const target = determineJobTarget(options.initialText, this.config);
    const cwd = this.safeCwd(target.cwd || workspaceDir, workspaceDir);

    const thread = await this.tryCreateThread(options.sourceMessage, title);
    const channel = thread ?? (options.sourceMessage.channel as SendableChannel);
    const now = new Date().toISOString();
    const record: JobRecord = {
      id,
      title,
      ownerUserId: options.ownerUserId,
      guildId: options.guildId,
      channelId: channel.id,
      threadId: thread?.id,
      createdAt: now,
      updatedAt: now,
      workspaceDir,
      cwd,
      kind: target.kind,
      status: "idle",
      runnerKind: this.config.defaultRunner,
    };
    await this.store.upsert(record);

    const job = await this.activate(record, channel);
    await job.channel.send({
      content: [
        `🛠️ Created job \`${record.id}\`: **${record.title}** (${jobKindDescription(record.kind)})`,
        `Cwd: \`${record.cwd}\``,
        `Allowed roots: ${summarizeAllowedRoots(this.allowedRootsForWorkspace(record.workspaceDir))}`,
      ].join("\n"),
      allowedMentions: NO_MENTIONS,
    });
    await this.sendToJob(record.id, options.initialText, options.sourceMessage.attachments.values(), "immediate");
    return record;
  }

  async sendToJob(
    jobId: string,
    text: string,
    attachments: Iterable<Attachment> = [],
    behavior: PiPromptRequest["behavior"] = "immediate",
    channel?: SendableChannel,
  ): Promise<void> {
    const job = await this.getOrActivate(jobId, channel);
    const attachmentDir = join(job.record.workspaceDir, "attachments");
    const downloaded = await downloadDiscordAttachments(attachments, { dir: attachmentDir, maxBytes: this.config.maxAttachmentBytes });
    const promptText = `${text.trim()}${formatAttachmentPrompt(downloaded)}`.trim();
    const images = downloaded.flatMap((file) => (file.image ? [file.image] : []));
    const state = job.runner.getState();
    const effectiveBehavior = behavior === "immediate" && state.isStreaming ? "followUp" : behavior;

    if (effectiveBehavior === "followUp" && state.isStreaming) {
      await job.channel.send({ content: "📥 Queued as a follow-up for this job.", allowedMentions: NO_MENTIONS });
    }
    if (effectiveBehavior === "steer") {
      await job.channel.send({ content: "🕹️ Steering message queued for the active turn.", allowedMentions: NO_MENTIONS });
    }

    this.setStatus(job, state.isStreaming ? "queued" : "busy");
    void this.runPrompt(job, { text: promptText, images, behavior: effectiveBehavior }).catch(async (error) => {
      this.setStatus(job, "error");
      await sendChunked(job.channel, `Clank runner error: ${formatError(error)}`);
    });
  }

  async stopJob(jobId: string, channel?: SendableChannel): Promise<void> {
    const job = await this.getOrActivate(jobId, channel);
    this.confirmations.clearJob(jobId);
    await job.runner.abort();
    this.setStatus(job, "stopped");
    await job.channel.send({ content: "🛑 Stopped active job turn.", allowedMentions: NO_MENTIONS });
  }

  async compactJob(jobId: string, instructions?: string, channel?: SendableChannel): Promise<void> {
    const job = await this.getOrActivate(jobId, channel);
    await job.channel.send({ content: "🧹 Starting Pi compaction…", allowedMentions: NO_MENTIONS });
    const result = await job.runner.compact(instructions);
    const summary = result ? `Compaction complete. Tokens before: ${result.tokensBefore}; estimated after: ${result.estimatedTokensAfter}.` : "Compaction complete.";
    await job.channel.send({ content: summary, allowedMentions: NO_MENTIONS });
  }

  async newSession(jobId: string, channel?: SendableChannel): Promise<void> {
    const job = await this.getOrActivate(jobId, channel);
    await job.runner.newSession();
    job.record.sessionFile = job.runner.getState().sessionFile;
    job.record.updatedAt = new Date().toISOString();
    await this.store.upsert(job.record);
    await job.channel.send({ content: "🆕 Started a fresh Pi session for this job.", allowedMentions: NO_MENTIONS });
  }

  async status(jobId?: string, channel?: SendableChannel): Promise<string> {
    if (!jobId) {
      const jobs = this.store.list(5);
      if (jobs.length === 0) return "No jobs yet.";
      return jobs.map((job) => this.formatJobLine(job)).join("\n");
    }
    const job = await this.getOrActivate(jobId, channel);
    const state = await job.runner.getStatus();
    const allowedRoots = state.allowedRoots ?? this.allowedRootsForWorkspace(job.record.workspaceDir);
    return [
      `Job: ${job.record.id} (${job.record.status})`,
      `Title: ${job.record.title}`,
      `Runner: ${state.runnerKind}`,
      `Model: ${state.model ?? "unknown"}`,
      `Session: ${state.sessionFile ?? "not persisted"}`,
      `Kind: ${jobKindDescription(job.record.kind)}`,
      `Cwd: ${state.cwd}`,
      `Allowed roots: ${summarizeAllowedRoots(allowedRoots)}`,
      `Queue: ${state.pendingMessageCount}`,
    ].join("\n");
  }

  listJobs(limit = 10): string {
    const jobs = this.store.list(limit);
    if (jobs.length === 0) return "No jobs yet.";
    return jobs.map((job) => this.formatJobLine(job)).join("\n");
  }

  private formatJobLine(job: JobRecord): string {
    return `\`${job.id}\` ${job.status.padEnd(7)} ${jobKindDescription(job.kind)} — ${job.title}${job.threadId ? ` (thread ${job.threadId})` : ""}`;
  }

  private async runPrompt(job: ActiveJob, request: PiPromptRequest): Promise<void> {
    await this.ensurePreview(job, "🤖 Clank is working…");
    await job.runner.prompt(request);
    const state = job.runner.getState();
    job.record.sessionFile = state.sessionFile;
    job.record.updatedAt = new Date().toISOString();
    if (!state.isStreaming && job.record.status !== "stopped") job.record.status = "idle";
    await this.store.upsert(job.record);
  }

  private async activate(record: JobRecord, channel: SendableChannel): Promise<ActiveJob> {
    await this.ensureRecordCwdAllowed(record);
    const runner = await this.createRunner(record);
    const job: ActiveJob = { record, runner, channel, unsubscribe: () => undefined, previewText: "", toolLines: [] };
    job.unsubscribe = runner.onEvent((event) => void this.handleRunnerEvent(job, event));
    this.active.set(record.id, job);
    return job;
  }

  private async getOrActivate(jobId: string, channel?: SendableChannel): Promise<ActiveJob> {
    const existing = this.active.get(jobId);
    if (existing) {
      if (channel) existing.channel = channel;
      return existing;
    }
    const record = this.store.get(jobId);
    if (!record) throw new Error(`Unknown job: ${jobId}`);
    if (!channel) throw new Error(`Job ${jobId} is not active and no Discord channel was provided to restore it`);
    return this.activate(record, channel);
  }

  private allowedRootsForWorkspace(workspaceDir: string): string[] {
    return uniqueResolvedPaths([workspaceDir, ...this.config.allowedRootDirs]);
  }

  private safeCwd(targetCwd: string, workspaceDir: string): string {
    const fallback = resolve(workspaceDir);
    const candidate = resolve(targetCwd || workspaceDir);
    const allowedRoots = this.allowedRootsForWorkspace(workspaceDir);
    return isAllowedByRoots(candidate, allowedRoots) ? candidate : fallback;
  }

  private async ensureRecordCwdAllowed(record: JobRecord): Promise<void> {
    const cwd = this.safeCwd(record.cwd, record.workspaceDir);
    if (record.cwd === cwd) return;
    record.cwd = cwd;
    record.updatedAt = new Date().toISOString();
    await this.store.upsert(record);
  }

  private async createRunner(record: JobRecord): Promise<PiRunner> {
    const requestConfirmation = async (title: string, message: string): Promise<boolean> => {
      const job = this.active.get(record.id);
      const channel = job?.channel;
      if (!channel) return false;
      const pending = this.confirmations.create(record.id, title, message, this.config.destructiveConfirmTimeoutMs);
      await channel.send({
        content: `⚠️ **Confirmation required** (${pending.code})\n${title}\n\n${previewText(message, 1200)}\n\nReply \`confirm ${pending.code}\` or \`deny ${pending.code}\` within ${Math.round(this.config.destructiveConfirmTimeoutMs / 1000)}s.`,
        allowedMentions: NO_MENTIONS,
      });
      return pending.promise;
    };

    if (record.runnerKind === "sdk") {
      return SdkPiRunner.create({
        jobId: record.id,
        cwd: record.cwd,
        workspaceDir: record.workspaceDir,
        kind: record.kind,
        config: this.config,
        sessionFile: record.sessionFile,
        requestConfirmation,
      });
    }
    if (record.runnerKind === "rpc") return new RpcPiRunner(record.cwd);
    if (record.runnerKind === "container-rpc") return new ContainerRpcRunner(record.cwd);
    return new MicroVmRpcRunner(record.cwd);
  }

  private async handleRunnerEvent(job: ActiveJob, event: PiRunnerEvent): Promise<void> {
    if (event.type === "text_delta") {
      job.previewText = event.text;
      this.schedulePreviewFlush(job);
      return;
    }

    if (event.type === "tool_status") {
      job.toolLines.push(formatToolStatus(event.toolName, event.status));
      job.toolLines = job.toolLines.slice(-5);
      this.schedulePreviewFlush(job);
      return;
    }

    if (event.type === "queue_update") {
      if (event.followUp.length + event.steering.length > 0) this.setStatus(job, "queued");
      return;
    }

    if (event.type === "file_ready") {
      await this.sendFile(job, event.path, event.fileName, event.description);
      return;
    }

    if (event.type === "final") {
      await this.finalizePreview(job, event.stopReason === "error" ? "⚠️ Clank hit an error." : "✅ Clank finished.");
      if (event.stopReason === "aborted") return;
      if (event.errorMessage) {
        await sendChunked(job.channel, `Pi error: ${event.errorMessage}`);
      }
      if (event.text.trim().length > 0) {
        await sendChunked(job.channel, event.text);
      }
      if (job.record.status !== "stopped") this.setStatus(job, "idle");
    }
  }

  private async sendFile(job: ActiveJob, path: string, fileName: string, description?: string): Promise<void> {
    const options: MessageCreateOptions = {
      content: description ? previewText(description, 500) : `File from Clank: ${fileName}`,
      files: [new AttachmentBuilder(path, { name: fileName })],
      allowedMentions: NO_MENTIONS,
    };
    await job.channel.send(options);
  }

  private setStatus(job: ActiveJob, status: JobStatus): void {
    job.record.status = status;
    job.record.updatedAt = new Date().toISOString();
    void this.store.upsert(job.record);
  }

  private async ensurePreview(job: ActiveJob, initialContent: string): Promise<void> {
    if (job.previewMessage) return;
    job.previewText = "";
    job.toolLines = [];
    job.previewMessage = await job.channel.send({ content: initialContent, allowedMentions: NO_MENTIONS });
  }

  private schedulePreviewFlush(job: ActiveJob): void {
    if (job.flushTimer) return;
    job.flushTimer = setTimeout(() => {
      job.flushTimer = undefined;
      void this.flushPreview(job);
    }, this.config.previewThrottleMs);
  }

  private previewContent(job: ActiveJob, status = "🤖 Clank is working…", includeText = true): string {
    const tools = job.toolLines.length > 0 ? `${job.toolLines.join("  ")}\n\n` : "";
    const text = includeText
      ? job.previewText.trim().length > 0
        ? previewText(job.previewText.trim(), 1600)
        : "_Waiting for Pi output…_"
      : "";
    return chunkText(`${status}\n${tools}${text}`.trim(), 1900)[0] ?? status;
  }

  private async flushPreview(job: ActiveJob): Promise<void> {
    if (!job.previewMessage) return;
    await job.previewMessage.edit({ content: this.previewContent(job), allowedMentions: NO_MENTIONS }).catch(() => undefined);
  }

  private async finalizePreview(job: ActiveJob, status: string): Promise<void> {
    if (job.flushTimer) {
      clearTimeout(job.flushTimer);
      job.flushTimer = undefined;
    }
    if (!job.previewMessage) return;
    await job.previewMessage.edit({ content: this.previewContent(job, status, false), allowedMentions: NO_MENTIONS }).catch(() => undefined);
    job.previewMessage = undefined;
    job.previewText = "";
    job.toolLines = [];
  }

  private async tryCreateThread(message: Message, title: string): Promise<SendableChannel | undefined> {
    if (!message.guild || !message.channel.isTextBased() || message.channel.isDMBased() || message.channel.isThread()) return undefined;
    try {
      return (await message.startThread({
        name: `Clank: ${title}`.slice(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: "Clank job thread",
      })) as SendableChannel;
    } catch (error) {
      console.error("clank-thread-create-debug", {
        messageId: message.id,
        channelId: message.channel.id,
        guildId: message.guildId,
        title,
        error: formatError(error),
      });
      return undefined;
    }
  }
}
