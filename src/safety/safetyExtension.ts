import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandNeedsConfirmation, commandTouchesSensitivePath, explainPathPolicy, isAllowedByRoots, uniqueResolvedPaths, type PathProtectionConfig } from "./pathProtection.js";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toolPathInputs(toolName: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (["read", "write", "edit"].includes(toolName)) {
    const path = stringValue(input.path);
    if (path) paths.push(path);
  }
  if (["grep", "find", "ls"].includes(toolName)) {
    paths.push(stringValue(input.path) ?? ".");
  }
  return paths;
}

function allowedRootsForConfig(config: PathProtectionConfig): string[] {
  return uniqueResolvedPaths(config.allowedRoots && config.allowedRoots.length > 0 ? config.allowedRoots : [config.workspaceRoot]);
}

function safetyPrompt(config: PathProtectionConfig): string {
  const allowedRoots = allowedRootsForConfig(config).join(", ");
  const base =
    `\n\nClank Discord bridge safety rules:\n` +
    `- Work only under allowed roots: ${allowedRoots}. Do not read or expose secrets, .env files, SSH keys, Discord tokens, API keys, or Pi auth files.\n` +
    `- If the user asks for a generated file to be sent back to Discord, call discord_send_file with a path under an allowed root.\n` +
    `- Do not use sudo or attempt to access Docker socket or host-level privileged resources.\n` +
    `- Automatic deployment/restart is disabled for MVP. If code changes require it, say \"restart required\".`;

  if (config.mode === "self-improvement") {
    return (
      base +
      `\n\nClank self-improvement rules:\n` +
      `- You may work on Clank's own repo at ${config.clankAppDir}. Prefer git-tracked source, tests, docs, and config templates.\n` +
      `- Before major code changes, inspect git status and summarize the intended diff. After changes, summarize the actual diff.\n` +
      `- When relevant, run npm run check, npm test, and npm run build.\n` +
      `- You may create/update Pi resources only in safe subdirs of ${config.piAgentDir}: skills, prompts, extensions, themes, packages.\n` +
      `- Do not edit /etc/clank/clank.env, .env files, SSH keys, API keys, Discord tokens, Pi auth files, or other secrets.\n` +
      `- Do not deploy or restart the service automatically. A future deploy may only use a fixed approved script like /usr/local/sbin/deploy-clank.`
    );
  }

  if (config.mode === "pi-agent") {
    return (
      base +
      `\n\nPi agent resource update rules:\n` +
      `- You may create/update reviewed Pi resources under ${config.piAgentDir}/skills, prompts, extensions, themes, or packages.\n` +
      `- Do not edit Pi auth, model, settings, or credential files. Do not expose secrets.\n` +
      `- Document any new skill/prompt/package behavior and any required setup.`
    );
  }

  return base;
}

export function createSafetyExtension(config: PathProtectionConfig) {
  return function safetyExtension(pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
      const input = event.input as Record<string, unknown>;

      for (const path of toolPathInputs(event.toolName, input)) {
        const reason = explainPathPolicy(path, ctx.cwd, config);
        if (reason) {
          ctx.ui.notify(`Blocked ${event.toolName}: ${reason}`, "warning");
          return { block: true, reason };
        }
      }

      if (event.toolName !== "bash") return undefined;

      const allowedRoots = allowedRootsForConfig(config);
      if (!isAllowedByRoots(ctx.cwd, allowedRoots)) {
        const reason = `bash cwd is outside allowed roots (${allowedRoots.join(", ")}): ${ctx.cwd}`;
        ctx.ui.notify(`Blocked bash: ${reason}`, "warning");
        return { block: true, reason };
      }

      const command = stringValue(input.command) ?? "";
      const secretReason = commandTouchesSensitivePath(command, config);
      if (secretReason) {
        ctx.ui.notify(`Blocked bash: ${secretReason}`, "warning");
        return { block: true, reason: secretReason };
      }

      const confirmationReason = commandNeedsConfirmation(command);
      if (!confirmationReason) return undefined;

      if (confirmationReason.includes("sudo")) {
        return { block: true, reason: "sudo is not allowed for Clank jobs" };
      }
      if (["service management", "process or host control", "container runtime operation"].includes(confirmationReason)) {
        return { block: true, reason: `${confirmationReason} is disabled in the SDK runner; use manual VPS steps or future isolated runners` };
      }

      if (!ctx.hasUI) {
        return { block: true, reason: `${confirmationReason} requires confirmation, but no UI is available` };
      }

      const confirmed = await ctx.ui.confirm("Confirm privileged/destructive command", `Reason: ${confirmationReason}\n\n${command}`);
      if (!confirmed) return { block: true, reason: "Blocked by Discord confirmation flow" };
      return undefined;
    });

    pi.on("before_agent_start", async (event) => ({
      systemPrompt: event.systemPrompt + safetyPrompt(config),
    }));
  };
}
