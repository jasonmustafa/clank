import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  canAccessCasual,
  canAccessElevated,
  canAccessWork,
  isOwner,
  isPrivilegedApprover,
  loadConfig,
  type DiscordAccessSubject,
} from "./index.js";

const policy = {
  discord: {
    applicationId: "app",
    guildId: "work-guild",
    ownerUserIds: ["owner"],
    workUserIds: ["worker"],
    workRoleIds: ["work-role"],
    privilegedApproverUserIds: ["approver"],
    workChannelIds: ["work-channel"],
    elevatedChannelIds: ["elevated-channel"],
    casualGuildIds: ["casual-guild"],
  },
  github: {
    allowedOwners: ["octo"],
    allowedRepositories: ["octo/repo"],
    commitAuthorName: "Clank",
    commitAuthorEmail: "clank@example.test",
    commitFooter: "Generated-by: Clank, owner's clanker",
  },
  workspaces: [
    { aliases: ["repo"], repository: "octo/repo", canonicalPath: "/srv/repos/repo" },
  ],
  deployment: {
    appPath: "/srv/clank/app",
    remote: "origin",
    branch: "main",
    checks: {
      install: ["npm", "ci"],
      typecheck: ["npm", "run", "check"],
      tests: ["npm", "test"],
      build: ["npm", "run", "build"],
      registerCommands: ["npm", "run", "register-commands"],
    },
  },
  paths: {
    state: "/srv/clank/state",
    workspaces: "/srv/clank/workspaces",
    sessions: "/srv/clank/sessions",
    temporary: "/srv/clank/tmp",
    resources: "/srv/clank/resources",
  },
  safety: {
    normalWork: { confirmWorkspaceDestructive: true },
    elevatedWork: { confirmWorkspaceDestructive: false },
  },
  resources: [
    {
      id: "trusted-tools",
      repo: "https://github.com/example/resources.git",
      ref: "v1.2.3",
      skills: ["skills/*/SKILL.md"],
      prompts: ["prompts/review.md"],
      extensions: ["extensions/*.ts"],
    },
  ],
};

async function policyFile(value: unknown = policy): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clank-config-"));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

function subject(overrides: Partial<DiscordAccessSubject> = {}): DiscordAccessSubject {
  return {
    userId: "stranger",
    roleIds: [],
    channelId: "other-channel",
    guildId: "work-guild",
    isBot: false,
    isDm: false,
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads secrets from env and policy from a JSON override, then clears secrets", async () => {
    const path = await policyFile();
    const env: NodeJS.ProcessEnv = {
      CLANK_CONFIG_PATH: path,
      CLANK_DISCORD_TOKEN: "discord-secret",
      CLANK_GITHUB_TOKEN: "github-secret",
    };

    const config = await loadConfig({ env, cwd: "/unused" });

    expect(config.secrets).toEqual({ discordToken: "discord-secret", githubToken: "github-secret" });
    expect(config.policy.discord.applicationId).toBe("app");
    expect(config.policy.workspaces[0]?.repository).toBe("octo/repo");
    expect(config.policy.resources[0]).toEqual(policy.resources[0]);
    expect(config.policy.paths.resources).toBe("/srv/clank/resources");
    expect(config.policy.safety).toEqual(policy.safety);
    expect(env.CLANK_DISCORD_TOKEN).toBeUndefined();
    expect(env.CLANK_GITHUB_TOKEN).toBeUndefined();
  });

  it("loads .env.local and local policy defaults for development", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "clank-local-"));
    await writeFile(join(cwd, ".env.local"), "CLANK_DISCORD_TOKEN=local-discord\nCLANK_GITHUB_TOKEN=local-github\n");
    await mkdir(join(cwd, "config"));
    await writeFile(join(cwd, "config", "clank.config.local.json"), JSON.stringify(policy));

    const config = await loadConfig({ env: {}, cwd, local: true });

    expect(config.secrets.discordToken).toBe("local-discord");
    expect(config.policy.paths.state).toBe("/srv/clank/state");
  });

  it("loads a production env file when secrets are not already in the environment", async () => {
    const path = await policyFile();
    const directory = await mkdtemp(join(tmpdir(), "clank-env-"));
    const envPath = join(directory, "clank.env");
    await writeFile(envPath, "CLANK_DISCORD_TOKEN=file-discord\nCLANK_GITHUB_TOKEN=file-github\n");

    const config = await loadConfig({ env: { CLANK_CONFIG_PATH: path }, cwd: "/unused", envPath });

    expect(config.secrets).toEqual({ discordToken: "file-discord", githubToken: "file-github" });
  });

  it("defaults safety profiles and rejects non-boolean options", async () => {
    const withoutSafety: Record<string, unknown> = { ...policy };
    delete withoutSafety.safety;
    const defaultPath = await policyFile(withoutSafety);
    const defaults = await loadConfig({ env: { CLANK_CONFIG_PATH: defaultPath, CLANK_DISCORD_TOKEN: "d", CLANK_GITHUB_TOKEN: "g" } });
    expect(defaults.policy.safety.normalWork.confirmWorkspaceDestructive).toBe(true);
    expect(defaults.policy.safety.elevatedWork.confirmWorkspaceDestructive).toBe(false);

    const invalidPath = await policyFile({ ...policy, safety: { ...policy.safety, elevatedWork: { confirmWorkspaceDestructive: "no" } } });
    await expect(loadConfig({ env: { CLANK_CONFIG_PATH: invalidPath, CLANK_DISCORD_TOKEN: "d", CLANK_GITHUB_TOKEN: "g" } }))
      .rejects.toThrow("safety.elevatedWork.confirmWorkspaceDestructive");
  });

  it("rejects resource patterns that escape their checkout", async () => {
    const path = await policyFile({ ...policy, resources: [{ ...policy.resources[0], skills: ["../secret/SKILL.md"] }] });
    await expect(loadConfig({ env: { CLANK_CONFIG_PATH: path, CLANK_DISCORD_TOKEN: "d", CLANK_GITHUB_TOKEN: "g" } }))
      .rejects.toThrow("resources[0].skills[0]");
  });

  it("reports actionable paths without exposing secret values", async () => {
    const path = await policyFile({ ...policy, discord: { ...policy.discord, ownerUserIds: "nope" } });
    const secret = "must-not-leak";

    await expect(loadConfig({
      env: { CLANK_CONFIG_PATH: path, CLANK_DISCORD_TOKEN: secret },
      cwd: "/unused",
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("discord.ownerUserIds");
      expect(message).toContain("CLANK_GITHUB_TOKEN");
      expect(message).not.toContain(secret);
      return true;
    });
  });
});

describe("authorization tiers", () => {
  const discord = policy.discord;

  it("recognizes owners and privileged approvers, with owners always able to approve", () => {
    expect(isOwner(discord, "owner")).toBe(true);
    expect(isOwner(discord, "worker")).toBe(false);
    expect(isPrivilegedApprover(discord, "owner")).toBe(true);
    expect(isPrivilegedApprover(discord, "approver")).toBe(true);
    expect(isPrivilegedApprover(discord, "worker")).toBe(false);
  });

  it("allows work users or roles only in work channels or DMs", () => {
    expect(canAccessWork(discord, subject({ userId: "worker", channelId: "work-channel" }))).toBe(true);
    expect(canAccessWork(discord, subject({ roleIds: ["work-role"], channelId: "work-channel" }))).toBe(true);
    expect(canAccessWork(discord, subject({ userId: "owner", isDm: true, guildId: null }))).toBe(true);
    expect(canAccessWork(discord, subject({ userId: "worker", isDm: true, guildId: null }))).toBe(true);
    expect(canAccessWork(discord, subject({ roleIds: ["work-role"], isDm: true, guildId: null }))).toBe(false);
    expect(canAccessWork(discord, subject({ userId: "owner", channelId: "elevated-channel" }))).toBe(true);
    expect(canAccessWork(discord, subject({ userId: "worker", channelId: "elevated-channel" }))).toBe(false);
    expect(canAccessWork({ ...discord, workChannelIds: ["elevated-channel"] }, subject({ userId: "worker", channelId: "elevated-channel" }))).toBe(false);
    expect(canAccessWork(discord, subject({ userId: "worker", channelId: "other-channel" }))).toBe(false);
    expect(canAccessWork(discord, subject({ userId: "worker", channelId: "work-channel", guildId: "other-guild" }))).toBe(false);
    expect(canAccessWork(discord, subject({ userId: "approver", channelId: "work-channel" }))).toBe(false);
    expect(canAccessWork(discord, subject({ channelId: "work-channel" }))).toBe(false);
    expect(canAccessWork(discord, subject({ isDm: true, guildId: null }))).toBe(false);
    expect(canAccessWork(discord, subject({ userId: "worker", isBot: true, channelId: "work-channel" }))).toBe(false);
    expect(canAccessWork(discord, subject({ userId: "worker", isBot: true, isDm: true, guildId: null }))).toBe(false);
  });

  it("reserves elevated channels for owners", () => {
    expect(canAccessElevated(discord, subject({ userId: "owner", channelId: "elevated-channel" }))).toBe(true);
    expect(canAccessElevated(discord, subject({ userId: "worker", channelId: "elevated-channel" }))).toBe(false);
    expect(canAccessElevated(discord, subject({ userId: "approver", channelId: "elevated-channel" }))).toBe(false);
    expect(canAccessElevated(discord, subject({ userId: "owner", channelId: "work-channel" }))).toBe(false);
    expect(canAccessElevated(discord, subject({ userId: "owner", channelId: "elevated-channel", guildId: "other-guild" }))).toBe(false);
    expect(canAccessElevated(discord, subject({ userId: "owner", channelId: "elevated-channel", guildId: null, isDm: true }))).toBe(false);
  });

  it("allows non-bots in casual guilds but not DMs or unconfigured guilds", () => {
    expect(canAccessCasual(discord, subject({ guildId: "casual-guild" }))).toBe(true);
    expect(canAccessCasual(discord, subject({ guildId: "other-guild" }))).toBe(false);
    expect(canAccessCasual(discord, subject({ guildId: "casual-guild", isBot: true }))).toBe(false);
    expect(canAccessCasual(discord, subject({ guildId: null, isDm: true }))).toBe(false);
  });
});
