# Clank

Clank is a private Discord-to-Pi daemon. Authorized owners receive ordinary Pi project sessions in configured working directories; casual mentions run in isolated, short-lived sessions with bounded web tools.

## Trust and safety model

- Authorization uses immutable Discord user, guild, and channel IDs. Bot and webhook messages are ignored.
- Owner tasks run as the dedicated `clank` Unix account with normal Pi, Git, and `gh` behavior. Configured aliases select reviewed starting directories; the Unix account—not aliases—is the filesystem boundary.
- Casual sessions have no project/global resources, built-ins, filesystem tools, or shell. Their web requests are bounded by scheme, address, redirects, response size, and rate limits.
- Attachments are task-scoped and bounded by count and size; filenames, paths, and symlinks are validated.
- Task/session mappings and approvals are written atomically. Active tasks become interrupted after restart and can recover their saved Pi session.
- Destructive shell commands can require an exact, expiring, requester/task/cwd-bound Discord approval. General privileged execution should remain disabled. The only recommended sudo grant is the exact nonblocking service restart command.
- Configuration contains policy only. Keep the Discord token and Pi/GitHub credentials outside Git.

Discord approval mitigates owner mistakes; it is not a security boundary against compromised daemon or model code. The Unix account and host sandbox are that boundary.

## Configure

Requirements: Node.js 24.18.0, Pi credentials, a Discord application with Message Content Intent, and a dedicated Unix account.

```sh
npm ci
cp config/clank.config.example.json /srv/clank/config/clank.config.json
```

Replace every placeholder and review each working-directory alias. Put the bot token in `/etc/clank/clank.env`:

```sh
CLANK_DISCORD_TOKEN=...
```

`CLANK_CONFIG_PATH` optionally overrides `/srv/clank/config/clank.config.json`. Configure normal Pi settings under `/srv/clank/.pi/agent`; configure Git and `gh` as the `clank` account. Clank does not clone mandatory workspaces, stage trusted resources, filter paths/commands, enforce repository allowlists, or provide GitHub helper bridges.

## Develop and verify

```sh
npm run dev
npm run check
npm test
npm run check:public
npm run build
npm start
```

The build removes `dist/` first so deleted architecture cannot survive as stale output.

## Install the service

After building in `/srv/clank/app`:

```sh
sudo chmod 0755 setup/systemd/run-clank
sudo install -o root -g root -m 0644 setup/systemd/clank.service /etc/systemd/system/clank.service
sudo install -o root -g root -m 0440 setup/systemd/clank-restart.sudoers /etc/sudoers.d/clank-restart
sudo visudo -cf /etc/sudoers.d/clank-restart
sudo systemctl daemon-reload
sudo systemctl enable --now clank.service
```

Inspect with `systemctl status clank.service` and `journalctl -u clank.service`. Validate the complete Discord, GitHub, approval, restart, and recovery loop using [the smoke-test runbook](docs/self-improvement-smoke-test.md) before production cutover.

## State, backup, and recovery

Canonical persistent paths are `/srv/clank/state/tasks.json` and `/srv/clank/pi-sessions`. Stop the service and back up state and sessions together; encrypt and restrict backups. A task record without its corresponding Pi session cannot resume.

Legacy job state is deliberately not migrated because it embeds removed workspace/profile/policy assumptions. Follow [the cutover and recovery procedure](docs/cutover-and-recovery.md) for backup, fresh startup, rollback, and recovery of unfinished repository work.

## Public-repository checks

`npm run check:public` rejects tracked secret-like filenames and unsafe repository artifacts. It complements, but does not replace, safeguards at release time: run a secret scanner against the working tree and full Git history, inspect staged files and refs for identifiers or generated artifacts, and verify a fresh public clone contains only intended files and documentation. Never commit credentials, private IDs, state, sessions, logs, attachments, or environment files.
