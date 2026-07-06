import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { uniqueResolvedPaths } from "../utils/pathRoots.js";

export interface ClankConfig {
  discordToken: string;
  clientId?: string;
  allowedUserIds: Set<string>;
  allowedGuildIds: Set<string>;
  allowedChannelIds: Set<string>;
  allowDms: boolean;
  allowGuildChannelMessages: boolean;
  commandPrefixes: string[];
  piAgentDir: string;
  piSessionDir: string;
  workspaceRoot: string;
  clankAppDir: string;
  allowedRootDirs: string[];
  stateDir: string;
  tempDir: string;
  maxAttachmentBytes: number;
  previewThrottleMs: number;
  destructiveConfirmTimeoutMs: number;
  defaultRunner: "sdk" | "rpc" | "container-rpc" | "microvm-rpc";
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return parsed;
}

export function parsePathList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseSet(value: string | undefined): Set<string> {
  return new Set(parsePathList(value));
}

function parsePrefixes(value: string | undefined): string[] {
  const prefixes = (value ?? "!,/")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return prefixes.length > 0 ? prefixes : ["!", "/"];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClankConfig {
  loadDotenv();

  const discordToken = env.DISCORD_TOKEN;
  if (!discordToken) {
    throw new Error("DISCORD_TOKEN is required");
  }

  const allowedUserIds = parseSet(env.DISCORD_ALLOWED_USER_IDS);
  if (allowedUserIds.size === 0) {
    throw new Error("DISCORD_ALLOWED_USER_IDS must contain at least one Discord user ID");
  }

  const defaultRunner = (env.CLANK_RUNNER ?? "sdk") as ClankConfig["defaultRunner"];
  if (!["sdk", "rpc", "container-rpc", "microvm-rpc"].includes(defaultRunner)) {
    throw new Error(`Unsupported CLANK_RUNNER: ${env.CLANK_RUNNER}`);
  }

  const piAgentDir = resolve(env.PI_AGENT_DIR || "/opt/clank/pi-agent");
  const piSessionDir = resolve(env.PI_SESSION_DIR || "/opt/clank/pi-sessions");
  const workspaceRoot = resolve(env.CLANK_WORKSPACE_ROOT || "/opt/clank/workspaces");
  const clankAppDir = resolve(env.CLANK_APP_DIR || "/opt/clank/app");
  const stateDir = resolve(env.CLANK_STATE_DIR || "/opt/clank/state");
  const tempDir = resolve(env.CLANK_TEMP_DIR || "/opt/clank/tmp");
  const configuredAllowedRoots = parsePathList(env.CLANK_ALLOWED_ROOTS);
  const allowedRootDirs = uniqueResolvedPaths([
    workspaceRoot,
    ...(configuredAllowedRoots.length > 0 ? configuredAllowedRoots : [clankAppDir, piAgentDir]),
  ]);

  return {
    discordToken,
    clientId: env.DISCORD_CLIENT_ID || undefined,
    allowedUserIds,
    allowedGuildIds: parseSet(env.DISCORD_ALLOWED_GUILD_IDS),
    allowedChannelIds: parseSet(env.DISCORD_ALLOWED_CHANNEL_IDS),
    allowDms: parseBoolean(env.DISCORD_ALLOW_DMS, true),
    allowGuildChannelMessages: parseBoolean(env.DISCORD_ALLOW_GUILD_CHANNEL_MESSAGES, false),
    commandPrefixes: parsePrefixes(env.CLANK_COMMAND_PREFIXES),
    piAgentDir,
    piSessionDir,
    workspaceRoot,
    clankAppDir,
    allowedRootDirs,
    stateDir,
    tempDir,
    maxAttachmentBytes: parseNumber(env.CLANK_MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024),
    previewThrottleMs: parseNumber(env.CLANK_PREVIEW_THROTTLE_MS, 1500),
    destructiveConfirmTimeoutMs: parseNumber(env.CLANK_CONFIRM_TIMEOUT_MS, 60_000),
    defaultRunner,
  };
}
