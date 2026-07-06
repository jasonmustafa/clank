import { loadConfig } from "./config/env.js";
import { createDiscordClient } from "./discord/client.js";
import { registerDiscordEvents } from "./discord/events.js";
import { JobManager } from "./jobs/jobManager.js";
import { JobStore } from "./jobs/jobStore.js";
import { ConfirmationManager } from "./safety/confirmation.js";

const config = loadConfig();
const client = createDiscordClient();
const store = new JobStore(config.stateDir);
const confirmations = new ConfirmationManager();
const jobs = new JobManager(config, store, confirmations);

await jobs.init();

registerDiscordEvents(client, config, jobs, confirmations);

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal}: shutting down Clank`);
  client.destroy();
  process.exit(0);
}

await client.login(config.discordToken);
