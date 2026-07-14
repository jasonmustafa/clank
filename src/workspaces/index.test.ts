import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorkspaceRegistry, type GitExecutor, type WorkspacePolicy } from "./index.js";

const policy: WorkspacePolicy = {
  root: "/srv/clank/workspaces",
  allowedRepositories: ["octo/project", "octo/vault"],
  commitAuthorName: "Owner Name",
  commitAuthorEmail: "12345+owner@users.noreply.github.com",
  commitFooter: "Generated-by: Clank, owner's clanker",
  entries: [
    { aliases: ["project", "main"], repository: "octo/project", canonicalPath: "/srv/repos/project" },
    { aliases: ["vault"], repository: "octo/vault", canonicalPath: "/srv/vaults/notes" },
  ],
};

class FakeGit implements GitExecutor {
  readonly calls: { args: readonly string[]; cwd?: string }[] = [];
  async run(args: readonly string[], cwd?: string): Promise<void> {
    this.calls.push(cwd === undefined ? { args } : { args, cwd });
    if (args[0] === "clone") {
      const destination = args.at(-1);
      if (destination === undefined) throw new Error("missing destination");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(destination, ".git", "hooks"), { recursive: true }));
    }
  }
}

async function localPolicy(): Promise<WorkspacePolicy> {
  return { ...policy, root: await mkdtemp(join(tmpdir(), "clank-workspaces-")) };
}

describe("WorkspaceRegistry", () => {
  it("resolves aliases and GitHub URLs to configured metadata and job paths", async () => {
    const registry = new WorkspaceRegistry(await localPolicy(), new FakeGit());
    const alias = registry.resolve("project", "job-1");
    const url = registry.resolve("https://github.com/octo/project.git", "job-2");

    expect(alias).toMatchObject({ repository: "octo/project", source: "/srv/repos/project", prAllowed: true, publicOnly: false });
    expect(alias.destination).toMatch(/\/jobs\/job-1$/u);
    expect(url).toMatchObject({ repository: "octo/project", source: "/srv/repos/project", prAllowed: true });
    expect(url.destination).toMatch(/\/jobs\/job-2$/u);
    expect(registry.requestFrom("Please work on the vault today")).toBe("vault");
    expect(registry.requestFrom("Review https://github.com/elsewhere/public.git please")).toBe("https://github.com/elsewhere/public.git");
    expect(registry.requestFrom("Just answer a question")).toBeUndefined();
  });

  it("allows arbitrary public GitHub repositories without PR capability", async () => {
    const registry = new WorkspaceRegistry(await localPolicy(), new FakeGit());
    expect(registry.resolve("https://github.com/elsewhere/public", "public-job")).toMatchObject({
      repository: "elsewhere/public",
      source: "https://github.com/elsewhere/public.git",
      prAllowed: false,
      publicOnly: true,
    });
    expect(() => registry.resolve("https://gitlab.com/elsewhere/public", "bad")).toThrow("GitHub");
  });

  it("creates an empty workspace for non-repo jobs", async () => {
    const local = await localPolicy();
    const git = new FakeGit();
    const registry = new WorkspaceRegistry(local, git);
    const prepared = await registry.prepare(undefined, "empty-job");

    expect(prepared.kind).toBe("empty");
    expect(prepared.path).toBe(join(local.root, "jobs", "empty-job"));
    expect(git.calls).toEqual([]);
  });

  it("clones into a per-job path and configures local identity and footer hook", async () => {
    const local = await localPolicy();
    const git = new FakeGit();
    const registry = new WorkspaceRegistry(local, git);
    const prepared = await registry.prepare("vault", "repo-job");

    expect(git.calls[0]).toEqual({ args: ["clone", "--", "/srv/vaults/notes", prepared.path], cwd: undefined });
    expect(git.calls).toContainEqual({ args: ["config", "--local", "user.name", policy.commitAuthorName], cwd: prepared.path });
    expect(git.calls).toContainEqual({ args: ["config", "--local", "user.email", policy.commitAuthorEmail], cwd: prepared.path });
    expect(prepared.prAllowed).toBe(true);

    const hook = join(prepared.path, ".git", "hooks", "commit-msg");
    await chmod(hook, 0o755);
    const message = join(local.root, "message.txt");
    await writeFile(message, "Subject\n");
    const runFile = promisify(execFile);
    await runFile(hook, [message]);
    await runFile(hook, [message]);
    expect(await readFile(message, "utf8")).toBe(`Subject\n\n${policy.commitFooter}\n`);
  });

  it("rejects unsafe job IDs rather than escaping the jobs root", async () => {
    const registry = new WorkspaceRegistry(await localPolicy(), new FakeGit());
    expect(() => registry.resolve("project", "../shared")).toThrow("job ID");
  });
});
