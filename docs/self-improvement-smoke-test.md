# Isolated self-improvement smoke test

Use this runbook to validate Clank's complete Discord-to-GitHub-to-restart loop before production cutover. This is an operational test: unit tests cannot prove Discord permissions, live GitHub credentials, systemd policy, or recovery across a real process restart.

## Safety and deployment assumptions

- Use a dedicated VPS or VM, Unix account, Discord application, private test guild/channel, and disposable GitHub repository. Do not share the production bot token, guild, checkout, or state directory.
- Treat the Discord token, Pi credentials, GitHub token/SSH key, and saved Pi sessions as secrets. Keep them out of Git, Discord messages, logs, and shareable backups. Use least-privilege repository credentials and rotate credentials after suspected exposure.
- Only list projects reviewed and trusted by the owner in `pi.workingDirectories`. Pi loads project and global instructions, skills, and extensions and can execute code as `clank`.
- Back up the root-owned configuration and secret file separately from `/srv/clank/state` and `/srv/clank/pi-sessions-v2`. Encrypt backups, restrict access, and practice restoring state and sessions together. A state record without its matching Pi session cannot resume.
- Keep `approvals.privilegedExecution` set to `disabled`. General passwordless sudo makes Clank effectively root-equivalent; Discord approval is mistake mitigation and is not a boundary against compromised daemon/model code.

## Required test environment

You need a separate Discord bot and a human owner account. No second “test bot” is required.

1. Create a test Discord application and private test guild/channel. Enable **Message Content Intent**. Invite the bot with View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, and Attach Files.
2. Put the owner's immutable user ID in `discord.superuserIds` and the private test channel ID in `discord.privateChannelIds`.
3. Create a disposable GitHub repository. As `clank`, configure Git author details, authenticate Git push and `gh`, and grant only the disposable repository access. Protect the default branch and perform work on a feature branch.
4. Authenticate Pi as `clank`; verify the configured provider/model with a harmless prompt.
5. Copy `config/clank.v2.config.example.json` to `/srv/clank/config/clank.v2.config.json`. Point the `clank` working-directory alias at `/srv/clank/app`, and use isolated state/session/temp paths.
6. Set the exact restart command to:

   ```json
   "restartCommand": "sudo /usr/bin/systemctl --no-block restart clank-v2.service"
   ```

   `--no-block` is required: a blocking restart invoked by the task would wait for the service while service shutdown waits for that task.

## Install the isolated service and narrow restart grant

Review all files before installing them:

```sh
cd /srv/clank/app
sudo -u clank -H /usr/local/bin/mise exec -- npm ci
sudo -u clank -H /usr/local/bin/mise exec -- npm run check
sudo -u clank -H /usr/local/bin/mise exec -- npm test
sudo -u clank -H /usr/local/bin/mise exec -- npm run build
sudo chmod 0755 setup/systemd/run-clank-v2
sudo install -o root -g root -m 0644 setup/systemd/clank-v2.service /etc/systemd/system/clank-v2.service
sudo install -o root -g root -m 0440 setup/systemd/clank-v2-restart.sudoers /etc/sudoers.d/clank-v2-restart
sudo visudo -cf /etc/sudoers.d/clank-v2-restart
sudo systemctl daemon-reload
sudo systemctl enable --now clank-v2.service
sudo systemctl status clank-v2.service
```

Do not run production Clank with the same bot token at the same time. Verify the grant rejects neighboring commands (do not execute a real reboot):

```sh
sudo -u clank -H sudo -n -l
sudo -u clank -H sudo -n /usr/bin/systemctl --no-block restart clank-v2.service
sudo -u clank -H sudo -n /usr/bin/systemctl --no-block restart ssh.service && echo 'UNEXPECTED' || echo 'correctly denied'
```

## End-to-end happy path

Record the Discord thread URL, task ID/session ID from `/status`, branch, commit, PR URL, service start timestamp, and relevant journal range.

1. In the configured private channel, ask Clank to inspect its checkout, create a small visible documentation-only change on a new branch, run `npm run check`, the relevant test, the full suite, and build, then commit, push, and open a PR with `gh pr create`.
2. Confirm all progress remains in the created thread. Review the diff, check output, commit author/trailer, remote branch, and PR. Confirm no SSH access or operator shell action was used after the initial setup.
3. In the same thread, ask Clank to run the configured exact restart command and then continue after restart. The Discord approval must show the exact command, task, requester, working directory, and expiration.
4. Deny the first request. Verify the command is not run and the denial is saved in `/srv/clank/state/v2-tasks.json`.
5. Ask again and approve from the configured owner account. Verify an unconfigured account cannot approve. The service should stop and start, and the thread should receive an interruption/recovery notice naming the saved Pi session.
6. Reply in that same thread with “resume and report the current branch, commit, PR URL, and completed checks.” Verify `/status` reports the original task and session ID and that Pi continues with prior context.
7. Verify startup and persisted state:

   ```sh
   sudo systemctl status clank-v2.service
   sudo journalctl -u clank-v2.service --since '<test start time>' --no-pager
   sudo -u clank -H git -C /srv/clank/app status --short --branch
   sudo -u clank -H gh pr view --web=false
   sudo -u clank -H test -s /srv/clank/state/v2-tasks.json
   sudo -u clank -H find /srv/clank/pi-sessions-v2 -type f -print
   ```

Pass only if edit, checks, test, build, commit, push, PR, owner approval, restart, recovery notice, and same-thread saved-session continuation are evidenced.

## Failure drills

Run each drill separately and retain the state file plus journal output.

- **Check failure:** introduce a deliberate lint/test failure. Clank must report it, avoid claiming success, and leave the working tree inspectable.
- **Push/PR failure:** revoke or narrow GitHub access temporarily. The thread must report the failed command; Git history and working tree must preserve the commit for retry.
- **Approval timeout/denial:** let a restart approval expire and deny another. Neither command may execute; durable approval records must show `expired`/`denied`.
- **Abrupt interruption:** while a harmless long-running task is active, run `sudo systemctl kill -s SIGKILL clank-v2.service`, then start it again. Startup must mark the formerly active task interrupted and post a recovery notice. Reply and verify session recovery. This drill tests hard failure; graceful restart is tested above.
- **Corrupt or missing state:** stop the service, back up state, replace the state file with invalid JSON, and start. Startup must fail visibly in the journal rather than silently discarding tasks. Restore state and matching sessions before continuing.
- **Unavailable saved session:** stop the service, temporarily move only that task's session directory, and start. The thread may receive the recovery notice, but replying must produce an actionable saved-session error. Restore it afterward.
- **Bad restart/deploy:** make the exact restart command unavailable or temporarily break startup configuration. Confirm systemd/journal expose the failure and the persisted task remains recoverable after restoring configuration.

## Cutover and recovery

Do not cut over until every happy-path step and failure drill passes. Archive a redacted evidence record (never tokens or session contents), restore clean repository/state snapshots, rotate temporary credentials if desired, disable the test bot, and repeat the checklist with production-specific IDs only after review.

If recovery is needed, stop the service before restoring. Restore configuration/secrets with correct ownership, then restore `/srv/clank/state` and `/srv/clank/pi-sessions-v2` from the same backup point. Run check/test/build, validate sudoers, start the service, inspect the journal, and reply in the original thread. If Discord is unavailable, use the host console to restore a reviewed commit; Discord is not the only disaster-recovery channel.
