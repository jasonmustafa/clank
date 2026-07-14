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
  defaultBaseBranch: string;
  maxChangedFiles: number;
  maxChangedLines: number;
  maxDiffBytes: number;
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
  resources: string;
}

export interface ResourceSource {
  id: string;
  repo: string;
  ref: string;
  skills: string[];
  prompts: string[];
  extensions: string[];
}

export interface DeploymentPolicy {
  appPath: string;
  remote: string;
  branch: string;
  checks: {
    install: string[];
    typecheck: string[];
    tests: string[];
    build: string[];
    registerCommands: string[];
  };
}

export interface LifecyclePolicy {
  runnerIdleTtlMs: number;
  cleanupRetentionMs: number;
}

export interface ClankPolicy {
  discord: DiscordPolicy;
  github: GithubPolicy;
  deployment: DeploymentPolicy;
  lifecycle: LifecyclePolicy;
  paths: PathPolicy;
  workspaces: WorkspaceRegistryEntry[];
  resources: ResourceSource[];
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
  const deploymentValue = record(root.deployment, "deployment", issues);
  if (discordValue === undefined || githubValue === undefined || pathsValue === undefined || deploymentValue === undefined) return undefined;

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
  const allowedOwners = stringArray(githubValue.allowedOwners, "github.allowedOwners", issues).map((item) => item.toLowerCase());
  const allowedRepositories = stringArray(githubValue.allowedRepositories, "github.allowedRepositories", issues).map((item) => item.toLowerCase());
  const ownerPattern = /^[A-Za-z0-9_.-]+$/u;
  const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
  if (allowedOwners.some((owner) => !ownerPattern.test(owner))) issues.push("github.allowedOwners contains an invalid owner");
  if (allowedRepositories.some((repository) => !repositoryPattern.test(repository))) issues.push("github.allowedRepositories contains an invalid repository");
  if (allowedRepositories.some((repository) => !allowedOwners.includes(repository.split("/")[0] ?? ""))) issues.push("github.allowedRepositories must be owned by github.allowedOwners");
  const github: GithubPolicy = {
    allowedOwners,
    allowedRepositories,
    commitAuthorName: stringValue(githubValue.commitAuthorName, "github.commitAuthorName", issues),
    commitAuthorEmail: stringValue(githubValue.commitAuthorEmail, "github.commitAuthorEmail", issues),
    commitFooter: stringValue(githubValue.commitFooter, "github.commitFooter", issues),
    defaultBaseBranch: optionalString(githubValue.defaultBaseBranch, "github.defaultBaseBranch", "main", issues),
    maxChangedFiles: optionalPositiveInteger(githubValue.maxChangedFiles, "github.maxChangedFiles", 100, issues),
    maxChangedLines: optionalPositiveInteger(githubValue.maxChangedLines, "github.maxChangedLines", 5000, issues),
    maxDiffBytes: optionalPositiveInteger(githubValue.maxDiffBytes, "github.maxDiffBytes", 1_000_000, issues),
  };
  const checksValue = record(deploymentValue.checks, "deployment.checks", issues);
  const deployment: DeploymentPolicy = {
    appPath: absolutePath(deploymentValue.appPath, "deployment.appPath", issues),
    remote: safeGitName(deploymentValue.remote, "deployment.remote", issues),
    branch: safeGitName(deploymentValue.branch, "deployment.branch", issues),
    checks: {
      install: commandValue(checksValue?.install, "deployment.checks.install", issues),
      typecheck: commandValue(checksValue?.typecheck, "deployment.checks.typecheck", issues),
      tests: commandValue(checksValue?.tests, "deployment.checks.tests", issues),
      build: commandValue(checksValue?.build, "deployment.checks.build", issues),
      registerCommands: commandValue(checksValue?.registerCommands, "deployment.checks.registerCommands", issues),
    },
  };
  const paths: PathPolicy = {
    state: absolutePath(pathsValue.state, "paths.state", issues),
    workspaces: absolutePath(pathsValue.workspaces, "paths.workspaces", issues),
    sessions: absolutePath(pathsValue.sessions, "paths.sessions", issues),
    temporary: absolutePath(pathsValue.temporary, "paths.temporary", issues),
    resources: pathsValue.resources === undefined
      ? join(absolutePath(pathsValue.state, "paths.state", issues), "resources")
      : absolutePath(pathsValue.resources, "paths.resources", issues),
  };
  const lifecycleValue = root.lifecycle === undefined ? {} : record(root.lifecycle, "lifecycle", issues);
  const lifecycle: LifecyclePolicy = {
    runnerIdleTtlMs: optionalPositiveInteger(lifecycleValue?.runnerIdleTtlMs, "lifecycle.runnerIdleTtlMs", 15 * 60_000, issues),
    cleanupRetentionMs: optionalPositiveInteger(lifecycleValue?.cleanupRetentionMs, "lifecycle.cleanupRetentionMs", 30 * 24 * 60 * 60_000, issues),
  };
  const workspaces = workspaceEntries(root.workspaces, issues);
  const resources = resourceEntries(root.resources, issues);
  return { discord, github, deployment, lifecycle, paths, workspaces, resources };
}

function resourceEntries(value: unknown, issues: string[]): ResourceSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { issues.push("resources must be an array"); return []; }
  const ids = new Set<string>();
  return value.map((item, index) => {
    const path = `resources[${String(index)}]`;
    const entry = record(item, path, issues);
    if (entry === undefined) return { id: "", repo: "", ref: "", skills: [], prompts: [], extensions: [] };
    const id = stringValue(entry.id, `${path}.id`, issues);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(id)) issues.push(`${path}.id must be a safe path segment`);
    if (ids.has(id)) issues.push(`${path}.id must be unique`); else ids.add(id);
    return {
      id,
      repo: stringValue(entry.repo, `${path}.repo`, issues),
      ref: stringValue(entry.ref, `${path}.ref`, issues),
      skills: resourcePatterns(entry.skills, `${path}.skills`, issues),
      prompts: resourcePatterns(entry.prompts, `${path}.prompts`, issues),
      extensions: resourcePatterns(entry.extensions, `${path}.extensions`, issues),
    };
  });
}

function resourcePatterns(value: unknown, path: string, issues: string[]): string[] {
  const patterns = optionalStringArray(value, path, issues);
  patterns.forEach((pattern, index) => {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/u).includes("..")) issues.push(`${path}[${String(index)}] must stay within its source checkout`);
  });
  return patterns;
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

function optionalString(value: unknown, path: string, fallback: string, issues: string[]): string {
  return value === undefined ? fallback : stringValue(value, path, issues);
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

function commandValue(value: unknown, path: string, issues: string[]): string[] {
  const command = stringArray(value, path, issues);
  if (command.length === 0) issues.push(`${path} must contain an executable`);
  return command;
}

function safeGitName(value: unknown, path: string, issues: string[]): string {
  const result = stringValue(value, path, issues);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(result) || result.includes("..")) issues.push(`${path} must be a safe git remote or branch name`);
  return result;
}

function absolutePath(value: unknown, path: string, issues: string[]): string {
  const result = stringValue(value, path, issues);
  if (result !== "" && !isAbsolute(result)) issues.push(`${path} must be an absolute path`);
  return result;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
