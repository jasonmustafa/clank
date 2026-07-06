# Clank Message Flow

This is what happens when you message Clank in Discord.

## High-level architecture

```text
Discord user
  │
  ▼
Discord Gateway bot (discord.js)
  │
  ├─ allowlist checks: user, guild, channel, DM policy
  ├─ command routing: help/status/jobs/stop/new/compact/steer/confirm/deny/deploy
  ├─ thread/session routing: existing job thread, latest DM job, or new job
  │
  ▼
Clank Job Manager
  │
  ├─ creates/loads job record in /opt/clank/state/clank-jobs.json
  ├─ creates workspace under /opt/clank/workspaces/<job-id>
  ├─ validates cwd against CLANK_ALLOWED_ROOTS (workspace root is always allowed)
  ├─ creates Discord thread when possible
  ├─ downloads attachments into the job workspace
  │
  ▼
PiRunner abstraction
  │
  ├─ default: SdkPiRunner using Pi AgentSessionRuntime
  ├─ future: RpcPiRunner / ContainerRpcRunner / MicroVmRpcRunner
  │
  ▼
Pi AgentSessionRuntime
  │
  ├─ cwd = job workspace, Clank repo, or Pi agent dir depending on job kind
  ├─ allowed roots = CLANK_WORKSPACE_ROOT plus CLANK_ALLOWED_ROOTS
  ├─ agentDir = /opt/clank/pi-agent
  ├─ session files = /opt/clank/pi-sessions
  ├─ loads Pi settings, auth, packages, skills, prompts, extensions
  ├─ runs tools: read/bash/edit/write/etc. with Clank safety extension
  │
  ▼
Discord response
  ├─ streaming preview message is edited with throttling
  ├─ compact tool/status updates are shown
  ├─ final answer is sent as normal chunked Discord messages
  └─ generated files can be sent via the narrow discord_send_file tool
```

## Step-by-step: normal DM message

Example:

```text
You DM Clank: “summarize this repo”
```

1. Discord sends a `messageCreate` event to Clank over the Gateway.
2. Clank ignores bot messages.
3. Clank checks allowlists:
   - your Discord user ID must be in `DISCORD_ALLOWED_USER_IDS`
   - DMs must be enabled with `DISCORD_ALLOW_DMS=true`
4. Clank strips bot mentions/prefixes if present.
5. Clank checks whether the message is a built-in command.
6. If it is not a command, Clank routes it:
   - in DMs, it uses the latest DM job if one exists
   - otherwise it creates a new job
7. For a new job, Clank creates:
   - a job ID like `job_mqtdttwn_3edf3d`
   - a workspace under `/opt/clank/workspaces/<job-id>`
   - a Pi session file under `/opt/clank/pi-sessions`
   - a JSON job record in `/opt/clank/state/clank-jobs.json`
8. Clank creates an `SdkPiRunner` for that job.
9. The runner creates a Pi `AgentSessionRuntime` with:
   - `agentDir: /opt/clank/pi-agent`
   - `cwd: /opt/clank/workspaces/<job-id>` for standard jobs
   - allowed roots from `CLANK_ALLOWED_ROOTS` plus the workspace root
   - Pi settings/auth/models from `/opt/clank/pi-agent`
10. Clank sends the prompt to Pi.
11. While Pi streams text, Clank edits one Discord preview message.
12. Tool calls appear as compact status updates, not spammy full logs.
13. When Pi finishes, Clank edits the preview to `✅ Clank finished.`
14. Clank sends the final answer as normal Discord message(s), chunked below Discord limits.

## Step-by-step: server/channel mention

Example:

```text
@Clank help
```

1. The message arrives from a guild channel.
2. Clank checks:
   - user allowlist
   - `DISCORD_ALLOWED_GUILD_IDS`
   - optional `DISCORD_ALLOWED_CHANNEL_IDS`
   - bot mention or command prefix, unless `DISCORD_ALLOW_GUILD_CHANNEL_MESSAGES=true`
3. If allowed, Clank handles commands directly or creates/routes a job.
4. For new guild jobs, Clank tries to create a Discord thread.
5. Replies inside that thread continue the same job/Pi session.

## Job routing rules

| Message location | Behavior |
|---|---|
| DM, no existing recent job | create new job |
| DM, recent job exists | route to latest DM job |
| Guild channel mention | create new job, preferably with a thread |
| Known job thread | continue that job |
| Busy known job thread | queue as follow-up by default |
| `steer <message>` in job thread | queue as steering message for active turn |
| `new <request>` | create a new job |
| `new` inside job thread | start a fresh Pi session for that job |

## Commands

| Command | What it does |
|---|---|
| `help` | usage summary |
| `status` | current job or recent job status |
| `jobs` | list recent jobs |
| `stop` | abort active job turn |
| `new <request>` | create unrelated new job |
| `new` in job thread | create fresh Pi session for that job |
| `compact [notes]` | trigger Pi session compaction |
| `steer <message>` | steer active busy turn |
| `confirm <code>` | approve destructive/privileged operation |
| `deny <code>` | deny destructive/privileged operation |
| `deploy` | placeholder only; deployment remains manual |

## Job kinds

Clank chooses a job cwd based on the request text. Cwd is for ergonomics only; filesystem access comes from `CLANK_ALLOWED_ROOTS` plus the workspace root. If a selected cwd is outside the allowlist, Clank falls back to the job workspace.

| Job kind | Cwd | Example requests |
|---|---|---|
| Standard | `/opt/clank/workspaces/<job-id>` | “summarize this file”, “write a script” |
| Self-improvement | `/opt/clank/app` | “improve the Discord bridge”, “add a command”, “add guild/role features” |
| Pi agent resource update | `/opt/clank/pi-agent` | “create a Pi skill”, “update a prompt”, “add a Pi package” |

Self-improvement and Pi-agent jobs have stricter safety instructions. Future configured roots such as `/data/example-notes`, `/opt/clank/repos`, or `/opt/clank/worktrees` can be used by any job when added to `CLANK_ALLOWED_ROOTS`.

## Attachments

When you attach files in Discord:

1. Clank downloads them into the job workspace.
2. It adds local paths to the Pi prompt.
3. If an attachment is an image, Clank also passes it as a Pi image input when possible.
4. Pi can inspect the downloaded paths using its tools.

## Sending generated files back

Pi cannot send arbitrary host files directly.

Instead, Clank exposes a narrow tool:

```text
discord_send_file
```

Rules:

- accepts a relative or absolute path under an allowed root
- resolves relative paths against the job cwd
- blocks protected/secrets paths even inside allowed roots
- enforces Discord upload size limits

## Safety model

Clank currently runs Pi through the SDK on the VPS, so safety is important.

Protections include:

- Discord user/guild/channel allowlists
- no sudo
- no Docker socket access
- sanitized environment for bash tools
- `CLANK_ALLOWED_ROOTS` as the master filesystem allowlist; no `/`, `/home`, `/etc`, or broad service-data roots by default
- blocked secret paths even inside allowed roots:
  - real `.env` files (`.env.example` templates are allowed)
  - `/etc/clank/clank.env`
  - SSH keys
  - API keys/tokens
  - Pi auth/model/settings files
  - `/proc` environment leaks
- confirmation flow before destructive/privileged commands
- manual deployment/restart only

Future risky repo-debug jobs should use the RPC runner in a container or microVM.

## Runtime persistence

Clank stores:

```text
/opt/clank/state/clank-jobs.json       # Discord job/thread/session mapping
/opt/clank/pi-sessions                 # Pi session JSONL files
/opt/clank/workspaces/<job-id>         # job attachments, scratch files, and generated artifacts
/opt/clank/pi-agent                    # Pi auth, settings, skills, prompts, extensions, packages
```

## Operational loop

```text
Edit code or config
  │
  ├─ npm run check
  ├─ npm test
  ├─ npm run build
  │
  ▼
sudo systemctl restart clank-discord
  │
  ▼
journalctl -u clank-discord -f
```
