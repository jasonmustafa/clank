import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { DiscordInputAttachment, TaskAttachmentBridge } from "./attachments.js";
import type { PersistedTask, PersistedTaskState, TaskStore } from "./task-store.js";

export type DiscordLocation = "dm" | "guild";
export interface DiscordRequest { id: string; userId: string; channelId: string; threadId: string | null; guildId: string | null; location: DiscordLocation; content: string; attachments: readonly DiscordInputAttachment[]; authorIsBot: boolean; webhookId: string | null; }
export type PiProgress = { kind: "text"; text: string } | { kind: "tool"; name: string; status: "started" | "completed" };
export interface DiscordTransport { createThread(requestId: string, name: string): Promise<string>; send(channelId: string, content: string, options?: { kind?: "preview" | "status" | "final"; files?: readonly string[] }): Promise<void>; updatePreview(channelId: string, content: string): Promise<void>; setTyping(channelId: string, active: boolean): Promise<void>; }
export interface SuperuserPiSession { prompt(prompt: string, images?: readonly ImageContent[], onProgress?: (event: PiProgress) => void): Promise<string>; followUp(prompt: string, images?: readonly ImageContent[]): Promise<void>; steer(prompt: string, images?: readonly ImageContent[]): Promise<void>; stop(): Promise<void>; compact(): Promise<void>; status(): { busy: boolean; queued: number; sessionId: string }; dispose(): Promise<void>; }
export interface SuperuserPiFactory { create(options: { taskId: string; cwd: string; sessionId?: string }): Promise<SuperuserPiSession>; }
export interface SuperuserRoutingPolicy { superuserIds: readonly string[]; privateChannelIds: readonly string[]; defaultWorkingDirectoryAlias: string; workingDirectories: Readonly<Record<string, string>>; }
export type RouteResult = { kind: "ignored" } | { kind: "accepted" | "completed"; taskId: string };
interface Task { record: PersistedTask; session: SuperuserPiSession | undefined; generation: number; running: boolean; }

export class SuperuserRequestRouter {
  readonly #tasks = new Map<string, Task>(); readonly #policy: SuperuserRoutingPolicy; readonly #discord: DiscordTransport; readonly #pi: SuperuserPiFactory; readonly #store: TaskStore | undefined; readonly #attachments: TaskAttachmentBridge | undefined;
  #state: PersistedTaskState = { version: 1, tasks: [], approvals: [] }; #initializePromise?: Promise<void>; #accepting = true; #shuttingDown = false; #saveQueue = Promise.resolve(); readonly #activeRuns = new Set<Promise<RouteResult>>();
  constructor(policy: SuperuserRoutingPolicy, discord: DiscordTransport, pi: SuperuserPiFactory, store?: TaskStore, attachments?: TaskAttachmentBridge) { this.#policy = policy; this.#discord = discord; this.#pi = pi; this.#store = store; this.#attachments = attachments; }

  initialize(): Promise<void> { return this.#initializePromise ??= this.#initialize(); }
  async #initialize(): Promise<void> {
    if (this.#store === undefined) return;
    this.#state = await this.#store.load(); const notices: PersistedTask[] = [];
    for (const record of this.#state.tasks) {
      if (record.lifecycleState === "active") { record.lifecycleState = "interrupted"; record.recoveryNoticePending = true; record.updatedAt = new Date().toISOString(); }
      if (record.recoveryNoticePending === true) notices.push(record);
      this.#tasks.set(record.threadId, { record, session: undefined, generation: 0, running: false });
    }
    for (const approval of this.#state.approvals) if (approval.status === "pending") approval.status = "expired";
    await this.#persist();
    for (const record of notices) { await this.#discord.send(record.threadId, `Task ${record.id} was interrupted by a restart. Reply here to resume saved Pi session ${record.piSessionId}.`, { kind: "status" }); record.recoveryNoticePending = false; await this.#persist(); }
  }

  async route(request: DiscordRequest): Promise<RouteResult> {
    await this.initialize(); if (!this.#accepting || !this.#isAuthorized(request) || (request.content.trim() === "" && request.attachments.length === 0)) return { kind: "ignored" };
    const taskChannelId = request.threadId ?? (request.location === "dm" ? request.channelId : undefined); const existing = taskChannelId === undefined ? undefined : this.#tasks.get(taskChannelId);
    if (existing !== undefined) return this.#continue(existing, request); if (request.threadId !== null) return { kind: "ignored" };
    const selection = selectWorkingDirectory(request.content.trim() === "" ? "Review the attached files." : request.content, this.#policy);
    if (selection.error !== undefined) { await this.#discord.send(request.channelId, selection.error, { kind: "status" }); return { kind: "ignored" }; }
    const threadId = request.location === "guild" ? await this.#discord.createThread(request.id, makeTaskThreadName(request.id, selection.prompt)) : request.channelId;
    let session: SuperuserPiSession; try { session = await this.#pi.create({ taskId: request.id, cwd: selection.path }); } catch (error) { await this.#discord.send(threadId, `Could not start task: ${error instanceof Error ? error.message : String(error)}`, { kind: "status" }); throw error; }
    const now = new Date().toISOString(); const record: PersistedTask = { id: request.id, requesterId: request.userId, threadId, capabilityMode: "superuser", workingDirectory: selection.path, lifecycleState: "idle", createdAt: now, updatedAt: now, piSessionId: session.status().sessionId };
    const task: Task = { record, session, generation: 0, running: false }; this.#tasks.set(threadId, task); this.#state.tasks.push(record); await this.#persist(); return this.#startRun(task, selection.prompt, request);
  }

  async shutdown(): Promise<void> {
    this.#accepting = false; this.#shuttingDown = true; await this.initialize();
    for (const task of this.#tasks.values()) if (task.session !== undefined && (task.running || task.session.status().busy)) { task.record.lifecycleState = "interrupted"; task.record.recoveryNoticePending = true; await task.session.stop(); }
    await Promise.allSettled(this.#activeRuns);
    for (const task of this.#tasks.values()) if (task.session !== undefined) { await task.session.dispose(); task.session = undefined; }
    for (const task of this.#tasks.values()) await this.#attachments?.cleanupTask(task.record.id);
    await this.#persist(); await this.#saveQueue;
  }

  async #session(task: Task): Promise<SuperuserPiSession> { return task.session ??= await this.#pi.create({ taskId: task.record.id, cwd: task.record.workingDirectory, sessionId: task.record.piSessionId }); }
  async #continue(task: Task, request: DiscordRequest): Promise<RouteResult> {
    if (task.record.requesterId !== request.userId) return { kind: "ignored" }; const session = await this.#session(task); const text = request.content.trim(); const [command, ...rest] = text.split(/\s+/u);
    if (command === "/status") { const state = session.status(); const alias = Object.entries(this.#policy.workingDirectories).find(([, path]) => path === task.record.workingDirectory)?.[0] ?? "custom"; await this.#discord.send(task.record.threadId, `Task ${task.record.id}: ${state.busy ? "working" : "idle"}; ${String(state.queued)} queued; session ${state.sessionId}; directory ${alias} (${task.record.workingDirectory}).`, { kind: "status" }); }
    else if (command === "/stop") { await session.stop(); task.record.lifecycleState = "stopped"; await this.#discord.send(task.record.threadId, "Stopped active work and cleared queued messages.", { kind: "status" }); }
    else if (command === "/compact") { await session.compact(); await this.#discord.send(task.record.threadId, "Session context compacted.", { kind: "status" }); }
    else if (command === "/reset") { await session.stop(); await session.dispose(); await this.#attachments?.cleanupTask(task.record.id); task.session = await this.#pi.create({ taskId: task.record.id, cwd: task.record.workingDirectory }); task.record.piSessionId = task.session.status().sessionId; task.generation += 1; await this.#discord.send(task.record.threadId, "Task session reset.", { kind: "status" }); }
    else if (command === "/steer") { const direction = rest.join(" ").trim(); if (direction === "") await this.#discord.send(task.record.threadId, "Usage: /steer <instruction>", { kind: "status" }); else { const attachment = await this.#ingest(task, request); await session.steer(direction + attachment.prompt, attachment.images); } }
    else { const attachment = await this.#ingest(task, request); if (task.running || session.status().busy) { await session.followUp((request.content.trim() || "Review the attached files.") + attachment.prompt, attachment.images); await this.#discord.send(task.record.threadId, "Queued follow-up.", { kind: "status" }); } else return this.#startRun(task, request.content.trim() || "Review the attached files.", request, attachment); }
    task.record.updatedAt = new Date().toISOString(); await this.#persist(); return { kind: "accepted", taskId: task.record.id };
  }

  #startRun(task: Task, prompt: string, request: DiscordRequest, ingested?: { prompt: string; images: readonly ImageContent[] }): Promise<RouteResult> { const run = this.#run(task, prompt, request, ingested); this.#activeRuns.add(run); void run.finally(() => this.#activeRuns.delete(run)).catch(() => undefined); return run; }
  async #run(task: Task, prompt: string, request: DiscordRequest, supplied?: { prompt: string; images: readonly ImageContent[] }): Promise<RouteResult> {
    const attachment = supplied ?? await this.#ingest(task, request); const session = await this.#session(task); const generation = task.generation; task.running = true; task.record.lifecycleState = "active"; task.record.updatedAt = new Date().toISOString(); await this.#persist(); await this.#discord.setTyping(task.record.threadId, true); let preview = ""; let previewUpdate = Promise.resolve();
    try { const response = await session.prompt(prompt + attachment.prompt, attachment.images, (event) => { if (event.kind === "text") { preview += event.text; previewUpdate = previewUpdate.then(() => this.#discord.updatePreview(task.record.threadId, preview.slice(-1_500))).catch(() => undefined); } else previewUpdate = previewUpdate.then(() => this.#discord.send(task.record.threadId, `${event.status === "started" ? "Running" : "Finished"} ${event.name}`, { kind: "status" })).catch(() => undefined); }); await previewUpdate; if (task.generation === generation) { const files = this.#attachments?.outputFor(task.record.id).take() ?? []; try { await this.#discord.send(task.record.threadId, response || "Task completed without text output.", { kind: "final", files }); } finally { await this.#attachments?.cleanupFiles(files); } } return { kind: "completed", taskId: task.record.id }; }
    finally { await this.#attachments?.cleanupInputs(task.record.id); task.running = false; task.record.lifecycleState = this.#shuttingDown ? "interrupted" : "idle"; if (this.#shuttingDown) task.record.recoveryNoticePending = true; else delete task.record.recoveryNoticePending; task.record.piSessionId = session.status().sessionId; task.record.updatedAt = new Date().toISOString(); await this.#persist(); await this.#discord.setTyping(task.record.threadId, false); }
  }
  async #ingest(task: Task, request: DiscordRequest): Promise<{ prompt: string; images: readonly ImageContent[] }> { if (this.#attachments === undefined || request.attachments.length === 0) return { prompt: "", images: [] }; const result = await this.#attachments.ingest(task.record.id, request.id, request.attachments); for (const error of result.errors) await this.#discord.send(task.record.threadId, `Attachment rejected: ${error}`, { kind: "status" }); return { prompt: result.prompt, images: result.images }; }
  #persist(): Promise<void> { const store = this.#store; if (store === undefined) return Promise.resolve(); this.#saveQueue = this.#saveQueue.then(() => store.save(structuredClone(this.#state))); return this.#saveQueue; }
  #isAuthorized(request: DiscordRequest): boolean { if (request.authorIsBot || request.webhookId !== null || !this.#policy.superuserIds.includes(request.userId)) return false; return request.location === "dm" ? request.guildId === null : request.guildId !== null && (request.threadId !== null || this.#policy.privateChannelIds.includes(request.channelId)); }
}
function selectWorkingDirectory(content: string, policy: SuperuserRoutingPolicy): { path: string; prompt: string; error?: string } {
  const match = /^\/in(?:\s+(\S+))?(?:\s+([\s\S]*))?$/u.exec(content.trim());
  const alias = match?.[1] ?? policy.defaultWorkingDirectoryAlias;
  const path = Object.hasOwn(policy.workingDirectories, alias) ? policy.workingDirectories[alias] : undefined;
  if (match !== null && (match[1] === undefined || (match[2] ?? "").trim() === "")) return { path: "", prompt: "", error: "Usage: /in <working-directory-alias> <task>" };
  if (path === undefined) return { path: "", prompt: "", error: `Unknown working-directory alias '${alias}'. Configured aliases: ${Object.keys(policy.workingDirectories).join(", ")}.` };
  return { path, prompt: match?.[2]?.trim() ?? content };
}

export function makeTaskThreadName(taskId: string, content: string): string { const shortId = createHash("sha256").update(taskId).digest("hex").slice(0, 8); const concise = content.trim().split(/\s+/u).slice(0, 12).join(" "); const summary = concise.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "") || "task"; const suffix = ` — ${shortId}`; return `${summary.slice(0, 100 - suffix.length)}${suffix}`; }
