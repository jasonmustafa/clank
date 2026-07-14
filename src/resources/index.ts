import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ResourceSource } from "../config/index.js";

const exec = promisify(execFile);

export interface ResolvedResources {
  skills: string[];
  prompts: string[];
  extensions: string[];
}

export interface ResourceUpdate {
  source: ResourceSource;
  checkout: string;
  previousRef: string | null;
  resultingRef: string;
  summary: string;
  requiresConfirmation: boolean;
}

export interface ResourceUpdatePlan {
  updates: ResourceUpdate[];
  requiresConfirmation: boolean;
  summary: string;
}

export interface ResourceUpdaterOptions { checkoutRoot: string; statePath: string; }

export async function resolveResourcePaths(source: ResourceSource, checkout: string): Promise<ResolvedResources> {
  return {
    skills: await expandPatterns(checkout, source.skills),
    prompts: await expandPatterns(checkout, source.prompts),
    extensions: await expandPatterns(checkout, source.extensions),
  };
}

export function checkoutPath(root: string, source: ResourceSource): string {
  return join(root, source.id);
}

export class ResourceUpdater {
  constructor(private readonly options: ResourceUpdaterOptions) {}

  async plan(sources: readonly ResourceSource[]): Promise<ResourceUpdatePlan> {
    await mkdir(this.options.checkoutRoot, { recursive: true });
    const recorded = await this.readState();
    const updates: ResourceUpdate[] = [];
    for (const source of sources) {
      const checkout = checkoutPath(this.options.checkoutRoot, source);
      if (!(await exists(join(checkout, ".git")))) {
        await runGit(this.options.checkoutRoot, "clone", "--no-checkout", "--", source.repo, checkout);
      } else {
        await runGit(checkout, "remote", "set-url", "origin", source.repo);
      }
      await runGit(checkout, "fetch", "--prune", "origin", source.ref);
      const resultingRef = await runGit(checkout, "rev-parse", "FETCH_HEAD");
      const previousRef = recorded[source.id] ?? null;
      const containsExecutableResources = source.extensions.length > 0
        || (await runGit(checkout, "ls-tree", "-r", "--name-only", resultingRef)).split("\n")
          .some((path) => path === "package.json" || path.endsWith("/package.json"));
      const summary = previousRef === resultingRef
        ? `${source.id}: unchanged at ${resultingRef.slice(0, 12)}`
        : `${source.id}: ${previousRef?.slice(0, 12) ?? "uninitialized"} -> ${resultingRef.slice(0, 12)}\n${await commitSummary(checkout, previousRef, resultingRef)}`;
      updates.push({ source, checkout, previousRef, resultingRef, summary, requiresConfirmation: containsExecutableResources && previousRef !== resultingRef });
    }
    return { updates, requiresConfirmation: updates.some((item) => item.requiresConfirmation), summary: updates.map((item) => item.summary).join("\n\n") };
  }

  async apply(plan: ResourceUpdatePlan, confirmation: { ownerConfirmed: boolean } = { ownerConfirmed: false }): Promise<ResolvedResources[]> {
    if (plan.requiresConfirmation && !confirmation.ownerConfirmed) throw new Error("Resource update requires extra owner confirmation");
    for (const update of plan.updates) {
      await runGit(update.checkout, "reset", "--hard", update.resultingRef);
      await runGit(update.checkout, "clean", "-fdx");
    }
    await this.writeState(Object.fromEntries(plan.updates.map((item) => [item.source.id, item.resultingRef])));
    return Promise.all(plan.updates.map((item) => resolveResourcePaths(item.source, item.checkout)));
  }

  private async readState(): Promise<Record<string, string>> {
    try { return JSON.parse(await readFile(this.options.statePath, "utf8")) as Record<string, string>; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return {}; throw error; }
  }

  private async writeState(state: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.options.statePath), { recursive: true });
    const temporary = `${this.options.statePath}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.options.statePath);
  }
}

async function expandPatterns(root: string, patterns: readonly string[]): Promise<string[]> {
  const files = await walk(root);
  const matches = new Set<string>();
  for (const pattern of patterns) {
    const matcher = globRegex(pattern.replaceAll("\\", "/"));
    for (const file of files) if (matcher.test(relative(root, file).replaceAll("\\", "/"))) matches.add(resolve(file));
  }
  return [...matches].sort();
}

async function walk(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path)); else if (entry.isFile()) result.push(path);
  }
  return result;
}

function globRegex(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") { expression += ".*"; index += 1; }
    else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") ?? "";
  }
  return new RegExp(`${expression}$`, "u");
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
}

async function commitSummary(checkout: string, previous: string | null, resulting: string): Promise<string> {
  if (previous === null) return (await runGit(checkout, "show", "--stat", "--oneline", "--no-renames", resulting)).slice(0, 1800);
  return (await runGit(checkout, "log", "--oneline", "--stat", "--no-renames", `${previous}..${resulting}`)).slice(0, 1800);
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
