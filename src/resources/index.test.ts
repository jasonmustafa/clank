import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ResourceUpdater, resolveResourcePaths } from "./index.js";
import type { ResourceSource } from "../config/index.js";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function repository(): Promise<{ remote: string; first: string; second: string }> {
  const root = await mkdtemp(join(tmpdir(), "clank-resource-git-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  await git(root, "init", "--bare", remote);
  await git(root, "clone", remote, work);
  await git(work, "config", "user.name", "Test");
  await git(work, "config", "user.email", "test@example.test");
  await mkdir(join(work, "skills", "one"), { recursive: true });
  await writeFile(join(work, "skills", "one", "SKILL.md"), "one");
  await git(work, "add", "."); await git(work, "commit", "-m", "first"); await git(work, "push", "origin", "HEAD:main");
  const first = await git(work, "rev-parse", "HEAD");
  await mkdir(join(work, "extensions")); await writeFile(join(work, "extensions", "trusted.ts"), "export default () => {};");
  await writeFile(join(work, "package.json"), JSON.stringify({ name: "trusted-package" }));
  await git(work, "add", "."); await git(work, "commit", "-m", "extension"); await git(work, "push", "origin", "HEAD:main");
  const second = await git(work, "rev-parse", "HEAD");
  return { remote, first, second };
}

function source(repo: string, ref: string, extensions: string[] = []): ResourceSource {
  return { id: "trusted", repo, ref, skills: ["skills/*/SKILL.md"], prompts: [], extensions };
}

describe("trusted resource repositories", () => {
  it("resolves configured globs within a checkout by resource type", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "clank-resolve-"));
    await mkdir(join(checkout, "skills", "one"), { recursive: true });
    await mkdir(join(checkout, "prompts"));
    await writeFile(join(checkout, "skills", "one", "SKILL.md"), "one");
    await writeFile(join(checkout, "prompts", "review.md"), "review");
    const resolved = await resolveResourcePaths({ ...source("repo", "main"), prompts: ["prompts/*.md"] }, checkout);
    expect(resolved.skills).toEqual([join(checkout, "skills", "one", "SKILL.md")]);
    expect(resolved.prompts).toEqual([join(checkout, "prompts", "review.md")]);
  });

  it("plans extension updates, requires confirmation, resets, and atomically records refs", async () => {
    const repo = await repository();
    const root = await mkdtemp(join(tmpdir(), "clank-update-"));
    const statePath = join(root, "state", "resource-refs.json");
    const updater = new ResourceUpdater({ checkoutRoot: join(root, "checkouts"), statePath });
    await updater.apply(await updater.plan([source(repo.remote, repo.first)]));

    const plan = await updater.plan([source(repo.remote, repo.second)]);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.summary).toContain("extension");
    await expect(updater.apply(plan)).rejects.toThrow("owner confirmation");
    await updater.apply(plan, { ownerConfirmed: true });

    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ trusted: repo.second });
    expect(await git(join(root, "checkouts", "trusted"), "rev-parse", "HEAD")).toBe(repo.second);
  });
});
