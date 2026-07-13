import { REST, Routes, type RESTPostAPIApplicationGuildCommandsJSONBody } from "discord.js";
import { loadConfig, type DiscordPolicy } from "../config/index.js";
import { CLANK_COMMAND } from "./index.js";

export interface CommandRegistrar {
  put(route: string, options: { body: RESTPostAPIApplicationGuildCommandsJSONBody[] }): Promise<unknown>;
}

export async function registerGuildCommands(
  registrar: CommandRegistrar,
  policy: DiscordPolicy,
): Promise<void> {
  const route = Routes.applicationGuildCommands(policy.applicationId, policy.guildId);
  await registrar.put(route, { body: [CLANK_COMMAND.toJSON()] });
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const rest = new REST().setToken(config.secrets.discordToken);
  await registerGuildCommands(rest, config.policy.discord);
  console.log(`Registered /clank in guild ${config.policy.discord.guildId}.`);
}

if (process.argv[1] === import.meta.filename) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Command registration failed: ${message}`);
    process.exitCode = 1;
  });
}
