import { describe, expect, it } from "vitest";
import { commandTouchesSensitivePath, explainPathPolicy, isAllowedByRoots, uniqueResolvedPaths } from "../src/safety/pathProtection.js";

const config = {
  workspaceRoot: "/opt/clank/workspaces",
  piAgentDir: "/opt/clank/pi-agent",
  clankAppDir: "/opt/clank/app",
  allowedRoots: ["/opt/clank/app", "/opt/clank/pi-agent", "/opt/clank/workspaces/job1"],
  mode: "self-improvement" as const,
};

describe("path protection", () => {
  it("allows standard mode to read Clank repo files when the repo is globally allowed", () => {
    expect(
      explainPathPolicy("/opt/clank/app/.gitignore", "/opt/clank/workspaces/job1", {
        ...config,
        mode: "standard",
      }),
    ).toBeUndefined();
  });

  it("blocks paths outside allowed roots", () => {
    expect(explainPathPolicy("/etc/passwd", "/opt/clank/app", config)).toContain("outside allowed roots");
  });

  it("allows Clank repo files", () => {
    expect(explainPathPolicy("package.json", "/opt/clank/app", config)).toBeUndefined();
  });

  it("allows Pi resource subdirs but blocks auth/model/settings", () => {
    expect(explainPathPolicy("/opt/clank/pi-agent/skills/demo/SKILL.md", "/opt/clank/app", config)).toBeUndefined();
    expect(explainPathPolicy("/opt/clank/pi-agent/auth.json", "/opt/clank/app", config)).toContain("protected");
    expect(explainPathPolicy("/opt/clank/pi-agent/models.json", "/opt/clank/app", config)).toContain("protected");
    expect(explainPathPolicy("/opt/clank/pi-agent/settings.json", "/opt/clank/app", config)).toContain("protected");
  });

  it("blocks real .env files but allows .env.example templates", () => {
    expect(explainPathPolicy(".env", "/opt/clank/app", config)).toContain("protected");
    expect(explainPathPolicy(".env.local", "/opt/clank/app", config)).toContain("protected");
    expect(explainPathPolicy(".env.example", "/opt/clank/app", config)).toBeUndefined();
  });

  it("blocks secret command references", () => {
    expect(commandTouchesSensitivePath("cat /etc/clank/clank.env", config)).toContain("protected");
    expect(commandTouchesSensitivePath("cat .env", config)).toContain(".env");
    expect(commandTouchesSensitivePath("cat .env.example", config)).toBeUndefined();
  });

  it("blocks obvious absolute bash path references outside allowed roots", () => {
    expect(commandTouchesSensitivePath("cat /etc/passwd", config)).toContain("outside allowed roots");
    expect(commandTouchesSensitivePath("ls /proc", config)).toContain("outside allowed roots");
    expect(commandTouchesSensitivePath("ls /opt/clank/app", config)).toBeUndefined();
  });

  it("exports allowed root helpers", () => {
    const roots = uniqueResolvedPaths(["/tmp/root", "/tmp/root", "/tmp/root/sub/.."]) ;
    expect(roots).toEqual(["/tmp/root"]);
    expect(isAllowedByRoots("/tmp/root/file.txt", roots)).toBe(true);
    expect(isAllowedByRoots("/tmp/other/file.txt", roots)).toBe(false);
  });
});
