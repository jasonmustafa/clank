import { EventEmitter } from "node:events";
import { basename, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashToolDefinition,
  defineTool,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CompactionResult,
  type ExtensionUIContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ClankConfig } from "../config/env.js";
import type { JobKind } from "../jobs/jobStore.js";
import { createSafetyExtension } from "../safety/safetyExtension.js";
import { commandTouchesSensitivePath, explainPathPolicy, isAllowedByRoots, sanitizeEnv, uniqueResolvedPaths, type PathProtectionConfig } from "../safety/pathProtection.js";
import { formatError } from "../format/discord.js";
import type { PiPromptRequest, PiRunner, PiRunnerEvent, PiRunnerEventListener, PiRunnerState } from "./runner.js";

export interface SdkPiRunnerOptions {
  jobId: string;
  cwd: string;
  workspaceDir: string;
  kind: JobKind;
  config: ClankConfig;
  sessionFile?: string;
  requestConfirmation?: (title: string, message: string) => Promise<boolean>;
}

type InternalEvents = {
  event: [PiRunnerEvent];
};

function extractAssistantText(messages: unknown[]): { text: string; stopReason?: string; errorMessage?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .map((block) => {
        const value = block as { type?: string; text?: string };
        return value.type === "text" && typeof value.text === "string" ? value.text : "";
      })
      .join("")
      .trim();
    const result: { text: string; stopReason?: string; errorMessage?: string } = { text };
    if (message.stopReason) result.stopReason = message.stopReason;
    if (message.errorMessage) result.errorMessage = message.errorMessage;
    return result;
  }
  return { text: "" };
}

function modelName(session: AgentSession): string | undefined {
  return session.model ? `${session.model.provider}/${session.model.id}` : undefined;
}

function runnerAllowedRoots(options: SdkPiRunnerOptions): string[] {
  return uniqueResolvedPaths([options.workspaceDir, ...options.config.allowedRootDirs]);
}

function runnerPathProtectionConfig(options: SdkPiRunnerOptions, allowedRoots: string[]): PathProtectionConfig {
  return {
    workspaceRoot: options.config.workspaceRoot,
    piAgentDir: options.config.piAgentDir,
    clankAppDir: options.config.clankAppDir,
    allowedRoots,
    mode: options.kind,
  };
}

function createDiscordFileTool(options: SdkPiRunnerOptions, emit: (event: PiRunnerEvent) => void) {
  return defineTool({
    name: "discord_send_file",
    label: "Discord Send File",
    description: "Queue one generated file under an allowed root to send back to Discord.",
    promptSnippet: "Queue a generated file under an allowed root to send back to Discord.",
    promptGuidelines: [
      "Use discord_send_file when the Discord user asks you to send back a generated artifact. Pass a relative or absolute path under an allowed root; relative paths resolve against the job cwd.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Relative or absolute path of a file under an allowed root to send back to Discord" }),
      description: Type.Optional(Type.String({ description: "Short note to show with the uploaded file" })),
    }),
    async execute(_toolCallId, params) {
      const inputPath = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(options.cwd, inputPath);
      const allowedRoots = runnerAllowedRoots(options);
      const policyReason = explainPathPolicy(inputPath, options.cwd, runnerPathProtectionConfig(options, allowedRoots));
      if (policyReason) throw new Error(policyReason);
      const stats = await stat(absolutePath);
      if (!stats.isFile()) throw new Error(`Not a file: ${params.path}`);
      if (stats.size > options.config.maxAttachmentBytes) {
        throw new Error(`File is too large for Discord upload (${stats.size} bytes)`);
      }
      emit({ type: "file_ready", path: absolutePath, fileName: basename(absolutePath), description: params.description });
      return {
        content: [{ type: "text", text: `Queued ${params.path} for upload to Discord.` }],
        details: { path: absolutePath },
      };
    },
  });
}

function createDiscordUiContext(options: SdkPiRunnerOptions, emit: (event: PiRunnerEvent) => void): ExtensionUIContext {
  const theme = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as ExtensionUIContext["theme"];

  return {
    async select(title, choices) {
      if (choices.length === 2 && options.requestConfirmation) {
        const confirmed = await options.requestConfirmation(title, choices.join(" / "));
        return confirmed ? choices[0] : choices[1];
      }
      emit({ type: "tool_status", toolName: "ui", status: "error", summary: `Unsupported select UI: ${title}` });
      return undefined;
    },
    async confirm(title, message) {
      if (!options.requestConfirmation) return false;
      return options.requestConfirmation(title, message);
    },
    async input() {
      return undefined;
    },
    notify(message, type = "info") {
      emit({ type: "tool_status", toolName: "notice", status: type === "error" ? "error" : "end", summary: message });
    },
    onTerminalInput() {
      return () => undefined;
    },
    setStatus(key, text) {
      if (text) emit({ type: "tool_status", toolName: key, status: "end", summary: text });
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() {
      return undefined as never;
    },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    async editor() {
      return undefined;
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    theme,
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Discord bridge has no TUI theme" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };
}

export class SdkPiRunner implements PiRunner {
  readonly kind = "sdk";
  private readonly emitter = new EventEmitter<InternalEvents>();
  private runtime!: AgentSessionRuntime;
  private unsubscribe?: () => void;
  private assistantText = "";

  private constructor(private readonly options: SdkPiRunnerOptions) {}

  static async create(options: SdkPiRunnerOptions): Promise<SdkPiRunner> {
    const runner = new SdkPiRunner(options);
    await runner.init();
    return runner;
  }

  private emit(event: PiRunnerEvent): void {
    this.emitter.emit("event", event);
  }

  private async init(): Promise<void> {
    const allowedRoots = runnerAllowedRoots(this.options);
    if (!isAllowedByRoots(this.options.cwd, allowedRoots)) {
      throw new Error(`Runner cwd is outside allowed roots (${allowedRoots.join(", ")}): ${this.options.cwd}`);
    }

    const pathProtection = runnerPathProtectionConfig(this.options, allowedRoots);
    const safetyExtension = createSafetyExtension(pathProtection);
    const discordFileTool = createDiscordFileTool(this.options, (event) => this.emit(event));
    const bashTool = createBashToolDefinition(this.options.cwd, {
      spawnHook: ({ command, cwd, env }) => {
        if (!isAllowedByRoots(cwd, allowedRoots)) {
          throw new Error(`bash cwd is outside allowed roots (${allowedRoots.join(", ")}): ${cwd}`);
        }
        const secretReason = commandTouchesSensitivePath(command, pathProtection);
        if (secretReason) throw new Error(`Blocked bash: ${secretReason}`);
        return { command, cwd, env: sanitizeEnv(env) };
      },
    });

    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: { cwd: string; agentDir: string; sessionManager: SessionManager; sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"] }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          extensionFactories: [safetyExtension],
        },
      });
      const customTools = [bashTool, discordFileTool] as unknown as ToolDefinition[];
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          customTools,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const sessionManager = this.options.sessionFile
      ? SessionManager.open(this.options.sessionFile, this.options.config.piSessionDir, this.options.cwd)
      : SessionManager.create(this.options.cwd, this.options.config.piSessionDir);

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: this.options.cwd,
      agentDir: this.options.config.piAgentDir,
      sessionManager,
    });
    this.runtime.setRebindSession(async (session) => this.bindSession(session));
    await this.bindSession(this.runtime.session);
  }

  private async bindSession(session: AgentSession): Promise<void> {
    this.unsubscribe?.();
    await session.bindExtensions({
      mode: "rpc",
      uiContext: createDiscordUiContext(this.options, (event) => this.emit(event)),
      onError: (error) => {
        this.emit({ type: "tool_status", toolName: "extension", status: "error", summary: formatError(error.error) });
      },
    });
    this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    this.emit({ type: "session_event", event });

    if (event.type === "message_start") {
      const message = event.message as { role?: string };
      if (message.role === "assistant") this.assistantText = "";
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.assistantText += event.assistantMessageEvent.delta;
      this.emit({ type: "text_delta", delta: event.assistantMessageEvent.delta, text: this.assistantText });
    }

    if (event.type === "tool_execution_start") {
      this.emit({ type: "tool_status", toolName: event.toolName, status: "start", summary: `${event.toolName} running` });
    }

    if (event.type === "tool_execution_end") {
      this.emit({
        type: "tool_status",
        toolName: event.toolName,
        status: event.isError ? "error" : "end",
        summary: `${event.toolName} ${event.isError ? "failed" : "done"}`,
      });
    }

    if (event.type === "queue_update") {
      this.emit({ type: "queue_update", steering: event.steering, followUp: event.followUp });
    }

    if (event.type === "agent_end") {
      const assistant = extractAssistantText(event.messages);
      this.emit({ type: "final", text: assistant.text, stopReason: assistant.stopReason, errorMessage: assistant.errorMessage });
    }
  }

  async prompt(request: PiPromptRequest): Promise<void> {
    const session = this.runtime.session;
    const streamingBehavior = request.behavior === "steer" ? "steer" : request.behavior === "followUp" || session.isStreaming ? "followUp" : undefined;
    const options: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp"; source: "rpc" } = { source: "rpc" };
    if (request.images && request.images.length > 0) options.images = request.images;
    if (streamingBehavior) options.streamingBehavior = streamingBehavior;
    await session.prompt(request.text, options);
  }

  async abort(): Promise<void> {
    await this.runtime.session.abort();
  }

  async compact(customInstructions?: string): Promise<CompactionResult | undefined> {
    return this.runtime.session.compact(customInstructions);
  }

  async newSession(): Promise<void> {
    const result = await this.runtime.newSession({ parentSession: this.runtime.session.sessionFile });
    if (result.cancelled) throw new Error("New session was cancelled by an extension");
  }

  onEvent(listener: PiRunnerEventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  getState(): PiRunnerState {
    const session = this.runtime.session;
    return {
      runnerKind: this.kind,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      model: modelName(session),
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      pendingMessageCount: session.pendingMessageCount,
      cwd: this.runtime.cwd,
      allowedRoots: runnerAllowedRoots(this.options),
    };
  }

  async getStatus(): Promise<PiRunnerState> {
    return this.getState();
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    await this.runtime.dispose();
  }
}
