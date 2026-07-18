import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTaskStore, IncompatibleTaskStateError, type PersistedTaskState } from "./task-store.js";

const task: PersistedTaskState["tasks"][number] = {
  id: "task-1", requesterId: "owner", threadId: "thread-1", capabilityMode: "superuser",
  workingDirectory: "/srv/clank/app", lifecycleState: "active", createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z", piSessionId: "session-1",
};

describe("file task store", () => {
  it("atomically replaces state without leaving its temporary file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clank-state-"));
    const path = join(directory, "tasks.json"); const store = new FileTaskStore(path);
    await store.save({ version: 1, tasks: [task], approvals: [] });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, tasks: [task], approvals: [] });
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });

  it("rejects corrupt and incompatible state explicitly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clank-state-")); const path = join(directory, "tasks.json");
    await writeFile(path, "not json");
    await expect(new FileTaskStore(path).load()).rejects.toThrow(/corrupt/u);
    await writeFile(path, JSON.stringify({ version: 99, tasks: [], approvals: [] }));
    await expect(new FileTaskStore(path).load()).rejects.toBeInstanceOf(IncompatibleTaskStateError);
  });

  it("rejects legacy job state instead of silently starting empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clank-state-")); const path = join(directory, "tasks.json");
    await writeFile(path, JSON.stringify({ version: 1, jobs: [{ id: "legacy-job" }] }));

    await expect(new FileTaskStore(path).load()).rejects.toThrow(IncompatibleTaskStateError);
  });
});
