import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskAttachmentBridge } from "./attachments.js";

const roots: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "clank-attachments-")); roots.push(value); return value; }
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))));

describe("task attachment bridge", () => {
  it("sanitizes supported text and images into isolated task storage", async () => {
    const temporaryRoot = await root();
    const bridge = new TaskAttachmentBridge({ temporaryRoot, maxCount: 3, maxInputBytesEach: 100, maxInputBytesTotal: 200 });
    const result = await bridge.ingest("task-1", "message-1", [
      { name: "../../notes?.txt", url: "https://cdn.test/notes", size: 5, contentType: "text/plain" },
      { name: "..\\photo.png", url: "https://cdn.test/photo", size: 3, contentType: "image/png" },
    ], (url) => Promise.resolve(new Response(url.endsWith("notes") ? "hello" : new Uint8Array([1, 2, 3]))));
    expect(result.prompt).toContain(join(temporaryRoot, "task-1", "input", "message-1", "notes-.txt"));
    expect(result.images).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
    expect(await readFile(join(temporaryRoot, "task-1", "input", "message-1", "notes-.txt"), "utf8")).toBe("hello");
    expect(result.errors).toEqual([]);
  });

  it("rejects unsupported types and declared or downloaded oversize content", async () => {
    const bridge = new TaskAttachmentBridge({ temporaryRoot: await root(), maxInputBytesEach: 4, maxInputBytesTotal: 8 });
    const result = await bridge.ingest("task", "message", [
      { name: "run.sh", url: "https://cdn.test/run", size: 2, contentType: "application/x-sh" },
      { name: "large.txt", url: "https://cdn.test/large", size: 5, contentType: "text/plain" },
      { name: "lying.txt", url: "https://cdn.test/lying", size: 1, contentType: "text/plain" },
    ], () => Promise.resolve(new Response("12345")));
    expect(result.files).toEqual([]);
    expect(result.errors.join("\n")).toMatch(/unsupported|per-file limit|configured size limits/u);
  });

  it("queues only regular task-output files within the size limit", async () => {
    const temporaryRoot = await root(); const bridge = new TaskAttachmentBridge({ temporaryRoot, maxOutputBytesEach: 4 });
    const output = bridge.outputFor("task-a"); await mkdir(output.directory, { recursive: true });
    const okay = join(output.directory, "ok.txt"); await writeFile(okay, "1234");
    await expect(output.enqueue(okay)).resolves.toBe(okay); expect(output.take()).toEqual([okay]);
    const large = join(output.directory, "large.txt"); await writeFile(large, "12345");
    await expect(output.enqueue(large)).rejects.toThrow("output size limit");
    const unrelated = join(temporaryRoot, "task-b", "output", "secret.txt"); await mkdir(join(temporaryRoot, "task-b", "output"), { recursive: true }); await writeFile(unrelated, "x");
    await expect(output.enqueue(unrelated)).rejects.toThrow("outside this task's output directory");
    const target = join(temporaryRoot, "target.txt"); await writeFile(target, "x"); const link = join(output.directory, "link.txt"); await symlink(target, link);
    await expect(output.enqueue(link)).rejects.toThrow("regular file");
  });

  it("cleans one message or the entire task without touching another task", async () => {
    const temporaryRoot = await root(); const bridge = new TaskAttachmentBridge({ temporaryRoot });
    const attachment = [{ name: "a.txt", url: "https://cdn.test/a", size: 1, contentType: "text/plain" }];
    await bridge.ingest("one", "m1", attachment, () => Promise.resolve(new Response("a")));
    await bridge.ingest("two", "m1", attachment, () => Promise.resolve(new Response("b")));
    await bridge.cleanupMessage("one", "m1");
    await expect(readFile(join(temporaryRoot, "one", "input", "m1", "a.txt"))).rejects.toThrow();
    await expect(readFile(join(temporaryRoot, "two", "input", "m1", "a.txt"), "utf8")).resolves.toBe("b");
  });
});
