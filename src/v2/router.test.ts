import { describe, expect, it } from "vitest";
import { SuperuserRequestRouter, makeTaskThreadName, type DiscordRequest, type DiscordTransport, type PiProgress, type SuperuserPiFactory, type SuperuserPiSession } from "./router.js";

function request(overrides: Partial<DiscordRequest> = {}): DiscordRequest {
  return { id: "message-1", userId: "owner-123", channelId: "private-channel", threadId: null, guildId: "guild-1", location: "guild", content: "Inspect the checkout", authorIsBot: false, webhookId: null, ...overrides };
}

function harness() {
  const calls: string[] = [];
  const sessions: FakeSession[] = [];
  class FakeSession implements SuperuserPiSession {
    busy = false;
    prompt(text: string, onProgress?: (event: PiProgress) => void) { calls.push(`prompt:${text}`); this.busy = true; onProgress?.({ kind: "text", text: `answer:${text}` }); return Promise.resolve(`answer:${text}`).finally(() => { this.busy = false; }); }
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
    send(channelId, content, options) { sent.push({ channelId, content, kind: options?.kind }); return Promise.resolve(); },
    updatePreview(channelId, content) { sent.push({ channelId, content, kind: "preview" }); return Promise.resolve(); },
    setTyping(channelId, active) { calls.push(`typing:${channelId}:${String(active)}`); return Promise.resolve(); },
  };
  const router = new SuperuserRequestRouter({ superuserIds: ["owner-123"], privateChannelIds: ["private-channel"], defaultWorkingDirectory: "/srv/clank/app" }, discord, pi);
  return { router, calls, sessions, sent };
}

describe("superuser task router", () => {
  it("creates a recognizable owned thread and streams the task result there", async () => {
    const { router, calls, sent } = harness();
    await expect(router.route(request())).resolves.toEqual({ kind: "completed", taskId: "message-1" });
    expect(calls[0]).toMatch(/^thread:inspect-the-checkout — [a-z0-9]{8}$/u);
    expect(calls).toContain("create:message-1:/srv/clank/app");
    expect(sent).toContainEqual({ channelId: "thread-1", content: "answer:Inspect the checkout", kind: "preview" });
    expect(sent).toContainEqual({ channelId: "thread-1", content: "answer:Inspect the checkout", kind: "final" });
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
    expect(sent.some((entry) => entry.content.includes("session-1"))).toBe(true);
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

  it("rejects unauthorized continuations as well as top-level requests", async () => {
    const { router, sessions, calls } = harness();
    await router.route(request());
    const before = calls.length;
    await expect(router.route(request({ id: "intrusion", userId: "intruder", channelId: "thread-1", threadId: "thread-1" }))).resolves.toEqual({ kind: "ignored" });
    expect(calls).toHaveLength(before);
    expect(sessions).toHaveLength(1);
  });
});

describe("task thread titles", () => {
  it("truncates the summary while preserving the stable short identifier", () => {
    const title = makeTaskThreadName("message-123", "A ".repeat(100));
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).toMatch(/ — [a-z0-9]{8}$/u);
    expect(makeTaskThreadName("message-123", "different words").slice(-8)).toBe(title.slice(-8));
  });
});
