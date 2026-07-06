import { describe, expect, it } from "vitest";
import { chunkText, escapeMassMentions } from "../src/format/chunk.js";

describe("chunkText", () => {
  it("keeps chunks under the configured limit", () => {
    const chunks = chunkText("a".repeat(25), 10);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks.join("")).toBe("a".repeat(25));
  });

  it("escapes mass mentions", () => {
    expect(escapeMassMentions("hi @everyone and @here")).toContain("@\u200beveryone");
  });
});
