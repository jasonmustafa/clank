#!/usr/local/lib/clank/node/bin/node
import { readFile } from "node:fs/promises";
import { executeGithubRequest, type GithubHelperPolicy } from "./github-helper.js";
import { type GithubAuditContext } from "./github-protocol.js";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { input += chunk; if (Buffer.byteLength(input) > 128 * 1024) process.exit(2); });
process.stdin.once("end", () => { void main(); });
async function main(): Promise<void> {
  try {
    const envelope: unknown = JSON.parse(input);
    if (!isEnvelope(envelope)) throw new Error("Invalid GitHub helper envelope");
    const policy = await loadPolicy();
    const result = await executeGithubRequest(envelope.request, policy, envelope.context);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "GitHub helper failed"}\n`); process.exitCode = 1; }
}
async function loadPolicy(): Promise<GithubHelperPolicy> {
  const document: unknown = JSON.parse(await readFile("/srv/clank/config/clank.config.json", "utf8"));
  const token = envValue(await readFile("/etc/clank/clank.env", "utf8"), "CLANK_GITHUB_TOKEN");
  if (!record(document) || !record(document.github) || !record(document.paths) || !Array.isArray(document.github.allowedOwners) || !Array.isArray(document.github.allowedRepositories) || typeof document.paths.workspaces !== "string") throw new Error("Invalid GitHub helper policy");
  return { allowedOwners: strings(document.github.allowedOwners), allowedRepositories: strings(document.github.allowedRepositories), workspacesRoot: document.paths.workspaces, token };
}
function envValue(contents: string, key: string): string { const line = contents.split(/\r?\n/u).find((item) => item.startsWith(`${key}=`)); if (line === undefined) throw new Error("GitHub helper credential unavailable"); const value = line.slice(key.length + 1).trim().replace(/^(?:'|")|(?:'|")$/gu, ""); if (value === "") throw new Error("GitHub helper credential unavailable"); return value; }
function strings(value: unknown[]): string[] { if (value.some((item) => typeof item !== "string")) throw new Error("Invalid GitHub helper policy"); return value as string[]; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isEnvelope(value: unknown): value is { request: unknown; context: GithubAuditContext } { if (!record(value) || Object.keys(value).some((key) => key !== "request" && key !== "context") || !record(value.context)) return false; return typeof value.context.requesterId === "string" && typeof value.context.jobId === "string" && Object.keys(value.context).every((key) => key === "requesterId" || key === "jobId"); }
