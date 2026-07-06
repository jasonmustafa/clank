import type { CompactionResult } from "@earendil-works/pi-coding-agent";

// Future isolated implementations should wrap Pi's exported RpcClient rather than hand-rolling JSONL.
import { RunnerUnavailableError, type PiPromptRequest, type PiRunner, type PiRunnerEventListener, type PiRunnerState } from "./runner.js";

abstract class UnimplementedRunner implements PiRunner {
  protected constructor(readonly kind: string, protected readonly cwd: string) {}
  async prompt(_request: PiPromptRequest): Promise<void> {
    throw new RunnerUnavailableError(this.kind);
  }
  async abort(): Promise<void> {
    throw new RunnerUnavailableError(this.kind);
  }
  async compact(_customInstructions?: string): Promise<CompactionResult | undefined> {
    throw new RunnerUnavailableError(this.kind);
  }
  async newSession(): Promise<void> {
    throw new RunnerUnavailableError(this.kind);
  }
  onEvent(_listener: PiRunnerEventListener): () => void {
    return () => undefined;
  }
  getState(): PiRunnerState {
    return {
      runnerKind: this.kind,
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      cwd: this.cwd,
    };
  }
  async getStatus(): Promise<PiRunnerState> {
    return this.getState();
  }
  async dispose(): Promise<void> {}
}

export class RpcPiRunner extends UnimplementedRunner {
  constructor(cwd: string) {
    super("rpc", cwd);
  }
}

export class ContainerRpcRunner extends UnimplementedRunner {
  constructor(cwd: string) {
    super("container-rpc", cwd);
  }
}

export class MicroVmRpcRunner extends UnimplementedRunner {
  constructor(cwd: string) {
    super("microvm-rpc", cwd);
  }
}
