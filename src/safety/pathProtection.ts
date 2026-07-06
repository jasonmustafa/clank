import { relative, resolve } from "node:path";
import { isAllowedByRoots, isInside, uniqueResolvedPaths } from "../utils/pathRoots.js";

export { isAllowedByRoots, isInside, uniqueResolvedPaths } from "../utils/pathRoots.js";

export interface PathProtectionConfig {
  workspaceRoot: string;
  piAgentDir: string;
  clankAppDir?: string;
  allowedRoots?: string[];
  extraBlockedRoots?: string[];
  mode?: "standard" | "self-improvement" | "pi-agent";
}

const SAFE_PI_AGENT_SUBDIRS = new Set(["skills", "prompts", "extensions", "themes", "packages"]);

const SENSITIVE_ENV_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  ".env.staging",
  ".env.production.local",
  ".env.development.local",
  ".env.test.local",
  ".env.staging.local",
]);

const SENSITIVE_BASENAMES = new Set([
  "auth.json",
  "models.json",
  "settings.json",
  "id_rsa",
  "id_ed25519",
  "known_hosts",
  "docker.sock",
]);

const SENSITIVE_DIR_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".docker", ".git", "node_modules"]);
const ALWAYS_BLOCKED_ROOTS = ["/proc", "/sys/kernel", "/sys/fs/cgroup"];

function allowedRootsFromConfig(config: PathProtectionConfig): string[] {
  return uniqueResolvedPaths(config.allowedRoots && config.allowedRoots.length > 0 ? config.allowedRoots : [config.workspaceRoot]);
}

function pathSegments(path: string): string[] {
  return resolve(path).toLowerCase().split(/[\\/]+/).filter(Boolean);
}

function hasGitHubCliConfigPath(segments: readonly string[]): boolean {
  return segments.some((segment, index) => segment === ".config" && segments[index + 1] === "gh");
}

export function normalizeCandidatePath(inputPath: string, cwd: string): string {
  const withoutAt = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  return resolve(cwd, withoutAt);
}

export function isSensitivePath(path: string, config: PathProtectionConfig): boolean {
  const resolved = resolve(path);
  const lower = resolved.toLowerCase();
  const segments = pathSegments(resolved);
  const base = segments.at(-1) ?? "";

  if (ALWAYS_BLOCKED_ROOTS.some((root) => isInside(resolved, root))) return true;
  if (SENSITIVE_ENV_BASENAMES.has(base)) return true;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (segments.some((segment) => SENSITIVE_DIR_SEGMENTS.has(segment))) return true;
  if (hasGitHubCliConfigPath(segments)) return true;
  if (lower.includes("/run/docker.sock") || lower.includes("/var/run/docker.sock")) return true;

  if (isInside(resolved, config.piAgentDir)) {
    const rel = relative(resolve(config.piAgentDir), resolved);
    const first = rel.split(/[\\/]/)[0] ?? "";
    if (!SAFE_PI_AGENT_SUBDIRS.has(first)) return true;
  }
  for (const root of config.extraBlockedRoots ?? []) {
    if (isInside(resolved, root)) return true;
  }
  return false;
}

export function explainPathPolicy(inputPath: string, cwd: string, config: PathProtectionConfig): string | undefined {
  const resolved = normalizeCandidatePath(inputPath, cwd);
  const allowedRoots = allowedRootsFromConfig(config);
  if (!isAllowedByRoots(resolved, allowedRoots)) {
    return `Path is outside allowed roots (${allowedRoots.join(", ")}): ${inputPath}`;
  }
  if (isSensitivePath(resolved, config)) {
    return `Path is protected: ${inputPath}`;
  }
  return undefined;
}

const SECRET_ENV_KEY_PATTERN = /(TOKEN|SECRET|KEY|PASSWORD|PASS|COOKIE|CREDENTIAL|AUTH|PRIVATE|SSH|DISCORD|ANTHROPIC|OPENAI|GOOGLE|GITHUB|GITLAB|AWS|AZURE)/i;
const ENV_SECRET_NAME_PATTERN = /(^|[\\/\s"'`=])\.env(?:\.(?:local|production|development|test|staging|production\.local|development\.local|test\.local|staging\.local))?(?=$|[\\/\s"'`;|&<>])/i;
const PROTECTED_FILE_NAME_PATTERN = /(^|[\\/\s"'`=])(auth\.json|models\.json|settings\.json|id_rsa|id_ed25519|known_hosts|docker\.sock)(?=$|[\\/\s"'`;|&<>])/i;
const PROTECTED_DIR_NAME_PATTERN = /(^|[\\/\s"'`=])(\.ssh|\.gnupg|\.aws|\.docker|\.git)(?=$|[\\/\s"'`;|&<>])/i;
const GITHUB_CLI_CONFIG_PATTERN = /(^|[\\/\s"'`=])\.config[\\/]gh(?=$|[\\/\s"'`;|&<>])/i;
const ABSOLUTE_PATH_TOKEN_PATTERN = /(^|[\s"'`([<{=])(@?\/[^\s"'`;$|&<>)]*)/g;

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  const allow = new Set(["HOME", "PATH", "SHELL", "TERM", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "LOGNAME", "CI"]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (allow.has(key) || key.startsWith("npm_")) safe[key] = value;
    if (SECRET_ENV_KEY_PATTERN.test(key)) delete safe[key];
  }
  return safe;
}

function cleanCommandPathToken(token: string): string {
  return token.replace(/^@/, "").replace(/[.,;:]+$/g, "");
}

function commandAbsolutePathPolicyReason(command: string, config: PathProtectionConfig): string | undefined {
  const allowedRoots = allowedRootsFromConfig(config);
  for (const match of command.matchAll(ABSOLUTE_PATH_TOKEN_PATTERN)) {
    const rawPath = match[2];
    if (!rawPath) continue;
    const path = cleanCommandPathToken(rawPath);
    if (!path) continue;
    const resolved = resolve(path);
    if (!isAllowedByRoots(resolved, allowedRoots)) {
      return `Command references path outside allowed roots (${allowedRoots.join(", ")}): ${path}`;
    }
    if (isSensitivePath(resolved, config)) {
      return `Command references protected path: ${path}`;
    }
  }
  return undefined;
}

export function commandTouchesSensitivePath(command: string, config: PathProtectionConfig): string | undefined {
  const lower = command.toLowerCase();
  const blockedNeedles = [
    "/etc/clank/clank.env",
    "/usr/local/sbin/deploy-clank",
    "deploy-clank",
    "discord_token",
    "anthropic_api_key",
    "openai_api_key",
    "google_api_key",
    "github_token",
    "/etc/shadow",
    "/proc/self/environ",
  ];
  const found = blockedNeedles.find((needle) => lower.includes(needle));
  if (found) return `Command references protected secret/path (${found})`;
  if (ENV_SECRET_NAME_PATTERN.test(command)) return "Command references protected .env file";
  if (PROTECTED_FILE_NAME_PATTERN.test(command)) return "Command references protected credential/settings file";
  if (PROTECTED_DIR_NAME_PATTERN.test(command) || GITHUB_CLI_CONFIG_PATTERN.test(command)) return "Command references protected credential/config directory";
  if (/\bps\b.*\b(e|eww|auxe)\b/i.test(command)) return "Command may expose process environments";

  const absolutePathReason = commandAbsolutePathPolicyReason(command, config);
  if (absolutePathReason) return absolutePathReason;

  if (config.mode === "self-improvement" && /\b(npm\s+run\s+start|node\s+dist\/index\.js|tsx\s+src\/index\.ts)\b/i.test(command)) {
    return "Starting/restarting Clank is manual for MVP";
  }
  const piAgent = resolve(config.piAgentDir).toLowerCase();
  if (lower.includes(`${piAgent}/auth.json`) || lower.includes(`${piAgent}/models.json`) || lower.includes(`${piAgent}/settings.json`)) {
    return "Command references protected Pi agent auth/settings files";
  }
  return undefined;
}

export function commandNeedsConfirmation(command: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/\bsudo\b/i, "sudo is not allowed for Clank jobs"],
    [/\brm\s+(-[a-z]*r[a-z]*f?|--recursive|--force)/i, "recursive/forced removal"],
    [/\b(systemctl|service)\b/i, "service management"],
    [/\b(chmod|chown)\b/i, "permission/ownership changes"],
    [/\b(mkfs|mount|umount|fdisk|parted)\b/i, "disk or mount operation"],
    [/\b(docker|podman)\b/i, "container runtime operation"],
    [/\b(killall|pkill|reboot|shutdown)\b/i, "process or host control"],
  ];
  for (const [pattern, reason] of patterns) {
    if (pattern.test(command)) return reason;
  }
  return undefined;
}
