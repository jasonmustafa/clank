import { describe, expect, it } from "vitest";
import { SuperuserRequestRouter, type DiscordRequest, type DiscordTransport, type SuperuserPiFactory } from "./router.js";

function request(overrides: Partial<DiscordRequest> = {}): DiscordRequest {
  return {
    id: "message-1",
    userId: "owner-123",
    channelId: "private-channel",
    guildId: "guild-1",
    location: "guild",
    content: "Inspect the checkout",
    authorIsBot: false,
    webhookId: null,
    ...overrides,
  };
}

function harness() {
  const created: { taskId: string; cwd: string }[] = [];
  const prompts: string[] = [];
  const sent: { requestId: string; content: string }[] = [];
  const pi: SuperuserPiFactory = {
    create(options) {
      created.push(options);
      return Promise.resolve({
        prompt(prompt) { prompts.push(prompt); return Promise.resolve("Pi completed the task."); },
        dispose() { return Promise.resolve(); },
      });
    },
  };
  const discord: DiscordTransport = {
    send(requestId, content) { sent.push({ requestId, content }); return Promise.resolve(); },
  };
  const router = new SuperuserRequestRouter({
    superuserIds: ["owner-123"],
    privateChannelIds: ["private-channel"],
    defaultWorkingDirectory: "/srv/clank/app",
  }, discord, pi);
  return { router, created, prompts, sent };
}

describe("superuser request router", () => {
  it("runs an authenticated private-channel request in the configured default directory and replies in Discord", async () => {
    const { router, created, prompts, sent } = harness();

    await expect(router.route(request())).resolves.toEqual({ kind: "completed", taskId: "message-1" });

    expect(created).toEqual([{ taskId: "message-1", cwd: "/srv/clank/app" }]);
    expect(prompts).toEqual(["Inspect the checkout"]);
    expect(sent).toEqual([{ requestId: "message-1", content: "Pi completed the task." }]);
  });

  it("runs the complete request and response path for a configured superuser in a DM", async () => {
    const { router, created, prompts, sent } = harness();

    await router.route(request({ channelId: "dm-1", guildId: null, location: "dm", content: "Check status" }));

    expect(created).toEqual([{ taskId: "message-1", cwd: "/srv/clank/app" }]);
    expect(prompts).toEqual(["Check status"]);
    expect(sent).toEqual([{ requestId: "message-1", content: "Pi completed the task." }]);
  });

  it.each([
    ["different immutable user ID", { userId: "owner-display-name" }],
    ["bot author", { authorIsBot: true }],
    ["webhook author", { webhookId: "webhook-1" }],
    ["unconfigured guild channel", { channelId: "public-channel" }],
  ])("does not invoke Pi for a %s", async (_case, overrides) => {
    const { router, created, sent } = harness();

    await expect(router.route(request(overrides))).resolves.toEqual({ kind: "ignored" });

    expect(created).toEqual([]);
    expect(sent).toEqual([]);
  });
});
