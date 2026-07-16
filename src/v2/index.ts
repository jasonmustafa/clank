import { loadV2Config } from "./config.js";
import { startV2DiscordGateway } from "./discord.js";
import { SdkSuperuserPiFactory } from "./pi.js";

export async function startV2(): Promise<void> {
  const config = await loadV2Config();
  const pi = new SdkSuperuserPiFactory(config.policy.pi);
  const client = await startV2DiscordGateway(config.secrets.discordToken, {
    superuserIds: config.policy.discord.superuserIds,
    privateChannelIds: config.policy.discord.privateChannelIds,
    defaultWorkingDirectory: config.policy.pi.defaultWorkingDirectory,
  }, pi);
  console.log(`clank v2 connected as ${client.user?.tag ?? "unknown user"}`);
}

if (process.argv[1] === import.meta.filename) {
  startV2().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`clank v2 failed to start: ${message}`);
    process.exitCode = 1;
  });
}
