# Production cutover and recovery

Clank intentionally rejects legacy job state. It is not safe to translate old jobs automatically: they contain mandatory clone paths, work/elevated profiles, and policy assumptions that no longer exist. Preserve the old deployment as a coherent backup and begin with canonical task state.

## Preconditions

1. Complete every step and failure drill in [the isolated smoke test](self-improvement-smoke-test.md).
2. Record the previous-good commit and retain its matching unit, configuration, secrets, state, sessions, and workspaces.
3. Ensure normal checkouts contain or have pushed all work that must survive. Uncommitted files in old managed workspaces require manual recovery.

## Backup and cut over

Stop both unit names before copying mutable data:

```sh
sudo systemctl stop clank.service clank-v2.service 2>/dev/null || true
sudo tar --xattrs --acls -C /srv/clank -czf /root/clank-pre-cutover.tgz \
  state pi-sessions pi-sessions-v2 workspaces config
sudo cp /etc/clank/clank.env /root/clank.env.pre-cutover
sudo tar -czf /root/clank-host-policy-pre-cutover.tgz \
  /etc/systemd/system/clank.service /etc/systemd/system/clank-v2.service \
  /etc/sudoers.d/clank-restart /etc/sudoers.d/clank-v2-restart \
  /etc/sudoers.d/clank-github-helper /etc/sudoers.d/clank-system-helper \
  /usr/local/lib/clank 2>/dev/null || true
sudo chmod 0600 /root/clank-pre-cutover.tgz /root/clank.env.pre-cutover \
  /root/clank-host-policy-pre-cutover.tgz
```

Also retain the previous commit's tracked setup files. Record ownership and modes, encrypt the backups, and test their archive listings. Do not publish it.

If promoting previously validated task state, with the service stopped rename `v2-tasks.json` to `tasks.json` and `pi-sessions-v2` to `pi-sessions` together. Otherwise archive those paths and start with no `tasks.json`; Clank creates empty state on first save. Never place legacy `jobs.json` at the canonical task path—startup rejects its shape.

Install the canonical config, unit, wrapper, and restart sudoers file as documented in the README. Remove obsolete host machinery:

```sh
sudo systemctl disable --now clank-v2.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/clank-v2.service \
  /etc/sudoers.d/clank-v2-restart \
  /etc/sudoers.d/clank-github-helper \
  /etc/sudoers.d/clank-system-helper
sudo rm -rf /usr/local/lib/clank/github-helper /usr/local/lib/clank/system-helper
sudo systemctl daemon-reload
```

Run `npm run check`, `npm test`, `npm run check:public`, and `npm run build`; validate sudoers and start `clank.service`. Confirm the journal, task creation, casual isolation, owner workflow, approval denial/approval, restart recovery, and backup restoration.

## Recover unfinished legacy work

Keep the service stopped while inspecting the archive. Restore an old workspace to a temporary owner-only location, inspect `git status`, and copy or commit reviewed changes into a normal configured checkout. Do not restore old workspace paths, job records, helper policy, or profiles into the new service.

## Roll back the cutover

1. Stop `clank.service` and preserve its canonical state/sessions as a separate post-cutover backup.
2. Check out the recorded previous-good commit.
3. Restore the old unit, wrapper, config, secrets, job state, Pi sessions, and workspaces from the same backup point with their original ownership and modes.
4. Build that commit, validate its unit and helper/sudoers policy, reload systemd, and start the old service.
5. Inspect the journal and verify one known legacy job. Do not combine old state with new sessions.

After fixing the cutover, repeat the full smoke test before trying again.

## Canonical disaster recovery

For the current architecture, stop the service and restore `/srv/clank/state` and `/srv/clank/pi-sessions` from one backup point, plus separately protected configuration/secrets. Build a reviewed commit, validate sudoers, start the service, inspect the journal, and continue in the original Discord thread. If Discord is unavailable, recovery remains possible from the host console.
