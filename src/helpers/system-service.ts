import { type DiscordPolicy } from "../config/index.js";
import { type ApprovalService } from "../safety/index.js";
import { isMutatingSystemRequest, validateSystemRequest, type SystemAuditContext, type SystemHelperResult, type SystemRequest } from "./system-protocol.js";

export interface SystemRequestContext { requesterId: string; channelId: string; }
export interface ConfirmationRequest extends SystemRequestContext { summary: string; }
export interface ConfirmationResult { approved: boolean; approvalId?: string; approverId?: string; }
export interface SystemRequestServiceOptions {
  ownerUserIds: readonly string[];
  invoke: (request: SystemRequest, context: SystemAuditContext) => Promise<SystemHelperResult>;
  confirm: (request: ConfirmationRequest) => Promise<boolean | ConfirmationResult>;
}

export class SystemRequestService {
  constructor(private readonly options: SystemRequestServiceOptions) {}
  async execute(input: SystemRequest, context: SystemRequestContext): Promise<SystemHelperResult> {
    const validation = validateSystemRequest(input);
    if (!validation.ok) throw new Error(`Invalid system request: ${validation.error}`);
    if (!this.options.ownerUserIds.includes(context.requesterId)) throw new Error("System helper requests are owner-only");
    const request = validation.value;
    let auditContext: SystemAuditContext = { requesterId: context.requesterId };
    if (isMutatingSystemRequest(request)) {
      const confirmation = await this.options.confirm({ ...context, summary: summarize(request) });
      const approved = typeof confirmation === "boolean" ? confirmation : confirmation.approved;
      if (!approved) throw new Error("Privileged action was denied or expired");
      if (typeof confirmation !== "boolean") auditContext = {
        ...auditContext,
        ...(confirmation.approvalId === undefined ? {} : { approvalId: confirmation.approvalId }),
        ...(confirmation.approverId === undefined ? {} : { approverId: confirmation.approverId }),
      };
    }
    return this.options.invoke(request, auditContext);
  }
}

export function approvalConfirmation(approvals: ApprovalService, timeoutMs = 60_000): (request: ConfirmationRequest) => Promise<ConfirmationResult> {
  return async (request) => {
    const approval = await approvals.request({ ...request, timeoutMs });
    const decided = await approvals.waitForDecision(approval.id);
    return { approved: decided.status === "approved", approvalId: decided.id, ...(decided.decidedBy === undefined ? {} : { approverId: decided.decidedBy }) };
  };
}

export function createSystemRequestService(policy: DiscordPolicy, approvals: ApprovalService, invoke: SystemRequestServiceOptions["invoke"]): SystemRequestService {
  return new SystemRequestService({
    ownerUserIds: policy.ownerUserIds,
    invoke,
    confirm: approvalConfirmation(approvals),
  });
}

function summarize(request: SystemRequest): string {
  switch (request.action) {
    case "apt-update": return "Run apt update";
    case "apt-install": return `Install apt packages: ${request.packages.join(", ")}`;
    case "service-restart": return "Restart clank.service";
    case "service-status": return "Read clank.service status";
    case "journal-read": return `Read the latest ${String(request.lines)} clank.service journal entries`;
  }
}

