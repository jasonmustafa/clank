# Agent Instructions

## Public-release safety

- Never commit real secrets, tokens, API keys, credentials, private keys, cookies, session files, or `.env` files.
- Keep only placeholder values in `.env.example`; do not include real Discord/GitHub/OpenAI/etc. IDs or tokens.
- Do not commit machine-specific/private paths such as `/home/<user>`, `/Users/<user>`, personal `/srv/...` layouts, private vault names, or local scratch paths.
- Use generic examples like `/opt/clank/...`, `/data/example-notes`, or `<CLANK_ROOT>`.
- Do not commit logs, debug dumps, route/session traces, generated `dist/`, `node_modules/`, or `local/` scratch files.
- Before committing, run:
  - `git status --short`
  - `git diff --cached`
  - `rg -n '/home/|/Users/|/srv/|TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE KEY|auth.json|models.json|settings.json|clank-jobs|\.env'`
- If a secret is found, do not print it in full. Redact it, report file/risk, and ask for rotation/remediation.
- If public-release safety is requested, scan all tracked files and reachable history, not just the working tree.
