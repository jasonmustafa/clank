import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { validateSystemRequest, type SystemAuditContext, type SystemHelperResult, type SystemRequest } from "./system-protocol.js";

const AUDIT_PATH = "/srv/clank/logs/helper-audit.log";
const MAX_OUTPUT_BYTES = 256 * 1024;
export interface ProcessResult { exitCode: number; stdout: string; stderr: string; }
export interface RunOptions { timeoutMs: number; maxOutputBytes: number; environment: Record<string, string>; }
export interface AuditEntry { timestamp: string; action: string; arguments: Record<string, unknown>; outcome: "started" | "succeeded" | "failed" | "denied"; requesterId?: string; approvalId?: string; approverId?: string; exitCode?: number; }
export interface HelperDependencies {
  run?: (executable: string, args: readonly string[], options: RunOptions) => Promise<ProcessResult>;
  audit?: (entry: AuditEntry) => Promise<void>;
  now?: () => Date;
}

export async function executeSystemRequest(input: unknown, dependencies: HelperDependencies = {}, context?: SystemAuditContext): Promise<SystemHelperResult> {
  const audit = dependencies.audit ?? appendAudit;
  const now = dependencies.now ?? (() => new Date());
  const validation = validateSystemRequest(input);
  if (!validation.ok) {
    await audit({ timestamp: now().toISOString(), action: "invalid", arguments: {}, outcome: "denied" });
    throw new Error(`Invalid system helper request: ${validation.error}`);
  }
  const request = validation.value;
  const command = commandFor(request);
  const base = { timestamp: now().toISOString(), action: request.action, arguments: auditArguments(request), ...sanitizeContext(context) };
  await audit({ ...base, outcome: "started" });
  try {
    const result = await (dependencies.run ?? runProcess)(command.executable, command.args, {
      timeoutMs: command.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive" },
    });
    const ok = result.exitCode === 0;
    await audit({ ...base, outcome: ok ? "succeeded" : "failed", exitCode: result.exitCode });
    return { ok, output: result.stdout, ...(ok ? {} : { error: "System helper command failed" }) };
  } catch (error) {
    await audit({ ...base, outcome: "failed" });
    throw error;
  }
}

function commandFor(request: SystemRequest): { executable: string; args: string[]; timeoutMs: number } {
  switch (request.action) {
    case "apt-update": return { executable: "/usr/bin/apt-get", args: ["update"], timeoutMs: 300_000 };
    case "apt-install": return { executable: "/usr/bin/apt-get", args: ["install", "--yes", "--no-install-recommends", "--", ...request.packages], timeoutMs: 300_000 };
    case "service-status": return { executable: "/usr/bin/systemctl", args: ["status", "--no-pager", "--full", "clank.service"], timeoutMs: 15_000 };
    case "service-restart": return { executable: "/usr/bin/systemctl", args: ["restart", "clank.service"], timeoutMs: 30_000 };
    case "journal-read": return { executable: "/usr/bin/journalctl", args: ["--unit=clank.service", `--lines=${String(request.lines)}`, ...(request.since === undefined ? [] : [`--since=${request.since}`]), "--no-pager", "--output=short-iso"], timeoutMs: 15_000 };
  }
}

function sanitizeContext(context: SystemAuditContext | undefined): Partial<SystemAuditContext> {
  if (context === undefined) return {};
  const discordId = /^\d{1,24}$/u;
  const uuid = /^[0-9a-f-]{36}$/iu;
  return {
    ...(discordId.test(context.requesterId) ? { requesterId: context.requesterId } : {}),
    ...(context.approvalId !== undefined && uuid.test(context.approvalId) ? { approvalId: context.approvalId } : {}),
    ...(context.approverId !== undefined && discordId.test(context.approverId) ? { approverId: context.approverId } : {}),
  };
}

function auditArguments(request: SystemRequest): Record<string, unknown> {
  if (request.action === "apt-install") return { packages: request.packages };
  if (request.action === "journal-read") return { lines: request.lines, ...(request.since === undefined ? {} : { since: request.since }) };
  return {};
}

async function appendAudit(entry: AuditEntry): Promise<void> {
  const handle = await open(AUDIT_PATH, "a", 0o600);
  try { await handle.write(`${JSON.stringify(entry)}\n`); await handle.sync(); } finally { await handle.close(); }
}

function runProcess(executable: string, args: readonly string[], options: RunOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, env: options.environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const finish = (error?: Error, exitCode?: number): void => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error !== undefined) reject(error); else resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    };
    const collect = (current: string, chunk: string): string => {
      if (settled) return current;
      const combined = current + chunk;
      if (Buffer.byteLength(combined) > options.maxOutputBytes) { child.kill("SIGKILL"); finish(new Error("System helper output limit exceeded")); return current; }
      return combined;
    };
    child.stdout.on("data", (chunk: string) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = collect(stderr, chunk); });
    child.once("error", (error) => { finish(error); });
    child.once("close", (code) => { finish(undefined, code ?? 1); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("System helper command timed out")); }, options.timeoutMs);
    timer.unref();
  });
}
