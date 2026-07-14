import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeploymentManager, type DeploymentCommandRunner } from "./index.js";

const policy = {
  appPath: "/srv/clank/app",
  remote: "origin",
  branch: "main",
  checks: {
    install: ["npm", "ci"], typecheck: ["npm", "run", "check"], tests: ["npm", "test"],
    build: ["npm", "run", "build"], registerCommands: ["npm", "run", "register-commands"],
  },
};

async function fixture(failAt?: string) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "clank-deploy-"));
  let head = "old-good";
  const calls: { executable: string; args: readonly string[]; cwd: string }[] = [];
  const runner: DeploymentCommandRunner = { run(executable, args, options) {
    calls.push({ executable, args, cwd: options.cwd });
    if (executable === "git" && args[0] === "rev-parse") return Promise.resolve({ exitCode: 0, stdout: args[1] === "HEAD" ? `${head}\n` : "new-commit\n", stderr: "" });
    if (executable === "git" && args[0] === "reset") head = args[2] ?? head;
    const label = [executable, ...args].join(" ");
    return Promise.resolve(label === failAt ? { exitCode: 1, stdout: "", stderr: "token=secret noisy failure\nsecond line" } : { exitCode: 0, stdout: "", stderr: "" });
  } };
  const restart = vi.fn(() => Promise.resolve({ ok: true, output: "" }));
  return { manager: new DeploymentManager(policy, stateDirectory, runner, restart), calls, restart, stateDirectory };
}

describe("DeploymentManager", () => {
  it("deploys only the configured remote branch and runs every check before restart", async () => {
    const { manager, calls, restart, stateDirectory } = await fixture();
    const result = await manager.deploy({ requesterId: "owner", channelId: "channel" });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => [call.executable, ...call.args])).toEqual([
      ["git", "rev-parse", "HEAD"], ["git", "fetch", "--", "origin", "main"],
      ["git", "rev-parse", "FETCH_HEAD"], ["git", "reset", "--hard", "new-commit"],
      ...Object.values(policy.checks),
    ]);
    expect(calls.every((call) => call.cwd === policy.appPath)).toBe(true);
    expect(restart).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(stateDirectory, "pending-deploy.json"), "utf8"))).toMatchObject({ fromCommit: "old-good", toCommit: "new-commit", channelId: "channel", operation: "deploy" });
  });

  it("restores the original checkout and does not restart when a check fails", async () => {
    const { manager, calls, restart } = await fixture("npm test");
    const result = await manager.deploy({ requesterId: "owner", channelId: "channel" });
    expect(result).toMatchObject({ ok: false, stage: "tests" });
    expect(result.summary).not.toContain("secret");
    expect(calls.at(-1)?.args).toEqual(["reset", "--hard", "old-good"]);
    expect(restart).not.toHaveBeenCalled();
  });

  it("finalizes a pending deploy atomically and rolls back to the previous good commit", async () => {
    const { manager, restart, stateDirectory } = await fixture();
    await manager.deploy({ requesterId: "owner", channelId: "channel" });
    const pending = await manager.completePending();
    expect(pending).toMatchObject({ toCommit: "new-commit", channelId: "channel" });
    const history = JSON.parse(await readFile(join(stateDirectory, "deploy-history.json"), "utf8")) as { commits: string[] };
    expect(history.commits).toEqual(["old-good", "new-commit"]);
    const result = await manager.rollback({ requesterId: "owner", channelId: "channel" });
    expect(result.ok).toBe(true);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(join(stateDirectory, "pending-deploy.json"), "utf8"))).toMatchObject({ toCommit: "old-good", operation: "rollback" });
  });
});
