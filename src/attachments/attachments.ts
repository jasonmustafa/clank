import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Attachment } from "discord.js";
import type { ImageContent } from "@earendil-works/pi-ai";

export interface DownloadedAttachment {
  path: string;
  fileName: string;
  contentType?: string;
  size: number;
  isImage: boolean;
  image?: ImageContent;
}

export interface AttachmentDownloadOptions {
  dir: string;
  maxBytes: number;
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned || `attachment-${Date.now()}`;
}

function isImageContentType(contentType: string | undefined, fileName: string): boolean {
  if (contentType?.toLowerCase().startsWith("image/")) return true;
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extname(fileName).toLowerCase());
}

function guessContentType(contentType: string | undefined, fileName: string): string | undefined {
  if (contentType) return contentType;
  const ext = extname(fileName).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return undefined;
}

export async function downloadDiscordAttachments(
  attachments: Iterable<Attachment>,
  options: AttachmentDownloadOptions,
): Promise<DownloadedAttachment[]> {
  await mkdir(options.dir, { recursive: true });
  const downloaded: DownloadedAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.size > options.maxBytes) {
      throw new Error(`Attachment ${attachment.name ?? attachment.id} exceeds ${options.maxBytes} bytes`);
    }
    const fileName = `${Date.now()}-${attachment.id}-${sanitizeFileName(attachment.name ?? "file")}`;
    const targetPath = join(options.dir, fileName);
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Failed to download ${attachment.url}: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > options.maxBytes) {
      throw new Error(`Attachment ${fileName} exceeds ${options.maxBytes} bytes`);
    }
    const buffer = Buffer.from(arrayBuffer);
    await writeFile(targetPath, buffer);
    const contentType = guessContentType(attachment.contentType ?? response.headers.get("content-type") ?? undefined, fileName);
    const isImage = isImageContentType(contentType, fileName);
    const item: DownloadedAttachment = {
      path: targetPath,
      fileName,
      contentType,
      size: buffer.byteLength,
      isImage,
    };
    if (isImage && contentType) {
      item.image = { type: "image", data: buffer.toString("base64"), mimeType: contentType };
    }
    downloaded.push(item);
  }
  return downloaded;
}

export function formatAttachmentPrompt(downloaded: DownloadedAttachment[]): string {
  if (downloaded.length === 0) return "";
  const lines = ["", "Discord attachments were downloaded locally:"];
  for (const file of downloaded) {
    lines.push(`- ${file.path}${file.contentType ? ` (${file.contentType})` : ""}`);
  }
  lines.push("Use read/bash tools on these paths as needed. Images are also attached as image inputs when supported.");
  return lines.join("\n");
}
