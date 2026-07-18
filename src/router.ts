import { createHash, randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { DiscordInputAttachment, TaskAttachmentBridge } from "./attachments.js";
import type { PersistedApproval, PersistedTask, PersistedTaskState, TaskStore } from "./task-store.js";

export type DiscordLocation = "dm" | "guild";
export interface DiscordRequest { id: string; userId: string; channelId: string; threadId: string | null; guildId: string | null; location: DiscordLocation; content: string; attachments: readonly DiscordInputAttachment[]; authorIsBot: boolean; webhookId: string | null; replyToMessageId: string | null; mentionsApplication: boolean; }
export type PiProgress = { kind: "text"; text: string } | { kind: "tool"; name: string; status: "started" | "completed" };
export interface DiscordTransport { createThread(requestId: string, name: string): Promise<string>; send(channelId: string, content: string, options?: { kind?: "preview" | "status" | "final"; files?: readonly string[]; approval?: { id: string; taskId: string; command: string } }): Promise<string | undefined>; updatePreview(channelId: string, content: string): Promise<void>; setTyping(channelId: string, active: boolean): Promise<void>; }
export interface SuperuserPiSession { prompt(prompt: string, images?: readonly ImageContent[], onProgress?: (event: PiProgress) => void): Promise<string>; followUp(prompt: string, images?: readonly ImageContent[]): Promise<void>; steer(prompt: string, images?: readonly ImageContent[]): Promise<void>; stop(): Promise<void>; compact(): Promise<void>; status(): { busy: boolean; queued: number; sessionId: string }; dispose(): Promise<void>; }
export interface SuperuserPiFactory { create(options: { taskId: string; cwd: string; sessionId?: string; confirmCommand?: (command: string) => Promise<boolean> }): Promise<SuperuserPiSession>; }
export interface ApprovalPolicy { expiresMs: number; destructiveConfirmation: boolean; restartCommand: string | null; privilegedExecution: "disabled" | "approval-required"; }
export interface SuperuserRoutingPolicy { superuserIds: readonly string[]; privateChannelIds: readonly string[]; defaultWorkingDirectoryAlias: string; workingDirectories: Readonly<Record<string, string>>; approvals?: ApprovalPolicy; }
export interface ApprovalDecision { approvalId: string; taskId: string; command: string; userId: string; decision: "approve" | "deny"; }
export type RouteResult = { kind: "ignored" } | { kind: "accepted" | "completed"; taskId: string };
interface Task { record: PersistedTask; session: SuperuserPiSession | undefined; generation: number; running: boolean; continuationQueue: Promise<void>; }

export class SuperuserRequestRouter {
  readonly #tasks = new Map<string, Task>(); readonly #policy: SuperuserRoutingPolicy; readonly #discord: DiscordTransport; readonly #pi: SuperuserPiFactory; readonly #store: TaskStore | undefined; readonly #attachments: TaskAttachmentBridge | undefined;
  #state: PersistedTaskState = { version: 1, tasks: [], approvals: [] }; #initializePromise?: Promise<void>; #accepting = true; #shuttingDown = false; #saveQueue = Promise.resolve(); readonly #activeRuns = new Set<Promise<RouteResult>>(); readonly #approvalWaiters = new Map<string, (approved: boolean) => void>();
  constructor(policy: SuperuserRoutingPolicy, discord: DiscordTransport, pi: SuperuserPiFactory, store?: TaskStore, attachments?: TaskAttachmentBridge, readonly now: () => number = Date.now) { this.#policy = policy; this.#discord = discord; this.#pi = pi; this.#store = store; this.#attachments = attachments; }

  initialize(): Promise<void> { return this.#initializePromise ??= this.#initialize(); }
  async #initialize(): Promise<void> {
    if (this.#store === undefined) return;
    this.#state = await this.#store.load(); const notices: PersistedTask[] = [];
    for (const record of this.#state.tasks) {
      if (record.lifecycleState === "active") { record.lifecycleState = "interrupted"; record.recoveryNoticePending = true; record.updatedAt = new Date().toISOString(); }
      if (record.recoveryNoticePending === true) notices.push(record);
      this.#tasks.set(record.threadId, { record, session: undefined, generation: 0, running: false, continuationQueue: Promise.resolve() });
    }
    for (const approval of this.#state.approvals) if (approval.status === "pending") { approval.status = "expired"; approval.decidedAt = new Date(this.now()).toISOString(); }
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
    let session: SuperuserPiSession; try { session = await this.#createSession({ taskId: request.id, requesterId: request.userId, threadId, cwd: selection.path }); } catch (error) { await this.#discord.send(threadId, `Could not start task: ${error instanceof Error ? error.message : String(error)}`, { kind: "status" }); throw error; }
    const now = new Date().toISOString(); const record: PersistedTask = { id: request.id, requesterId: request.userId, threadId, capabilityMode: "superuser", workingDirectory: selection.path, lifecycleState: "idle", createdAt: now, updatedAt: now, piSessionId: session.status().sessionId };
    const task: Task = { record, session, generation: 0, running: true, continuationQueue: Promise.resolve() }; this.#tasks.set(threadId, task); this.#state.tasks.push(record); await this.#persist(); return this.#startRun(task, selection.prompt, request);
  }

  async shutdown(): Promise<void> {
    this.#accepting = false; this.#shuttingDown = true; await this.initialize();
    for (const task of this.#tasks.values()) this.#cancelTaskApprovals(task.record.id, "expired");
    for (const task of this.#tasks.values()) if (task.session !== undefined && (task.running || task.session.status().busy)) { task.record.lifecycleState = "interrupted"; task.record.recoveryNoticePending = true; await task.session.stop(); }
    await Promise.allSettled(this.#activeRuns);
    for (const task of this.#tasks.values()) if (task.session !== undefined) { await task.session.dispose(); task.session = undefined; }
    for (const task of this.#tasks.values()) await this.#attachments?.cleanupTask(task.record.id);
    await this.#persist(); await this.#saveQueue;
  }

  async #session(task: Task): Promise<SuperuserPiSession> { return task.session ??= await this.#createSession({ taskId: task.record.id, requesterId: task.record.requesterId, threadId: task.record.threadId, cwd: task.record.workingDirectory, sessionId: task.record.piSessionId }); }
  #continue(task: Task, request: DiscordRequest): Promise<RouteResult> {
    let resolve!: (result: RouteResult) => void; let reject!: (error: unknown) => void;
    const result = new Promise<RouteResult>((res, rej) => { resolve = res; reject = rej; });
    task.continuationQueue = task.continuationQueue.then(async () => { try { resolve(await this.#processContinuation(task, request)); } catch (error) { reject(error); } });
    return result;
  }
  async #processContinuation(task: Task, request: DiscordRequest): Promise<RouteResult> {
    if (task.record.requesterId !== request.userId) return { kind: "ignored" }; const session = await this.#session(task); const text = request.content.trim(); const [command, ...rest] = text.split(/\s+/u);
    if (command === "/status") { const state = session.status(); const alias = Object.entries(this.#policy.workingDirectories).find(([, path]) => path === task.record.workingDirectory)?.[0] ?? "custom"; await this.#discord.send(task.record.threadId, `Task ${task.record.id}: ${state.busy ? "working" : "idle"}; ${String(state.queued)} queued; session ${state.sessionId}; directory ${alias} (${task.record.workingDirectory}).`, { kind: "status" }); }
    else if (command === "/stop") { this.#cancelTaskApprovals(task.record.id, "denied"); await session.stop(); task.record.lifecycleState = "stopped"; await this.#discord.send(task.record.threadId, "Stopped active work, cleared queued messages, and denied pending command approvals.", { kind: "status" }); }
    else if (command === "/compact") { await session.compact(); await this.#discord.send(task.record.threadId, "Session context compacted.", { kind: "status" }); }
    else if (command === "/reset") { this.#cancelTaskApprovals(task.record.id, "denied"); await session.stop(); await session.dispose(); await this.#attachments?.cleanupTask(task.record.id); task.session = await this.#createSession({ taskId: task.record.id, requesterId: task.record.requesterId, threadId: task.record.threadId, cwd: task.record.workingDirectory }); task.record.piSessionId = task.session.status().sessionId; task.generation += 1; await this.#discord.send(task.record.threadId, "Task session reset.", { kind: "status" }); }
    else if (command === "/steer") { const direction = rest.join(" ").trim(); if (direction === "") await this.#discord.send(task.record.threadId, "Usage: /steer <instruction>", { kind: "status" }); else { const attachment = await this.#ingest(task, request); await session.steer(direction + attachment.prompt, attachment.images); } }
    else { const attachment = await this.#ingest(task, request); if (task.running || session.status().busy) { await session.followUp((request.content.trim() || "Review the attached files.") + attachment.prompt, attachment.images); await this.#discord.send(task.record.threadId, "Queued follow-up.", { kind: "status" }); } else return this.#startRun(task, request.content.trim() || "Review the attached files.", request, attachment); }
    task.record.updatedAt = new Date().toISOString(); await this.#persist(); return { kind: "accepted", taskId: task.record.id };
  }

  #startRun(task: Task, prompt: string, request: DiscordRequest, ingested?: { prompt: string; images: readonly ImageContent[] }): Promise<RouteResult> { task.running = true; const run = this.#run(task, prompt, request, ingested); this.#activeRuns.add(run); void run.finally(() => { task.running = false; this.#activeRuns.delete(run); }).catch(() => undefined); return run; }
  async #run(task: Task, prompt: string, request: DiscordRequest, supplied?: { prompt: string; images: readonly ImageContent[] }): Promise<RouteResult> {
    const attachment = supplied ?? await this.#ingest(task, request); const session = await this.#session(task); const generation = task.generation; task.record.lifecycleState = "active"; task.record.updatedAt = new Date().toISOString(); await this.#persist(); await this.#discord.setTyping(task.record.threadId, true); let typing = true; const stopTyping = async () => { if (!typing) return; typing = false; await this.#discord.setTyping(task.record.threadId, false); }; let preview = ""; let previewUpdate = Promise.resolve();
    try { const response = await session.prompt(prompt + attachment.prompt, attachment.images, (event) => { if (event.kind === "text") { preview += event.text; previewUpdate = previewUpdate.then(() => this.#discord.updatePreview(task.record.threadId, preview.slice(-1_500))).catch(() => undefined); } else previewUpdate = previewUpdate.then(async () => { await this.#discord.send(task.record.threadId, `${event.status === "started" ? "Running" : "Finished"} ${event.name}`, { kind: "status" }); }).catch(() => undefined); }); await previewUpdate; if (task.generation === generation) { const files = this.#attachments?.outputFor(task.record.id).take() ?? []; try { await stopTyping(); await this.#discord.send(task.record.threadId, response || "Task completed without text output.", { kind: "final", files }); } finally { await this.#attachments?.cleanupFiles(files); } } return { kind: "completed", taskId: task.record.id }; }
    finally { await stopTyping(); await this.#attachments?.cleanupInputs(task.record.id); task.record.lifecycleState = this.#shuttingDown ? "interrupted" : "idle"; if (this.#shuttingDown) task.record.recoveryNoticePending = true; else delete task.record.recoveryNoticePending; task.record.piSessionId = session.status().sessionId; task.record.updatedAt = new Date().toISOString(); await this.#persist(); }
  }
  async #ingest(task: Task, request: DiscordRequest): Promise<{ prompt: string; images: readonly ImageContent[] }> { if (this.#attachments === undefined || request.attachments.length === 0) return { prompt: "", images: [] }; const result = await this.#attachments.ingest(task.record.id, request.id, request.attachments); for (const error of result.errors) await this.#discord.send(task.record.threadId, `Attachment rejected: ${error}`, { kind: "status" }); return { prompt: result.prompt, images: result.images }; }
  async handleApprovalAction(input: { approvalId: string; userId: string; decision: "approve" | "deny" }): Promise<"approved" | "denied" | "unauthorized" | "unavailable"> { const approval = this.#state.approvals.find(({ id }) => id === input.approvalId); if (approval === undefined) return "unavailable"; const result = await this.decideApproval({ ...input, taskId: approval.taskId, command: approval.command }); return result === "mismatch" ? "unavailable" : result; }
  async decideApproval(decision: ApprovalDecision): Promise<"approved" | "denied" | "unauthorized" | "mismatch" | "unavailable"> {
    if (!this.#policy.superuserIds.includes(decision.userId)) return "unauthorized";
    const approval = this.#state.approvals.find(({ id }) => id === decision.approvalId);
    if (approval?.status !== "pending") return "unavailable";
    if (approval.taskId !== decision.taskId || approval.command !== decision.command) return "mismatch";
    if (Date.parse(approval.expiresAt) <= this.now()) { this.#markApproval(approval, "expired"); await this.#persist(); this.#resolveApproval(approval.id, false); return "unavailable"; }
    const approved = decision.decision === "approve"; this.#markApproval(approval, approved ? "approved" : "denied"); await this.#persist(); this.#resolveApproval(approval.id, approved);
    const task = this.#state.tasks.find(({ id }) => id === approval.taskId); if (task !== undefined) await this.#discord.send(task.threadId, approved ? `Approved command for task ${task.id}. Execution resumed.` : `Denied command for task ${task.id}. It was not executed.`, { kind: "status" });
    return approved ? "approved" : "denied";
  }
  expireApprovals(): void { for (const approval of this.#state.approvals) if (approval.status === "pending" && Date.parse(approval.expiresAt) <= this.now()) { this.#markApproval(approval, "expired"); this.#resolveApproval(approval.id, false); } void this.#persist(); }
  async #createSession(options: { taskId: string; requesterId: string; threadId: string; cwd: string; sessionId?: string }): Promise<SuperuserPiSession> {
    return this.#pi.create({ taskId: options.taskId, cwd: options.cwd, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }), confirmCommand: (command) => this.#confirmCommand(options, command) });
  }
  async #confirmCommand(task: { taskId: string; requesterId: string; threadId: string; cwd: string }, command: string): Promise<boolean> {
    const policy = this.#policy.approvals; if (policy === undefined) return true;
    const privileged = /(?:^|[\s;&|])(?:[^\s;&|]*\/)?sudo(?:\s|$)/u.test(command); const restart = policy.restartCommand !== null && command === policy.restartCommand; const destructive = /(?:^|[\s;&|])(?:[^\s;&|]*\/)?(?:rm(?=[\s;&|])[^\n;&|]*(?:-[^\s;&|]*r|--recursive)|git\s+(?:[^\n;&|]+\s+)*(?:reset\s+--hard|clean\s+[^\n;&|]*-[^\s;&|]*f|push\s+[^\n;&|]*--force)|systemctl\s+(?:stop|restart)|shutdown|reboot)(?:\s|$)/u.test(command);
    if (privileged && !restart && policy.privilegedExecution === "disabled") return false;
    if (!restart && !(privileged && policy.privilegedExecution === "approval-required") && !(destructive && policy.destructiveConfirmation)) return true;
    const createdAt = new Date(this.now()).toISOString(); const approval: PersistedApproval = { id: randomUUID(), taskId: task.taskId, requesterId: task.requesterId, command, workingDirectory: task.cwd, status: "pending", createdAt, expiresAt: new Date(this.now() + policy.expiresMs).toISOString() };
    this.#state.approvals.push(approval); await this.#persist();
    const decision = new Promise<boolean>((resolve) => { this.#approvalWaiters.set(approval.id, resolve); });
    try { await this.#discord.send(task.threadId, `Command approval required:\n${command}\nTask: ${task.taskId}\nRequester: ${task.requesterId}\nWorking directory: ${task.cwd}\nExpires: ${approval.expiresAt}`, { kind: "status", approval: { id: approval.id, taskId: task.taskId, command } }); }
    catch { this.#markApproval(approval, "denied"); await this.#persist(); this.#resolveApproval(approval.id, false); return false; }
    const delay = Math.max(0, Date.parse(approval.expiresAt) - this.now()); setTimeout(() => { if (approval.status === "pending") { this.#markApproval(approval, "expired"); void this.#persist().then(() => { this.#resolveApproval(approval.id, false); return this.#discord.send(task.threadId, `Command approval expired for task ${task.taskId}. It was not executed.`, { kind: "status" }); }); } }, delay).unref(); return decision;
  }
  #markApproval(approval: PersistedApproval, status: "approved" | "denied" | "expired"): void { if (approval.status !== "pending") return; approval.status = status; approval.decidedAt = new Date(this.now()).toISOString(); }
  #resolveApproval(approvalId: string, approved: boolean): void { const waiter = this.#approvalWaiters.get(approvalId); this.#approvalWaiters.delete(approvalId); waiter?.(approved); }
  #cancelTaskApprovals(taskId: string, status: "denied" | "expired"): void { for (const approval of this.#state.approvals) if (approval.taskId === taskId && approval.status === "pending") { this.#markApproval(approval, status); this.#resolveApproval(approval.id, false); } }
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

export function makeTaskThreadName(taskId: string, content: string): string { const shortId = createHash("sha256").update(taskId).digest("hex").slice(0, 8); const request = content.trim().replace(/^(?:<@!?\d+>\s*)+/u, ""); const concise = request.split(/\s+/u).slice(0, 12).join(" "); const summary = concise.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "") || "task"; const suffix = ` · ${shortId}`; return `${summary.slice(0, 100 - suffix.length)}${suffix}`; }
