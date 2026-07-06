import type { ClankConfig } from "../config/env.js";
import type { JobKind } from "./jobStore.js";

export interface JobTarget {
  kind: JobKind;
  cwd: string;
  safetyLabel: string;
}

const PI_AGENT_PATTERN = /\b(pi[- ]?agent|pi\s+(skill|skills|prompt|prompts|package|packages|extension|extensions|theme|themes)|skills?|prompts?|prompt templates?|pi packages?)\b/i;
const SELF_PATTERN = /\b(clank|discord bridge|discord bot|gateway|guild|guilds|role|roles|commands?|obsidian|integration|integrations|own repo|self[- ]?improv|restart required)\b/i;
const CLANK_REPO_READ_PATTERN = /\b(clank(?:'s)?\s+(repo|repository|source|codebase|code|app)|(?:repo|repository|source|codebase|code)\s+(?:of|for|in)\s+clank|own repo)\b/i;
const CHANGE_PATTERN = /\b(improve|add|create|update|edit|modify|implement|build|fix|refactor|document)\b/i;

export function determineJobTarget(text: string, config: ClankConfig): JobTarget {
  const normalized = text.toLowerCase();
  if (PI_AGENT_PATTERN.test(normalized) && CHANGE_PATTERN.test(normalized)) {
    return { kind: "pi-agent", cwd: config.piAgentDir, safetyLabel: "Pi agent resource update" };
  }
  if ((SELF_PATTERN.test(normalized) && CHANGE_PATTERN.test(normalized)) || CLANK_REPO_READ_PATTERN.test(normalized)) {
    return { kind: "self-improvement", cwd: config.clankAppDir, safetyLabel: "Clank self-improvement" };
  }
  return { kind: "standard", cwd: "", safetyLabel: "standard" };
}

export function jobKindDescription(kind: JobKind): string {
  if (kind === "self-improvement") return "self-improvement repo job";
  if (kind === "pi-agent") return "Pi agent resource job";
  return "standard workspace job";
}
