# Clank

Discord-to-Pi assistant daemon. Clank lets an allowed Discord user DM or mention the bot, then runs the request through Pi on a VPS.

## Features

- Discord Gateway bot using `discord.js`
- DMs, mentions, and optional allowlisted guild channels
- Per-job Pi `AgentSessionRuntime`, workspace, and session file
- Global filesystem allowlist via `CLANK_ALLOWED_ROOTS`; each job also gets a workspace for attachments/scratch
- Job routing selects ergonomic cwd (`/<path>/clank/app` for Clank, `/<path>/clank/pi-agent` for Pi resources) without granting extra filesystem access
- Discord threads for job follow-ups when possible
- Busy thread messages queue as follow-ups; `steer <msg>` explicitly steers the active turn
- Streamed preview/status edits and final chunked Discord replies
- Attachment download into job workspace with image inputs passed to Pi
- Narrow `discord_send_file` Pi tool for sending generated files back
- User/guild/channel allowlists, path protection, sanitized bash env, and Discord confirmation for destructive commands

## Layout

- Pi agent dir: `/<path>/clank/pi-agent`
- Pi sessions: `/<path>/clank/pi-sessions`
- Workspaces: `/<path>/clank/workspaces`
- Clank repo: `/<path>/clank/app`
- State: `/<path>/clank/state/clank-jobs.json`
- Temp: `/<path>/clank/tmp`
- Allowed roots: `CLANK_WORKSPACE_ROOT` plus `CLANK_ALLOWED_ROOTS` (defaults to Clank repo and Pi agent dir when unset)

## Discord app setup

1. Create an app at <https://discord.com/developers/applications>.
2. Add a bot and copy the bot token.
3. Enable Message Content Intent.
4. Invite the bot with permissions:
   - View Channels
   - Send Messages
   - Create Public Threads / Create Private Threads (as desired)
   - Send Messages in Threads
   - Attach Files
   - Read Message History
5. Get your Discord user ID and any guild/channel IDs for allowlists.

## VPS setup

```bash
cd /<path>/clank/app
npm install
cp .env.example .env
$EDITOR .env

mkdir -p /<path>/clank/pi-agent /<path>/clank/pi-sessions /<path>/clank/workspaces /<path>/clank/state /<path>/clank/tmp
npm run build
npm run start
```

Configure Pi credentials/resources in `/<path>/clank/pi-agent` (`auth.json`, `settings.json`, `models.json`, `skills/`, `prompts/`, `extensions/`, packages, etc.). Review any Pi packages/extensions/skills before loading them.

Set `CLANK_ALLOWED_ROOTS` to the master list of non-workspace directories Clank may inspect or edit, for example `/<path>/clank/app,/<path>/clank/pi-agent,/data/example-notes,/<path>/clank/repos,/<path>/clank/worktrees`. Do not allow `/`, `/home`, `/etc`, or broad service-data roots by default.

## Commands

In DMs, mentions, allowed channels, or a job thread:

- `help` — concise usage
- `status` — current job or recent jobs summary
- `jobs` — active/recent jobs
- `stop` — abort active job turn
- `new <request>` — create a new job
- `new` in a job thread — start a fresh Pi session for that job
- `compact [notes]` — trigger Pi compaction for current job
- `steer <message>` — steer the active busy turn
- `confirm <code>` / `deny <code>` — respond to safety prompts

## Self-improvement

Requests such as “improve the Discord bridge”, “add commands”, “add guild/role scanning”, “create a Pi skill”, or “build an Obsidian integration” are routed as stricter jobs:

- Clank repo work uses `/<path>/clank/app` as cwd when that path is allowed.
- Pi resource work uses `/<path>/clank/pi-agent` as cwd when that path is allowed, but only safe resource subdirs (`skills`, `prompts`, `extensions`, `themes`, `packages`) are writable/readable through path-gated tools.
- The safety prompt tells Pi to inspect git status, summarize/diff major changes, and run `npm run check`, `npm test`, and `npm run build` when relevant.
- Deployment/restart is manual for MVP. `deploy` is only a placeholder response.

For future Discord guild/role scanning, document and enable only the minimum required Discord Developer Portal settings and bot permissions. `src/discord/guildRoles.ts` is a read-only placeholder. Likely requirements: Guilds gateway intent; Guild Members privileged intent if scanning all members/roles by member; bot permissions such as View Channels and Manage Roles only if role mutation is explicitly implemented.

## Security notes

- Keep `.env`, `/etc/clank/clank.env`, and Pi auth files out of git.
- `CLANK_ALLOWED_ROOTS` is a master filesystem allowlist, but secrets remain blocked even inside allowed roots (`.env`, SSH keys, Pi `auth.json`/`models.json`/`settings.json`, Docker socket, `/proc`, etc.).
- Allowlist Discord user IDs; guild/channel allowlists are strongly recommended.
- Do not run Clank as root and do not grant sudo.
- Do not mount Docker socket into future agent containers.
- Future deployment automation must use only a fixed root-owned script such as `/usr/local/sbin/deploy-clank`; never arbitrary sudo.
- The SDK runner executes locally on the VPS. Route risky repo-debug jobs to future RPC container/microVM runners.

## Development

```bash
npm run dev
npm run check
npm run test
npm run build
```

See `docs/architecture.md` for implementation details and Pi reference notes.
