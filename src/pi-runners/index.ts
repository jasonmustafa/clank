import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  type AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { chunkDiscordMessage } from "../formatting/index.js";

export type RunnerState = "idle" | "running" | "compacting" | "disposed";
export interface PiRunnerStatus { state: RunnerState; sessionId: string; model: string; }
export type PiRunnerEvent =
  | { type: "text_delta"; text: string }
  | { type: "preview"; text: string }
  | { type: "final"; text: string; messages: readonly string[] }
  | { type: "status"; status: PiRunnerStatus };
export type PiRunnerListener = (event: PiRunnerEvent) => void | Promise<void>;

export interface PiRunner {
  prompt(prompt: string): Promise<readonly string[]>;
  followUp(prompt: string): Promise<void>;
  steer(prompt: string): Promise<void>;
  clearQueues(): void;
  queueSize(): number;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  newSession(): Promise<void>;
  onEvent(listener: PiRunnerListener): () => void;
  status(): PiRunnerStatus;
  dispose(): Promise<void>;
}

abstract class EventedRunner {
  protected readonly listeners = new Set<PiRunnerListener>();
  onEvent(listener: PiRunnerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected async emit(event: PiRunnerEvent): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => listener(event)));
  }
}

export interface FakeRunnerOptions { chunks?: readonly string[]; final?: string; }
export class FakePiRunner extends EventedRunner implements PiRunner {
  readonly #chunks: readonly string[];
  readonly #final: string;
  #state: RunnerState = "idle";
  #sessionNumber = 1;
  #queuedMessages = 0;
  readonly received: { text: string; behavior: "prompt" | "followUp" | "steer" }[] = [];
  constructor(options: FakeRunnerOptions = {}) {
    super();
    this.#chunks = options.chunks ?? ["Clank is working..."];
    this.#final = options.final ?? "Fake runner completed the job.";
  }
  status(): PiRunnerStatus { return { state: this.#state, sessionId: `fake-session-${String(this.#sessionNumber)}`, model: "fake/model" }; }
  async prompt(prompt: string): Promise<readonly string[]> {
    this.received.push({ text: prompt, behavior: "prompt" });
    this.#state = "running";
    await this.emit({ type: "status", status: this.status() });
    for (const text of this.#chunks) await this.emit({ type: "text_delta", text });
    const messages = chunkDiscordMessage(this.#final);
    await this.emit({ type: "final", text: this.#final, messages });
    this.#state = "idle";
    await this.emit({ type: "status", status: this.status() });
    return messages;
  }
  followUp(text: string): Promise<void> { this.received.push({ text, behavior: "followUp" }); this.#queuedMessages += 1; return Promise.resolve(); }
  steer(text: string): Promise<void> { this.received.push({ text, behavior: "steer" }); this.#queuedMessages += 1; return Promise.resolve(); }
  clearQueues(): void { this.#queuedMessages = 0; }
  queueSize(): number { return this.#queuedMessages; }
  setState(state: RunnerState): void { this.#state = state; }
  abort(): Promise<void> { this.#state = "idle"; return Promise.resolve(); }
  compact(): Promise<void> { this.#state = "idle"; return Promise.resolve(); }
  newSession(): Promise<void> { this.#sessionNumber += 1; return Promise.resolve(); }
  dispose(): Promise<void> { this.#state = "disposed"; this.listeners.clear(); return Promise.resolve(); }

  /** Legacy adapter used by the initial Discord work-message path. */
  async run(prompt: string, onText: (text: string) => void | Promise<void> = () => undefined): Promise<string> {
    for (const text of this.#chunks) await onText(text);
    void prompt;
    return this.#final;
  }
}

/** Backward-compatible name for early callers. */
export { FakePiRunner as FakeRunner };

export interface SdkPiRunnerOptions {
  jobId: string;
  cwd: string;
  agentDir: string;
  sessionsDir: string;
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  trustedResourcePaths?: readonly string[];
  previewIntervalMs?: number;
  messageLimit?: number;
}

export class SdkPiRunner extends EventedRunner implements PiRunner {
  readonly #runtime: AgentSessionRuntime;
  readonly #previewIntervalMs: number;
  readonly #messageLimit: number;
  #state: RunnerState = "idle";
  #unsubscribe: (() => void) | undefined;
  #text = "";
  #lastPreviewAt = 0;
  #lastPreviewText = "";
  #eventQueue: Promise<void> = Promise.resolve();
  #queuedMessages = 0;
  readonly #model: string;

  private constructor(runtime: AgentSessionRuntime, options: SdkPiRunnerOptions) {
    super();
    this.#runtime = runtime;
    this.#model = `${options.model.provider}/${options.model.id}`;
    this.#previewIntervalMs = options.previewIntervalMs ?? 1_000;
    this.#messageLimit = options.messageLimit ?? 1_900;
    this.#subscribe();
  }

  static async create(options: SdkPiRunnerOptions): Promise<SdkPiRunner> {
    const sessionDir = jobSessionDir(options.sessionsDir, options.jobId);
    await mkdir(sessionDir, { recursive: true });
    const authStorage = AuthStorage.create(join(options.agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, join(options.agentDir, "models.json"));
    const model = modelRegistry.find(options.model.provider, options.model.id);
    if (model === undefined) throw new Error(`Pi model not found: ${options.model.provider}/${options.model.id}`);
    const createRuntime = async ({ cwd, sessionManager }: { cwd: string; sessionManager: SessionManager }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir: options.agentDir,
        authStorage,
        modelRegistry,
        // Prevent the temporary default loader from evaluating project-local resources.
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const trustedPaths = [...(options.trustedResourcePaths ?? [])];
      // Discover from the trusted agent directory, never from the arbitrary job cwd.
      const resourceLoader = new DefaultResourceLoader({
        cwd: options.agentDir,
        agentDir: options.agentDir,
        settingsManager: services.settingsManager,
        additionalExtensionPaths: trustedPaths,
        additionalSkillPaths: trustedPaths,
        additionalPromptTemplatePaths: trustedPaths,
        additionalThemePaths: trustedPaths,
      });
      await resourceLoader.reload();
      services.resourceLoader = resourceLoader;
      return {
        ...(await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: options.thinkingLevel })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.cwd,
      agentDir: options.agentDir,
      sessionManager: SessionManager.create(options.cwd, sessionDir),
    });
    return new SdkPiRunner(runtime, options);
  }

  status(): PiRunnerStatus { return { state: this.#state, sessionId: this.#runtime.session.sessionId, model: this.#model }; }
  async prompt(prompt: string): Promise<readonly string[]> {
    this.#assertIdle();
    this.#text = "";
    this.#lastPreviewAt = 0;
    this.#lastPreviewText = "";
    this.#eventQueue = Promise.resolve();
    await this.#setState("running");
    try {
      await this.#runtime.session.prompt(prompt);
      await this.#eventQueue;
      if (this.#text !== this.#lastPreviewText) await this.emit({ type: "preview", text: this.#text });
      const messages = chunkDiscordMessage(this.#text, this.#messageLimit);
      await this.emit({ type: "final", text: this.#text, messages });
      return messages;
    } finally {
      await this.#setState("idle");
    }
  }
  async followUp(text: string): Promise<void> { await this.#runtime.session.prompt(text, { streamingBehavior: "followUp" }); }
  async steer(text: string): Promise<void> { await this.#runtime.session.prompt(text, { streamingBehavior: "steer" }); }
  clearQueues(): void {
    this.#runtime.session.agent.clearSteeringQueue();
    this.#runtime.session.agent.clearFollowUpQueue();
    this.#queuedMessages = 0;
  }
  queueSize(): number { return this.#queuedMessages; }
  async abort(): Promise<void> { await this.#runtime.session.abort(); await this.#setState("idle"); }
  async compact(instructions?: string): Promise<void> {
    this.#assertIdle();
    await this.#setState("compacting");
    try {
      await this.#runtime.session.compact(instructions);
    } finally {
      await this.#setState("idle");
    }
  }
  async newSession(): Promise<void> {
    this.#assertIdle();
    const previousUnsubscribe = this.#unsubscribe;
    previousUnsubscribe?.();
    try {
      await this.#runtime.newSession();
    } finally {
      this.#subscribe();
    }
  }
  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    await this.#runtime.dispose();
    this.#state = "disposed";
    this.listeners.clear();
  }
  #subscribe(): void {
    this.#unsubscribe = this.#runtime.session.subscribe((event) => {
      if (event.type === "queue_update") {
        this.#queuedMessages = event.steering.length + event.followUp.length;
        return;
      }
      if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
      const text = event.assistantMessageEvent.delta;
      this.#text += text;
      this.#enqueueEvent({ type: "text_delta", text });
      const now = Date.now();
      if (now - this.#lastPreviewAt >= this.#previewIntervalMs) {
        this.#lastPreviewAt = now;
        this.#lastPreviewText = this.#text;
        this.#enqueueEvent({ type: "preview", text: this.#text });
      }
    });
  }
  #enqueueEvent(event: PiRunnerEvent): void {
    this.#eventQueue = this.#eventQueue.then(async () => this.emit(event));
  }
  async #setState(state: RunnerState): Promise<void> {
    this.#state = state;
    await this.emit({ type: "status", status: this.status() });
  }
  #assertIdle(): void {
    if (this.#state === "disposed") throw new Error("SdkPiRunner is disposed");
    if (this.#state !== "idle") throw new Error(`SdkPiRunner is ${this.#state}`);
  }
}

export function jobSessionDir(sessionsDir: string, jobId: string): string {
  if (jobId.length === 0 || jobId === "." || jobId === ".." || jobId.includes("/") || jobId.includes("\\")) {
    throw new Error("jobId must be a non-empty path segment");
  }
  const root = resolve(sessionsDir);
  const result = resolve(root, jobId);
  if (relative(root, result).startsWith("..")) throw new Error("jobId escapes sessionsDir");
  return result;
}

export class RpcPiRunner extends EventedRunner implements PiRunner {
  status(): PiRunnerStatus { return { state: "idle", sessionId: "rpc-not-implemented", model: "rpc/not-implemented" }; }
  prompt(prompt: string): Promise<readonly string[]> { void prompt; return Promise.reject(new Error("RpcPiRunner is not implemented")); }
  followUp(prompt: string): Promise<void> { void prompt; return Promise.reject(new Error("RpcPiRunner is not implemented")); }
  steer(prompt: string): Promise<void> { void prompt; return Promise.reject(new Error("RpcPiRunner is not implemented")); }
  clearQueues(): void { throw new Error("RpcPiRunner is not implemented"); }
  queueSize(): number { return 0; }
  abort(): Promise<void> { return Promise.reject(new Error("RpcPiRunner is not implemented")); }
  compact(): Promise<void> { return Promise.reject(new Error("RpcPiRunner is not implemented")); }
  newSession(): Promise<void> { return Promise.reject(new Error("RpcPiRunner is not implemented")); }
  dispose(): Promise<void> { this.listeners.clear(); return Promise.resolve(); }
}
