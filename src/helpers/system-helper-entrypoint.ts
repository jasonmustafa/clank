#!/usr/local/lib/clank/node/bin/node
import { executeSystemRequest } from "./system-helper.js";
import { type SystemAuditContext } from "./system-protocol.js";

const MAX_REQUEST_BYTES = 16 * 1024;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
    process.stderr.write("Request exceeds size limit\n");
    process.exit(2);
  }
});
process.stdin.once("end", () => { void main(); });

async function main(): Promise<void> {
  try {
    const document: unknown = JSON.parse(input);
    if (!isEnvelope(document)) throw new Error("Invalid helper request envelope");
    const result = await executeSystemRequest(document.request, {}, document.context);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "System helper failed"}\n`);
    process.exitCode = 1;
  }
}

function isEnvelope(value: unknown): value is { request: unknown; context: SystemAuditContext } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "request" && key !== "context")) return false;
  const context = record.context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) return false;
  const item = context as Record<string, unknown>;
  return typeof item.requesterId === "string"
    && (item.approvalId === undefined || typeof item.approvalId === "string")
    && (item.approverId === undefined || typeof item.approverId === "string")
    && Object.keys(item).every((key) => ["requesterId", "approvalId", "approverId"].includes(key));
}
