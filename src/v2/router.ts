import { createHash } from "node:crypto";

export type DiscordLocation = "dm" | "guild";
export interface DiscordRequest {
  id: string; userId: string; channelId: string; threadId: string | null; guildId: string | null;
  location: DiscordLocation; content: string; authorIsBot: boolean; webhookId: string | null;
}
export type PiProgress = { kind: "text"; text: string } | { kind: "tool"; name: string; status: "started" | "completed" };
export interface DiscordTransport {
  createThread(requestId: string, name: string): Promise<string>;
  send(channelId: string, content: string, options?: { kind?: "preview" | "status" | "final" }): Promise<void>;
  updatePreview(channelId: string, content: string): Promise<void>;
  setTyping(channelId: string, active: boolean): Promise<void>;
}
export interface SuperuserPiSession {
  prompt(prompt: string, onProgress?: (event: PiProgress) => void): Promise<string>;
  followUp(prompt: string): Promise<void>;
  steer(prompt: string): Promise<void>;
  stop(): Promise<void>;
  compact(): Promise<void>;
  status(): { busy: boolean; queued: number; sessionId: string };
  dispose(): Promise<void>;
}
export interface SuperuserPiFactory { create(options: { taskId: string; cwd: string }): Promise<SuperuserPiSession>; }
export interface SuperuserRoutingPolicy { superuserIds: readonly string[]; privateChannelIds: readonly string[]; defaultWorkingDirectory: string; }
export type RouteResult = { kind: "ignored" } | { kind: "accepted" | "completed"; taskId: string };
interface Task { id: string; ownerId: string; threadId: string; session: SuperuserPiSession; generation: number; running: boolean; }

export class SuperuserRequestRouter {
  readonly #tasks = new Map<string, Task>();
  readonly #policy: SuperuserRoutingPolicy;
  readonly #discord: DiscordTransport;
  readonly #pi: SuperuserPiFactory;
  constructor(policy: SuperuserRoutingPolicy, discord: DiscordTransport, pi: SuperuserPiFactory) {
    this.#policy = policy; this.#discord = discord; this.#pi = pi;
  }

  async route(request: DiscordRequest): Promise<RouteResult> {
    if (!this.#isAuthorized(request) || request.content.trim() === "") return { kind: "ignored" };
    const taskChannelId = request.threadId ?? (request.location === "dm" ? request.channelId : undefined);
    const existing = taskChannelId === undefined ? undefined : this.#tasks.get(taskChannelId);
    if (existing !== undefined) return this.#continue(existing, request);
    if (request.threadId !== null) return { kind: "ignored" };

    const threadId = request.location === "guild"
      ? await this.#discord.createThread(request.id, makeTaskThreadName(request.id, request.content))
      : request.channelId;
    let session: SuperuserPiSession;
    try { session = await this.#createSession(request.id); }
    catch (error) { await this.#discord.send(threadId, `Could not start task: ${error instanceof Error ? error.message : String(error)}`, { kind: "status" }); throw error; }
    const task: Task = { id: request.id, ownerId: request.userId, threadId, session, generation: 0, running: false };
    this.#tasks.set(threadId, task);
    return this.#run(task, request.content);
  }

  async #continue(task: Task, request: DiscordRequest): Promise<RouteResult> {
    if (task.ownerId !== request.userId) return { kind: "ignored" };
    const text = request.content.trim();
    const [command, ...rest] = text.split(/\s+/u);
    if (command === "/status") {
      const state = task.session.status();
      await this.#discord.send(task.threadId, `Task ${task.id}: ${state.busy ? "working" : "idle"}; ${String(state.queued)} queued; session ${state.sessionId}.`, { kind: "status" });
    } else if (command === "/stop") {
      await task.session.stop();
      await this.#discord.send(task.threadId, "Stopped active work and cleared queued messages.", { kind: "status" });
    } else if (command === "/compact") {
      await task.session.compact();
      await this.#discord.send(task.threadId, "Session context compacted.", { kind: "status" });
    } else if (command === "/reset") {
      await task.session.stop(); await task.session.dispose();
      task.session = await this.#createSession(task.id); task.generation += 1;
      await this.#discord.send(task.threadId, "Task session reset.", { kind: "status" });
    } else if (command === "/steer") {
      const direction = rest.join(" ").trim();
      if (direction === "") await this.#discord.send(task.threadId, "Usage: /steer <instruction>", { kind: "status" });
      else await task.session.steer(direction);
    } else if (task.running || task.session.status().busy) {
      await task.session.followUp(request.content);
      await this.#discord.send(task.threadId, "Queued follow-up.", { kind: "status" });
    } else {
      return this.#run(task, request.content);
    }
    return { kind: "accepted", taskId: task.id };
  }

  async #run(task: Task, prompt: string): Promise<RouteResult> {
    const generation = task.generation;
    task.running = true;
    await this.#discord.setTyping(task.threadId, true);
    let preview = ""; let previewUpdate = Promise.resolve();
    try {
      const response = await task.session.prompt(prompt, (event) => {
        if (event.kind === "text") {
          preview += event.text;
          previewUpdate = previewUpdate.then(() => this.#discord.updatePreview(task.threadId, preview.slice(-1_500))).catch(() => undefined);
        } else {
          previewUpdate = previewUpdate.then(() => this.#discord.send(task.threadId, `${event.status === "started" ? "Running" : "Finished"} ${event.name}`, { kind: "status" })).catch(() => undefined);
        }
      });
      await previewUpdate;
      if (task.generation === generation) await this.#discord.send(task.threadId, response || "Task completed without text output.", { kind: "final" });
      return { kind: "completed", taskId: task.id };
    } finally { task.running = false; await this.#discord.setTyping(task.threadId, false); }
  }

  #createSession(taskId: string) { return this.#pi.create({ taskId, cwd: this.#policy.defaultWorkingDirectory }); }
  #isAuthorized(request: DiscordRequest): boolean {
    if (request.authorIsBot || request.webhookId !== null || !this.#policy.superuserIds.includes(request.userId)) return false;
    return request.location === "dm" ? request.guildId === null : request.guildId !== null && (request.threadId !== null || this.#policy.privateChannelIds.includes(request.channelId));
  }
}

export function makeTaskThreadName(taskId: string, content: string): string {
  const shortId = createHash("sha256").update(taskId).digest("hex").slice(0, 8);
  const concise = content.trim().split(/\s+/u).slice(0, 12).join(" ");
  const summary = concise.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "") || "task";
  const suffix = ` — ${shortId}`;
  return `${summary.slice(0, 100 - suffix.length)}${suffix}`;
}
