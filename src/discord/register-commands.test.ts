import { describe, expect, it, vi } from "vitest";
import type { DiscordPolicy } from "../config/index.js";
import { registerGuildCommands } from "./register-commands.js";

const policy: DiscordPolicy = {
  applicationId: "application",
  guildId: "guild",
  ownerUserIds: ["owner"],
  workUserIds: [],
  workRoleIds: [],
  privilegedApproverUserIds: [],
  workChannelIds: [],
  elevatedChannelIds: [],
  casualGuildIds: [],
};

describe("guild command registration", () => {
  it("puts /clank on the configured application guild route", async () => {
    const put = vi.fn<(route: string, options: { body: unknown[] }) => Promise<unknown>>().mockResolvedValue([]);

    await registerGuildCommands({ put }, policy);

    expect(put).toHaveBeenCalledOnce();
    const [route, options] = put.mock.calls[0] ?? [];
    expect(route).toBe("/applications/application/guilds/guild/commands");
    expect(options?.body).toMatchObject([{ name: "clank" }]);
  });
});
