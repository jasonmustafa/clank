# Root-owned GitHub helper

After the system helper has installed the pinned Node runtime, run `sudo setup/github-helper/install.sh` after `npm run build`.

The exact sudoers rule permits only the no-argument helper. The helper reads root-controlled policy from `/srv/clank/config/clank.config.json` and the token from `/etc/clank/clank.env`; credentials are passed to Git only through its process environment and are never stored in remotes, arguments, responses, or audit records. It permits configured owner/repository pairs, job workspaces, bot branches, and creates PRs directly through GitHub's REST API.
