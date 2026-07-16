export type GithubHelperRequest =
  | { action: "clone"; repository: string; destination: string }
  | { action: "fetch"; repository: string; workspacePath: string }
  | { action: "push-branch"; jobId: string; repository: string; workspacePath: string; branch: string; expectedCommit: string }
  | { action: "create-pull-request"; jobId: string; repository: string; head: string; base: string; title: string; body: string; draft: boolean }
  | { action: "create-issue"; repository: string; title: string; body: string };

export interface GithubAuditContext { requesterId: string; jobId: string }
export type GithubHelperResult =
  | { ok: true; action: "clone" | "fetch" | "push-branch" }
  | { ok: true; action: "create-pull-request"; number: number; url: string; draft: boolean }
  | { ok: true; action: "create-issue"; number: number; url: string }
  | { ok: false; action: GithubHelperRequest["action"]; error: string };
export type GithubValidationResult = { ok: true; value: GithubHelperRequest } | { ok: false; error: string };

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const SHA = /^[0-9a-f]{40}$/u;

export function normalizeGithubRepository(value: string): string {
  const normalized = value.replace(/\.git$/u, "").toLowerCase();
  if (!REPOSITORY.test(normalized) || normalized.includes("..")) throw new Error("Invalid GitHub repository");
  return normalized;
}

export function isClankBranch(branch: string, jobId: string): boolean {
  return branch.startsWith(`clank/${jobId}-`) && REF.test(branch) && !branch.includes("..") && !branch.endsWith("/");
}

export function validateGithubHelperRequest(value: unknown): GithubValidationResult {
  if (!record(value) || typeof value.action !== "string") return bad("request must be an object with an action");
  try {
    switch (value.action) {
      case "clone":
        if (!keys(value, ["action", "repository", "destination"]) || !text(value.destination, 4096)) return bad("invalid clone request");
        return { ok: true, value: { action: "clone", repository: repository(value.repository), destination: value.destination } };
      case "fetch":
        if (!keys(value, ["action", "repository", "workspacePath"]) || !text(value.workspacePath, 4096)) return bad("invalid fetch request");
        return { ok: true, value: { action: "fetch", repository: repository(value.repository), workspacePath: value.workspacePath } };
      case "push-branch":
        if (!keys(value, ["action", "jobId", "repository", "workspacePath", "branch", "expectedCommit"]) || typeof value.jobId !== "string" || !JOB_ID.test(value.jobId) || !text(value.workspacePath, 4096) || typeof value.branch !== "string" || !isClankBranch(value.branch, value.jobId) || typeof value.expectedCommit !== "string" || !SHA.test(value.expectedCommit)) return bad("invalid push request");
        return { ok: true, value: { action: "push-branch", jobId: value.jobId, repository: repository(value.repository), workspacePath: value.workspacePath, branch: value.branch, expectedCommit: value.expectedCommit } };
      case "create-pull-request":
        if (!keys(value, ["action", "jobId", "repository", "head", "base", "title", "body", "draft"]) || typeof value.jobId !== "string" || !JOB_ID.test(value.jobId) || !text(value.head, 255) || !isClankBranch(value.head, value.jobId) || !text(value.base, 255) || !REF.test(value.base) || value.base.startsWith("clank/") || !text(value.title, 256) || typeof value.body !== "string" || value.body.length > 65_536 || typeof value.draft !== "boolean") return bad("invalid pull request");
        return { ok: true, value: { action: "create-pull-request", jobId: value.jobId, repository: repository(value.repository), head: value.head, base: value.base, title: value.title, body: value.body, draft: value.draft } };
      case "create-issue":
        if (!keys(value, ["action", "repository", "title", "body"]) || !text(value.title, 256) || typeof value.body !== "string" || value.body.length > 65_536) return bad("invalid issue");
        return { ok: true, value: { action: "create-issue", repository: repository(value.repository), title: value.title, body: value.body } };
      default: return bad("unsupported action");
    }
  } catch { return bad("invalid repository"); }
}
function repository(value: unknown): string { if (typeof value !== "string") throw new Error(); return normalizeGithubRepository(value); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: string[]): boolean { return Object.keys(value).length === expected.length && expected.every((key) => key in value); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"); }
function bad(error: string): GithubValidationResult { return { ok: false, error }; }
