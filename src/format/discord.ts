import type { Message, MessageCreateOptions } from "discord.js";
import { chunkText, previewText } from "./chunk.js";

export const NO_MENTIONS = { parse: [] as [] };

export type SendableChannel = {
  id: string;
  send(options: string | MessageCreateOptions): Promise<Message>;
};

export async function sendChunked(channel: SendableChannel, text: string, options: Omit<MessageCreateOptions, "content"> = {}): Promise<void> {
  for (const chunk of chunkText(text)) {
    await channel.send({ ...options, content: chunk, allowedMentions: NO_MENTIONS });
  }
}

export function formatJobTitle(input: string): string {
  const firstLine = input.replace(/\s+/g, " ").trim();
  const title = firstLine.length > 0 ? firstLine : "Clank job";
  return previewText(title, 80);
}

export function formatToolStatus(toolName: string, state: "start" | "end" | "error"): string {
  const icon = state === "start" ? "🔧" : state === "error" ? "⚠️" : "✅";
  return `${icon} ${toolName}`;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
