import { describe, expect, it } from "vitest";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import type { PiPromptRequest, PiRunner, PiRunnerEventListener, PiRunnerState } from "../src/pi/runner.js";
import { RpcPiRunner } from "../src/pi/rpcRunner.js";

class FakeRunner implements PiRunner {
  readonly kind = "fake";
  prompts: PiPromptRequest[] = [];
  private listeners = new Set<PiRunnerEventListener>();
  async prompt(request: PiPromptRequest): Promise<void> {
    this.prompts.push(request);
    for (const listener of this.listeners) listener({ type: "final", text: request.text });
  }
  async abort(): Promise<void> {}
  async compact(): Promise<CompactionResult | undefined> {
    return undefined;
  }
  async newSession(): Promise<void> {}
  onEvent(listener: PiRunnerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getState(): PiRunnerState {
    return { runnerKind: this.kind, isStreaming: false, isCompacting: false, pendingMessageCount: 0, cwd: "/tmp" };
  }
  async getStatus(): Promise<PiRunnerState> {
    return this.getState();
  }
  async dispose(): Promise<void> {}
}

describe("PiRunner interface", () => {
  it("supports event subscription and unsubscription", async () => {
    const runner = new FakeRunner();
    const events: string[] = [];
    const unsubscribe = runner.onEvent((event) => {
      if (event.type === "final") events.push(event.text);
    });
    await runner.prompt({ text: "hello" });
    unsubscribe();
    await runner.prompt({ text: "ignored" });
    expect(events).toEqual(["hello"]);
  });

  it("future RPC runners report unavailable instead of hand-rolling JSONL", async () => {
    const runner = new RpcPiRunner("/tmp");
    await expect(runner.prompt({ text: "x" })).rejects.toThrow("rpc runner is not implemented yet");
    expect(runner.getState().runnerKind).toBe("rpc");
  });
});
