import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { SuperuserPiFactory, SuperuserPiSession } from "./router.js";

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

  async prompt(prompt: string): Promise<string> {
    let text = "";
    const unsubscribe = this.#result.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
    });
    try {
      await this.#result.session.prompt(prompt);
      return text;
    } finally {
      unsubscribe();
    }
  }

  dispose(): Promise<void> {
    this.#result.session.dispose();
    return Promise.resolve();
  }
}

export class SdkSuperuserPiFactory implements SuperuserPiFactory {
  readonly #options: SuperuserPiOptions;

  constructor(options: SuperuserPiOptions) {
    this.#options = options;
  }

  async create(options: { taskId: string; cwd: string }): Promise<SdkSuperuserPiSession> {
    const constructed = await constructSuperuserPiSession(this.#options, options);
    return new SdkSuperuserPiSession(constructed.result);
  }
}

export async function constructSuperuserPiSession(
  config: SuperuserPiOptions,
  task: { taskId: string; cwd: string },
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
    sessionManager: SessionManager.create(task.cwd, sessionDirectory),
  });
  return { result, cwd: task.cwd, sessionDirectory };
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
