import { isOwner, type DiscordPolicy } from "../config/index.js";
import type { DeploymentManager, DeploymentResult } from "../deployment/index.js";

export interface DeploymentHandler { deploy(request: { requesterId: string; channelId: string }): Promise<DeploymentResult>; rollback(request: { requesterId: string; channelId: string }): Promise<DeploymentResult>; }

export async function handleDeployment(policy: DiscordPolicy, userId: string, channelId: string, operation: "deploy" | "rollback", manager: DeploymentHandler): Promise<{ allowed: boolean; content: string }> {
  if (!isOwner(policy, userId)) return { allowed: false, content: "Only a Clank owner can deploy or rollback." };
  const result = await manager[operation]({ requesterId: userId, channelId });
  return { allowed: result.ok, content: result.summary };
}

export type { DeploymentManager };
