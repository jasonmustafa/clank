export const DISCORD_MESSAGE_LIMIT = 1_900;

/** Split text without losing whitespace, preferring a newline near the limit. */
export function chunkDiscordMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf("\n", limit - 1);
    const splitAt = newline >= Math.floor(limit / 2) ? newline + 1 : limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
