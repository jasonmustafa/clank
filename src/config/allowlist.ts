import type { ClankConfig } from "./env.js";

export interface AllowlistInput {
  userId: string;
  guildId?: string | null;
  channelId?: string | null;
  parentChannelId?: string | null;
  isDm: boolean;
  isKnownJobThread?: boolean;
}

export interface AllowlistDecision {
  allowed: boolean;
  reason?: string;
}

export function isUserAllowed(userId: string, config: Pick<ClankConfig, "allowedUserIds">): boolean {
  return config.allowedUserIds.has(userId);
}

export function isGuildAllowed(guildId: string | null | undefined, config: Pick<ClankConfig, "allowedGuildIds">): boolean {
  if (!guildId) return false;
  return config.allowedGuildIds.has(guildId);
}

export function isChannelAllowed(
  channelId: string | null | undefined,
  parentChannelId: string | null | undefined,
  config: Pick<ClankConfig, "allowedChannelIds">,
): boolean {
  if (config.allowedChannelIds.size === 0) return true;
  return Boolean((channelId && config.allowedChannelIds.has(channelId)) || (parentChannelId && config.allowedChannelIds.has(parentChannelId)));
}

export function checkAllowlist(input: AllowlistInput, config: ClankConfig): AllowlistDecision {
  if (!isUserAllowed(input.userId, config)) {
    return { allowed: false, reason: "user is not allowed" };
  }

  if (input.isDm) {
    return config.allowDms ? { allowed: true } : { allowed: false, reason: "DMs are disabled" };
  }

  if (!isGuildAllowed(input.guildId, config)) {
    return { allowed: false, reason: "guild is not allowed" };
  }

  if (input.isKnownJobThread) {
    return { allowed: true };
  }

  if (!isChannelAllowed(input.channelId, input.parentChannelId, config)) {
    return { allowed: false, reason: "channel is not allowed" };
  }

  return { allowed: true };
}
