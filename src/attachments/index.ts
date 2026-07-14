import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface DiscordAttachment { name: string; url: string; size: number; contentType?: string | null; }
export interface IngestedAttachment { name: string; path: string; contentType: string; size: number; image: boolean; }
export interface AttachmentIngestionResult {
  files: readonly IngestedAttachment[];
  images: readonly ImageContent[];
  prompt: string;
  errors: readonly string[];
}
export interface AttachmentLimits { temporaryRoot: string; maxCount?: number; maxBytesEach?: number; maxBytesTotal?: number; }
type FetchAttachment = (url: string) => Promise<Response>;

export class AttachmentIngestor {
  readonly #maxCount: number;
  readonly #maxBytesEach: number;
  readonly #maxBytesTotal: number;
  constructor(private readonly options: AttachmentLimits) {
    this.#maxCount = options.maxCount ?? 10;
    this.#maxBytesEach = options.maxBytesEach ?? 25 * 1024 * 1024;
    this.#maxBytesTotal = options.maxBytesTotal ?? 50 * 1024 * 1024;
  }

  async ingest(jobId: string, attachments: readonly DiscordAttachment[], fetchAttachment: FetchAttachment = fetch): Promise<AttachmentIngestionResult> {
    assertPathSegment(jobId, "jobId");
    const directory = resolve(this.options.temporaryRoot, jobId, "attachments");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files: IngestedAttachment[] = [];
    const images: ImageContent[] = [];
    const errors: string[] = [];
    let total = 0;
    const names = new Set<string>();

    for (const [index, attachment] of attachments.entries()) {
      if (index >= this.#maxCount) {
        errors.push(`Attachment ${attachment.name} rejected: at most ${String(this.#maxCount)} attachment${this.#maxCount === 1 ? " is" : "s are"} allowed per message.`);
        continue;
      }
      if (attachment.size > this.#maxBytesEach) {
        errors.push(`Attachment ${attachment.name} exceeds the ${String(this.#maxBytesEach)} byte per-file limit.`);
        continue;
      }
      if (total + attachment.size > this.#maxBytesTotal) {
        errors.push(`Attachment ${attachment.name} exceeds the ${String(this.#maxBytesTotal)} byte total attachment limit.`);
        continue;
      }
      try {
        const response = await fetchAttachment(attachment.url);
        if (!response.ok) throw new Error(`download returned HTTP ${String(response.status)}`);
        const bytes = await readBounded(response, Math.min(this.#maxBytesEach, this.#maxBytesTotal - total));
        const name = uniqueName(sanitizeAttachmentName(attachment.name), names);
        const path = resolve(directory, name);
        await writeFile(path, bytes, { mode: 0o600 });
        total += bytes.byteLength;
        const suppliedContentType = attachment.contentType?.split(";", 1)[0]?.trim().toLowerCase();
        const contentType = suppliedContentType === undefined || suppliedContentType === "" ? "application/octet-stream" : suppliedContentType;
        const image = contentType.startsWith("image/");
        files.push({ name, path, contentType, size: bytes.byteLength, image });
        if (image) images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: contentType });
      } catch (error) {
        errors.push(`Attachment ${attachment.name} could not be downloaded: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
    const prompt = files.length === 0 ? "" : `\n\nLocal Discord attachments:\n${files.map((file) => `- ${file.path} (${file.contentType})`).join("\n")}`;
    return { files, images, prompt, errors };
  }
}

export function sanitizeAttachmentName(input: string): string {
  const cleaned = basename(input.replaceAll("\\", "/"))
    .normalize("NFKC").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+/u, "").slice(0, 120);
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "attachment";
  return cleaned;
}

function uniqueName(name: string, names: Set<string>): string {
  let result = name;
  let suffix = 2;
  while (names.has(result.toLowerCase())) result = `${name}-${String(suffix++)}`;
  names.add(result.toLowerCase());
  return result;
}

export interface DiscordAttachmentQueueOptions { workspaceRoot: string; outputRoot: string; }
export class DiscordAttachmentQueue {
  readonly #queued: string[] = [];
  readonly #roots: string[];
  constructor(options: DiscordAttachmentQueueOptions) { this.#roots = [resolve(options.workspaceRoot), resolve(options.outputRoot)]; }
  async enqueue(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error("discord_attach requires an absolute path");
    const path = resolve(input);
    if (!this.#roots.some((root) => isWithin(root, path))) throw new Error("Path is outside the job workspace/output roots");
    if (secretLooking(path)) throw new Error("Path is protected or secret-looking");
    let details;
    let canonicalPath: string;
    try { details = await lstat(path); canonicalPath = await realpath(path); } catch { throw new Error("Path does not exist"); }
    if (details.isSymbolicLink() || !details.isFile()) throw new Error("Path must be a regular file and not a symbolic link");
    if (!this.#roots.some((root) => isWithin(root, canonicalPath))) throw new Error("Resolved path is outside the job workspace/output roots");
    if (secretLooking(canonicalPath)) throw new Error("Path is protected or secret-looking");
    if (!this.#queued.includes(canonicalPath)) this.#queued.push(canonicalPath);
    return canonicalPath;
  }
  take(): string[] { return this.#queued.splice(0); }
}

const attachParameters = Type.Object({ path: Type.String({ description: "Absolute path to a generated file in this job's workspace or output directory" }) });
export function createDiscordAttachTool(queue: DiscordAttachmentQueue): ToolDefinition<typeof attachParameters> {
  return {
    name: "discord_attach",
    label: "Attach file to Discord",
    description: "Queue one generated file for upload with the next or final Discord reply.",
    parameters: attachParameters,
    execute: async (_toolCallId, params) => {
      const path = await queue.enqueue(params.path);
      return { content: [{ type: "text", text: `Queued ${basename(path)} for the next Discord reply.` }], details: {} };
    },
  };
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    let finished = false;
    while (!finished) {
      const { done, value } = await reader.read();
      finished = done;
      if (!done) {
        size += value.byteLength;
        if (size > limit) throw new Error("downloaded content exceeds configured size limits");
        chunks.push(value);
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function isWithin(root: string, path: string): boolean { const value = relative(root, path); return value === "" || (!value.startsWith("..") && !isAbsolute(value)); }
function secretLooking(path: string): boolean {
  return path.split(/[\\/]/u).some((part) => /^(?:\.env(?:\..*)?|\.git|\.ssh|auth\.json|credentials?|secrets?|.*\.(?:pem|key|p12))$/iu.test(part));
}
function assertPathSegment(value: string, label: string): void { if (value === "" || value === "." || value === ".." || /[\\/]/u.test(value)) throw new Error(`${label} must be a path segment`); }
