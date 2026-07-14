# Root-owned system helper

Build as the unprivileged application user, then copy the built helper with `sudo setup/system-helper/install.sh /absolute/path/to/pinned/node`. The Node binary must be the pinned Node 24 runtime and the source path supplied to the installer must not be writable by `clank` during installation.

Installed paths:

- `/usr/local/lib/clank/system-helper` — root-owned helper entrypoint, executable only through the exact sudoers rule.
- `/usr/local/lib/clank/node/bin/node` — root-owned pinned runtime; never use `env node`, mise shims, or an app-owned runtime.
- `/etc/sudoers.d/clank-system-helper` — permits the `clank` account to invoke only the no-argument helper.
- `/srv/clank/logs/helper-audit.log` — root-written, group-readable sanitized JSONL audit log.
- `/etc/clank/clank.env` — root-owned secrets, mode `0640 root:clank`.
- `/srv/clank/config/clank.config.json` — non-secret daemon policy.

Keep `/usr/local/lib/clank` and all helper files root-owned and not group/world writable. Validate sudo policy with `visudo -cf`. The helper accepts one bounded JSON request on stdin, hardcodes `clank.service`, invokes absolute executables with argument arrays, and never runs a shell. Rotate audit logs with the included root-owned logrotate policy.
