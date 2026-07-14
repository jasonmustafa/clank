import { GatewayIntentBits } from "discord.js";
import { describe, expect, it } from "vitest";
import type { DiscordPolicy } from "../config/index.js";
import {
  CLANK_COMMAND,
  createDiscordClient,
  routeCommand,
  type CommandRequest,
} from "./index.js";

const policy: DiscordPolicy = {
  applicationId: "app",
  guildId: "work-guild",
  ownerUserIds: ["owner"],
  workUserIds: ["worker"],
  workRoleIds: ["work-role"],
  privilegedApproverUserIds: [],
  workChannelIds: ["work-channel"],
  elevatedChannelIds: ["owner-channel"],
  casualGuildIds: ["casual-guild"],
};

function request(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    commandName: "clank",
    subcommand: "help",
    userId: "stranger",
    roleIds: [],
    guildId: "work-guild",
    channelId: "elsewhere",
    parentChannelId: null,
    channelKind: "guild",
    isJobThread: false,
    isBot: false,
    ...overrides,
  };
}

describe("Discord gateway", () => {
  it("requests guild, message, and message-content gateway events", () => {
    const client = createDiscordClient();

    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.DirectMessages)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(true);
  });
});

describe("/clank command", () => {
  it("declares a guild command with a help subcommand", () => {
    const command = CLANK_COMMAND.toJSON();
    expect(command.name).toBe("clank");
    expect(command.options?.map((option) => option.name)).toEqual(["help", "stop", "steer", "compact", "status", "jobs", "new", "deploy", "rollback", "resources-update"]);
  });

  it.each([
    ["casual", request({ guildId: "casual-guild" }), "Casual chat"],
    ["work", request({ userId: "worker", channelId: "work-channel" }), "Work channel"],
    ["job thread", request({ userId: "worker", channelId: "thread", parentChannelId: "work-channel", channelKind: "thread", isJobThread: true }), "Job thread"],
    ["DM", request({ userId: "worker", guildId: null, channelId: "dm", channelKind: "dm" }), "Direct message"],
    ["owner", request({ userId: "owner", channelId: "owner-channel" }), "Owner commands"],
  ])("returns context-aware help in %s contexts", (_name, input, heading) => {
    const response = routeCommand(policy, input);
    expect(response.allowed).toBe(true);
    expect(response.content).toContain(heading);
  });

  it("does not describe unrelated work-channel threads as jobs", () => {
    const response = routeCommand(policy, request({
      userId: "worker",
      channelId: "thread",
      parentChannelId: "work-channel",
      channelKind: "thread",
    }));

    expect(response.content).toContain("Work channel");
    expect(response.content).not.toContain("current job");
  });

  it("denies unauthorized use concisely without policy details", () => {
    const response = routeCommand(policy, request());

    expect(response).toEqual({
      allowed: false,
      content: "You aren't authorized to use Clank here.",
      ephemeral: true,
    });
    expect(response.content).not.toContain("work-channel");
  });
});
