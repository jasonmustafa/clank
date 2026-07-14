import { spawn } from "node:child_process";
import { validateSystemRequest, type SystemAuditContext, type SystemHelperResult, type SystemRequest } from "./system-protocol.js";

const SUDO = "/usr/bin/sudo";
const HELPER = "/usr/local/lib/clank/system-helper";
const MAX_RESPONSE = 300 * 1024;

export class SystemHelperClient {
  async invoke(request: SystemRequest, context: SystemAuditContext): Promise<SystemHelperResult> {
    const validation = validateSystemRequest(request);
    if (!validation.ok) throw new Error(`Invalid system helper request: ${validation.error}`);
    return new Promise((resolve, reject) => {
      const child = spawn(SUDO, ["-n", "--", HELPER], { shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; if (stdout.length > MAX_RESPONSE) child.kill("SIGKILL"); });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; if (stderr.length > 4096) stderr = stderr.slice(0, 4096); });
      child.once("error", reject);
      child.once("close", (code) => {
        if (stdout.length > MAX_RESPONSE) { reject(new Error("System helper response limit exceeded")); return; }
        if (code !== 0) { reject(new Error(`System helper failed with exit code ${String(code)}: ${stderr.trim()}`)); return; }
        try { resolve(JSON.parse(stdout) as SystemHelperResult); } catch { reject(new Error("System helper returned an invalid response")); }
      });
      child.stdin.end(`${JSON.stringify({ request: validation.value, context })}\n`);
    });
  }
}
