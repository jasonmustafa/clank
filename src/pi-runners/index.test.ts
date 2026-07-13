import { describe, expect, it, vi } from "vitest";
import { FakeRunner } from "./index.js";

describe("FakeRunner", () => {
  it("produces deterministic streamed and final replies", async () => {
    const onText = vi.fn();
    const runner = new FakeRunner({ chunks: ["Working", "..."], final: "Done." });

    await expect(runner.run("ignored prompt", onText)).resolves.toBe("Done.");
    expect(onText.mock.calls).toEqual([["Working"], ["..."]]);
  });
});
