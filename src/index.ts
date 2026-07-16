import { loadConfig } from "./config/index.js";
import { startDiscordGateway } from "./discord/index.js";
import { JobManager, JobStore, type Job } from "./jobs/index.js";
import { JobController } from "./jobs/routing.js";
import { LazyPiRunner, SdkPiRunner, type PiRunner } from "./pi-runners/index.js";
import { AttachmentIngestor, DiscordAttachmentQueue, createDiscordAttachTool } from "./attachments/index.js";
import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { cleanupCompletedJobs, RunnerPool } from "./lifecycle/index.js";
import { CasualController, SdkCasualRunner } from "./discord/casual.js";
import { WorkspaceRegistry } from "./workspaces/index.js";
import { ApprovalService, commandSafetyPolicy } from "./safety/index.js";
import { attachApprovalInteractionRouter, DiscordApprovalMessenger } from "./safety/discord.js";
import { createSystemRequestService, GithubHelperClient, SystemHelperClient } from "./helpers/index.js";
import { ResourceUpdater } from "./resources/index.js";
import { DeploymentManager, SpawnRunner } from "./deployment/index.js";
import { createGithubIssueTool } from "./github/index.js";

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
  await cleanupCompletedJobs(jobs.list(), {
    workspaceRoot: config.policy.paths.workspaces,
    temporaryRoot: config.policy.paths.temporary,
    retentionMs: config.policy.lifecycle.cleanupRetentionMs,
  });
  const attachmentQueues = new Map<string, DiscordAttachmentQueue>();
  const queueFor = (job: { id: string; workspacePath: string }): DiscordAttachmentQueue => {
    let queue = attachmentQueues.get(job.id);
    if (queue === undefined) {
      queue = new DiscordAttachmentQueue({ workspaceRoot: job.workspacePath, outputRoot: join(config.policy.paths.temporary, job.id, "output") });
      attachmentQueues.set(job.id, queue);
    }
    return queue;
  };
  const agentDir = "/srv/clank/pi-agent";
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
    defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  if (settings.defaultProvider === undefined || settings.defaultModel === undefined) throw new Error("Pi default provider/model is not configured");
  const defaultProvider = settings.defaultProvider;
  const defaultModel = settings.defaultModel;
  const runnerPool = new RunnerPool<PiRunner>((job) => new LazyPiRunner(() => SdkPiRunner.create({
    jobId: job.id,
    cwd: job.workspacePath,
    agentDir,
    sessionsDir: config.policy.paths.sessions,
    model: { provider: defaultProvider, id: defaultModel },
    thinkingLevel: settings.defaultThinkingLevel ?? "high",
    customTools: [createDiscordAttachTool(queueFor(job)), createGithubIssueTool(github, job.requesterId, job.id)],
    safety: {
      ...commandSafetyPolicy({ workspaceRoot: job.workspacePath, protectedRoots: [agentDir, config.policy.paths.state, config.policy.paths.resources, "/srv/clank/config", "/usr/local/lib/clank"] }, job.profile, config.policy.safety),
      confirm: () => Promise.resolve(false),
    },
  })), config.policy.lifecycle.runnerIdleTtlMs);
  const runnerFor = (job: { id: string; workspacePath: string }): PiRunner => runnerPool.get(job as Job);
  const ingestor = new AttachmentIngestor({ temporaryRoot: config.policy.paths.temporary });
  const controller = new JobController(jobs.list(), runnerFor, undefined, async (job) => jobs.update(job), (job) => queueFor(job).take(), async (job) => {
    try { await access(job.workspacePath); return true; } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }, config.policy.discord.ownerUserIds);
  const casual = new CasualController(config.policy.discord, new SdkCasualRunner("/srv/clank/pi-agent"));
  const resourceUpdater = new ResourceUpdater({
    checkoutRoot: config.policy.paths.resources,
    statePath: join(config.policy.paths.state, "resource-refs.json"),
  });
  const helper = new SystemHelperClient();
  const deployment = new DeploymentManager(config.policy.deployment, config.policy.paths.state, new SpawnRunner(), async (requesterId) => helper.invoke({ action: "service-restart" }, { requesterId }));
  const client = await startDiscordGateway(config.secrets.discordToken, config.policy.discord, {
    jobs,
    runnerForJob: runnerFor,
    workspaceRoot: config.policy.paths.workspaces,
    sessionRoot: config.policy.paths.sessions,
    onJobCreated: (job) => { controller.add(job); },
    attachmentIngestor: ingestor,
    takeAttachments: (job) => queueFor(job).take(),
    prepareWorkspace: async (jobId, request) => (await workspaces.prepare(workspaces.requestFrom(request), jobId)).path,
  }, controller, { ingestor }, casual, { updater: resourceUpdater, sources: config.policy.resources }, deployment);
  for (const recovered of jobs.recoveredJobs()) {
    let posted = false;
    for (const channelId of [...new Set([recovered.threadId, recovered.channelId].filter((id) => id !== ""))]) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isSendable() === true) {
          await channel.send(`Job ${recovered.id} was interrupted because Clank restarted. Reply in its thread to resume the saved session.`);
          posted = true;
          break;
        }
      } catch (error) {
        console.warn(`Could not post restart notice for job ${recovered.id} in channel ${channelId}:`, error);
      }
    }
    if (!posted) console.warn(`No restart notice destination was available for job ${recovered.id}.`);
  }
  const approvals = await ApprovalService.open({
    directory: config.policy.paths.state,
    messenger: new DiscordApprovalMessenger(client),
    approverUserIds: [...config.policy.discord.ownerUserIds, ...config.policy.discord.privilegedApproverUserIds],
  });
  attachApprovalInteractionRouter(client, approvals);
  const systemRequests = createSystemRequestService(config.policy.discord, approvals, (request, context) => helper.invoke(request, context));
  void systemRequests;
  const pendingDeploy = await deployment.completePending();
  if (pendingDeploy !== undefined) {
    const channel = await client.channels.fetch(pendingDeploy.channelId);
    if (channel?.isSendable() === true) await channel.send(`${pendingDeploy.operation === "deploy" ? "Deploy" : "Rollback"} to ${pendingDeploy.toCommit.slice(0, 12)} succeeded.`);
  }
  console.log(`${serviceName} connected as ${client.user?.tag ?? "unknown user"}`);
}

if (process.argv[1] === import.meta.filename) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${serviceName} failed to start: ${message}`);
    process.exitCode = 1;
  });
}
