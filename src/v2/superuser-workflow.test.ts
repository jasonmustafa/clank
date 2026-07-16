import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

async function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const result = await execute(executable, args, { cwd, env });
  return result.stdout;
}

describe("isolated superuser project workflow", () => {
  it("edits, checks, commits, pushes, and invokes ordinary gh issue and PR commands without live network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "clank-superuser-workflow-"));
    const remote = join(root, "remote.git");
    const checkout = join(root, "checkout");
    const bin = join(root, "bin");
    const ghLog = join(root, "gh.log");
    await run("git", ["init", "--bare", remote], root);
    await run("git", ["clone", remote, checkout], root);
    await run("git", ["config", "user.name", "Clank Bot"], checkout);
    await run("git", ["config", "user.email", "clank@example.invalid"], checkout);
    await writeFile(join(checkout, "package.json"), JSON.stringify({ scripts: { check: "node --check index.js" } }));
    await writeFile(join(checkout, "index.js"), "console.log('before');\n");
    await run("git", ["add", "."], checkout);
    await run("git", ["commit", "-m", "initial"], checkout);
    await run("git", ["switch", "-c", "clank/change"], checkout);

    await writeFile(join(checkout, "index.js"), "console.log('after');\n");
    await run("npm", ["run", "check"], checkout);
    await run("git", ["add", "index.js"], checkout);
    await run("git", ["commit", "-m", "Update output", "-m", "Generated-by: Clank"], checkout);
    await run("git", ["push", "-u", "origin", "clank/change"], checkout);

    await mkdir(bin);
    const fakeGh = join(bin, "gh");
    await writeFile(fakeGh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_LOG"\n`);
    await chmod(fakeGh, 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GH_LOG: ghLog };
    await run("gh", ["issue", "create", "--title", "Follow-up", "--body", "Details"], checkout, env);
    await run("gh", ["pr", "create", "--title", "Update output", "--body", "Generated-by: Clank"], checkout, env);

    expect(await run("git", ["rev-parse", "refs/heads/clank/change"], remote)).toBe(await run("git", ["rev-parse", "HEAD"], checkout));
    expect(await run("git", ["log", "-1", "--format=%an <%ae>%n%B"], checkout)).toContain("Clank Bot <clank@example.invalid>\nUpdate output\n\nGenerated-by: Clank");
    expect(await readFile(ghLog, "utf8")).toBe("issue create --title Follow-up --body Details\npr create --title Update output --body Generated-by: Clank\n");
  });
});
