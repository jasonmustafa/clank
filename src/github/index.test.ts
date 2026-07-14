/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, expect, it, vi } from "vitest";
import { PullRequestBridge, type GitInspector, type PullRequestHelper } from "./index.js";
import { type GithubHelperRequest, type GithubHelperResult } from "../helpers/github-protocol.js";

const repo = { jobId: "job-1", path: "/srv/clank/workspaces/jobs/job-1", repository: "owner/repo", prAllowed: true };
const policy = { commitAuthorEmail: "owner@example.com", commitFooter: "Generated-by: Clank", maxChangedFiles: 10, maxChangedLines: 100, maxDiffBytes: 10_000, defaultBaseBranch: "main" };
function inspector(overrides: Partial<Record<string, string>> = {}): GitInspector { return { output: vi.fn(async (args) => { const command = args[0] ?? ""; if (command === "rev-parse") return "a".repeat(40); if (command === "diff" && args.includes("--numstat")) return overrides.numstat ?? "2\t1\tfile.ts\n"; if (command === "diff") return overrides.diff ?? "patch"; return overrides.log ?? "owner@example.com\0Subject\n\nGenerated-by: Clank\0\n"; }) }; }
function helper(): PullRequestHelper & { invoke: ReturnType<typeof vi.fn> } { const invoke = vi.fn(async (request: GithubHelperRequest): Promise<GithubHelperResult> => request.action === "create-pull-request" ? { ok: true, action: request.action, number: 1, url: "https://example/pr/1", draft: request.draft } : { ok: true, action: request.action }); return { invoke }; }

describe("PullRequestBridge", () => {
  it("validates commits, pushes exact HEAD, then creates a normal PR", async () => {
    const client = helper(); const bridge = new PullRequestBridge(client, policy, inspector());
    const result = await bridge.create(repo, { branch: "clank/job-1-work", title: "Work" }, "123");
    expect(result).toMatchObject({ ok: true, draft: false });
    expect(client.invoke).toHaveBeenCalledTimes(2);
    expect(client.invoke.mock.calls[0]?.[0]).toMatchObject({ action: "push-branch", expectedCommit: "a".repeat(40) });
    expect(client.invoke.mock.calls[1]?.[0]).toMatchObject({ action: "create-pull-request", draft: false });
  });
  it("creates drafts only when requested or incomplete", async () => {
    const client = helper(); const bridge = new PullRequestBridge(client, policy, inspector());
    await bridge.create(repo, { branch: "clank/job-1-work", title: "Work", incomplete: true }, "123");
    expect(client.invoke.mock.calls[1]?.[0]).toMatchObject({ draft: true });
  });
  it("rejects wrong branches, empty diffs, and invalid commit metadata before pushing", async () => {
    const client = helper();
    await expect(new PullRequestBridge(client, policy, inspector()).create(repo, { branch: "main", title: "x" }, "123")).rejects.toThrow("belong");
    await expect(new PullRequestBridge(client, policy, inspector({ numstat: "" })).create(repo, { branch: "clank/job-1-x", title: "x" }, "123")).rejects.toThrow("no changes");
    await expect(new PullRequestBridge(client, policy, inspector({ log: "other@example.com\0No footer\0\n" })).create(repo, { branch: "clank/job-1-x", title: "x" }, "123")).rejects.toThrow("author email");
    expect(client.invoke).not.toHaveBeenCalled();
  });
});
