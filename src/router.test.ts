import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TaskAttachmentBridge } from "./attachments.js";
import { SuperuserRequestRouter, makeTaskThreadName, type DiscordRequest, type DiscordTransport, type PiProgress, type SuperuserPiFactory, type SuperuserPiSession } from "./router.js";
import type { PersistedTaskState, TaskStore } from "./task-store.js";

function request(overrides: Partial<DiscordRequest> = {}): DiscordRequest {
  return { id: "message-1", userId: "owner-123", channelId: "private-channel", threadId: null, guildId: "guild-1", location: "guild", content: "Inspect the checkout", attachments: [], authorIsBot: false, webhookId: null, replyToMessageId: null, mentionsApplication: false, ...overrides };
}

function harness(store?: TaskStore) {
  const calls: string[] = [];
  const sessions: FakeSession[] = [];
  class FakeSession implements SuperuserPiSession {
    busy = false;
    prompt(text: string, _images?: readonly import("@earendil-works/pi-ai").ImageContent[], onProgress?: (event: PiProgress) => void) { calls.push(`prompt:${text}`); this.busy = true; onProgress?.({ kind: "text", text: `answer:${text}` }); return Promise.resolve(`answer:${text}`).finally(() => { this.busy = false; }); }
    followUp(text: string) { calls.push(`follow:${text}`); return Promise.resolve(); }
    steer(text: string) { calls.push(`steer:${text}`); return Promise.resolve(); }
    stop() { calls.push("stop"); this.busy = false; return Promise.resolve(); }
    compact() { calls.push("compact"); return Promise.resolve(); }
    status() { return { busy: this.busy, queued: 0, sessionId: `session-${String(sessions.indexOf(this) + 1)}` }; }
    dispose() { calls.push("dispose"); return Promise.resolve(); }
  }
  const pi: SuperuserPiFactory = { create({ taskId, cwd }) { calls.push(`create:${taskId}:${cwd}`); const session = new FakeSession(); sessions.push(session); return Promise.resolve(session); } };
  const sent: { channelId: string; content: string; kind: string | undefined }[] = [];
  let threadCount = 0;
  const discord: DiscordTransport = {
    createThread(_requestId, name) { calls.push(`thread:${name}`); threadCount += 1; return Promise.resolve(`thread-${String(threadCount)}`); },
    send(channelId, content, options) { calls.push(`send:${channelId}:${options?.kind ?? "default"}`); sent.push({ channelId, content, kind: options?.kind }); return Promise.resolve(undefined); },
    updatePreview(channelId, content) { sent.push({ channelId, content, kind: "preview" }); return Promise.resolve(); },
  };
  const router = new SuperuserRequestRouter({ superuserIds: ["owner-123"], privateChannelIds: ["private-channel"], defaultWorkingDirectoryAlias: "clank", workingDirectories: { clank: "/srv/clank/app", docs: "/srv/clank/docs" } }, discord, pi, store);
  return { router, calls, sessions, sent };
}

describe("superuser task router", () => {
  it("creates a recognizable owned thread and streams the task result there", async () => {
    const { router, calls, sent } = harness();
    await expect(router.route(request())).resolves.toEqual({ kind: "completed", taskId: "message-1" });
    expect(calls[0]).toMatch(/^thread:inspect-the-checkout · [a-f0-9]{8}$/u);
    expect(calls).toContain("create:message-1:/srv/clank/app");
    expect(sent).toContainEqual({ channelId: "thread-1", content: "⏳ Working…", kind: "preview" });
    expect(sent).toContainEqual({ channelId: "thread-1", content: "⏳ Working…\n\nanswer:Inspect the checkout", kind: "preview" });
    expect(sent).toContainEqual({ channelId: "thread-1", content: "✅ Finished\n\nanswer:Inspect the checkout", kind: "final" });
  });

  it("selects a configured working directory and strips the selector from the prompt", async () => {
    const { router, calls } = harness();
    await router.route(request({ content: "/in docs Update the guide" }));
    expect(calls).toContain("create:message-1:/srv/clank/docs");
    expect(calls).toContain("prompt:Update the guide");
  });

  it("rejects an unknown alias before creating a thread or Pi runtime", async () => {
    const { router, calls, sent } = harness();
    await expect(router.route(request({ location: "dm", guildId: null, channelId: "dm-1", content: "/in nowhere Do work" }))).resolves.toEqual({ kind: "ignored" });
    await expect(router.route(request({ id: "prototype", location: "dm", guildId: null, channelId: "dm-2", content: "/in constructor Do work" }))).resolves.toEqual({ kind: "ignored" });
    expect(calls.some((call) => call.startsWith("create:") || call.startsWith("thread:"))).toBe(false);
    expect(sent[0]?.content).toContain("Unknown working-directory alias 'nowhere'");
    expect(sent[1]?.content).toContain("Unknown working-directory alias 'constructor'");
  });

  it("queues a continuation that arrives while the initial task is still being persisted", async () => {
    let releaseSave!: () => void; const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; }); let saves = 0;
    const store: TaskStore = { load: () => Promise.resolve({ version: 1, tasks: [], approvals: [] }), save: () => { saves += 1; return saves === 2 ? saveGate : Promise.resolve(); } };
    const { router, calls } = harness(store); await router.initialize();
    const initial = router.route(request());
    while (saves < 2) await Promise.resolve();
    const continuation = router.route(request({ id: "m2", channelId: "thread-1", threadId: "thread-1", content: "next" }));
    await Promise.resolve(); releaseSave(); await Promise.all([initial, continuation]);
    expect(calls.filter((call) => call.startsWith("prompt:"))).toEqual(["prompt:Inspect the checkout"]);
    expect(calls).toContain("follow:next");
  });

  it("continues, queues by default while busy, and explicitly steers one thread only", async () => {
    const { router, sessions, calls } = harness();
    await router.route(request());
    const session = sessions[0];
    if (session === undefined) throw new Error("session not created");
    session.busy = true;
    await router.route(request({ id: "m2", channelId: "thread-1", threadId: "thread-1", content: "next" }));
    await router.route(request({ id: "m3", channelId: "thread-1", threadId: "thread-1", content: "/steer change direction" }));
    expect(calls).toContain("follow:next");
    expect(calls).toContain("steer:change direction");
  });

  it("supports owner status, stop, compact, and reset controls", async () => {
    const { router, calls, sessions, sent } = harness();
    await router.route(request());
    for (const [id, content] of [["s", "/status"], ["x", "/stop"], ["c", "/compact"], ["r", "/reset"]] as const) {
      await router.route(request({ id, channelId: "thread-1", threadId: "thread-1", content }));
    }
    expect(sent.some((entry) => entry.content.includes("session-1") && entry.content.includes("clank (/srv/clank/app)"))).toBe(true);
    expect(calls).toEqual(expect.arrayContaining(["stop", "compact", "dispose"]));
    expect(sessions).toHaveLength(2);
  });

  it("keeps concurrently started task sessions and queues independent", async () => {
    const { router, sessions } = harness();
    await Promise.all([
      router.route(request({ id: "one", content: "first" })),
      router.route(request({ id: "two", content: "second" })),
    ]);
    expect(sessions).toHaveLength(2);
    const first = sessions[0]; const second = sessions[1];
    if (first === undefined || second === undefined) throw new Error("sessions not created");
    expect(first.status().sessionId).not.toBe(second.status().sessionId);
  });

  it("forwards task-scoped text/images, returns approved outputs, and cleans input", async () => {
    const root = await mkdtemp(join(tmpdir(), "clank-router-attachments-")); const bridge = new TaskAttachmentBridge({ temporaryRoot: root, maxOutputBytesEach: 100 }); let receivedPrompt = ""; let imageCount = 0;
    const pi: SuperuserPiFactory = { async create({ taskId }) { const output = bridge.outputFor(taskId); await mkdir(output.directory, { recursive: true }); const report = join(output.directory, "report.txt"); await writeFile(report, "done"); return { async prompt(text, images) { receivedPrompt = text; imageCount = images?.length ?? 0; await output.enqueue(report); return "finished"; }, followUp: () => Promise.resolve(), steer: () => Promise.resolve(), stop: () => Promise.resolve(), compact: () => Promise.resolve(), status: () => ({ busy: false, queued: 0, sessionId: "s" }), dispose: () => Promise.resolve() }; } };
    const sent: { content: string; files?: readonly string[] }[] = []; const discord: DiscordTransport = { createThread: () => Promise.resolve("thread"), send: (_channel, content, options) => { sent.push({ content, ...(options?.files === undefined ? {} : { files: options.files }) }); return Promise.resolve(undefined); }, updatePreview: () => Promise.resolve() };
    const router = new SuperuserRequestRouter({ superuserIds: ["owner-123"], privateChannelIds: ["private-channel"], defaultWorkingDirectoryAlias: "clank", workingDirectories: { clank: "/work" } }, discord, pi, undefined, bridge);
    await router.route(request({ attachments: [{ name: "../note.txt", url: "data:text/plain,hello", size: 5, contentType: "text/plain" }, { name: "pic.png", url: "data:image/png;base64,AQID", size: 3, contentType: "image/png" }] }));
    expect(receivedPrompt).toContain(join(root, "message-1", "input", "message-1", "note.txt")); expect(imageCount).toBe(1); expect(sent.at(-1)?.files?.[0]).toBe(join(root, "message-1", "output", "report.txt"));
    await expect(readFile(join(root, "message-1", "input", "message-1", "note.txt"))).rejects.toThrow();
  });

  it("rejects unauthorized continuations as well as top-level requests", async () => {
    const { router, sessions, calls } = harness();
    await router.route(request());
    const before = calls.length;
    await expect(router.route(request({ id: "intrusion", userId: "intruder", channelId: "thread-1", threadId: "thread-1" }))).resolves.toEqual({ kind: "ignored" });
    expect(calls).toHaveLength(before);
    expect(sessions).toHaveLength(1);
  });
});

describe("durable superuser task routing", () => {
  it("marks active work interrupted, expires approvals, notices once, and resumes the saved session", async () => {
    const { calls, sent } = harness();
    let state: PersistedTaskState = { version: 1, tasks: [{ id: "old-task", requesterId: "owner-123", threadId: "old-thread", capabilityMode: "superuser", workingDirectory: "/work/original", lifecycleState: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", piSessionId: "saved-session" }], approvals: [{ id: "approval-1", taskId: "old-task", requesterId: "owner-123", command: "rm -rf build", workingDirectory: "/work/original", status: "pending", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }] };
    const store: TaskStore = { load: () => Promise.resolve(structuredClone(state)), save: (next) => { state = structuredClone(next); return Promise.resolve(); } };
    const pi: SuperuserPiFactory = { create(options) { calls.push(`resume:${options.taskId}:${options.cwd}:${options.sessionId ?? "new"}`); return Promise.resolve({ prompt: (text) => Promise.resolve(`resumed:${text}`), followUp: () => Promise.resolve(), steer: () => Promise.resolve(), stop: () => Promise.resolve(), compact: () => Promise.resolve(), status: () => ({ busy: false, queued: 0, sessionId: "saved-session" }), dispose: () => Promise.resolve() }); } };
    const discord: DiscordTransport = { createThread: () => Promise.reject(new Error("unused")), send: (channelId, content, options) => { sent.push({ channelId, content, kind: options?.kind }); return Promise.resolve(undefined); }, updatePreview: () => Promise.resolve() };
    const router = new SuperuserRequestRouter({ superuserIds: ["owner-123"], privateChannelIds: ["private-channel"], defaultWorkingDirectoryAlias: "default", workingDirectories: { default: "/default" } }, discord, pi, store);
    await router.initialize(); await router.initialize();
    expect(state.tasks[0]?.lifecycleState).toBe("interrupted"); expect(state.approvals[0]?.status).toBe("expired");
    expect(sent.filter((entry) => entry.content.includes("interrupted"))).toHaveLength(1);
    await router.route(request({ id: "reply", channelId: "old-thread", threadId: "old-thread", content: "continue" }));
    expect(calls).toContain("resume:old-task:/work/original:saved-session");
    expect(sent).toContainEqual({ channelId: "old-thread", content: "✅ Finished\n\nresumed:continue", kind: "final" });
  });

  it("stops accepting work and disposes runtimes during graceful shutdown", async () => {
    const { router, calls, sessions } = harness(); await router.route(request());
    const session = sessions[0]; if (session === undefined) throw new Error("session not created"); session.busy = true;
    await router.shutdown();
    expect(calls).toEqual(expect.arrayContaining(["stop", "dispose"]));
    await expect(router.route(request({ id: "later" }))).resolves.toEqual({ kind: "ignored" });
  });
});

describe("Discord command approvals", () => {
  function approvalHarness(now = () => Date.parse("2026-01-01T00:00:00.000Z"), command = "sudo systemctl restart clank", privilegedExecution: "disabled" | "approval-required" = "disabled") {
    const sent: { channelId: string; content: string; approvalId?: string }[] = []; const executed: string[] = []; let state: PersistedTaskState = { version: 1, tasks: [], approvals: [] };
    const store: TaskStore = { load: () => Promise.resolve(structuredClone(state)), save: (next) => { state = structuredClone(next); return Promise.resolve(); } };
    const discord: DiscordTransport = { createThread: () => Promise.resolve("thread-approval"), send: (channelId, content, options) => { sent.push({ channelId, content, ...(options?.approval === undefined ? {} : { approvalId: options.approval.id }) }); return Promise.resolve(undefined); }, updatePreview: () => Promise.resolve() };
    const pi: SuperuserPiFactory = { create(options) { return Promise.resolve({ async prompt() { if (await (options.confirmCommand?.(command) ?? false)) { executed.push(command); return "command completed"; } return "command not executed"; }, followUp: () => Promise.resolve(), steer: () => Promise.resolve(), stop: () => Promise.resolve(), compact: () => Promise.resolve(), status: () => ({ busy: false, queued: 0, sessionId: "approval-session" }), dispose: () => Promise.resolve() }); } };
    const router = new SuperuserRequestRouter({ superuserIds: ["owner-123"], privateChannelIds: ["private-channel"], defaultWorkingDirectoryAlias: "clank", workingDirectories: { clank: "/srv/clank/app" }, approvals: { expiresMs: 1_000, restartCommand: "sudo systemctl restart clank", privilegedExecution, destructiveConfirmation: true } }, discord, pi, store, undefined, now);
    return { router, sent, executed, state: () => state };
  }

  it("binds an approval to exact task context and executes once after its owner approves", async () => {
    const { router, sent, executed, state } = approvalHarness(); const run = router.route(request());
    await vi.waitFor(() => { expect(sent.some((entry) => entry.approvalId !== undefined)).toBe(true); });
    const approval = state().approvals[0]; if (approval === undefined) throw new Error("approval not persisted");
    expect(sent.find((entry) => entry.approvalId === approval.id)?.content).toContain("sudo systemctl restart clank\nTask: message-1\nRequester: owner-123\nWorking directory: /srv/clank/app");
    await expect(router.decideApproval({ approvalId: approval.id, taskId: "message-1", command: "sudo systemctl restart clank", userId: "owner-123", decision: "approve" })).resolves.toBe("approved");
    await expect(run).resolves.toEqual({ kind: "completed", taskId: "message-1" }); expect(executed).toEqual(["sudo systemctl restart clank"]); expect(state().approvals[0]?.status).toBe("approved");
    await expect(router.decideApproval({ approvalId: approval.id, taskId: "message-1", command: "sudo systemctl restart clank", userId: "owner-123", decision: "approve" })).resolves.toBe("unavailable");
  });

  it("rejects unauthorized, mutated, cross-task, denied, and expired decisions without execution", async () => {
    const { router, sent, executed, state } = approvalHarness(); const run = router.route(request()); await vi.waitFor(() => { expect(sent.some((entry) => entry.approvalId !== undefined)).toBe(true); }); const approval = state().approvals[0]; if (approval === undefined) throw new Error("approval not persisted");
    await expect(router.decideApproval({ approvalId: approval.id, taskId: "message-1", command: approval.command, userId: "intruder", decision: "approve" })).resolves.toBe("unauthorized");
    await expect(router.decideApproval({ approvalId: approval.id, taskId: "message-1", command: `${approval.command} --changed`, userId: "owner-123", decision: "approve" })).resolves.toBe("mismatch");
    await expect(router.decideApproval({ approvalId: approval.id, taskId: "other", command: approval.command, userId: "owner-123", decision: "approve" })).resolves.toBe("mismatch");
    await expect(router.decideApproval({ approvalId: approval.id, taskId: "message-1", command: approval.command, userId: "owner-123", decision: "deny" })).resolves.toBe("denied"); await run; expect(executed).toEqual([]);
  });

  it("gates destructive and embedded privileged invocations conservatively", async () => {
    const destructive = approvalHarness(undefined, "/bin/rm target --recursive"); const destructiveRun = destructive.router.route(request()); await vi.waitFor(() => { expect(destructive.state().approvals).toHaveLength(1); }); const destructiveApproval = destructive.state().approvals[0]; if (destructiveApproval === undefined) throw new Error("approval missing"); await destructive.router.decideApproval({ approvalId: destructiveApproval.id, taskId: "message-1", command: destructiveApproval.command, userId: "owner-123", decision: "deny" }); await destructiveRun; expect(destructive.executed).toEqual([]);
    const disabledSudo = approvalHarness(undefined, "cd /tmp && /usr/bin/sudo id"); await disabledSudo.router.route(request()); expect(disabledSudo.executed).toEqual([]); expect(disabledSudo.state().approvals).toEqual([]);
    const gatedSudo = approvalHarness(undefined, "echo ready; command sudo id", "approval-required"); const gatedRun = gatedSudo.router.route(request()); await vi.waitFor(() => { expect(gatedSudo.state().approvals).toHaveLength(1); }); const gatedApproval = gatedSudo.state().approvals[0]; if (gatedApproval === undefined) throw new Error("approval missing"); await gatedSudo.router.decideApproval({ approvalId: gatedApproval.id, taskId: "message-1", command: gatedApproval.command, userId: "owner-123", decision: "deny" }); await gatedRun; expect(gatedSudo.executed).toEqual([]);
  });

  it("expires pending approval on timeout and restart", async () => {
    let time = Date.parse("2026-01-01T00:00:00.000Z"); const current = approvalHarness(() => time); const run = current.router.route(request()); await vi.waitFor(() => { expect(current.state().approvals).toHaveLength(1); }); time += 1_001; current.router.expireApprovals(); await run; expect(current.executed).toEqual([]); expect(current.state().approvals[0]?.status).toBe("expired");
  });
});

describe("task thread titles", () => {
  it("puts the request first and strips leading Discord mentions", () => {
    const title = makeTaskThreadName("message-123", "<@1519648634528989405> Review the deployment");
    expect(title).toMatch(/^review-the-deployment · [a-f0-9]{8}$/u);
  });

  it("truncates the summary while preserving the stable short identifier", () => {
    const title = makeTaskThreadName("message-123", "A ".repeat(100));
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).toMatch(/ · [a-f0-9]{8}$/u);
    expect(makeTaskThreadName("message-123", "different words").slice(-8)).toBe(title.slice(-8));
  });
});
