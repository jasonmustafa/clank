import { describe, expect, it, vi } from "vitest";
import { handleResourcesUpdate } from "./resources-update.js";
import type { DiscordPolicy } from "../config/index.js";

const policy = { ownerUserIds: ["owner"] } as DiscordPolicy;
const plan = { updates: [], requiresConfirmation: true, summary: "trusted: aaa -> bbb\nextension.ts" };

describe("/clank resources-update", () => {
  it("denies non-owners", async () => {
    const updater = { plan: vi.fn(), apply: vi.fn() };
    expect(await handleResourcesUpdate(policy, "worker", false, updater, [])).toMatchObject({ allowed: false });
    expect(updater.plan).not.toHaveBeenCalled();
  });

  it("asks for explicit owner confirmation with the diff summary before applying extensions", async () => {
    const updater = { plan: vi.fn().mockResolvedValue(plan), apply: vi.fn() };
    const response = await handleResourcesUpdate(policy, "owner", false, updater, []);
    expect(response.content).toContain("extension.ts");
    expect(response.content).toContain("confirm");
    expect(updater.apply).not.toHaveBeenCalled();
  });

  it("applies an explicitly confirmed owner update", async () => {
    const updater = { plan: vi.fn().mockResolvedValue(plan), apply: vi.fn().mockResolvedValue([]) };
    const response = await handleResourcesUpdate(policy, "owner", true, updater, []);
    expect(response.allowed).toBe(true);
    expect(updater.apply).toHaveBeenCalledWith(plan, { ownerConfirmed: true });
  });
});
