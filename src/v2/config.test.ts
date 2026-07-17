import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { V2ConfigValidationError, loadV2Config } from "./config.js";

const policy = {
  discord: {
    applicationId: "app-id",
    superuserIds: ["owner-id"],
    privateChannelIds: ["private-channel"],
    casual: { allowedGuildIds: ["guild"], allowedChannelIds: ["casual"], continuationTtlMs: 300_000, maxContinuationTurns: 3, userRateLimit: { requests: 5, windowMs: 60_000 }, guildRateLimit: { requests: 20, windowMs: 60_000 } },
  },
  lifecycle: { taskStatePath: "/srv/clank/state/v2-tasks.json" },
  approvals: { expiresMs: 300_000, destructiveConfirmation: true, restartCommand: "sudo systemctl restart clank.service", privilegedExecution: "disabled" },
  attachments: { temporaryRoot: "/srv/clank/tmp/v2-attachments", maxCount: 10, maxInputBytesEach: 10_000, maxInputBytesTotal: 20_000, maxOutputBytesEach: 10_000, maxOutputCount: 10 },
  pi: {
    agentDir: "/srv/clank/.pi/agent",
    sessionsDirectory: "/srv/clank/pi-sessions-v2",
    casualAgentDir: "/srv/clank/.pi/casual-agent",
    casualIsolationDirectory: "/srv/clank/casual-isolation",
    defaultWorkingDirectoryAlias: "clank",
    workingDirectories: { clank: "/srv/clank/app", docs: "/srv/clank/docs" },
    model: { provider: "openai-codex", id: "gpt-5.4", thinkingLevel: "high" },
  },
};

async function configFile(value: unknown = policy): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clank-v2-config-"));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("v2 configuration", () => {
  it("loads deployment-specific Discord and Pi values while keeping the token in the environment", async () => {
    const path = await configFile();
    const env = { CLANK_DISCORD_TOKEN: "discord-secret" };

    const config = await loadV2Config({ path, env });

    expect(config).toEqual({ secrets: { discordToken: "discord-secret" }, policy });
    expect(env.CLANK_DISCORD_TOKEN).toBeUndefined();
  });

  it("rejects missing identities, relative paths, and invalid model settings without leaking secrets", async () => {
    const path = await configFile({
      discord: { applicationId: "app-id", superuserIds: [], privateChannelIds: [], casual: { allowedGuildIds: [], allowedChannelIds: [], continuationTtlMs: 1, maxContinuationTurns: 1, userRateLimit: { requests: 1, windowMs: 1 }, guildRateLimit: { requests: 1, windowMs: 1 } } },
      lifecycle: { taskStatePath: "/state/tasks.json" },
      approvals: { expiresMs: 1, destructiveConfirmation: true, restartCommand: null, privilegedExecution: "disabled" },
      attachments: { temporaryRoot: "/tmp/attachments", maxCount: 10, maxInputBytesEach: 10_000, maxInputBytesTotal: 20_000, maxOutputBytesEach: 10_000, maxOutputCount: 10 },
      pi: {
        agentDir: "relative",
        sessionsDirectory: "/sessions",
        casualAgentDir: "/casual-agent",
        casualIsolationDirectory: "/casual",
        defaultWorkingDirectoryAlias: "missing",
        workingDirectories: { clank: "checkout" },
        model: { provider: "", id: "model", thinkingLevel: "extreme" },
      },
    });
    const secret = "must-not-leak";

    await expect(loadV2Config({ path, env: { CLANK_DISCORD_TOKEN: secret } })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(V2ConfigValidationError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("discord.superuserIds");
      expect(message).toContain("pi.workingDirectories.clank");
      expect(message).toContain("pi.defaultWorkingDirectoryAlias");
      expect(message).toContain("pi.model.thinkingLevel");
      expect(message).not.toContain(secret);
      return true;
    });
  });
});
