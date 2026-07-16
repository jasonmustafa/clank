import { loadV2Config } from "./config.js";
import { startV2DiscordGateway } from "./discord.js";
import { SdkCasualPiFactory, SdkSuperuserPiFactory } from "./pi.js";
import { FileTaskStore } from "./task-store.js";
import { TaskAttachmentBridge } from "./attachments.js";

export async function startV2(): Promise<void> {
  const config = await loadV2Config();
  const attachments = new TaskAttachmentBridge(config.policy.attachments);
  const pi = new SdkSuperuserPiFactory(config.policy.pi, attachments);
  const casualPi = new SdkCasualPiFactory({ agentDir: config.policy.pi.casualAgentDir, isolationDirectory: config.policy.pi.casualIsolationDirectory, model: config.policy.pi.model });
  const gateway = await startV2DiscordGateway(config.secrets.discordToken, config.policy.discord.applicationId, {
    superuserIds: config.policy.discord.superuserIds,
    privateChannelIds: config.policy.discord.privateChannelIds,
    defaultWorkingDirectoryAlias: config.policy.pi.defaultWorkingDirectoryAlias,
    workingDirectories: config.policy.pi.workingDirectories,
  }, pi, { ...config.policy.discord.casual, superuserIds: config.policy.discord.superuserIds }, casualPi, new FileTaskStore(config.policy.lifecycle.taskStatePath), attachments);
  console.log(`clank v2 connected as ${gateway.client.user?.tag ?? "unknown user"}`);
  let shuttingDown = false;
  const shutdown = () => { if (shuttingDown) return; shuttingDown = true; void gateway.shutdown().then(() => { process.exitCode = 0; }).catch((error: unknown) => { console.error(`clank v2 shutdown failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}

if (process.argv[1] === import.meta.filename) {
  startV2().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`clank v2 failed to start: ${message}`);
    process.exitCode = 1;
  });
}
