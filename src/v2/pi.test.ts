import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { constructSuperuserPiSession } from "./pi.js";

async function temporaryDirectory(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), name));
}

describe("real superuser Pi construction", () => {
  it("uses the requested cwd, persistent task directory, normal resources, and standard full-capability tools without a live model call", async () => {
    const root = await temporaryDirectory("clank-v2-pi-");
    const cwd = join(root, "checkout");
    const agentDir = join(root, "agent");
    const sessionsDirectory = join(root, "sessions");
    await mkdir(cwd);
    await mkdir(agentDir);
    await writeFile(join(cwd, "AGENTS.md"), "PROJECT_CONTEXT_MARKER");
    await writeFile(join(agentDir, "AGENTS.md"), "GLOBAL_CONTEXT_MARKER");
    const registry = ModelRegistry.inMemory(AuthStorage.create(join(agentDir, "auth.json")));
    const model = registry.getAll()[0];
    if (model === undefined) throw new Error("Pi has no built-in model for its construction test");
    const constructed = await constructSuperuserPiSession({
      agentDir,
      sessionsDirectory,
      model: { provider: model.provider, id: model.id, thinkingLevel: "off" },
    }, { taskId: "task-123", cwd });

    expect(constructed.cwd).toBe(cwd);
    expect(constructed.sessionDirectory).toBe(join(sessionsDirectory, "task-123"));
    expect(constructed.result.session.agent.state.tools.map((tool) => tool.name).sort())
      .toEqual(["bash", "edit", "read", "write"]);
    expect(constructed.result.session.agent.state.systemPrompt).toContain("PROJECT_CONTEXT_MARKER");
    expect(constructed.result.session.agent.state.systemPrompt).toContain("GLOBAL_CONTEXT_MARKER");
    constructed.result.session.dispose();
  });
});
