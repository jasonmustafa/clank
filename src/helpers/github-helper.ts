import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { validateGithubHelperRequest, type GithubAuditContext, type GithubHelperRequest, type GithubHelperResult } from "./github-protocol.js";

export interface GithubHelperPolicy { allowedOwners: readonly string[]; allowedRepositories: readonly string[]; workspacesRoot: string; token: string; apiBaseUrl?: string }
export interface GithubProcessResult { exitCode: number; stdout: string }
export interface GithubHelperDependencies {
  run?: (executable: string, args: readonly string[], options: { cwd?: string; environment: Record<string, string>; timeoutMs: number }) => Promise<GithubProcessResult>;
  fetch?: typeof fetch;
  audit?: (entry: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}
const AUDIT_PATH = "/srv/clank/logs/helper-audit.log";

export async function executeGithubRequest(input: unknown, policy: GithubHelperPolicy, context: GithubAuditContext, dependencies: GithubHelperDependencies = {}): Promise<GithubHelperResult> {
  const validation = validateGithubHelperRequest(input);
  if (!validation.ok) throw new Error(`Invalid GitHub helper request: ${validation.error}`);
  const request = validation.value;
  authorize(request, policy);
  const audit = dependencies.audit ?? appendAudit;
  const base = { timestamp: (dependencies.now?.() ?? new Date()).toISOString(), helper: "github", action: request.action, arguments: auditArguments(request), requesterId: safeId(context.requesterId), jobId: safeId(context.jobId) };
  await audit({ ...base, outcome: "started" });
  try {
    const result = request.action === "create-pull-request"
      ? await createPullRequest(request, policy, dependencies.fetch ?? fetch)
      : request.action === "create-issue"
        ? await createIssue(request, policy, dependencies.fetch ?? fetch)
        : await gitAction(request, policy, dependencies.run ?? runGit);
    await audit({ ...base, outcome: result.ok ? "succeeded" : "failed", ...((result.action === "create-pull-request" || result.action === "create-issue") && result.ok ? { number: result.number, url: result.url } : {}) });
    return result;
  } catch (error) {
    await audit({ ...base, outcome: "failed" });
    throw new Error(error instanceof Error && error.message.startsWith("GitHub helper") ? error.message : "GitHub helper operation failed");
  }
}

function authorize(request: GithubHelperRequest, policy: GithubHelperPolicy): void {
  const allowed = policy.allowedRepositories.map((item) => item.toLowerCase());
  const owner = request.repository.split("/")[0] ?? "";
  if (!allowed.includes(request.repository) || !policy.allowedOwners.map((item) => item.toLowerCase()).includes(owner)) throw new Error("GitHub helper denied repository");
  if ("destination" in request) assertWorkspace(request.destination, policy.workspacesRoot);
  if ("workspacePath" in request) assertWorkspace(request.workspacePath, policy.workspacesRoot);
}
function assertWorkspace(path: string, root: string): void {
  if (!isAbsolute(path)) throw new Error("GitHub helper denied workspace path");
  const rel = relative(resolve(root, "jobs"), resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("GitHub helper denied workspace path");
}
async function gitAction(request: Extract<GithubHelperRequest, { action: "clone" | "fetch" | "push-branch" }>, policy: GithubHelperPolicy, run: NonNullable<GithubHelperDependencies["run"]>): Promise<GithubHelperResult> {
  const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GITHUB_TOKEN: policy.token };
  const url = `https://github.com/${request.repository}.git`;
  let args: string[]; let cwd: string | undefined;
  if (request.action === "clone") args = ["-c", "credential.helper=!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f", "clone", "--origin", "origin", "--", url, request.destination];
  else if (request.action === "fetch") { args = ["-c", "credential.helper=!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f", "fetch", "--prune", "--", url]; cwd = request.workspacePath; }
  else { args = ["-c", "credential.helper=!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f", "push", "--", url, `${request.expectedCommit}:refs/heads/${request.branch}`]; cwd = request.workspacePath; }
  const result = await run("/usr/bin/git", args, { ...(cwd === undefined ? {} : { cwd }), environment: env, timeoutMs: 300_000 });
  if (result.exitCode !== 0) return { ok: false, action: request.action, error: "GitHub helper git command failed" };
  return { ok: true, action: request.action };
}
async function createPullRequest(request: Extract<GithubHelperRequest, { action: "create-pull-request" }>, policy: GithubHelperPolicy, requestFetch: typeof fetch): Promise<GithubHelperResult> {
  const response = await requestFetch(`${policy.apiBaseUrl ?? "https://api.github.com"}/repos/${request.repository}/pulls`, { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${policy.token}`, "Content-Type": "application/json", "User-Agent": "Clank" }, body: JSON.stringify({ title: request.title, body: request.body, head: request.head, base: request.base, draft: request.draft }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return { ok: false, action: request.action, error: `GitHub API request failed (${String(response.status)})` };
  const data: unknown = await response.json();
  if (!isPr(data)) throw new Error("GitHub helper received invalid API response");
  return { ok: true, action: request.action, number: data.number, url: data.html_url, draft: request.draft };
}
async function createIssue(request: Extract<GithubHelperRequest, { action: "create-issue" }>, policy: GithubHelperPolicy, requestFetch: typeof fetch): Promise<GithubHelperResult> {
  const response = await requestFetch(`${policy.apiBaseUrl ?? "https://api.github.com"}/repos/${request.repository}/issues`, { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${policy.token}`, "Content-Type": "application/json", "User-Agent": "Clank" }, body: JSON.stringify({ title: request.title, body: request.body }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return { ok: false, action: request.action, error: `GitHub API request failed (${String(response.status)})` };
  const data: unknown = await response.json();
  if (!isNumberedUrl(data)) throw new Error("GitHub helper received invalid API response");
  return { ok: true, action: request.action, number: data.number, url: data.html_url };
}
function isPr(value: unknown): value is { number: number; html_url: string } { return isNumberedUrl(value); }
function isNumberedUrl(value: unknown): value is { number: number; html_url: string } { return typeof value === "object" && value !== null && Number.isInteger((value as Record<string, unknown>).number) && typeof (value as Record<string, unknown>).html_url === "string"; }
function auditArguments(request: GithubHelperRequest): Record<string, unknown> { return { repository: request.repository, ...(request.action === "push-branch" ? { branch: request.branch, expectedCommit: request.expectedCommit } : {}), ...(request.action === "create-pull-request" ? { head: request.head, base: request.base, draft: request.draft } : {}) }; }
function safeId(value: string): string | undefined { return /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined; }
async function appendAudit(entry: Record<string, unknown>): Promise<void> { const file = await open(AUDIT_PATH, "a", 0o600); try { await file.write(`${JSON.stringify(entry)}\n`); await file.sync(); } finally { await file.close(); } }
function runGit(executable: string, args: readonly string[], options: { cwd?: string; environment: Record<string, string>; timeoutMs: number }): Promise<GithubProcessResult> { return new Promise((resolveResult, reject) => { const child = spawn(executable, args, { shell: false, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env: options.environment, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let bytes = 0; const collect = (chunk: Buffer): void => { bytes += chunk.length; if (bytes > 256 * 1024) { child.kill("SIGKILL"); reject(new Error("GitHub helper output limit exceeded")); } }; child.stdout.on("data", (chunk: Buffer) => { collect(chunk); stdout += chunk.toString("utf8"); }); child.stderr.on("data", collect); child.once("error", reject); child.once("close", (code) => { resolveResult({ exitCode: code ?? 1, stdout }); }); const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("GitHub helper timed out")); }, options.timeoutMs); timer.unref(); }); }
