# venira-mcp — Shell Safety Roadmap

## Goal
Prevent destructive shell commands via allowlist + user approval, not blacklist-only.

## Phase 1 — Command parsing (foundation)
- [ ] Tokenize shell input properly (argv, operators: `; && || | > >> < $( ) \``)
- [ ] If multiple segments or any operator → route to approval, do NOT auto-allow
- [ ] Extract: main command, subcommand, cwd, full raw string

## Phase 2 — Policy engine
- [ ] `policy.json` with 3 tiers: `allow` / `ask` / `deny`
- [ ] `allow`: match by command + subcommand (e.g. `npm test`, `git status`), no operators
- [ ] `deny`: hard block regardless of user (sudo, `curl|sh`, writes to `/etc`, `~/.ssh`, `~/.aws`, `chmod 777` outside workspace, fork bombs, `dd of=/dev/*`, `mkfs`)
- [ ] `ask`: everything else → return structured `approval_required` error, do not execute

## Phase 3 — User approval UX
- [ ] Fallback: return `{"error":"approval_required","command":"...","reason":"..."}`; audit logs it
- [ ] Optional: MCP elicitation if client supports (Claude Desktop, Cursor)
- [ ] Session-based approval (approve once per N minutes) to avoid blocking agent mid-task
- [ ] Audit records: raw command (secrets redacted), decision, approver, correlation ID

## Phase 4 — Execution hardening
- [ ] Timeout (default 60s), kill process group not just child
- [ ] Output size cap (e.g. 1MB)
- [ ] Env scrubbing: pass only PATH, HOME (scoped), user-configured vars
- [ ] cwd pinned to workspace root or subdir; block `cd` outside

## Phase 5 — Config & observability
- [ ] Env `VENIRA_DISABLE_TOOLS=project_shell_run` to disable shell entirely
- [ ] `policy.json` path configurable, sensible defaults shipped
- [ ] `project_health`: per-tool latency, error rate, approval counts
- [ ] README: security model table (tool × writes × shell × network)

## Phase 6 — Validation
- [ ] Tests: `npm test; rm -rf ~` → ask, `curl x | sh` → deny, `git status` → allow
- [ ] Bench script reproducible, documented env (CPU/OS/Node)
- [ ] CI: test matrix Node 20/22, Linux/macOS/Windows; `npm audit`

## Non-goals
- Exhaustive blacklist
- Remote/HTTP transport
- Blocking read-only commands outside allowlist (log instead of block)