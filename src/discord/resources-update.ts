import { isOwner, type DiscordPolicy, type ResourceSource } from "../config/index.js";
import type { ResourceUpdatePlan } from "../resources/index.js";

export interface ResourceUpdateHandler {
  plan(sources: readonly ResourceSource[]): Promise<ResourceUpdatePlan>;
  apply(plan: ResourceUpdatePlan, confirmation?: { ownerConfirmed: boolean }): Promise<unknown>;
}

export interface ResourcesUpdateResponse { allowed: boolean; content: string; ephemeral: true; }

export async function handleResourcesUpdate(
  policy: DiscordPolicy,
  userId: string,
  ownerConfirmed: boolean,
  updater: ResourceUpdateHandler,
  sources: readonly ResourceSource[],
): Promise<ResourcesUpdateResponse> {
  if (!isOwner(policy, userId)) return { allowed: false, content: "You aren't authorized to update Clank resources.", ephemeral: true };
  const plan = await updater.plan(sources);
  if (plan.requiresConfirmation && !ownerConfirmed) {
    return {
      allowed: true,
      content: `This update contains extensions or packages and can execute code. Review the commit diff summary, then rerun with confirm enabled:\n\n${plan.summary}`,
      ephemeral: true,
    };
  }
  await updater.apply(plan, { ownerConfirmed });
  return { allowed: true, content: `Trusted resources updated.\n\n${plan.summary}`, ephemeral: true };
}
