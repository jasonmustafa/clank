import type { ImageContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";

export interface DiscordInputAttachment { name: string; url: string; size: number; contentType?: string | null; }
export interface IngestedTaskAttachment { name: string; path: string; contentType: string; size: number; image: boolean; }
export interface TaskAttachmentResult { files: readonly IngestedTaskAttachment[]; images: readonly ImageContent[]; prompt: string; errors: readonly string[]; }
export interface TaskAttachmentOptions { temporaryRoot: string; maxCount?: number; maxInputBytesEach?: number; maxInputBytesTotal?: number; maxOutputBytesEach?: number; maxOutputCount?: number; }
type FetchAttachment = (url: string) => Promise<Response>;
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "application/xml", "text/xml"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class TaskAttachmentBridge {
  readonly #root: string; readonly #maxCount: number; readonly #maxInputBytesEach: number; readonly #maxInputBytesTotal: number; readonly #maxOutputBytesEach: number; readonly #maxOutputCount: number;
  readonly #outputs = new Map<string, TaskOutputQueue>();
  constructor(options: TaskAttachmentOptions) { this.#root = resolve(options.temporaryRoot); this.#maxCount = options.maxCount ?? 10; this.#maxInputBytesEach = options.maxInputBytesEach ?? 10 * 1024 * 1024; this.#maxInputBytesTotal = options.maxInputBytesTotal ?? 25 * 1024 * 1024; this.#maxOutputBytesEach = options.maxOutputBytesEach ?? 10 * 1024 * 1024; this.#maxOutputCount = options.maxOutputCount ?? 10; if (this.#maxOutputBytesEach > 10 * 1024 * 1024 || this.#maxOutputCount > 10) throw new Error("Discord output limits cannot exceed 10 MiB per file or 10 files per message"); }
  async ingest(taskId: string, messageId: string, attachments: readonly DiscordInputAttachment[], fetchAttachment: FetchAttachment = fetch): Promise<TaskAttachmentResult> {
    segment(taskId, "taskId"); segment(messageId, "messageId"); const directory = resolve(this.#root, taskId, "input", messageId); await mkdir(directory, { recursive: true, mode: 0o700 });
    const files: IngestedTaskAttachment[] = []; const images: ImageContent[] = []; const errors: string[] = []; const names = new Set<string>(); let total = 0;
    for (const [index, attachment] of attachments.entries()) {
      const contentType = attachment.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (index >= this.#maxCount) { errors.push(`${attachment.name}: at most ${String(this.#maxCount)} attachments are allowed.`); continue; }
      if (!TEXT_TYPES.has(contentType) && !IMAGE_TYPES.has(contentType)) { errors.push(`${attachment.name}: unsupported attachment type ${contentType || "unknown"}.`); continue; }
      if (attachment.size > this.#maxInputBytesEach) { errors.push(`${attachment.name}: exceeds the ${String(this.#maxInputBytesEach)} byte per-file limit.`); continue; }
      if (total + attachment.size > this.#maxInputBytesTotal) { errors.push(`${attachment.name}: exceeds the ${String(this.#maxInputBytesTotal)} byte total limit.`); continue; }
      try {
        const response = await fetchAttachment(attachment.url); if (!response.ok) throw new Error(`download returned HTTP ${String(response.status)}`);
        const bytes = await readBounded(response, Math.min(this.#maxInputBytesEach, this.#maxInputBytesTotal - total)); const name = uniqueName(sanitizeName(attachment.name), names); const path = resolve(directory, name); await writeFile(path, bytes, { mode: 0o600 }); total += bytes.byteLength;
        const image = IMAGE_TYPES.has(contentType); files.push({ name, path, contentType, size: bytes.byteLength, image }); if (image) images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: contentType });
      } catch (error) { errors.push(`${attachment.name}: could not be downloaded: ${error instanceof Error ? error.message : String(error)}.`); }
    }
    const prompt = files.length === 0 ? "" : `\n\nDiscord attachments (inputs only; do not execute automatically):\n${files.map((file) => `- ${file.path} (${file.contentType})`).join("\n")}`;
    return { files, images, prompt, errors };
  }
  outputFor(taskId: string): TaskOutputQueue { segment(taskId, "taskId"); let result = this.#outputs.get(taskId); if (result === undefined) { result = new TaskOutputQueue(resolve(this.#root, taskId, "output"), this.#maxOutputBytesEach, this.#maxOutputCount); this.#outputs.set(taskId, result); } return result; }
  cleanupMessage(taskId: string, messageId: string): Promise<void> { segment(taskId, "taskId"); segment(messageId, "messageId"); return rm(resolve(this.#root, taskId, "input", messageId), { recursive: true, force: true }); }
  cleanupInputs(taskId: string): Promise<void> { segment(taskId, "taskId"); return rm(resolve(this.#root, taskId, "input"), { recursive: true, force: true }); }
  async cleanupFiles(paths: readonly string[]): Promise<void> { await Promise.all(paths.map((path) => rm(path, { force: true }))); }
  async cleanupTask(taskId: string): Promise<void> { segment(taskId, "taskId"); this.#outputs.delete(taskId); await rm(resolve(this.#root, taskId), { recursive: true, force: true }); }
}

export class TaskOutputQueue {
  readonly directory: string; readonly #queued: string[] = [];
  constructor(directory: string, readonly maxBytesEach: number, readonly maxCount: number) { this.directory = resolve(directory); }
  async enqueue(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error("discord_attach requires an absolute path"); const path = resolve(input); if (!within(this.directory, path)) throw new Error("Path is outside this task's output directory");
    let details; let canonical: string; try { details = await lstat(path); canonical = await realpath(path); } catch { throw new Error("Path does not exist"); }
    if (details.isSymbolicLink() || !details.isFile()) throw new Error("Path must be a regular file and not a symbolic link"); if (!within(this.directory, canonical)) throw new Error("Resolved path is outside this task's output directory");
    if ((await stat(canonical)).size > this.maxBytesEach) throw new Error(`File exceeds the ${String(this.maxBytesEach)} byte Discord output size limit`); if (!this.#queued.includes(canonical) && this.#queued.length >= this.maxCount) throw new Error(`At most ${String(this.maxCount)} output files may be attached per reply`);
    if (!this.#queued.includes(canonical)) this.#queued.push(canonical); return canonical;
  }
  take(): string[] { return this.#queued.splice(0); }
}

const parameters = Type.Object({ path: Type.String({ description: "Absolute path to a generated file in this task's approved output directory" }) });
export function createTaskDiscordAttachTool(queue: TaskOutputQueue): ToolDefinition<typeof parameters> { return { name: "discord_attach", label: "Attach file to Discord", description: `Attach a generated file from ${queue.directory} to the next final Discord reply. Create or copy the file into that directory first.`, parameters, execute: async (_id, params) => ({ content: [{ type: "text", text: `Queued ${basename(await queue.enqueue(params.path))} for Discord.` }], details: {} }) }; }
function sanitizeName(input: string): string { const cleaned: string = basename(input.replaceAll("\\", "/")).normalize("NFKC").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+/u, "").slice(0, 120); switch (cleaned) { case "": case ".": case "..": return "attachment"; default: return cleaned; } }
function uniqueName(name: string, names: Set<string>): string { let result = name; let n = 2; while (names.has(result.toLowerCase())) result = `${name}-${String(n++)}`; names.add(result.toLowerCase()); return result; }
function segment(value: string, label: string): void { if (value === "" || value === "." || value === ".." || /[\\/]/u.test(value)) throw new Error(`${label} must be a path segment`); }
function within(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !isAbsolute(value)); }
async function readBounded(response: Response, limit: number): Promise<Uint8Array> { if (response.body === null) return new Uint8Array(); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; try { let finished = false; while (!finished) { const { done, value } = await reader.read(); finished = done; if (!done) { size += value.byteLength; if (size > limit) throw new Error("downloaded content exceeds configured size limits"); chunks.push(value); } } } catch (error) { await reader.cancel().catch(() => undefined); throw error; } const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result; }
