import { spawn } from "node:child_process";
import { validateGithubHelperRequest, type GithubAuditContext, type GithubHelperRequest, type GithubHelperResult } from "./github-protocol.js";

export class GithubHelperClient {
  async invoke(request: GithubHelperRequest, context: GithubAuditContext): Promise<GithubHelperResult> {
    const validated = validateGithubHelperRequest(request);
    if (!validated.ok) throw new Error(`Invalid GitHub helper request: ${validated.error}`);
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/sudo", ["-n", "--", "/usr/local/lib/clank/github-helper"], { shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 64 * 1024) child.kill("SIGKILL"); });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
      child.once("error", reject);
      child.once("close", (code) => { if (code !== 0) { reject(new Error(`GitHub helper failed (${String(code)}): ${stderr.trim()}`)); return; } try { const value: unknown = JSON.parse(stdout); if (!isResult(value)) throw new Error(); resolve(value); } catch { reject(new Error("GitHub helper returned an invalid response")); } });
      child.stdin.end(`${JSON.stringify({ request: validated.value, context })}\n`);
    });
  }
}
function isResult(value: unknown): value is GithubHelperResult { if (typeof value !== "object" || value === null) return false; const item = value as Record<string, unknown>; return typeof item.ok === "boolean" && typeof item.action === "string" && (item.ok ? true : typeof item.error === "string"); }
