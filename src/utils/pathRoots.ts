import { isAbsolute, relative, resolve } from "node:path";

export function isInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child);
  const normalizedParent = resolve(parent);
  const rel = relative(normalizedParent, normalizedChild);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function uniqueResolvedPaths(paths: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const resolved = resolve(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

export function isAllowedByRoots(path: string, roots: readonly string[]): boolean {
  const resolvedPath = resolve(path);
  return roots.some((root) => isInside(resolvedPath, root));
}
