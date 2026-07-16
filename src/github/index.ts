import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isClankBranch, type GithubHelperRequest, type GithubHelperResult } from "../helpers/github-protocol.js";

const execFileAsync = promisify(execFile);
export interface PullRequestRepository { jobId: string; path: string; repository: string; prAllowed: boolean }
export interface PullRequestPolicy { commitAuthorEmail: string; commitFooter: string; maxChangedFiles: number; maxChangedLines: number; maxDiffBytes: number; defaultBaseBranch: string }
export interface CreatePullRequestInput { branch: string; title: string; body?: string; base?: string; draft?: boolean; incomplete?: boolean }
export interface PullRequestHelper { invoke(request: GithubHelperRequest, context: { requesterId: string; jobId: string }): Promise<GithubHelperResult> }
export interface GitInspector { output(args: readonly string[], cwd: string): Promise<string> }

const issueParameters = Type.Object({ repository: Type.String(), title: Type.String(), body: Type.Optional(Type.String()) });
export function createGithubIssueTool(helper: PullRequestHelper, requesterId: string, jobId: string): ToolDefinition<typeof issueParameters> {
  return {
    name: "create_github_issue",
    label: "Create GitHub issue",
    description: "Create an issue in a policy-allowed GitHub repository. Include any requested authorship or generated-by disclaimer in the body.",
    parameters: issueParameters,
    execute: async (_id, params) => {
      const result = await helper.invoke({ action: "create-issue", repository: params.repository, title: params.title, body: params.body ?? "" }, { requesterId, jobId });
      if (!result.ok) throw new Error(result.error);
      if (result.action !== "create-issue") throw new Error("GitHub operation failed");
      return { content: [{ type: "text", text: `Created issue #${String(result.number)}: ${result.url}` }], details: result };
    },
  };
}

const pullRequestParameters = Type.Object({ branch: Type.String(), title: Type.String(), body: Type.Optional(Type.String()), base: Type.Optional(Type.String()), draft: Type.Optional(Type.Boolean()), incomplete: Type.Optional(Type.Boolean()) });
export function createPullRequestTool(bridge: PullRequestBridge, repo: PullRequestRepository, requesterId: string): ToolDefinition<typeof pullRequestParameters> {
  return { name: "create_pull_request", label: "Create pull request", description: "Validate local commits, push this job's Clank branch, and open a GitHub pull request.", parameters: pullRequestParameters, execute: async (_id, params) => { const result = await bridge.create(repo, params, requesterId); if (!result.ok) throw new Error(result.error); return { content: [{ type: "text", text: result.action === "create-pull-request" ? `Created pull request #${String(result.number)}: ${result.url}` : "GitHub operation failed" }], details: result }; } };
}

export class PullRequestBridge {
  constructor(private readonly helper: PullRequestHelper, private readonly policy: PullRequestPolicy, private readonly git: GitInspector = new SystemGitInspector()) {}
  async create(repo: PullRequestRepository, input: CreatePullRequestInput, requesterId: string): Promise<GithubHelperResult> {
    if (!repo.prAllowed || repo.repository === "") throw new Error("Job repository is not PR-capable");
    if (!isClankBranch(input.branch, repo.jobId)) throw new Error("Pull request branch must belong to this job");
    const base = input.base ?? this.policy.defaultBaseBranch;
    if (base === input.branch || base.startsWith("clank/")) throw new Error("Invalid pull request base branch");
    const head = (await this.git.output(["rev-parse", "HEAD"], repo.path)).trim();
    if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error("Invalid repository HEAD");
    const diff = await this.git.output(["diff", "--numstat", `${base}...${head}`], repo.path);
    const bytes = Buffer.byteLength(await this.git.output(["diff", "--binary", `${base}...${head}`], repo.path));
    const rows = diff.trim() === "" ? [] : diff.trim().split("\n");
    let lines = 0;
    for (const row of rows) { const [added, deleted] = row.split("\t"); lines += numeric(added) + numeric(deleted); }
    if (rows.length === 0) throw new Error("Pull request has no changes");
    if (rows.length > this.policy.maxChangedFiles || lines > this.policy.maxChangedLines || bytes > this.policy.maxDiffBytes) throw new Error("Pull request diff exceeds configured thresholds");
    const log = await this.git.output(["log", "--format=%ae%x00%B%x00", `${base}..${head}`], repo.path);
    const commits = log.split("\0\n").filter((item) => item.trim() !== "");
    if (commits.length === 0 || commits.some((commit) => { const newline = commit.indexOf("\0"); return newline < 0 || commit.slice(0, newline) !== this.policy.commitAuthorEmail || !commit.slice(newline + 1).split("\n").includes(this.policy.commitFooter); })) throw new Error("Pull request commits must use the configured author email and generated-by footer");
    const context = { requesterId, jobId: repo.jobId };
    const pushed = await this.helper.invoke({ action: "push-branch", jobId: repo.jobId, repository: repo.repository, workspacePath: repo.path, branch: input.branch, expectedCommit: head }, context);
    if (!pushed.ok) return pushed;
    return this.helper.invoke({ action: "create-pull-request", jobId: repo.jobId, repository: repo.repository, head: input.branch, base, title: input.title, body: input.body ?? "", draft: input.draft === true || input.incomplete === true }, context);
  }
}
class SystemGitInspector implements GitInspector { async output(args: readonly string[], cwd: string): Promise<string> { const result = await execFileAsync("/usr/bin/git", [...args], { cwd, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1" }, maxBuffer: 2 * 1024 * 1024 }); return result.stdout; } }
function numeric(value: string | undefined): number { return value === undefined || value === "-" ? 0 : Number.parseInt(value, 10); }
