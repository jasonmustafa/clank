import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createTaskDiscordAttachTool, type TaskAttachmentBridge } from "./attachments.js";
import type { PiProgress, SuperuserPiFactory, SuperuserPiSession } from "./router.js";

export interface SuperuserPiOptions {
  agentDir: string;
  sessionsDirectory: string;
  model: { provider: string; id: string; thinkingLevel: ThinkingLevel };
}

export interface ConstructedSuperuserPiSession {
  result: CreateAgentSessionResult;
  cwd: string;
  sessionDirectory: string;
}

export class SdkSuperuserPiSession implements SuperuserPiSession {
  readonly #result: CreateAgentSessionResult;

  constructor(result: CreateAgentSessionResult) {
    this.#result = result;
  }

  async prompt(prompt: string, images?: readonly ImageContent[], onProgress?: (event: PiProgress) => void): Promise<string> {
    let text = "";
    const unsubscribe = this.#result.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
        onProgress?.({ kind: "text", text: event.assistantMessageEvent.delta });
      } else if (event.type === "tool_execution_start") {
        onProgress?.({ kind: "tool", name: event.toolName, status: "started" });
      } else if (event.type === "tool_execution_end") {
        onProgress?.({ kind: "tool", name: event.toolName, status: "completed" });
      }
    });
    try {
      await this.#result.session.prompt(prompt, { images: [...(images ?? [])] });
      return text;
    } finally { unsubscribe(); }
  }

  followUp(prompt: string, images?: readonly ImageContent[]): Promise<void> { return this.#result.session.followUp(prompt, [...(images ?? [])]); }
  steer(prompt: string, images?: readonly ImageContent[]): Promise<void> { return this.#result.session.steer(prompt, [...(images ?? [])]); }
  async stop(): Promise<void> { this.#result.session.clearQueue(); await this.#result.session.abort(); }
  async compact(): Promise<void> { await this.#result.session.compact(); }
  status() {
    return { busy: !this.#result.session.isIdle, queued: this.#result.session.pendingMessageCount, sessionId: this.#result.session.sessionId };
  }
  dispose(): Promise<void> { this.#result.session.dispose(); return Promise.resolve(); }
}

export class SdkSuperuserPiFactory implements SuperuserPiFactory {
  readonly #options: SuperuserPiOptions; readonly #attachments: TaskAttachmentBridge | undefined;

  constructor(options: SuperuserPiOptions, attachments?: TaskAttachmentBridge) {
    this.#options = options; this.#attachments = attachments;
  }

  async create(options: { taskId: string; cwd: string; sessionId?: string }): Promise<SdkSuperuserPiSession> {
    const constructed = await constructSuperuserPiSession(this.#options, options, this.#attachments);
    return new SdkSuperuserPiSession(constructed.result);
  }
}

export async function constructSuperuserPiSession(
  config: SuperuserPiOptions,
  task: { taskId: string; cwd: string; sessionId?: string },
  attachments?: TaskAttachmentBridge,
): Promise<ConstructedSuperuserPiSession> {
  const sessionDirectory = taskSessionDirectory(config.sessionsDirectory, task.taskId);
  await mkdir(sessionDirectory, { recursive: true });
  const authStorage = AuthStorage.create(join(config.agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(config.agentDir, "models.json"));
  const model = modelRegistry.find(config.model.provider, config.model.id);
  if (model === undefined) throw new Error(`Pi model not found: ${config.model.provider}/${config.model.id}`);
  const result = await createAgentSession({
    cwd: task.cwd,
    agentDir: config.agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: config.model.thinkingLevel,
    sessionManager: sessionManagerForTask(task.cwd, sessionDirectory, task.sessionId),
    ...(attachments === undefined ? {} : { customTools: [createTaskDiscordAttachTool(attachments.outputFor(task.taskId))] }),
  });
  return { result, cwd: task.cwd, sessionDirectory };
}

function sessionManagerForTask(cwd: string, sessionDirectory: string, sessionId?: string): SessionManager {
  if (sessionId === undefined) return SessionManager.create(cwd, sessionDirectory);
  const manager = SessionManager.continueRecent(cwd, sessionDirectory);
  if (manager.getSessionId() !== sessionId) throw new Error(`Saved Pi session ${sessionId} is unavailable`);
  return manager;
}

export function taskSessionDirectory(sessionsDirectory: string, taskId: string): string {
  if (taskId === "" || taskId === "." || taskId === ".." || taskId.includes("/") || taskId.includes("\\")) {
    throw new Error("taskId must be a non-empty path segment");
  }
  const root = resolve(sessionsDirectory);
  const result = resolve(root, taskId);
  if (relative(root, result).startsWith("..")) throw new Error("taskId escapes sessionsDirectory");
  return result;
}
