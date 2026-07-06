import { randomBytes } from "node:crypto";

export interface PendingConfirmation {
  code: string;
  jobId: string;
  title: string;
  message: string;
  expiresAt: number;
}

interface PendingInternal extends PendingConfirmation {
  resolve: (value: boolean) => void;
  timeout: NodeJS.Timeout;
}

export class ConfirmationManager {
  private readonly pending = new Map<string, PendingInternal>();

  create(jobId: string, title: string, message: string, timeoutMs: number): PendingConfirmation & { promise: Promise<boolean> } {
    const code = randomBytes(3).toString("hex");
    const expiresAt = Date.now() + timeoutMs;
    let resolvePromise!: (value: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });
    const timeout = setTimeout(() => this.resolve(code, false), timeoutMs);
    this.pending.set(code, { code, jobId, title, message, expiresAt, resolve: resolvePromise, timeout });
    return { code, jobId, title, message, expiresAt, promise };
  }

  get(code: string): PendingConfirmation | undefined {
    const item = this.pending.get(code);
    if (!item) return undefined;
    return { code: item.code, jobId: item.jobId, title: item.title, message: item.message, expiresAt: item.expiresAt };
  }

  list(jobId?: string): PendingConfirmation[] {
    return Array.from(this.pending.values())
      .filter((item) => !jobId || item.jobId === jobId)
      .map((item) => ({ code: item.code, jobId: item.jobId, title: item.title, message: item.message, expiresAt: item.expiresAt }));
  }

  resolve(code: string, confirmed: boolean): boolean {
    const item = this.pending.get(code);
    if (!item) return false;
    this.pending.delete(code);
    clearTimeout(item.timeout);
    item.resolve(confirmed);
    return true;
  }

  clearJob(jobId: string): void {
    for (const item of this.pending.values()) {
      if (item.jobId === jobId) this.resolve(item.code, false);
    }
  }
}
