import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export type TaskLifecycleState = "active" | "idle" | "interrupted" | "stopped";
export interface PersistedTask {
  id: string; requesterId: string; threadId: string; capabilityMode: "superuser"; workingDirectory: string;
  lifecycleState: TaskLifecycleState; createdAt: string; updatedAt: string; piSessionId: string; recoveryNoticePending?: boolean;
}
export interface PersistedApproval { id: string; taskId: string; requesterId: string; command: string; workingDirectory: string; status: "pending" | "approved" | "denied" | "expired"; createdAt: string; expiresAt: string; decidedAt?: string; }
export interface PersistedTaskState { version: 1; tasks: PersistedTask[]; approvals: PersistedApproval[]; }
export interface TaskStore { load(): Promise<PersistedTaskState>; save(state: PersistedTaskState): Promise<void>; }

export class IncompatibleTaskStateError extends Error {}
export class CorruptTaskStateError extends Error {}

export class FileTaskStore implements TaskStore {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }
  async load(): Promise<PersistedTaskState> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.#path, "utf8")) as unknown; }
    catch (error) {
      if (isMissing(error)) return { version: 1, tasks: [], approvals: [] };
      throw new CorruptTaskStateError(`Task state is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isObject(value) || value.version !== 1) throw new IncompatibleTaskStateError("Task state version is incompatible");
    if (!Array.isArray(value.tasks) || !value.tasks.every(isTask) || !Array.isArray(value.approvals) || !value.approvals.every(isApproval)) {
      throw new CorruptTaskStateError("Task state is corrupt: invalid document shape");
    }
    return value as unknown as PersistedTaskState;
  }
  async save(state: PersistedTaskState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true }); const temporary = `${this.#path}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, this.#path); const directory = await open(dirname(this.#path), "r"); try { await directory.sync(); } finally { await directory.close(); } }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMissing(error: unknown): boolean { return isObject(error) && error.code === "ENOENT"; }
function isTask(value: unknown): boolean {
  if (!isObject(value)) return false;
  return ["id", "requesterId", "threadId", "workingDirectory", "createdAt", "updatedAt", "piSessionId"].every((key) => typeof value[key] === "string")
    && (value.recoveryNoticePending === undefined || typeof value.recoveryNoticePending === "boolean")
    && value.capabilityMode === "superuser" && ["active", "idle", "interrupted", "stopped"].includes(String(value.lifecycleState));
}
function isApproval(value: unknown): boolean {
  return isObject(value) && ["id", "taskId", "requesterId", "command", "workingDirectory", "createdAt", "expiresAt"].every((key) => typeof value[key] === "string")
    && (value.decidedAt === undefined || typeof value.decidedAt === "string") && ["pending", "approved", "denied", "expired"].includes(String(value.status));
}
