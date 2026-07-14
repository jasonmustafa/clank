import { loadConfig } from "./config/index.js";
import { startDiscordGateway } from "./discord/index.js";
import { JobManager, JobStore } from "./jobs/index.js";
import { JobController } from "./jobs/routing.js";
import { FakeRunner } from "./pi-runners/index.js";

export const serviceName = "clank";

async function main(): Promise<void> {
  const config = await loadConfig();
  const jobs = await JobManager.open(new JobStore(config.policy.paths.state));
  const runners = new Map<string, FakeRunner>();
  const runnerFor = (jobId: string): FakeRunner => {
    let runner = runners.get(jobId);
    if (runner === undefined) { runner = new FakeRunner(); runners.set(jobId, runner); }
    return runner;
  };
  const controller = new JobController(jobs.list(), (job) => runnerFor(job.id), undefined, async (job) => jobs.update(job));
  const client = await startDiscordGateway(config.secrets.discordToken, config.policy.discord, {
    jobs,
    runner: new FakeRunner(),
    runnerForJob: (job) => runnerFor(job.id),
    workspaceRoot: config.policy.paths.workspaces,
    sessionRoot: config.policy.paths.sessions,
    onJobCreated: (job) => { controller.add(job); },
  }, controller);
  console.log(`${serviceName} connected as ${client.user?.tag ?? "unknown user"}`);
}

if (process.argv[1] === import.meta.filename) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${serviceName} failed to start: ${message}`);
    process.exitCode = 1;
  });
}
