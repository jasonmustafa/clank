import { loadConfig } from "./config.js";
import { startDiscordGateway } from "./discord.js";
import { SdkCasualPiFactory, SdkSuperuserPiFactory } from "./pi.js";
import { FileTaskStore } from "./task-store.js";
import { TaskAttachmentBridge } from "./attachments.js";

export async function start(): Promise<void> {
  const config = await loadConfig();
  const attachments = new TaskAttachmentBridge(config.policy.attachments);
  const pi = new SdkSuperuserPiFactory(config.policy.pi, attachments);
  const casualPi = new SdkCasualPiFactory({ agentDir: config.policy.pi.casualAgentDir, isolationDirectory: config.policy.pi.casualIsolationDirectory, model: config.policy.pi.model });
  const gateway = await startDiscordGateway(config.secrets.discordToken, config.policy.discord.applicationId, {
    superuserIds: config.policy.discord.superuserIds,
    privateChannelIds: config.policy.discord.privateChannelIds,
    defaultWorkingDirectoryAlias: config.policy.pi.defaultWorkingDirectoryAlias,
    workingDirectories: config.policy.pi.workingDirectories,
    approvals: config.policy.approvals,
  }, pi, { ...config.policy.discord.casual, superuserIds: config.policy.discord.superuserIds }, casualPi, new FileTaskStore(config.policy.lifecycle.taskStatePath), attachments);
  console.log(`clank connected as ${gateway.client.user?.tag ?? "unknown user"}`);
  let shuttingDown = false;
  const shutdown = () => { if (shuttingDown) return; shuttingDown = true; void gateway.shutdown().then(() => { process.exitCode = 0; }).catch((error: unknown) => { console.error(`clank shutdown failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}

if (process.argv[1] === import.meta.filename) {
  start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`clank failed to start: ${message}`);
    process.exitCode = 1;
  });
}
