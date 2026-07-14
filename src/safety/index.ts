import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createBashTool, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type SafetyDecision = { action: "allow" } | { action: "deny" | "confirm"; reason: string };
export type JobProfile = "normal" | "elevated";
export interface PathSafetyPolicy { workspaceRoot: string; protectedRoots: readonly string[]; }
export interface CommandSafetyPolicy extends PathSafetyPolicy { profile: JobProfile; }

const SYSTEM_ROOTS = ["/boot", "/dev", "/etc", "/proc", "/root", "/run", "/sys", "/usr", "/var/lib", "/var/log"];
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519)(?:\.pub)?|.*(?:token|secret|password).*)$/iu;

export function normalizeToolPath(path: string, cwd: string): string {
  const clean = path.startsWith("@") ? path.slice(1) : path;
  return resolve(cwd, clean);
}

function within(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function pathDecision(path: string, policy: PathSafetyPolicy): SafetyDecision {
  const normalized = normalizeToolPath(path, policy.workspaceRoot);
  if (SECRET_NAME.test(basename(normalized))) return { action: "deny", reason: "Secret and authentication files are protected" };
  if ([...SYSTEM_ROOTS, ...policy.protectedRoots].some((root) => within(normalized, root))) return { action: "deny", reason: `Protected path: ${normalized}` };
  if (!within(normalized, policy.workspaceRoot)) return { action: "deny", reason: "Tool paths must stay inside the job workspace" };
  return { action: "allow" };
}

export function commandDecision(command: string, policy: CommandSafetyPolicy): SafetyDecision {
  const lower = command.toLowerCase();
  if (/\b(?:git\s+push|gh\b|ssh\b|scp\b|rsync\b)/u.test(lower)) return { action: "deny", reason: "Direct GitHub/remote credential operations must use the policy bridge" };
  if (/(?:curl|wget)\b[^\n]*(?:(?:\||;|&&)\s*(?:sudo\s+)?(?:ba)?sh\b|\)\s*$)|(?:ba)?sh\s+<\([^)]*(?:curl|wget)\b/iu.test(command)) return { action: "deny", reason: "Remote script execution is blocked" };
  if (/(?:^|[\s'"/])(?:\.env(?:\.[^\s'"/]*)?|\.npmrc|\.netrc|auth\.json|id_(?:rsa|ed25519)|[^\s'"/]*(?:token|secret|password)[^\s'"/]*)\b/iu.test(command)) return { action: "deny", reason: "Secret and authentication files are protected" };
  if (/(?:^|[\s'";|&])\.\.(?:\/|$)/u.test(command)) return { action: "deny", reason: "Bash paths must stay inside the job workspace" };
  const pathLike = command.match(/(?:^|[\s'"=])(\/(?:[^\s'";&|)]+))/gu) ?? [];
  for (const token of pathLike) {
    const decision = pathDecision(token.trim(), policy);
    if (decision.action === "deny") return decision;
  }
  const privilegedMutation = /\b(?:sudo\b|mkfs\b|dd\s+.*\bof=|systemctl\s+(?:restart|stop)|apt(?:-get)?\s+(?:install|remove|purge))/iu.test(command);
  if (privilegedMutation) return { action: "confirm", reason: "Privileged mutation requires approval" };
  const workspaceDestructive = /(?:^|[;&|]\s*)(?:rm\s+(?:-[a-z]*[rf][a-z]*\s+|--recursive)|rmdir\b|shred\b|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f)|chmod\s+-r|chown\s+-r)/iu.test(command);
  if (workspaceDestructive && policy.profile === "normal") return { action: "confirm", reason: "Destructive command requires approval" };
  return { action: "allow" };
}

const ENV_ALLOWLIST = ["HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ", "USER", "LOGNAME"] as const;
export function sanitizeEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) if (environment[key] !== undefined) sanitized[key] = environment[key];
  sanitized.PATH = "/usr/local/bin:/usr/bin:/bin";
  return sanitized;
}

export interface SafetyExtensionOptions extends CommandSafetyPolicy {
  environment?: NodeJS.ProcessEnv;
  confirm: (summary: string) => Promise<boolean>;
}

export function createSafetyExtension(options: SafetyExtensionOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const bash = createBashTool(options.workspaceRoot, {
      spawnHook: ({ command, cwd }) => ({ command, cwd, env: sanitizeEnvironment(options.environment ?? process.env) }),
    });
    pi.registerTool(bash);
    pi.on("tool_call", async (event) => {
      if (["read", "write", "edit"].includes(event.toolName)) {
        const path = (event.input as { path?: unknown }).path;
        if (typeof path !== "string") return { block: true, reason: "Missing tool path" };
        const decision = pathDecision(path, options);
        if (decision.action !== "allow") return { block: true, reason: decision.reason };
      }
      if (event.toolName === "bash") {
        const command = (event.input as { command?: unknown }).command;
        if (typeof command !== "string") return { block: true, reason: "Missing bash command" };
        const decision = commandDecision(command, options);
        if (decision.action === "deny") return { block: true, reason: decision.reason };
        if (decision.action === "confirm" && !(await options.confirm(command))) return { block: true, reason: "Approval denied or expired" };
      }
      return undefined;
    });
  };
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export interface Approval {
  id: string; requesterId: string; channelId: string; summary: string; status: ApprovalStatus;
  createdAt: number; expiresAt: number; decidedBy?: string; messageId?: string;
}
export interface ApprovalMessenger { send(approval: Approval): Promise<string | undefined>; update(approval: Approval): Promise<void>; }
interface ApprovalState { version: 1; approvals: Approval[]; }
export interface ApprovalServiceOptions { directory: string; messenger: ApprovalMessenger; approverUserIds: readonly string[]; now?: () => number; }

export class ApprovalService {
  readonly #approvals: Map<string, Approval>;
  readonly #path: string;
  readonly #now: () => number;
  private constructor(private readonly options: ApprovalServiceOptions, approvals: readonly Approval[]) {
    this.#approvals = new Map(approvals.map((approval) => [approval.id, approval]));
    this.#path = join(options.directory, "approvals.json");
    this.#now = options.now ?? Date.now;
  }
  static async open(options: ApprovalServiceOptions): Promise<ApprovalService> {
    const path = join(options.directory, "approvals.json");
    let approvals: Approval[] = [];
    try { approvals = (JSON.parse(await readFile(path, "utf8")) as ApprovalState).approvals; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const service = new ApprovalService(options, approvals);
    const pending = approvals.filter((approval) => approval.status === "pending");
    for (const approval of pending) {
      const expired = { ...approval, status: "expired" as const };
      service.#approvals.set(expired.id, expired);
      await options.messenger.update(expired);
    }
    if (pending.length > 0) await service.#save();
    return service;
  }
  get(id: string): Approval | undefined { return this.#approvals.get(id); }
  async request(input: { requesterId: string; channelId: string; summary: string; timeoutMs: number }): Promise<Approval> {
    const createdAt = this.#now();
    const approval: Approval = { id: crypto.randomUUID(), ...input, status: "pending", createdAt, expiresAt: createdAt + input.timeoutMs };
    this.#approvals.set(approval.id, approval);
    await this.#save();
    this.#scheduleExpiry(approval);
    const messageId = await this.options.messenger.send(approval);
    if (messageId !== undefined) {
      const persisted = { ...approval, messageId };
      this.#approvals.set(approval.id, persisted);
      await this.#save();
      return persisted;
    }
    return approval;
  }
  async decide(id: string, userId: string, approve: boolean): Promise<boolean> {
    const current = this.#approvals.get(id);
    if (current?.status !== "pending" || !this.options.approverUserIds.includes(userId)) return false;
    if (current.expiresAt <= this.#now()) { await this.#finish(current, "expired"); return false; }
    await this.#finish(current, approve ? "approved" : "denied", userId);
    return approve;
  }
  async expire(): Promise<void> {
    for (const approval of this.#approvals.values()) if (approval.status === "pending" && approval.expiresAt <= this.#now()) await this.#finish(approval, "expired");
  }
  #scheduleExpiry(approval: Approval): void {
    const timer = setTimeout(() => { void this.expire(); }, Math.max(0, approval.expiresAt - this.#now()));
    timer.unref();
  }
  async #finish(current: Approval, status: ApprovalStatus, decidedBy?: string): Promise<void> {
    const approval = { ...current, status, ...(decidedBy === undefined ? {} : { decidedBy }) };
    this.#approvals.set(approval.id, approval);
    await this.#save();
    await this.options.messenger.update(approval);
  }
  async #save(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    const temporary = `${this.#path}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, approvals: [...this.#approvals.values()] }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    } finally { await rm(temporary, { force: true }); }
  }
}
