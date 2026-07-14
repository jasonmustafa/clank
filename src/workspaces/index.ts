import { execFile } from "node:child_process";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export interface WorkspaceEntry {
  aliases: readonly string[];
  repository: string;
  canonicalPath?: string;
}

export interface WorkspacePolicy {
  root: string;
  allowedRepositories: readonly string[];
  commitAuthorName: string;
  commitAuthorEmail: string;
  commitFooter: string;
  entries: readonly WorkspaceEntry[];
}

export interface GitExecutor {
  run(args: readonly string[], cwd?: string): Promise<void>;
}

export interface WorkspaceResolution {
  repository: string;
  source: string;
  destination: string;
  prAllowed: boolean;
  publicOnly: boolean;
  configured: boolean;
}

export type PreparedWorkspace = {
  kind: "empty";
  path: string;
  prAllowed: false;
} | {
  kind: "repository";
  path: string;
  repository: string;
  prAllowed: boolean;
  publicOnly: boolean;
};

export class SystemGitExecutor implements GitExecutor {
  async run(args: readonly string[], cwd?: string): Promise<void> {
    await execFileAsync("git", [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false" },
    });
  }
}

export class WorkspaceRegistry {
  readonly #entriesByAlias = new Map<string, WorkspaceEntry>();
  readonly #entriesByRepository = new Map<string, WorkspaceEntry>();

  constructor(
    private readonly policy: WorkspacePolicy,
    private readonly git: GitExecutor = new SystemGitExecutor(),
  ) {
    for (const entry of policy.entries) {
      const repository = normalizeRepository(entry.repository);
      if (this.#entriesByRepository.has(repository)) throw new Error(`Duplicate workspace repository: ${repository}`);
      this.#entriesByRepository.set(repository, entry);
      for (const alias of entry.aliases) {
        const key = alias.toLowerCase();
        if (this.#entriesByAlias.has(key)) throw new Error(`Duplicate workspace alias: ${alias}`);
        this.#entriesByAlias.set(key, entry);
      }
    }
  }

  requestFrom(content: string): string | undefined {
    const githubUrl = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:\/?)(?=$|\s)/iu.exec(content)?.[0];
    if (githubUrl !== undefined) return githubUrl;
    const words = new Set(content.toLowerCase().split(/[^a-z0-9_.-]+/u));
    return [...this.#entriesByAlias.keys()].find((alias) => words.has(alias));
  }

  resolve(request: string, jobId: string): WorkspaceResolution {
    const destination = this.jobPath(jobId);
    const aliasEntry = this.#entriesByAlias.get(request.trim().toLowerCase());
    const requestedRepository = aliasEntry === undefined ? githubRepository(request) : normalizeRepository(aliasEntry.repository);
    const entry = aliasEntry ?? this.#entriesByRepository.get(requestedRepository);
    const repository = entry === undefined ? requestedRepository : normalizeRepository(entry.repository);
    const configured = entry !== undefined;
    return {
      repository,
      source: entry?.canonicalPath ?? githubCloneUrl(repository),
      destination,
      prAllowed: configured && this.policy.allowedRepositories.map(normalizeRepository).includes(repository),
      publicOnly: !configured,
      configured,
    };
  }

  async prepare(request: string | undefined, jobId: string): Promise<PreparedWorkspace> {
    const path = this.jobPath(jobId);
    await mkdir(join(this.policy.root, "jobs"), { recursive: true });
    await ensureMissing(path);
    if (request === undefined || request.trim() === "") {
      await mkdir(path);
      return { kind: "empty", path, prAllowed: false };
    }

    const resolution = this.resolve(request, jobId);
    try {
      await this.git.run(["clone", "--", resolution.source, path]);
      await this.git.run(["config", "--local", "user.name", this.policy.commitAuthorName], path);
      await this.git.run(["config", "--local", "user.email", this.policy.commitAuthorEmail], path);
      await installCommitMessageHook(path, this.policy.commitFooter);
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
    return {
      kind: "repository",
      path,
      repository: resolution.repository,
      prAllowed: resolution.prAllowed,
      publicOnly: resolution.publicOnly,
    };
  }

  private jobPath(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("Invalid job ID for workspace path");
    return resolve(this.policy.root, "jobs", jobId);
  }
}

function githubRepository(request: string): string {
  const value = request.trim();
  if (REPOSITORY_PATTERN.test(value)) return normalizeRepository(value);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Workspace must be a configured alias or public GitHub repository URL"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username !== "" || url.password !== "") {
    throw new Error("Only public HTTPS GitHub repository URLs are supported");
  }
  const parts = url.pathname.replace(/^\//u, "").replace(/\.git$/u, "").replace(/\/$/u, "").split("/");
  if (parts.length !== 2) throw new Error("GitHub URL must identify an owner and repository");
  return normalizeRepository(parts.join("/"));
}

function normalizeRepository(repository: string): string {
  const normalized = repository.replace(/\.git$/u, "").toLowerCase();
  if (!REPOSITORY_PATTERN.test(normalized)) throw new Error(`Invalid GitHub repository: ${repository}`);
  return normalized;
}

function githubCloneUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

async function ensureMissing(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`Job workspace already exists: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function installCommitMessageHook(repositoryPath: string, footer: string): Promise<void> {
  const hookPath = join(repositoryPath, ".git", "hooks", "commit-msg");
  const quotedFooter = `'${footer.replaceAll("'", `'"'"'`)}'`;
  const script = `#!/bin/sh\nset -eu\nmessage=$1\nfooter=${quotedFooter}\nif ! grep -Fqx -- "$footer" "$message"; then\n  printf '\\n%s\\n' "$footer" >> "$message"\nfi\n`;
  await mkdir(join(repositoryPath, ".git", "hooks"), { recursive: true });
  await writeFile(hookPath, script, { encoding: "utf8", mode: 0o755 });
  await chmod(hookPath, 0o755);
}
