# Clank

Clank is a private Discord-to-Pi assistant daemon. It is designed for one trusted operator on Debian 13 and uses defense-in-depth controls around an unprivileged daemon and narrow root-owned helpers.

## v2 superuser path

The first v2 path is developed alongside the production implementation. It accepts messages only from configured immutable Discord user IDs in DMs or configured private channels, starts an ordinary full-capability Pi session in the configured default working directory, and replies through Discord. Pi has its standard `read`, `write`, `edit`, and `bash` tools and the Clank Unix account's normal settings and resources; no v1 workspace, path, command, or GitHub bridge policy is installed.

Copy `config/clank.v2.config.example.json` outside the repository, replace every placeholder, set `CLANK_DISCORD_TOKEN` and `CLANK_V2_CONFIG_PATH`, then run `npm run dev:v2` (or build and run `npm run start:v2`). Use a separate development Discord application while v2 is being validated.

> **Security boundary:** Clank is not a hard sandbox. Pi can run code and shell commands as `clank`, and a model or dependency compromise can access anything that account can access. Path checks, confirmations, separate job clones, environment filtering, sudo allowlists, and protected ownership reduce risk; they do not provide container or VM isolation. Use a dedicated VPS/account, grant only necessary access, review privileged requests, and do not host unrelated sensitive data under the `clank` account.

## Discord application

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and bot. Keep the bot token secret.
2. On **Bot**, enable the privileged **Message Content Intent**. Clank needs it for work-channel messages, threads, and mentions. The normal Guilds and Guild Messages gateway intents are also used by the daemon.
3. Under OAuth2 URL Generator, select `bot` and `applications.commands`. Grant only the channel permissions Clank needs: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, and Attach Files.
4. Invite the bot to the target guild. Use a separate application and test guild for development.
5. Enable Discord Developer Mode and copy IDs. Fill `discord.applicationId`, `guildId`, owner/work/approver user or role IDs, work/elevated channel IDs, and casual guild/channel policy in `config/clank.config.example.json`.
6. Put `CLANK_DISCORD_TOKEN` in the secret environment file, then register the guild-scoped `/clank` command:

   ```sh
   sudo -u clank -H sh -lc 'cd /srv/clank/app && /usr/local/bin/mise exec -- npm run register-commands'
   ```

Guild commands update quickly and avoid publishing a global command. Re-run registration after command schema changes.

## Debian 13 VPS setup

Install `git`, `sudo`, `ca-certificates`, and `curl`, then install [mise](https://mise.jdx.dev/) as `/usr/local/bin/mise` (root-owned and not writable by `clank`). The repository's `mise.toml` pins Node.

Create the service account and layout:

```sh
sudo useradd --system --create-home --home-dir /srv/clank --shell /bin/bash clank
sudo install -d -o clank -g clank -m 0750 \
  /srv/clank/app /srv/clank/config /srv/clank/state \
  /srv/clank/workspaces/jobs /srv/clank/pi-sessions /srv/clank/tmp \
  /srv/clank/resources
sudo install -d -o root -g clank -m 0750 /srv/clank/logs /etc/clank
sudo install -d -o root -g clank -m 0770 /srv/clank/pi-agent
```

Suggested layout:

- `/srv/clank/app`: deploy checkout, owned by `clank` so the deploy workflow can fetch/reset/build it.
- `/srv/clank/config/clank.config.json`: non-secret runtime policy (`0640 clank:clank`). Start from `config/clank.config.example.json`; use absolute `/srv/clank/...` paths.
- `/srv/clank/state`, `workspaces/jobs`, `pi-sessions`, `tmp`: daemon-owned mutable data.
- `/srv/clank/pi-agent`: trusted, operator-maintained Pi resources; do not let jobs modify it. The `clank` group needs directory write access because Pi's OAuth storage creates a sibling lock while refreshing `auth.json`; keep membership limited to the daemon account.
- `/srv/clank/resources`: checkouts of explicitly trusted resource repositories configured by URL, ref, and resource globs. Review changes—especially extensions—before approval.
- `/etc/clank/clank.env`: root-owned secrets (`0640 root:clank`).
- `/usr/local/lib/clank`: root-owned helpers and their dedicated Node runtime.
- `/srv/clank/logs/helper-audit.log`: root-written, `clank`-readable sanitized JSONL audit trail.

Clone/copy the repository to `/srv/clank/app`, then:

```sh
sudo chown -R clank:clank /srv/clank/app
sudo -u clank -H sh -lc 'cd /srv/clank/app && /usr/local/bin/mise install && /usr/local/bin/mise exec -- npm ci && /usr/local/bin/mise exec -- npm run check && /usr/local/bin/mise exec -- npm test && /usr/local/bin/mise exec -- npm run build'
sudo install -o clank -g clank -m 0640 config/clank.config.example.json /srv/clank/config/clank.config.json
sudo install -o root -g clank -m 0640 /dev/null /etc/clank/clank.env
sudoedit /etc/clank/clank.env
```

Replace every JSON placeholder and add `CLANK_DISCORD_TOKEN=...` to the environment file; add `CLANK_GITHUB_TOKEN=...` only when the GitHub helper is used. The systemd unit sets the non-secret production config path, so do not duplicate `CLANK_CONFIG_PATH` in this file. Never place secrets in the JSON policy.

Deployment-specific values are configuration, never source constants. This includes the Git identity (`commitAuthorName` and `commitAuthorEmail`), trusted resource repository URLs and refs, the generated-by commit footer, and helper secret/environment paths. Keep placeholder-only examples in Git and set real values in the deployment's ignored config or root-owned environment file.

### Superuser v2 project and GitHub setup

The v2 policy configures named working directories. `defaultWorkingDirectoryAlias` is used for an ordinary task; start a task elsewhere with `/in <alias> <task>`. Only aliases in `pi.workingDirectories` are accepted, and the resolved absolute path is saved with the task and shown by `/status`.

V2 deliberately uses Pi's normal SDK resource loading. Configure settings, authentication, models, skills, extensions, prompt templates, and global context in `/srv/clank/.pi/agent`, and project resources in each checkout as for an interactive Pi installation. Review and trust projects while logged in as `clank`; Clank does not copy resources into a trusted staging area or implicitly trust a checkout.

Configure ordinary Git, SSH, and GitHub CLI credentials as the service account. Commit identity and disclosure are deployment choices, not push policy:

```sh
sudo -u clank -H git config --global user.name '<deployment commit author>'
sudo -u clank -H git config --global user.email '<deployment author email>'
sudo -u clank -H ssh -T git@github.com                 # verify the deployed SSH key/agent
sudo -u clank -H gh auth login                          # or provide standard gh authentication
```

Put the deployment's required generated-by trailer (for example, `Generated-by: Clank`) in the ordinary global `AGENTS.md` instructions. No Clank Git/GitHub bridge, command filter, commit hook, or push-policy helper is used by superuser sessions. Verify the deployment in a dedicated test repository by asking a v2 task to edit and check a branch, commit with the configured trailer, push, run `gh issue create`, and run `gh pr create`; never use the production repository for the first smoke test. The normal unit suite performs this workflow against a local bare Git remote and a fake `gh`, so it makes no live GitHub or SSH calls.

### Discord command approval

V2 can pause destructive Bash calls and post the exact command, task, requester, working directory, and expiration in the owning Discord thread. Only configured superuser IDs can use the **Approve** and **Deny** buttons. Decisions are task- and command-bound, expire, and are consumed once; restart, interruption, denial, or timeout leaves the command unexecuted.

The `approvals` policy separates three deployment choices:

- `destructiveConfirmation` gates recognized ordinary destructive commands.
- `restartCommand` permits one exact, approval-gated narrow service restart command (normally backed by a narrowly scoped root-owned sudoers/helper rule).
- `privilegedExecution` is `disabled` by default. Setting it to `approval-required` gates general `sudo` commands but grants the Clank account effectively root-equivalent capability if passwordless sudo is also configured.

> **Approval is a mistake-mitigation control, not a security sandbox.** It can stop an accidental model tool call, but cannot protect against compromised Clank code, a compromised model/dependency, or an account with general passwordless sudo. A compromised daemon can bypass its own confirmation UI. Prefer the exact restart capability, keep general privileged execution disabled, and treat any unrestricted passwordless sudo deployment as root-equivalent.

### Pi OpenAI subscription authentication

Authenticate interactively as the service account so credentials are stored under its home, not root's or an administrator's:

```sh
sudo -u clank -H sh -lc 'cd /srv/clank/app && /usr/local/bin/mise exec -- ./node_modules/.bin/pi'
```

In Pi, run `/login`, select OpenAI, and complete the subscription sign-in flow. Exit and verify a model can be listed or a harmless prompt can run as `clank`. Keep the resulting Pi auth files beneath `/srv/clank` mode `0600`, owned by `clank`; never copy them into the app checkout, config JSON, logs, or backups intended for sharing. Re-run this process to recover from expired/revoked credentials. API-key auth may instead be supplied through `/etc/clank/clank.env`, but do not configure both accidentally.

### Root-owned helpers

Build first. The helper runtime and all helper inputs must be root-owned before installation; never install directly from the daemon's writable mise tree or app checkout. Install the pinned Node release into a root-owned mise data directory and stage the built artifacts:

```sh
sudo env MISE_DATA_DIR=/opt/clank-mise /usr/local/bin/mise install node@24.18.0
NODE_BIN=$(sudo env MISE_DATA_DIR=/opt/clank-mise /usr/local/bin/mise where node@24.18.0)/bin/node
sudo rm -rf /root/clank-helper-stage
sudo install -d -o root -g root -m 0700 /root/clank-helper-stage/dist/helpers
sudo cp -a /srv/clank/app/setup /root/clank-helper-stage/
sudo cp /srv/clank/app/dist/helpers/{system-helper-entrypoint.js,system-helper.js,system-protocol.js,github-helper-entrypoint.js,github-helper.js,github-protocol.js} /root/clank-helper-stage/dist/helpers/
sudo chown -R root:root /root/clank-helper-stage
cd /root/clank-helper-stage
sudo setup/system-helper/install.sh "$NODE_BIN"
sudo setup/github-helper/install.sh   # only if GitHub operations are configured
sudo rm -rf /root/clank-helper-stage
```

Review staged code/checksums before installation. The installers copy code to `/usr/local/lib/clank`, copy Node to `/usr/local/lib/clank/node/bin/node`, install exact no-argument sudoers rules, validate them with `visudo`, and install audit-log rotation. After every helper code or Node update, repeat root-owned staging/review/reinstallation and verify (the `find` test must produce no output):

```sh
sudo sh -c 'bad=$(find /usr/local/lib/clank \( ! -user root -o -perm /022 \) -print); test -z "$bad" || { printf "%s\n" "$bad"; exit 1; }'
sudo visudo -cf /etc/sudoers.d/clank-system-helper
sudo visudo -cf /etc/sudoers.d/clank-github-helper
sudo tail -n 20 /srv/clank/logs/helper-audit.log
```

There is no general sudo grant. Helpers accept bounded JSON on stdin and use absolute executables without a shell. See [`setup/system-helper/README.md`](setup/system-helper/README.md) and [`setup/github-helper/README.md`](setup/github-helper/README.md).

### systemd

The example unit runs exactly `/srv/clank/app` through `setup/systemd/run-clank`, which invokes the pinned runtime through `/usr/local/bin/mise`. Ensure the wrapper is executable, then install and start it:

```sh
chmod 0755 /srv/clank/app/setup/systemd/run-clank
sudo install -o root -g root -m 0644 setup/systemd/clank.service /etc/systemd/system/clank.service
sudo systemctl daemon-reload
sudo systemctl enable --now clank.service
sudo systemctl status clank.service
sudo journalctl -u clank.service -n 100 --no-pager
```

The unit deliberately leaves `/srv/clank/app` writable because owner-approved deploy/rollback modifies it. `ProtectSystem` is defense-in-depth, not protection against all data accessible to `clank`.

### Recovery

1. Inspect `systemctl status clank` and `journalctl -u clank`; inspect the helper audit log separately.
2. Validate `/etc/clank/clank.env`, the JSON policy, ownership, free disk space, network/DNS, Discord token, and Pi auth as `clank`.
3. From `/srv/clank/app`, run `mise install`, `npm ci`, `npm run check`, `npm test`, and `npm run build` via `mise exec`.
4. Use owner-only `/clank rollback` for a recorded previous-good commit, or manually check out a reviewed commit and rebuild if Discord is unavailable.
5. Re-register commands if interaction schemas or application/guild IDs changed, then restart. Running jobs are marked interrupted after restart and can resume from saved metadata/session state.

## Local development

Use a separate development bot application, token, and guild—never the production bot or production guild. Copy `.env.example` to ignored `.env.local`, copy the config example to ignored `config/clank.config.local.json`, and set every runtime path under the ignored `.clank-dev/` tree (state, workspaces, sessions, temporary files, and resources). Set `CLANK_CONFIG_PATH` to that local JSON.

```sh
mise install
mise exec -- npm ci
mkdir -p .clank-dev/{state,workspaces,sessions,tmp,resources}
mise exec -- npm run register-commands
mise exec -- npm run dev
```

The current daemon work-job path uses `FakeRunner`, making it suitable for routing/UI development without live work-job model calls. Keep privileged and GitHub helpers disabled or replace their clients with mocks; do not add local passwordless sudo and do not point development config at `/etc/clank`, `/srv/clank`, production repositories, or production tokens. Casual mode uses the SDK and may make live model calls, so disable casual guilds in local config when an entirely fake run is required.

## Before making the repository public

Never commit Discord/GitHub tokens, API keys, Pi auth, `.env*` other than `.env.example`, real user/guild/channel/application IDs, private repository URLs, private prompts/resources, SSH keys, runtime config, state, sessions, workspaces, attachments, logs, database/dump files, or generated output. Placeholders can still reveal identities; review them manually.

Pre-publication checklist:

- [ ] Run `npm run check:public`, then confirm `git status --ignored` and `git ls-files` contain only intended source/examples.
- [ ] Search the working tree with a secret scanner such as `gitleaks detect --no-git` or `trufflehog filesystem .`.
- [ ] Scan and inspect full Git history (`gitleaks git .`, `git log --all --stat`, or equivalents), not only the current checkout.
- [ ] Verify no runtime state, sessions, workspaces, attachments, logs, databases, dumps, or generated output are tracked.
- [ ] Review `.scratch/` manually and verify it contains no secrets or identifying deployment values before publishing.
- [ ] Review branches, tags, stashes, reflogs, removed files, patches, issue exports, and CI artifacts for secrets and identifying IDs.
- [ ] Review example config, tests, snapshots, docs, remote URLs, commit messages/authors, and generated `dist`/coverage files.
- [ ] If anything sensitive was ever committed, revoke/rotate it first, rewrite all affected history, force-update every ref, remove hosted caches/artifacts, and have every clone re-clone. Deleting the current file is insufficient.
- [ ] Run tests and the scanner again from a fresh clone before publishing.
