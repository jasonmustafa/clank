#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";

const trackedFiles = execFileSync("git", ["ls-files", "-z"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const unsafeDirectories = new Set([
  ".clank-dev",
  "attachments",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "sessions",
  "state",
  "temp",
  "tmp",
  "vendor",
  "workspaces",
]);
const unsafeBasenames = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials.json",
  "hosts.yml",
]);
const unsafeSuffixes = [
  ".db",
  ".dump",
  ".key",
  ".log",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".sqlite3",
];

function isExample(path: string): boolean {
  if (path === ".env.example") return true;
  if (path.endsWith("/.env.example")) return true;
  return /\.example\.(json|ya?ml)$/.test(path);
}

function isUnsafe(path: string): boolean {
  if (isExample(path)) return false;

  const parts = path.split("/");
  const basename = parts.at(-1) ?? "";
  const rootDirectory = parts[0] ?? "";
  if (unsafeDirectories.has(rootDirectory)) return true;
  if (basename === ".env" || basename.startsWith(".env.")) return true;
  if (unsafeBasenames.has(basename)) return true;
  if (basename.startsWith("id_rsa") || basename.startsWith("id_ed25519")) return true;
  if (unsafeSuffixes.some((suffix) => basename.endsWith(suffix))) return true;
  if (basename.endsWith(".tsbuildinfo")) return true;

  return rootDirectory === "config" && /\.(json|ya?ml)$/.test(basename);
}

const unsafeFiles = trackedFiles.filter(isUnsafe);
if (unsafeFiles.length > 0) {
  for (const path of unsafeFiles) console.error(`unsafe tracked file: ${JSON.stringify(path)}`);
  console.error("Remove the files from Git tracking and rotate any exposed secrets.");
  process.exitCode = 1;
} else {
  console.log("Tracked-file safety check passed.");
}
