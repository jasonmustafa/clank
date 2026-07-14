export type SystemRequest =
  | { action: "apt-update" }
  | { action: "apt-install"; packages: string[] }
  | { action: "service-status" }
  | { action: "service-restart" }
  | { action: "journal-read"; lines: number; since?: string };

export interface SystemAuditContext { requesterId: string; approvalId?: string; approverId?: string; }
export interface SystemHelperResult { ok: boolean; output: string; error?: string; }
export type ValidationResult = { ok: true; value: SystemRequest } | { ok: false; error: string };

const PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,127}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export function validateSystemRequest(value: unknown): ValidationResult {
  if (!isRecord(value) || typeof value.action !== "string") return invalid("request must be an object with an action");
  switch (value.action) {
    case "apt-update":
    case "service-status":
    case "service-restart":
      return exactKeys(value, ["action"]) ? { ok: true, value: { action: value.action } } : invalid("unexpected request field");
    case "apt-install": {
      if (!exactKeys(value, ["action", "packages"]) || !Array.isArray(value.packages)) return invalid("packages must be an array");
      if (value.packages.length < 1 || value.packages.length > 32) return invalid("packages must contain 1 to 32 names");
      if (value.packages.some((item) => typeof item !== "string" || !PACKAGE.test(item))) return invalid("invalid Debian package name");
      const packages = value.packages as string[];
      if (new Set(packages).size !== packages.length) return invalid("package names must be unique");
      return { ok: true, value: { action: "apt-install", packages } };
    }
    case "journal-read": {
      if (!exactKeys(value, ["action", "lines", "since"], ["since"])) return invalid("unexpected request field");
      if (!Number.isInteger(value.lines) || (value.lines as number) < 1 || (value.lines as number) > 500) return invalid("lines must be an integer from 1 to 500");
      if (value.since !== undefined && (typeof value.since !== "string" || !ISO_UTC.test(value.since) || Number.isNaN(Date.parse(value.since)))) return invalid("since must be an RFC3339 UTC timestamp");
      return { ok: true, value: { action: "journal-read", lines: value.lines as number, ...(value.since === undefined ? {} : { since: value.since }) } };
    }
    default: return invalid("unsupported action");
  }
}

export function isMutatingSystemRequest(request: SystemRequest): boolean {
  return request.action === "apt-update" || request.action === "apt-install" || request.action === "service-restart";
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function invalid(error: string): ValidationResult { return { ok: false, error }; }
