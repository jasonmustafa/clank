# Clank Architecture

Clank is a private Discord-to-Pi daemon. It is a standalone Discord Gateway bot that owns Pi sessions directly through the Pi SDK (`AgentSessionRuntime`) rather than running `pi --mode json` or defaulting to RPC.

## Pi docs and bridge reference notes

Reviewed Pi SDK/runtime, RPC, extensions, packages, skills, prompt templates, and JSON event stream docs. Key implementation points:

- `AgentSessionRuntime` owns session replacement (`newSession`, switch/fork/import). After replacement, session event subscriptions and extension bindings must be rebound.
- `AgentSession.prompt()` requires `streamingBehavior: "steer" | "followUp"` while the agent is busy. Clank defaults same-thread busy messages to `followUp`; the `steer` command uses `steer`.
- `DefaultResourceLoader` with `agentDir: /opt/clank/pi-agent` loads normal Pi resources: settings, auth, models, packages, extensions, skills, prompts, themes, and context.
- RPC is kept as a future isolation path. Pi exports `RpcClient`, so future runners should use it instead of hand-rolled JSONL.
- Extensions are the right place for tool gates and custom tools. Clank installs an inline safety extension and a narrow `discord_send_file` tool.
- Pi packages/skills/prompts loaded from `/opt/clank/pi-agent` are trusted local resources and must be reviewed because they can affect the agent.
- JSON event stream mode is one-shot event JSONL and is intentionally not used by Clank.
- `pi-telegram` is a Pi extension bridge; useful patterns copied conceptually: allow one authorized user, queue busy messages, stream preview edits, download attachments to local temp paths, pass images as image inputs, and expose a narrow attach/send-file tool. Clank differs by being a standalone Discord daemon with one Pi runtime per job.

## Runtime model

- Each unrelated top-level request creates a Clank job.
- Each job gets:
  - its own workspace under `/opt/clank/workspaces/<job-id>` for attachments/artifacts and scratch files
  - access to globally allowed roots from `CLANK_ALLOWED_ROOTS` plus its workspace root
  - a cwd selected by job kind for ergonomics: normal workspace, `/opt/clank/app` for Clank repo work, or `/opt/clank/pi-agent` for Pi resource updates
  - its own `AgentSessionRuntime`
  - its own Pi session file under `/opt/clank/pi-sessions`
  - a Discord thread when Discord permits thread creation
- Replies inside a mapped job thread route back to that job and continue the same Pi session.
- In DMs, Discord has no threads; Clank routes follow-ups to the latest job for that DM unless the user sends `new <request>`.
- Job/thread/session metadata is stored as simple JSON in `/opt/clank/state/clank-jobs.json`.

## Runner abstraction

`PiRunner` defines the stable boundary:

- `prompt()` with optional queue behavior (`immediate`, `followUp`, `steer`)
- `abort()`
- `compact()`
- `newSession()`
- `onEvent()`
- `getState()` / `getStatus()`
- `dispose()`

Implemented now:

- `SdkPiRunner` using `createAgentSessionRuntime()` and `AgentSessionRuntime`.

Stubs for later isolation:

- `RpcPiRunner`
- `ContainerRpcRunner`
- `MicroVmRpcRunner`

Future RPC runners should use Pi's exported `RpcClient` and place risky repo-debug jobs in a container or microVM.

## Discord flow

- Gateway intents: guilds, guild messages, DMs, message content.
- Access is restricted by configured user IDs, guild IDs, and optional channel IDs.
- Guild top-level messages require a bot mention, command prefix, or selected-channel mode.
- Streaming assistant text updates a preview/status message with throttling.
- Final assistant text is sent as chunked Discord messages below Discord limits.
- Tool events update a compact rolling status line instead of spamming every tool delta.
- Attachments are downloaded into the job workspace; image attachments are also passed as Pi image inputs.

## Safety

- Bot config and secrets live in `.env` outside git.
- Bash child processes receive a sanitized environment with token/API-key-like variables removed.
- `CLANK_ALLOWED_ROOTS` is the master filesystem allowlist. If unset, it defaults to `CLANK_WORKSPACE_ROOT`, `CLANK_APP_DIR`, and `PI_AGENT_DIR`; the workspace root is always added. Future roots can be added explicitly, such as `/data/example-notes`, `/opt/clank/repos`, or `/opt/clank/worktrees`.
- Job kind/cwd is a routing convenience, not a permission boundary. A cwd outside the global roots falls back to the job workspace.
- The inline safety extension blocks model access to protected paths, Pi auth/config, real `.env` files, `/etc/clank/clank.env`, SSH keys, Docker socket, `/proc`, and paths outside the configured allowed roots. Config templates such as `.env.example` are allowed.
- `sudo` is blocked. Other destructive/privileged commands require Discord confirmation (`confirm <code>` / `deny <code>`).
- Generated files can be sent back only through `discord_send_file`, which accepts relative or absolute paths under an allowed root and still applies protected-path checks.
- The bot must not run with sudo and must not mount the Docker socket into future containers.

## Self-improvement hooks

Self-improvement is implemented as a normal job kind with stricter cwd and prompt rules.

- Requests matching Clank/Discord bridge/guild/role/command/Obsidian integration improvement language, plus read-only prompts that explicitly mention the Clank repo/source/codebase, use cwd `/opt/clank/app`.
- Requests matching Pi skills/prompts/extensions/themes/packages use cwd `/opt/clank/pi-agent`.
- Self-improvement jobs can also read/write reviewed Pi resource subdirs but not Pi auth/model/settings files.
- Safety instructions require git-status/diff summaries before/after major changes and `npm run check`, `npm test`, and `npm run build` when relevant.
- Automatic deploy/restart is intentionally absent. The `deploy` command is a placeholder that explains manual restart and the future fixed-script-only constraint (`/usr/local/sbin/deploy-clank`).
- Future Discord guild/role scanning work starts from `src/discord/guildRoles.ts` and must document gateway intents and bot permissions before command wiring or mutation support.
