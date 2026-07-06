export const DISCORD_SAFE_MESSAGE_LIMIT = 1900;

export function escapeMassMentions(text: string): string {
  return text.replace(/@(everyone|here)/gi, "@\u200b$1");
}

function splitLongToken(token: string, maxLength: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < token.length; i += maxLength) {
    chunks.push(token.slice(i, i + maxLength));
  }
  return chunks;
}

export function chunkText(text: string, maxLength = DISCORD_SAFE_MESSAGE_LIMIT): string[] {
  const normalized = escapeMassMentions(text || "").replace(/\r\n/g, "\n");
  if (normalized.length <= maxLength) return [normalized || "(no text)"];

  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.length > 0) chunks.push(current);
    current = "";
  };

  const appendPart = (part: string, separator: string) => {
    if (part.length > maxLength) {
      pushCurrent();
      chunks.push(...splitLongToken(part, maxLength));
      return;
    }

    const candidate = current.length === 0 ? part : `${current}${separator}${part}`;
    if (candidate.length <= maxLength) {
      current = candidate;
      return;
    }

    pushCurrent();
    current = part;
  };

  for (const paragraph of normalized.split(/\n\n+/)) {
    if (paragraph.length === 0) continue;
    if (paragraph.length <= maxLength) {
      appendPart(paragraph, "\n\n");
      continue;
    }

    for (const line of paragraph.split("\n")) {
      if (line.length <= maxLength) {
        appendPart(line, "\n");
        continue;
      }

      for (const word of line.split(/(\s+)/)) {
        if (word.length === 0) continue;
        appendPart(word, "");
      }
    }
  }

  pushCurrent();
  return chunks.length > 0 ? chunks : ["(no text)"];
}

export function previewText(text: string, maxLength = 1600): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
