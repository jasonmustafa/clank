import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentIngestor, DiscordAttachmentQueue, createDiscordAttachTool } from "./index.js";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "clank-attachments-")); roots.push(root); return root; }
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("AttachmentIngestor", () => {
  it("downloads sanitized attachments and provides prompt paths and image inputs", async () => {
    const root = await temporaryRoot();
    const ingestor = new AttachmentIngestor({ temporaryRoot: root, maxCount: 2, maxBytesEach: 100 });
    const result = await ingestor.ingest("job-1", [
      { name: "../odd name.png", url: "https://cdn.test/image", size: 3, contentType: "image/png" },
      { name: "notes?.txt", url: "https://cdn.test/notes", size: 5, contentType: "text/plain" },
    ], (url) => Promise.resolve(new Response(url.endsWith("image") ? new Uint8Array([1, 2, 3]) : "hello")));

    expect(result.files.map((file) => file.path)).toEqual([
      join(root, "job-1", "attachments", "odd-name.png"),
      join(root, "job-1", "attachments", "notes-.txt"),
    ]);
    expect(result.prompt).toContain(`- ${join(root, "job-1", "attachments", "odd-name.png")} (image/png)`);
    expect(result.images).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
    const notes = result.files.at(1);
    if (notes === undefined) throw new Error("Expected downloaded notes attachment");
    expect(await readFile(notes.path, "utf8")).toBe("hello");
  });

  it("reports count and size limit violations clearly without downloading rejected files", async () => {
    const root = await temporaryRoot();
    const ingestor = new AttachmentIngestor({ temporaryRoot: root, maxCount: 1, maxBytesEach: 4, maxBytesTotal: 4 });
    let downloads = 0;
    const result = await ingestor.ingest("job-1", [
      { name: "large.txt", url: "https://cdn.test/large", size: 5 },
      { name: "extra.txt", url: "https://cdn.test/extra", size: 1 },
    ], () => { downloads += 1; return Promise.resolve(new Response("unused")); });
    expect(downloads).toBe(0);
    expect(result.errors).toEqual([
      "Attachment large.txt exceeds the 4 byte per-file limit.",
      "Attachment extra.txt rejected: at most 1 attachment is allowed per message.",
    ]);
  });
});

describe("discord_attach", () => {
  it("queues workspace/output files and consumes them with the next reply", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const output = join(root, "output");
    await mkdir(workspace); await mkdir(output);
    const file = join(output, "report.pdf"); await writeFile(file, "report");
    const queue = new DiscordAttachmentQueue({ workspaceRoot: workspace, outputRoot: output });
    const tool = createDiscordAttachTool(queue);
    const result = await tool.execute("call-1", { path: file }, new AbortController().signal, () => undefined, {} as never);
    expect(result.content[0]).toMatchObject({ type: "text", text: "Queued report.pdf for the next Discord reply." });
    expect(queue.take()).toEqual([file]);
    expect(queue.take()).toEqual([]);
  });

  it("rejects directories, paths outside allowed roots, and secret-looking paths", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const queue = new DiscordAttachmentQueue({ workspaceRoot: workspace, outputRoot: join(root, "output") });
    await expect(queue.enqueue(workspace)).rejects.toThrow("regular file");
    await expect(queue.enqueue(join(root, "elsewhere.txt"))).rejects.toThrow("outside the job workspace/output roots");
    const secret = join(workspace, ".env"); await writeFile(secret, "TOKEN=x");
    await expect(queue.enqueue(secret)).rejects.toThrow("protected or secret-looking");
    const outside = join(root, "outside.txt"); await writeFile(outside, "outside");
    const link = join(workspace, "safe.txt"); await symlink(outside, link);
    await expect(queue.enqueue(link)).rejects.toThrow("not a symbolic link");
  });
});
