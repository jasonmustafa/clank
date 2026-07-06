import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parsePathList } from "../src/config/env.js";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "token",
    DISCORD_ALLOWED_USER_IDS: "u1",
    ...overrides,
  };
}

describe("environment config", () => {
  it("parses comma and whitespace separated path lists", () => {
    expect(parsePathList("/a,/b  /c\n/d")).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("defaults allowed roots to workspace root, Clank app dir, and Pi agent dir", () => {
    const config = loadConfig(baseEnv());
    expect(config.allowedRootDirs).toEqual([
      resolve("/opt/clank/workspaces"),
      resolve("/opt/clank/app"),
      resolve("/opt/clank/pi-agent"),
    ]);
  });

  it("parses custom allowed roots and resolves/dedupes them", () => {
    const config = loadConfig(
      baseEnv({
        CLANK_WORKSPACE_ROOT: "relative-workspaces",
        CLANK_ALLOWED_ROOTS: "/opt/test-a, /opt/test-b /opt/test-a ./relative-root",
      }),
    );
    expect(config.allowedRootDirs).toEqual([
      resolve("relative-workspaces"),
      resolve("/opt/test-a"),
      resolve("/opt/test-b"),
      resolve("./relative-root"),
    ]);
  });

  it("always includes the workspace root when custom allowed roots are set", () => {
    const config = loadConfig(baseEnv({ CLANK_WORKSPACE_ROOT: "/workspace", CLANK_ALLOWED_ROOTS: "/repo" }));
    expect(config.allowedRootDirs).toContain(resolve("/workspace"));
    expect(config.allowedRootDirs).toContain(resolve("/repo"));
  });
});
