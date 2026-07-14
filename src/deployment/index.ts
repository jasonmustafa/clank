import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface DeploymentChecks {
  install: string[];
  typecheck: string[];
  tests: string[];
  build: string[];
  registerCommands: string[];
}
export interface DeploymentPolicy { appPath: string; remote: string; branch: string; checks: DeploymentChecks; }
export interface ProcessResult { exitCode: number; stdout: string; stderr: string; }
export interface DeploymentCommandRunner { run(executable: string, args: readonly string[], options: { cwd: string }): Promise<ProcessResult>; }
export interface DeploymentRequest { requesterId: string; channelId: string; }
export interface PendingDeploy extends DeploymentRequest { operation: "deploy" | "rollback"; fromCommit: string; toCommit: string; startedAt: string; }
export type DeploymentResult = { ok: true; summary: string } | { ok: false; stage: string; summary: string };
type Restart = (requesterId: string) => Promise<{ ok: boolean; output: string; error?: string }>;
interface DeployHistory { commits: string[]; }

const CHECK_ORDER: readonly (keyof DeploymentChecks)[] = ["install", "typecheck", "tests", "build", "registerCommands"];
const MAX_OUTPUT = 256 * 1024;

export class DeploymentManager {
  readonly #pendingPath: string;
  readonly #historyPath: string;
  #busy = false;
  constructor(private readonly policy: DeploymentPolicy, stateDirectory: string, private readonly runner: DeploymentCommandRunner, private readonly restart: Restart) {
    this.#pendingPath = join(stateDirectory, "pending-deploy.json");
    this.#historyPath = join(stateDirectory, "deploy-history.json");
  }

  async deploy(request: DeploymentRequest): Promise<DeploymentResult> {
    return this.exclusively(async () => {
      const fromCommit = await this.git(["rev-parse", "HEAD"]);
      const fetch = await this.run("git", ["fetch", "--", this.policy.remote, this.policy.branch]);
      if (fetch.exitCode !== 0) return failure("deploy", "fetch", fetch);
      const target = await this.git(["rev-parse", "FETCH_HEAD"]);
      return this.prepareAndRestart("deploy", fromCommit, target, request, CHECK_ORDER);
    });
  }

  async rollback(request: DeploymentRequest): Promise<DeploymentResult> {
    return this.exclusively(async () => {
      const history = await this.readHistory();
      if (history.commits.length < 2) return { ok: false, stage: "history", summary: "Rollback unavailable: no previous good commit." };
      const fromCommit = await this.git(["rev-parse", "HEAD"]);
      const target = history.commits[history.commits.length - 2];
      if (target === undefined) return { ok: false, stage: "history", summary: "Rollback unavailable: no previous good commit." };
      return this.prepareAndRestart("rollback", fromCommit, target, request, CHECK_ORDER);
    });
  }

  async completePending(): Promise<PendingDeploy | undefined> {
    const pending = await readJson<PendingDeploy>(this.#pendingPath);
    if (pending === undefined) return undefined;
    const history = await this.readHistory();
    if (history.commits.at(-1) !== pending.toCommit) history.commits.push(pending.toCommit);
    await atomicWrite(this.#historyPath, history);
    await rm(this.#pendingPath, { force: true });
    return pending;
  }

  private async prepareAndRestart(operation: PendingDeploy["operation"], fromCommit: string, target: string, request: DeploymentRequest, checks: readonly (keyof DeploymentChecks)[]): Promise<DeploymentResult> {
    const reset = await this.run("git", ["reset", "--hard", target]);
    if (reset.exitCode !== 0) return failure(operation, "checkout", reset);
    for (const stage of checks) {
      const [executable, ...args] = this.policy.checks[stage];
      if (executable === undefined) { await this.restore(fromCommit); return { ok: false, stage, summary: `${label(operation)} failed during ${stage}: check is not configured.` }; }
      const result = await this.run(executable, args);
      if (result.exitCode !== 0) { await this.restore(fromCommit); return failure(operation, stage, result); }
    }
    const history = await this.readHistory();
    if (history.commits.length === 0) await atomicWrite(this.#historyPath, { commits: [fromCommit] });
    const pending: PendingDeploy = { ...request, operation, fromCommit, toCommit: target, startedAt: new Date().toISOString() };
    await atomicWrite(this.#pendingPath, pending);
    const restarted = await this.restart(request.requesterId);
    if (!restarted.ok) { await rm(this.#pendingPath, { force: true }); await this.restore(fromCommit); return { ok: false, stage: "restart", summary: "Deploy checks passed, but restart failed." }; }
    return { ok: true, summary: `${operation === "deploy" ? "Deploy" : "Rollback"} checks passed for ${short(target)}; restarting Clank.` };
  }

  private async exclusively(work: () => Promise<DeploymentResult>): Promise<DeploymentResult> {
    if (this.#busy) return { ok: false, stage: "busy", summary: "Another deployment operation is already running." };
    this.#busy = true;
    try { return await work(); } finally { this.#busy = false; }
  }
  private async restore(commit: string): Promise<void> { await this.run("git", ["reset", "--hard", commit]); }
  private async git(args: readonly string[]): Promise<string> {
    const result = await this.run("git", args);
    if (result.exitCode !== 0) throw new Error(`Deployment git operation failed: ${args[0] ?? "git"}`);
    return result.stdout.trim();
  }
  private run(executable: string, args: readonly string[]): Promise<ProcessResult> { return this.runner.run(executable, args, { cwd: this.policy.appPath }); }
  private async readHistory(): Promise<DeployHistory> { return (await readJson<DeployHistory>(this.#historyPath)) ?? { commits: [] }; }
}

export class SpawnRunner implements DeploymentCommandRunner {
  run(executable: string, args: readonly string[], options: { cwd: string }): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: options.cwd, shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const collect = (current: string, chunk: string): string => (current + chunk).slice(-MAX_OUTPUT);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = collect(stdout, chunk); });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = collect(stderr, chunk); });
      child.once("error", (error) => { reject(error); });
      child.once("close", (code) => { resolve({ exitCode: code ?? 1, stdout, stderr }); });
    });
  }
}

function failure(operation: PendingDeploy["operation"], stage: string, result: ProcessResult): DeploymentResult {
  const hasDetail = (result.stderr || result.stdout).trim() !== "";
  return { ok: false, stage, summary: `${label(operation)} failed during ${stage}.${hasDetail ? " See service logs for details." : ""}` };
}

function label(operation: PendingDeploy["operation"]): string { return operation === "deploy" ? "Deploy" : "Rollback"; }
function short(commit: string): string { return commit.slice(0, 12); }

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}