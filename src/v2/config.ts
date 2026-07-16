import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const DEFAULT_CONFIG_PATH = "/srv/clank/config/clank.v2.config.json";
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface V2DiscordPolicy {
  applicationId: string;
  superuserIds: string[];
  privateChannelIds: string[];
  casual: { allowedGuildIds: string[]; allowedChannelIds: string[]; continuationTtlMs: number; maxContinuationTurns: number; userRateLimit: { requests: number; windowMs: number }; guildRateLimit: { requests: number; windowMs: number } };
}

export interface V2PiPolicy {
  agentDir: string;
  sessionsDirectory: string;
  casualAgentDir: string;
  casualIsolationDirectory: string;
  defaultWorkingDirectoryAlias: string;
  workingDirectories: Record<string, string>;
  model: { provider: string; id: string; thinkingLevel: ThinkingLevel };
}

export interface V2Policy {
  discord: V2DiscordPolicy;
  pi: V2PiPolicy;
  lifecycle: { taskStatePath: string };
  attachments: { temporaryRoot: string; maxCount: number; maxInputBytesEach: number; maxInputBytesTotal: number; maxOutputBytesEach: number; maxOutputCount: number };
}

export interface V2RuntimeConfig {
  secrets: { discordToken: string };
  policy: V2Policy;
}

export class V2ConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Clank v2 configuration:\n- ${issues.join("\n- ")}`);
    this.name = "V2ConfigValidationError";
    this.issues = issues;
  }
}

export async function loadV2Config(options: { path?: string; env?: NodeJS.ProcessEnv } = {}): Promise<V2RuntimeConfig> {
  const env = options.env ?? process.env;
  const tokenValue = env.CLANK_DISCORD_TOKEN;
  delete env.CLANK_DISCORD_TOKEN;
  const issues: string[] = [];
  const discordToken = nonEmptyString(tokenValue, "CLANK_DISCORD_TOKEN", issues);
  const path = options.path ?? env.CLANK_V2_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    issues.push(`config file ${path} could not be read as JSON: ${detail}`);
  }
  const policy = validatePolicy(document, issues);
  if (discordToken === undefined || policy === undefined || issues.length > 0) throw new V2ConfigValidationError(issues);
  return { secrets: { discordToken }, policy };
}

function validatePolicy(value: unknown, issues: string[]): V2Policy | undefined {
  const root = objectValue(value, "config", issues);
  const discordValue = objectValue(root?.discord, "discord", issues);
  const piValue = objectValue(root?.pi, "pi", issues);
  const modelValue = objectValue(piValue?.model, "pi.model", issues);
  const casualValue = objectValue(discordValue?.casual, "discord.casual", issues);
  const userRateValue = objectValue(casualValue?.userRateLimit, "discord.casual.userRateLimit", issues);
  const guildRateValue = objectValue(casualValue?.guildRateLimit, "discord.casual.guildRateLimit", issues);
  const lifecycleValue = objectValue(root?.lifecycle, "lifecycle", issues);
  const attachmentsValue = objectValue(root?.attachments, "attachments", issues);
  if (root === undefined || discordValue === undefined || piValue === undefined || modelValue === undefined || casualValue === undefined || userRateValue === undefined || guildRateValue === undefined || lifecycleValue === undefined || attachmentsValue === undefined) return undefined;

  const superuserIds = stringArray(discordValue.superuserIds, "discord.superuserIds", issues);
  if (superuserIds.length === 0) issues.push("discord.superuserIds must contain at least one immutable Discord user ID");
  const privateChannelIds = stringArray(discordValue.privateChannelIds, "discord.privateChannelIds", issues);
  const thinkingLevel = stringValue(modelValue.thinkingLevel, "pi.model.thinkingLevel", issues);
  if (!THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) issues.push("pi.model.thinkingLevel must be a supported Pi thinking level");
  const workingDirectories = absolutePathRecord(piValue.workingDirectories, "pi.workingDirectories", issues);
  const defaultWorkingDirectoryAlias = stringValue(piValue.defaultWorkingDirectoryAlias, "pi.defaultWorkingDirectoryAlias", issues);
  if (defaultWorkingDirectoryAlias !== "" && !Object.hasOwn(workingDirectories, defaultWorkingDirectoryAlias)) {
    issues.push("pi.defaultWorkingDirectoryAlias must name a configured working directory");
  }

  return {
    discord: {
      applicationId: stringValue(discordValue.applicationId, "discord.applicationId", issues),
      superuserIds,
      privateChannelIds,
      casual: {
        allowedGuildIds: stringArray(casualValue.allowedGuildIds, "discord.casual.allowedGuildIds", issues),
        allowedChannelIds: stringArray(casualValue.allowedChannelIds, "discord.casual.allowedChannelIds", issues),
        continuationTtlMs: positiveInteger(casualValue.continuationTtlMs, "discord.casual.continuationTtlMs", issues),
        maxContinuationTurns: positiveInteger(casualValue.maxContinuationTurns, "discord.casual.maxContinuationTurns", issues),
        userRateLimit: { requests: positiveInteger(userRateValue.requests, "discord.casual.userRateLimit.requests", issues), windowMs: positiveInteger(userRateValue.windowMs, "discord.casual.userRateLimit.windowMs", issues) },
        guildRateLimit: { requests: positiveInteger(guildRateValue.requests, "discord.casual.guildRateLimit.requests", issues), windowMs: positiveInteger(guildRateValue.windowMs, "discord.casual.guildRateLimit.windowMs", issues) },
      },
    },
    lifecycle: { taskStatePath: absolutePath(lifecycleValue.taskStatePath, "lifecycle.taskStatePath", issues) },
    attachments: {
      temporaryRoot: absolutePath(attachmentsValue.temporaryRoot, "attachments.temporaryRoot", issues),
      maxCount: positiveInteger(attachmentsValue.maxCount, "attachments.maxCount", issues),
      maxInputBytesEach: positiveInteger(attachmentsValue.maxInputBytesEach, "attachments.maxInputBytesEach", issues),
      maxInputBytesTotal: positiveInteger(attachmentsValue.maxInputBytesTotal, "attachments.maxInputBytesTotal", issues),
      maxOutputBytesEach: boundedPositiveInteger(attachmentsValue.maxOutputBytesEach, "attachments.maxOutputBytesEach", 10 * 1024 * 1024, issues),
      maxOutputCount: boundedPositiveInteger(attachmentsValue.maxOutputCount, "attachments.maxOutputCount", 10, issues),
    },
    pi: {
      agentDir: absolutePath(piValue.agentDir, "pi.agentDir", issues),
      sessionsDirectory: absolutePath(piValue.sessionsDirectory, "pi.sessionsDirectory", issues),
      casualAgentDir: absolutePath(piValue.casualAgentDir, "pi.casualAgentDir", issues),
      casualIsolationDirectory: absolutePath(piValue.casualIsolationDirectory, "pi.casualIsolationDirectory", issues),
      defaultWorkingDirectoryAlias,
      workingDirectories,
      model: {
        provider: stringValue(modelValue.provider, "pi.model.provider", issues),
        id: stringValue(modelValue.id, "pi.model.id", issues),
        thinkingLevel: THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel) ? thinkingLevel as ThinkingLevel : "high",
      },
    },
  };
}

function objectValue(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function stringValue(value: unknown, path: string, issues: string[]): string {
  return nonEmptyString(value, path, issues) ?? "";
}

function stringArray(value: unknown, path: string, issues: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    issues.push(`${path} must be an array of non-empty strings`);
    return [];
  }
  return value as string[];
}

function absolutePathRecord(value: unknown, path: string, issues: string[]): Record<string, string> {
  const object = objectValue(value, path, issues);
  if (object === undefined) return {};
  const result: Record<string, string> = {};
  for (const [alias, candidate] of Object.entries(object)) {
    if (alias.trim() === "" || /\s/u.test(alias) || alias === "__proto__") { issues.push(`${path} aliases must be non-empty, contain no whitespace, and not be reserved`); continue; }
    result[alias] = absolutePath(candidate, `${path}.${alias}`, issues);
  }
  if (Object.keys(result).length === 0) issues.push(`${path} must contain at least one alias`);
  return result;
}

function positiveInteger(value: unknown, path: string, issues: string[]): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) { issues.push(`${path} must be a positive integer`); return 1; } return value as number; }
function boundedPositiveInteger(value: unknown, path: string, maximum: number, issues: string[]): number { const result = positiveInteger(value, path, issues); if (result > maximum) { issues.push(`${path} must not exceed ${String(maximum)}`); return maximum; } return result; }

function absolutePath(value: unknown, path: string, issues: string[]): string {
  const result = stringValue(value, path, issues);
  if (result !== "" && !isAbsolute(result)) issues.push(`${path} must be an absolute path`);
  return result;
}
