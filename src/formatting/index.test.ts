import { describe, expect, it } from "vitest";
import { chunkDiscordMessage } from "./index.js";

describe("chunkDiscordMessage", () => {
  it("prefers line boundaries and preserves all text", () => {
    const text = "first line\nsecond line\nthird";
    const chunks = chunkDiscordMessage(text, 18);
    expect(chunks).toEqual(["first line\n", "second line\nthird"]);
    expect(chunks.join("")).toBe(text);
  });

  it("hard-splits text with no suitable boundary", () => {
    expect(chunkDiscordMessage("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("returns no messages for empty text", () => {
    expect(chunkDiscordMessage("")).toEqual([]);
  });
});
