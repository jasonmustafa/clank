import type { Client, Guild, Role } from "discord.js";

export interface GuildRoleScanRequest {
  guildId: string;
  includeMembers?: boolean;
}

export interface GuildRoleScanResult {
  guildId: string;
  guildName: string;
  roles: Array<{ id: string; name: string; managed: boolean; memberCount?: number }>;
  notes: string[];
}

/**
 * Placeholder for future guild/role discovery.
 *
 * Required Discord setup must be documented before this grows beyond metadata:
 * - GatewayIntentBits.Guilds for guild/role metadata already used by the bot.
 * - GatewayIntentBits.GuildMembers is privileged and required for complete member/role membership scans.
 * - Bot permissions should stay read-only unless a future explicitly approved role mutation flow is added.
 */
export async function scanGuildRoles(client: Client, request: GuildRoleScanRequest): Promise<GuildRoleScanResult> {
  const guild = await client.guilds.fetch(request.guildId);
  const roles = await guild.roles.fetch();
  return formatGuildRoles(guild, Array.from(roles.values()).filter((role): role is Role => Boolean(role)), request.includeMembers === true);
}

function formatGuildRoles(guild: Guild, roles: Role[], includeMembers: boolean): GuildRoleScanResult {
  return {
    guildId: guild.id,
    guildName: guild.name,
    roles: roles
      .sort((a, b) => b.position - a.position)
      .map((role) => ({
        id: role.id,
        name: role.name,
        managed: role.managed,
        memberCount: includeMembers ? role.members.size : undefined,
      })),
    notes: includeMembers
      ? ["Member counts require GuildMembers intent and cache/fetch behavior to be reviewed before production use."]
      : ["Role metadata only; member scanning is intentionally not wired into commands yet."],
  };
}
