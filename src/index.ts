import { loadConfig } from "./config/index.js";
import { startDiscordGateway } from "./discord/index.js";
import { JobManager, JobStore } from "./jobs/index.js";
import { JobController } from "./jobs/routing.js";
import { FakeRunner } from "./pi-runners/index.js";
import { AttachmentIngestor, DiscordAttachmentQueue, createDiscordAttachTool } from "./attachments/index.js";
import { join } from "node:path";
import { CasualController, SdkCasualRunner } from "./discord/casual.js";
import { WorkspaceRegistry } from "./workspaces/index.js";
import { ApprovalService } from "./safety/index.js";
import { attachApprovalInteractionRouter, DiscordApprovalMessenger } from "./safety/discord.js";
import { createSystemRequestService, GithubHelperClient, SystemHelperClient } from "./helpers/index.js";

export const serviceName = "clank";

async function main(): Promise<void> {
  const config = await loadConfig();
  const jobs = await JobManager.open(new JobStore(config.policy.paths.state));
  const github = new GithubHelperClient();
  const workspaces = new WorkspaceRegistry({
    root: config.policy.paths.workspaces,
    allowedRepositories: config.policy.github.allowedRepositories,
    commitAuthorName: config.policy.github.commitAuthorName,
    commitAuthorEmail: config.policy.github.commitAuthorEmail,
    commitFooter: config.policy.github.commitFooter,
    entries: config.policy.workspaces,
  }, undefined, {
    clone: async (repository, destination) => {
      const jobId = destination.split("/").at(-1) ?? "";
      const result = await github.invoke({ action: "clone", repository, destination }, { requesterId: "daemon", jobId });
      if (!result.ok) throw new Error(result.error);
    },
    fetch: async (repository, workspacePath) => {
      const jobId = workspacePath.split("/").at(-1) ?? "";
      const result = await github.invoke({ action: "fetch", repository, workspacePath }, { requesterId: "daemon", jobId });
      if (!result.ok) throw new Error(result.error);
    },
  });
  const runners = new Map<string, FakeRunner>();
  const attachmentQueues = new Map<string, DiscordAttachmentQueue>();
  const queueFor = (job: { id: string; workspacePath: string }): DiscordAttachmentQueue => {
    let queue = attachmentQueues.get(job.id);
    if (queue === undefined) {
      queue = new DiscordAttachmentQueue({ workspaceRoot: job.workspacePath, outputRoot: join(config.policy.paths.temporary, job.id, "output") });
      attachmentQueues.set(job.id, queue);
    }
    return queue;
  };
  const runnerFor = (job: { id: string; workspacePath: string }): FakeRunner => {
    let runner = runners.get(job.id);
    if (runner === undefined) {
      runner = new FakeRunner({ customTools: [createDiscordAttachTool(queueFor(job))] });
      runners.set(job.id, runner);
    }
    return runner;
  };
  const ingestor = new AttachmentIngestor({ temporaryRoot: config.policy.paths.temporary });
  const controller = new JobController(jobs.list(), runnerFor, undefined, async (job) => jobs.update(job), (job) => queueFor(job).take());
  const casual = new CasualController(config.policy.discord, new SdkCasualRunner("/srv/clank/pi-agent"));
  const client = await startDiscordGateway(config.secrets.discordToken, config.policy.discord, {
    jobs,
    runner: new FakeRunner(),
    runnerForJob: runnerFor,
    workspaceRoot: config.policy.paths.workspaces,
    sessionRoot: config.policy.paths.sessions,
    onJobCreated: (job) => { controller.add(job); },
    attachmentIngestor: ingestor,
    takeAttachments: (job) => queueFor(job).take(),
    prepareWorkspace: async (jobId, request) => (await workspaces.prepare(workspaces.requestFrom(request), jobId)).path,
  }, controller, { ingestor }, casual);
  const approvals = await ApprovalService.open({
    directory: config.policy.paths.state,
    messenger: new DiscordApprovalMessenger(client),
    approverUserIds: [...config.policy.discord.ownerUserIds, ...config.policy.discord.privilegedApproverUserIds],
  });
  attachApprovalInteractionRouter(client, approvals);
  const helper = new SystemHelperClient();
  const systemRequests = createSystemRequestService(config.policy.discord, approvals, (request, context) => helper.invoke(request, context));
  void systemRequests;
  console.log(`${serviceName} connected as ${client.user?.tag ?? "unknown user"}`);
}

if (process.argv[1] === import.meta.filename) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${serviceName} failed to start: ${message}`);
    process.exitCode = 1;
  });
}
