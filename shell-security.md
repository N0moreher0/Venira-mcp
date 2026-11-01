# venira-mcp — Shell Safety Roadmap

## Goal
Prevent destructive shell commands via allowlist + user approval, not blacklist-only.

## Phase 1 — Command parsing (foundation)
- [x] Tokenize shell input properly (argv, operators: `; && || | > >> < $( ) \``)
- [x] Detect multiple segments/operators and inspect Windows `\` paths conservatively
- [x] Extract main command, subcommand, cwd, full raw string

## Phase 2 — Policy engine
- [x] Explicit policy file with 3 tiers: `allow` / `ask` / `deny`
- [x] `allow`: match by command + subcommand
- [x] `deny`: hard block sudo, download-to-shell, protected files, fork bombs, device writes and irreversible container/disk actions
- [x] `ask`: network, outside-workspace reads/writes, container controls, package mutations and all `git push` operations return structured approval

## Phase 3 — User approval UX
- [x] Fallback returns `approval_required` with a pending `approval_id`; audit logs it
- [x] Optional MCP elicitation when the client supports it
- [x] Human CLI approval: `npx venira-mcp --approve <id> [--session] [--yes]`
- [x] HMAC grant binds command, shell, cwd, sorted `secret_env` and rule
- [x] Session grants default to `cd_outside_workspace`; extend only with `VENIRA_SESSION_GRANT_RULES`

## Phase 4 — Execution hardening
- [x] Timeout (default 10 minutes), kill process tree not just child
- [x] Output size cap (1 MiB per stream)
- [x] Env scrubbing: pass only allow-listed variables plus explicit configuration
- [x] cwd pinned to workspace root or subdir; `cd` outside requires approval

## Phase 5 — Config & observability
- [x] Env `VENIRA_DISABLE_TOOLS=project_shell_run` to disable shell entirely
- [x] Policy path configurable through `VENIRA_SHELL_POLICY_FILE`
- [x] `project_health`: per-tool latency, error rate, approval counts
- [x] README: security model and approval flow

## Phase 6 — Validation
- [ ] Tests: `npm test; rm -rf ~` → ask, `curl x | sh` → deny, `git status` → allow
- [ ] Bench script reproducible, documented env (CPU/OS/Node)
- [ ] CI: test matrix Node 20/22, Linux/macOS/Windows; `npm audit`

## Non-goals
- Exhaustive blacklist
- Remote/HTTP transport
- Blocking read-only commands outside allowlist (log instead of block)