/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/array-type, @typescript-eslint/no-base-to-string */
import { describe, expect, it, vi } from "vitest";
import { executeGithubRequest } from "./github-helper.js";
import { validateGithubHelperRequest } from "./github-protocol.js";

const policy = { allowedOwners: ["owner"], allowedRepositories: ["owner/repo"], workspacesRoot: "/srv/clank/workspaces", token: "super-secret" };
const context = { requesterId: "123", jobId: "job-1" };

describe("GitHub helper", () => {
  it("rejects unknown fields and branches not bound to the job", () => {
    expect(validateGithubHelperRequest({ action: "clone", repository: "owner/repo", destination: "/tmp/x", extra: true }).ok).toBe(false);
    expect(validateGithubHelperRequest({ action: "push-branch", jobId: "job-1", repository: "owner/repo", workspacePath: "/x", branch: "main", expectedCommit: "a".repeat(40) }).ok).toBe(false);
  });

  it("uses credential environment without logging or putting the token in arguments", async () => {
    const calls: Array<{ args: readonly string[]; environment: Record<string, string> }> = [];
    const run = vi.fn(async (_executable: string, args: readonly string[], options: { environment: Record<string, string> }) => { calls.push({ args, environment: options.environment }); return { exitCode: 0, stdout: "" }; });
    const entries: Record<string, unknown>[] = [];
    const result = await executeGithubRequest({ action: "push-branch", jobId: "job-1", repository: "owner/repo", workspacePath: "/srv/clank/workspaces/jobs/job-1", branch: "clank/job-1-work", expectedCommit: "a".repeat(40) }, policy, context, { run, audit: async (entry) => { entries.push(entry); } });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(calls[0]?.args)).not.toContain(policy.token);
    expect(calls[0]?.environment.GITHUB_TOKEN).toBe(policy.token);
    expect(JSON.stringify(entries)).not.toContain(policy.token);
  });

  it("creates a normal PR through the REST API", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const requestFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { fetchCalls.push({ url: String(url), init }); return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/owner/repo/pull/7" }), { status: 201 }); });
    const result = await executeGithubRequest({ action: "create-pull-request", jobId: "job-1", repository: "owner/repo", head: "clank/job-1-work", base: "main", title: "Work", body: "Done", draft: false }, policy, context, { fetch: requestFetch as typeof fetch, audit: async () => undefined });
    expect(result).toMatchObject({ ok: true, number: 7, draft: false });
    expect(fetchCalls[0]?.url).toBe("https://api.github.com/repos/owner/repo/pulls");
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toMatchObject({ draft: false, head: "clank/job-1-work" });
  });

  it("creates an issue through the REST API without auditing its content", async () => {
    const entries: Record<string, unknown>[] = [];
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const requestFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { fetchCalls.push({ url: String(url), init }); return new Response(JSON.stringify({ number: 9, html_url: "https://github.com/owner/repo/issues/9" }), { status: 201 }); });
    const result = await executeGithubRequest({ action: "create-issue", repository: "owner/repo", title: "Issue title", body: "Sensitive issue details" }, policy, context, { fetch: requestFetch as typeof fetch, audit: async (entry) => { entries.push(entry); } });
    expect(result).toMatchObject({ ok: true, action: "create-issue", number: 9 });
    expect(fetchCalls[0]?.url).toBe("https://api.github.com/repos/owner/repo/issues");
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ title: "Issue title", body: "Sensitive issue details" });
    expect(JSON.stringify(entries)).not.toContain("Sensitive issue details");
  });

  it("validates issue title and body limits", () => {
    expect(validateGithubHelperRequest({ action: "create-issue", repository: "owner/repo", title: "", body: "" }).ok).toBe(false);
    expect(validateGithubHelperRequest({ action: "create-issue", repository: "owner/repo", title: "x".repeat(257), body: "" }).ok).toBe(false);
    expect(validateGithubHelperRequest({ action: "create-issue", repository: "owner/repo", title: "Valid", body: "x".repeat(65_537) }).ok).toBe(false);
  });

  it("denies repositories outside both allowlists", async () => {
    await expect(executeGithubRequest({ action: "clone", repository: "other/repo", destination: "/srv/clank/workspaces/jobs/job-1" }, policy, context, { audit: async () => undefined })).rejects.toThrow("denied repository");
  });
});
