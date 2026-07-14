import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const PRODUCTION_CONFIG_PATH = "/srv/clank/config/clank.config.json";
const PRODUCTION_ENV_PATH = "/etc/clank/clank.env";

type SensitiveEnvKey = "CLANK_DISCORD_TOKEN" | "CLANK_GITHUB_TOKEN";

export interface DiscordPolicy {
  applicationId: string;
  guildId: string;
  ownerUserIds: string[];
  workUserIds: string[];
  workRoleIds: string[];
  privilegedApproverUserIds: string[];
  workChannelIds: string[];
  elevatedChannelIds: string[];
  casualGuildIds: string[];
  casualDeniedChannelIds?: string[];
  casualContextMessages?: number;
  casualContinuationTtlMs?: number;
  casualUserRateLimit?: RateLimitPolicy;
  casualGuildRateLimit?: RateLimitPolicy;
}

export interface RateLimitPolicy {
  requests: number;
  windowMs: number;
}

export interface GithubPolicy {
  allowedOwners: string[];
  allowedRepositories: string[];
  commitAuthorName: string;
  commitAuthorEmail: string;
  commitFooter: string;
}

export interface WorkspaceRegistryEntry {
  aliases: string[];
  repository: string;
  canonicalPath?: string;
}

export interface PathPolicy {
  state: string;
  workspaces: string;
  sessions: string;
  temporary: string;
}

export interface ClankPolicy {
  discord: DiscordPolicy;
  github: GithubPolicy;
  paths: PathPolicy;
  workspaces: WorkspaceRegistryEntry[];
}

export interface RuntimeConfig {
  secrets: {
    discordToken: string;
    githubToken: string;
  };
  policy: ClankPolicy;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  local?: boolean;
  envPath?: string;
}

export interface DiscordAccessSubject {
  userId: string;
  roleIds: readonly string[];
  channelId: string | null;
  guildId: string | null;
  isBot: boolean;
  isDm: boolean;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Clank configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<RuntimeConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const local = options.local ?? env.NODE_ENV === "development";

  const envPath = options.envPath ?? (local ? join(cwd, ".env.local") : PRODUCTION_ENV_PATH);
  await loadEnvFile(envPath, env);

  const discordTokenValue = env.CLANK_DISCORD_TOKEN;
  const githubTokenValue = env.CLANK_GITHUB_TOKEN;
  delete env.CLANK_DISCORD_TOKEN;
  delete env.CLANK_GITHUB_TOKEN;

  const issues: string[] = [];
  const discordToken = requiredSecret(discordTokenValue, "CLANK_DISCORD_TOKEN", issues);
  const githubToken = requiredSecret(githubTokenValue, "CLANK_GITHUB_TOKEN", issues);
  const configPath = env.CLANK_CONFIG_PATH ?? (local
    ? join(cwd, "config", "clank.config.local.json")
    : PRODUCTION_CONFIG_PATH);
  const document = await readJson(configPath, issues);
  const policy = validatePolicy(document, issues);

  if (issues.length > 0 || policy === undefined || discordToken === undefined || githubToken === undefined) {
    throw new ConfigValidationError(issues);
  }

  return {
    secrets: { discordToken, githubToken },
    policy,
  };
}

export function isOwner(policy: DiscordPolicy, userId: string): boolean {
  return policy.ownerUserIds.includes(userId);
}

export function isPrivilegedApprover(policy: DiscordPolicy, userId: string): boolean {
  return isOwner(policy, userId) || policy.privilegedApproverUserIds.includes(userId);
}

export function canAccessWork(policy: DiscordPolicy, subject: DiscordAccessSubject): boolean {
  if (subject.isBot) return false;
  const explicitlyAuthorized = isOwner(policy, subject.userId) || policy.workUserIds.includes(subject.userId);
  if (subject.isDm) return explicitlyAuthorized;
  if (subject.guildId !== policy.guildId || subject.channelId === null) return false;

  const authorizedForGuildWork = explicitlyAuthorized
    || subject.roleIds.some((roleId) => policy.workRoleIds.includes(roleId));
  const authorizedChannel = policy.workChannelIds.includes(subject.channelId)
    || (isOwner(policy, subject.userId) && policy.elevatedChannelIds.includes(subject.channelId));
  return authorizedForGuildWork && authorizedChannel;
}

export function canAccessElevated(policy: DiscordPolicy, subject: DiscordAccessSubject): boolean {
  return !subject.isBot
    && !subject.isDm
    && subject.guildId === policy.guildId
    && isOwner(policy, subject.userId)
    && subject.channelId !== null
    && policy.elevatedChannelIds.includes(subject.channelId);
}

export function canAccessCasual(policy: DiscordPolicy, subject: DiscordAccessSubject): boolean {
  return !subject.isBot
    && !subject.isDm
    && subject.guildId !== null
    && policy.casualGuildIds.includes(subject.guildId);
}

async function loadEnvFile(path: string, env: NodeJS.ProcessEnv): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key === undefined || value === undefined || env[key] !== undefined) continue;
    env[key] = unquote(value);
  }
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function requiredSecret(value: string | undefined, key: SensitiveEnvKey, issues: string[]): string | undefined {
  if (value === undefined || value.trim() === "") {
    issues.push(`${key} must be set to a non-empty value`);
    return undefined;
  }
  return value;
}

async function readJson(path: string, issues: string[]): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    issues.push(`config file ${path} could not be read as JSON: ${detail}`);
    return undefined;
  }
}

function validatePolicy(value: unknown, issues: string[]): ClankPolicy | undefined {
  const root = record(value, "config", issues);
  if (root === undefined) return undefined;
  const discordValue = record(root.discord, "discord", issues);
  const githubValue = record(root.github, "github", issues);
  const pathsValue = record(root.paths, "paths", issues);
  if (discordValue === undefined || githubValue === undefined || pathsValue === undefined) return undefined;

  const ownerUserIds = stringArray(discordValue.ownerUserIds, "discord.ownerUserIds", issues);
  if (ownerUserIds.length === 0) issues.push("discord.ownerUserIds must contain at least one owner user ID");

  const discord: DiscordPolicy = {
    applicationId: stringValue(discordValue.applicationId, "discord.applicationId", issues),
    guildId: stringValue(discordValue.guildId, "discord.guildId", issues),
    ownerUserIds,
    workUserIds: stringArray(discordValue.workUserIds, "discord.workUserIds", issues),
    workRoleIds: stringArray(discordValue.workRoleIds, "discord.workRoleIds", issues),
    privilegedApproverUserIds: optionalStringArray(discordValue.privilegedApproverUserIds, "discord.privilegedApproverUserIds", issues),
    workChannelIds: stringArray(discordValue.workChannelIds, "discord.workChannelIds", issues),
    elevatedChannelIds: stringArray(discordValue.elevatedChannelIds, "discord.elevatedChannelIds", issues),
    casualGuildIds: stringArray(discordValue.casualGuildIds, "discord.casualGuildIds", issues),
    casualDeniedChannelIds: optionalStringArray(discordValue.casualDeniedChannelIds, "discord.casualDeniedChannelIds", issues),
    casualContextMessages: optionalPositiveInteger(discordValue.casualContextMessages, "discord.casualContextMessages", 5, issues),
    casualContinuationTtlMs: optionalPositiveInteger(discordValue.casualContinuationTtlMs, "discord.casualContinuationTtlMs", 300_000, issues),
    casualUserRateLimit: optionalRateLimit(discordValue.casualUserRateLimit, "discord.casualUserRateLimit", { requests: 5, windowMs: 60_000 }, issues),
    casualGuildRateLimit: optionalRateLimit(discordValue.casualGuildRateLimit, "discord.casualGuildRateLimit", { requests: 20, windowMs: 60_000 }, issues),
  };
  const github: GithubPolicy = {
    allowedOwners: stringArray(githubValue.allowedOwners, "github.allowedOwners", issues),
    allowedRepositories: stringArray(githubValue.allowedRepositories, "github.allowedRepositories", issues),
    commitAuthorName: stringValue(githubValue.commitAuthorName, "github.commitAuthorName", issues),
    commitAuthorEmail: stringValue(githubValue.commitAuthorEmail, "github.commitAuthorEmail", issues),
    commitFooter: stringValue(githubValue.commitFooter, "github.commitFooter", issues),
  };
  const paths: PathPolicy = {
    state: absolutePath(pathsValue.state, "paths.state", issues),
    workspaces: absolutePath(pathsValue.workspaces, "paths.workspaces", issues),
    sessions: absolutePath(pathsValue.sessions, "paths.sessions", issues),
    temporary: absolutePath(pathsValue.temporary, "paths.temporary", issues),
  };
  const workspaces = workspaceEntries(root.workspaces, issues);
  return { discord, github, paths, workspaces };
}

function workspaceEntries(value: unknown, issues: string[]): WorkspaceRegistryEntry[] {
  if (!Array.isArray(value)) {
    issues.push("workspaces must be an array");
    return [];
  }
  return value.map((item, index) => {
    const path = `workspaces[${String(index)}]`;
    const entry = record(item, path, issues);
    if (entry === undefined) return { aliases: [], repository: "" };
    const canonicalPath = entry.canonicalPath === undefined
      ? undefined
      : absolutePath(entry.canonicalPath, `${path}.canonicalPath`, issues);
    return {
      aliases: stringArray(entry.aliases, `${path}.aliases`, issues),
      repository: stringValue(entry.repository, `${path}.repository`, issues),
      ...(canonicalPath === undefined ? {} : { canonicalPath }),
    };
  });
}

function record(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string`);
    return "";
  }
  return value;
}

function stringArray(value: unknown, path: string, issues: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    issues.push(`${path} must be an array of non-empty strings`);
    return [];
  }
  return value as string[];
}

function optionalStringArray(value: unknown, path: string, issues: string[]): string[] {
  return value === undefined ? [] : stringArray(value, path, issues);
}

function optionalPositiveInteger(value: unknown, path: string, fallback: number, issues: string[]): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0) { issues.push(`${path} must be a positive integer`); return fallback; }
  return value as number;
}

function optionalRateLimit(value: unknown, path: string, fallback: RateLimitPolicy, issues: string[]): RateLimitPolicy {
  if (value === undefined) return fallback;
  const item = record(value, path, issues);
  if (item === undefined) return fallback;
  return {
    requests: optionalPositiveInteger(item.requests, `${path}.requests`, fallback.requests, issues),
    windowMs: optionalPositiveInteger(item.windowMs, `${path}.windowMs`, fallback.windowMs, issues),
  };
}

function absolutePath(value: unknown, path: string, issues: string[]): string {
  const result = stringValue(value, path, issues);
  if (result !== "" && !isAbsolute(result)) issues.push(`${path} must be an absolute path`);
  return result;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
