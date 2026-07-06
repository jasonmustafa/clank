import type { AgentSessionEvent, CompactionResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

export type PromptQueueBehavior = "immediate" | "followUp" | "steer";

export interface PiPromptRequest {
  text: string;
  images?: ImageContent[];
  behavior?: PromptQueueBehavior;
}

export interface PiRunnerState {
  runnerKind: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  model?: string;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
  cwd: string;
  allowedRoots?: string[];
}

export type PiRunnerEvent =
  | { type: "session_event"; event: AgentSessionEvent }
  | { type: "text_delta"; delta: string; text: string }
  | { type: "tool_status"; toolName: string; status: "start" | "end" | "error"; summary: string }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "final"; text: string; stopReason?: string; errorMessage?: string }
  | { type: "file_ready"; path: string; fileName: string; description?: string };

export type PiRunnerEventListener = (event: PiRunnerEvent) => void;

export interface PiRunner {
  readonly kind: string;
  prompt(request: PiPromptRequest): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<CompactionResult | undefined>;
  newSession(): Promise<void>;
  onEvent(listener: PiRunnerEventListener): () => void;
  getState(): PiRunnerState;
  getStatus(): Promise<PiRunnerState>;
  dispose(): Promise<void>;
}

export class RunnerUnavailableError extends Error {
  constructor(kind: string) {
    super(`${kind} runner is not implemented yet`);
  }
}
