# venira-mcp

Fast, workspace-scoped MCP server for coding agents (OpenCode, Claude Desktop, any MCP client).
Two tool modes — **Default** (32 coding tools + shell, no CI/CD) · **Expert** (42 tools: default + CI/CD). Setting `VENIRA_ALLOW_JS_EXEC=1` adds `project_execute_js` (33 / 43).
Pure Node, 1 native dependency (better-sqlite3), no GUI, no external binary.

## 1. Setup

**One-line install** (run in your project, then restart the client):

```bash
npx --yes venira-mcp@latest --install auto --workspace .
```

Prefer your agent? Paste this prompt into OpenCode/Claude/Cursor:

```text
Set up Venira MCP for this workspace.
1. Detect my MCP client config path.
2. Run: npx --yes venira-mcp@latest --install auto --workspace .
3. Restart the client. Then call project_health to verify.
```

**Manual config** (pick your client):

| Client | Config path | Format |
|---|---|---|
| VS Code | `<workspace>/.vscode/mcp.json` | JSONC |
| OpenCode | `~/.config/opencode/opencode.jsonc` | JSONC |
| Claude Desktop | `claude_desktop_config.json` | JSON |
| Cursor | `~/.cursor/mcp.json` | JSON |
| Codex | `~/.codex/config.toml` | TOML |

All use the same `npx` command. See §2 for ready-to-copy JSON/TOML.

## 2. Client configs (copy-paste)

The OpenCode block below is the full config — **only the wrapper format changes per client**.
Pick your client's shape, copy it, change `VENIRA_WORKSPACE`, and you're done.

**OpenCode / VS Code / Cursor / Claude / Kimi / DeepSeek / Antigravity / Codex** — same env vars, different wrapper:

```jsonc
// ── OpenCode (opencode.jsonc) — wrapper: "mcp" > "venira" > "environment"
{
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["npx", "--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "enabled": true,
      "environment": {
        "VENIRA_WORKSPACE": "/absolute/path/to/project",  // ← change this; Windows: "C:\\path\\to\\project"
        "VENIRA_TOOL_MODE": "expert",        // "expert" = 43 tools (all) · "default" = 33 (no PR/CI)
        "VENIRA_OUTPUT_MODE": "full",        // "full" = complete · "compact" = trim >8KB (small models)
        "VENIRA_SHELL_MODE": "permissive",   // "balanced" (default) = ask unless known-safe · "strict" = ask unless on the read-only allowlist · "permissive" = ask-rule commands run, but hard-deny commands become an approval request · "off" = NO shell checks (trusted machines only)
        "VENIRA_SHELL_ENV_PASS_ALL": "0",    // "1" = pass full env to shell (build tools that need it)
        "VENIRA_SHELL_EXIT_EARLY": "1",      // poll returns as soon as exit code is known
        "VENIRA_SHELL_TIMEOUT_POLICY": "soft", // "soft" = warn on timeout · "hard" = kill process tree
        "VENIRA_ALLOW_JS_EXEC": "1",         // "1" = register project_execute_js (default "0": tool not registered)
        "VENIRA_JS_EXEC_APPROVAL": "0",      // "1" (default) = human approval per JS call · "0" = no approval (trusted automation only)
        "VENIRA_USE_RIPGREP": "1",           // use ripgrep if installed (faster on big repos)
        "VENIRA_CACHE_ALL": "1",            // "1" = TTL caches on · "0" = always-fresh (slower)
        "VENIRA_EDIT_FUZZY": "0",           // "1" = fuzzy match fallback · "0" = exact only
        // Uncomment when needed:
        // "VENIRA_GIT_PROVIDER": "github", // auto-detect from .git/config; set only to override
        // "VENIRA_NETWORK": "0",           // "0" = kill all PR/CI calls (offline work)
        // "VENIRA_UNRESTRICTED": "0",     // "1" = disable workspace lock (NEVER in production)
        // "VENIRA_TRACE": "0",            // "1" = log every tool call to stderr (debug only)
      }
    }
  }
}

// ── VS Code (.vscode/mcp.json) — wrapper: "servers" > "venira" > "env"
// ${workspaceFolder} auto-expands; everything else identical to OpenCode.
{
  "servers": {
    "venira": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "${workspaceFolder}",
        "VENIRA_TOOL_MODE": "expert",
        "VENIRA_OUTPUT_MODE": "full",
        "VENIRA_SHELL_MODE": "permissive",
        "VENIRA_SHELL_EXIT_EARLY": "1",
        "VENIRA_ALLOW_JS_EXEC": "1",
        "VENIRA_JS_EXEC_APPROVAL": "0",
        "VENIRA_USE_RIPGREP": "1",
        "VENIRA_CACHE_ALL": "1"
      }
    }
  }
}

// ── Claude / Cursor / Kimi / DeepSeek / Antigravity — wrapper: "mcpServers" > "venira" > "env"
// Same env vars as VS Code, just a different top-level key and absolute path.
{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "/absolute/path/to/project",
        "VENIRA_TOOL_MODE": "expert",
        "VENIRA_OUTPUT_MODE": "full",
        "VENIRA_SHELL_MODE": "permissive",
        "VENIRA_SHELL_EXIT_EARLY": "1",
        "VENIRA_ALLOW_JS_EXEC": "1",
        "VENIRA_JS_EXEC_APPROVAL": "0",
        "VENIRA_USE_RIPGREP": "1",
        "VENIRA_CACHE_ALL": "1"
      }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`) — TOML, same values:

```toml
[mcp_servers.venira]
command = "npx"
args = ["--yes", "--package=venira-mcp@latest", "venira-mcp"]

[mcp_servers.venira.env]
VENIRA_WORKSPACE = "C:\\path\\to\\project"
VENIRA_TOOL_MODE = "expert"
VENIRA_OUTPUT_MODE = "full"
VENIRA_SHELL_MODE = "permissive"
VENIRA_SHELL_EXIT_EARLY = "1"
VENIRA_ALLOW_JS_EXEC = "1"
VENIRA_JS_EXEC_APPROVAL = "0"
VENIRA_USE_RIPGREP = "1"
VENIRA_CACHE_ALL = "1"
```

> ⚠️ **About the sample values above.** `VENIRA_SHELL_MODE=permissive` lets ask-rule commands run without a prompt (hard-deny commands such as `sudo` still need your approval); `VENIRA_SHELL_MODE=off` would disable the shell policy completely. `VENIRA_JS_EXEC_APPROVAL=0` removes the per-call approval for `project_execute_js`. That is fine on a trusted single-user machine; for a shared or untrusted workspace use `balanced` (the default) and leave `VENIRA_JS_EXEC_APPROVAL` unset. §7 explains how approvals work.

> **Quick reference — what to change vs what to leave alone:**
>
> | Variable | Change when | Default |
> |---|---|---|
> | `VENIRA_WORKSPACE` | **Always** — absolute project path | — |
> | `VENIRA_TOOL_MODE` | No PR/CI needed | `default` |
> | `VENIRA_SHELL_MODE` | Want more prompts (`strict`), fewer prompts (`permissive`), or none at all (`off` = shell checks fully off) | `balanced` |
> | `VENIRA_ALLOW_JS_EXEC` | Need `project_execute_js` | `0` |
> | `VENIRA_JS_EXEC_APPROVAL` | Trusted automation only (`0` skips the per-call approval) | `1` |
> | `VENIRA_NETWORK` | Offline repo | `1` |
> | `VENIRA_UNRESTRICTED` | **Never in production** | `0` |
## 3. Benchmark (per-op, p50)

Measured: Windows + Node 24, standalone build, 2026-11-01.

| Op | p50 | Notes |
|---|---|---|
| Cached `read_file` | 8.0 ms | warm cache |
| `read_batch` (8 files) | 12.8 ms | one call, 8 items |
| `get_file_info` | 6.2 ms | cached |
| `search` (literal, `*.ts`) | 11.5 ms | p95 ≈ 1.3 s (file count dependent) |
| `health` (no DB) | 28.5 ms | |
| `shell_run` + status | ~930 ms | 2 s wait budget dominates |
| **First call** | **113.7 ms** | post warm-up |

> Batch: 8 reads as one batch call (16.6 ms) vs 8× individual (~76 ms) — the round-trip saving
> that makes the agent loop fast.

### Case study: Venira MCP vs Codex `exec_command`

Measured on Windows in the Codex desktop workspace on 2026-11-06. Each case ran five
sequential rounds. Venira's relevant cache was cleared before each round. The native
comparison used Codex `exec_command`, starting a fresh PowerShell or ripgrep process for
each round; timings therefore include process startup and tool-call overhead.

| Workload | Venira MCP | Codex `exec_command` | Median ratio |
|---|---:|---:|---:|
| Read the first 80 lines of 8 files in one batch | median 276 ms (159–3,148 ms) | median 5,430 ms (2,881–6,098 ms) | 19.7× |
| Literal search for `VENIRA_WORKSPACE` | median 225 ms (168–293 ms) | median 2,098 ms (1,649–2,641 ms) | 9.3× |

Both search methods reported 45 matching lines. The batch read returned roughly 33.5k
characters through Venira and 29.0k through PowerShell; response formatting differs, so
these are end-to-end tool comparisons rather than isolated filesystem benchmarks. The
five-round sample is small and includes one 3.1 s Venira outlier; results should not be
read as a general performance guarantee. The earlier 8.3× single-file result is omitted
here because this larger case study focuses on batch reads and workspace search.

## 4. Two tool modes

Two tool modes set which tools the client sees. Set via `VENIRA_TOOL_MODE` env var or
`"toolMode"` in `venira.config.json` (env wins). `VENIRA_PROFILE=core|full` still applies on top.

| Mode | Tools | Includes |
|---|---|---|
| `default` | **32** (33 with `VENIRA_ALLOW_JS_EXEC=1`) | Read/write/edit/search, code intel, snapshots, shell, `project_delete_path`, optional JS exec — **no** CI/CD |
| `expert` | **42** (43 with `VENIRA_ALLOW_JS_EXEC=1`) | Everything in default + `project_pr_*`, `project_ci_*` |

`project_delete_path` is always available. In `balanced` / `strict` mode, shell `rm -rf /` / `~` and Windows drive-wide deletes are hard-denied, and recursive/force deletes (`Remove-Item -Recurse -Force`, `rd /s /q`, `del /f /q`) need approval. `permissive` mode applies no shell checks at all.

## 5. Tools quick reference

All tools return the standard envelope (`ok`, `kind`, `data`, `hint`, `elapsed_ms`).

**Read (batch-safe, cached)**

| Tool | Purpose |
|---|---|
| `project_list_files` | List files/dirs, depth 1–3, limit ≤ 200 |
| `project_read_file` | Read a file by line range; optional `ranges[]` (up to 16) |
| `project_get_file_info` | File/dir metadata (kind, size, mtime) |
| `project_search` | Search by file/dir name, content, regex, or symbol; `hybrid: 1` tags hits with `source`+`confidence` |
| `project_recent_files` | Recently modified files (index-first, scan-fallback) |
| `project_read_batch` | Up to 8 read-only ops in one call |
| `project_health` | Diagnostics: capability, queue, cache hit-rates, p50/p95 |
| `project_read_audit` | Read recent audit log rows |

**Write (mutating, pass `reason`)**

| Tool | Purpose |
|---|---|
| `project_write_file` | Create/overwrite/append; `expected_sha256` guards blind overwrites |
| `project_edit_file` | Replace `old_text`→`new_text`; `edits[]` (up to 64); fuzzy edit opt-in |
| `project_edit_batch` | Multiple edits atomically; stops at first failure |
| `project_create` | Create file or directory |
| `project_delete_path` | Delete file/dir; **not undoable** |

**Checkpoints (git-free rollback)**

`project_snapshot` — `create`/`list`/`restore`/`delete`. Content-addressed, deduplicated, atomic per-file restore.

**Code intelligence**

| Tool | Purpose |
|---|---|
| `project_outline_symbol` | Parse a file's symbols (functions, classes, types) with line numbers |
| `project_diff_files` | Unified diff between two files |
| `project_symbol_references` | Find all occurrences of a named symbol |
| `project_selective_search` | Multi-query search with AND/NOT + fuzzy scoring |
| `project_dependency_graph` | TS/JS/Python/Rust/Go/Java/Kotlin import/symbol graph (JSON/DOT/Mermaid) |
| `project_change_impact` | "What breaks if I edit this?" — bounded reverse/forward closure |

**Shell (async, policy-gated)**

| Tool | Purpose |
|---|---|
| `project_shell_run` | Run a command; `background: 0` blocks for final output; `1` returns `run_id` |
| `project_shell_status` | Poll a running command (not queued, not audit-logged) |
| `project_shell_cancel` | Kill a running command by `run_id` |
| `project_shell_cancel_session` | Kill all shell runs in this session |

**Git provider: PR/CI (GitHub, GitLab, Bitbucket)**

`project_pr_create/comment/merge/list/close/reopen`, `project_ci_status/trigger/logs/wait` — same tool args across providers; token from `project_secret` or env vars.

**Secrets (encrypted at rest)**

`project_secret` — store/inspect/remove credentials by name; AES-256-GCM; rotation metadata; expired secrets refused.
`project_github_connect` — GitHub Device Flow, tokens in vault.

**Diagnostics & planning**

`project_explain_error` — turn an error into a cause + next tool calls (rule table, no model).
`project_plan_read_batch` — plan which files to read for a task, returns ready `project_read_batch` call.

**JS execution**

`project_execute_js` — run synchronous JS (opt-in, `VENIRA_ALLOW_JS_EXEC=1`); per-call human approval by default.

## 6. Environment variables (key ones)

Full reference: ~60 `VENIRA_*` flags — see the env table in the source or `npx venira-mcp --help`.

| Variable | Default | What it does |
|---|---|---|
| `VENIRA_WORKSPACE` | `process.cwd()` | Workspace root; all paths resolve against it |
| `VENIRA_TOOL_MODE` | `default` | `default` (32 tools) or `expert` (42 tools); +1 with `VENIRA_ALLOW_JS_EXEC=1` |
| `VENIRA_OUTPUT_MODE` | `full` | `full` or `compact` (trim payloads > 8 KB) |
| `VENIRA_PROFILE` | `full` | `full` or `core` (disables dependency graph / change impact) |
| `VENIRA_UNRESTRICTED` | `"0"` | `"1"` disables workspace lock (never in production) |
| `VENIRA_SHELL_MODE` | `balanced` | Shell policy: `balanced` asks unless known-safe · `strict` asks unless on the read-only allowlist · `permissive` runs ask-rule commands and unclassified commands without a prompt; hard-deny commands become an approval request · `off` disables all checks |
| `VENIRA_SHELL_EXIT_EARLY` | `"1"` | `"1"` pollers return as soon as exit code is known |
| `VENIRA_SHELL_TIMEOUT_POLICY` | `"soft"` | `"soft"` warns on timeout · `"hard"` kills process tree |
| `VENIRA_SHELL_ENV_PASS_ALL` | `"0"` | `"1"` passes full host env to shell (build tools that need it) |
| `VENIRA_ALLOW_JS_EXEC` | `"0"` | `"1"` registers `project_execute_js` |
| `VENIRA_JS_EXEC_APPROVAL` | `"1"` | `"1"` human approval per JS call · `"0"` no approval (trusted automation only) |
| `VENIRA_USE_RIPGREP` | `"1"` | `"1"` uses ripgrep if installed (faster on big repos) |
| `VENIRA_CACHE_ALL` | `"1"` | `"1"` TTL caches on · `"0"` always-fresh (slower) |
| `VENIRA_EDIT_FUZZY` | `"0"` | `"1"` enables fuzzy-match fallback for `old_text` |
| `VENIRA_NETWORK` | `"1"` | `"0"` = hard kill switch for all provider calls |
| `VENIRA_DATA_DIR` | per-user OS path | Where audit DB + encrypted secrets live |
| `VENIRA_DISABLE_TOOLS` | unset | Comma-separated tool names to hide from `tools/list` |
| `VENIRA_GIT_PROVIDER` | inferred | `github` / `gitlab` / `bitbucket` |
| `VENIRA_GIT_TOKEN` | unset | Fallback token when no provider-specific secret found |
| `VENIRA_SECRET_ALLOW_REVEAL` | `"0"` | `"1"` allows `reveal=1` to print secret plaintext |
| `VENIRA_SHELL_OVERRIDES` | unset | Operator allowlist: `ALLOW_GIT_PUSH`, `ALLOW_ENV_READ` |
| `VENIRA_TRACE` | `"0"` | `"1"` logs every tool call to stderr (debug only) |
| `VENIRA_PERMISSION_MODE` | `allow_all` | Permission mode passed when the session scope opens (`manual` / `best_effort` / `allow_all`); shown in `project_health` |
| `VENIRA_SESSION_ID` | auto | Set for test/verify runs to separate audit rows |
| `VENIRA_SHELL_ELICIT` | `"0"` | `"1"` asks the person through an MCP confirmation dialog (client must support elicitation) |
| `VENIRA_SESSION_GRANT_RULES` | built-in: `cd_outside_workspace` | Extra ask-rule ids (comma-separated) that may be approved with `--approve --session` |
| `VENIRA_ALLOW_SELF_INSTALL` | `"0"` | `"1"` lets `project_install_self` write other clients' config files |
| `VENIRA_SHELL_POLICY_FILE` | unset | Path to a JSON shell policy file (allow/ask/deny rules); never read from the workspace automatically |
| `VENIRA_TOOL_POLICY_JSON` / `VENIRA_TOOL_POLICY_FILE` | unset | Per-tool policy rules, inline JSON or a file (see `lib/tool-policy.ts`) |

## 7. Security model

**Conservative by default:**
- **Workspace lock**: all paths validated inside `VENIRA_WORKSPACE`; `../` escape rejected (`path_escape`).
- **Shell policy** (`VENIRA_SHELL_MODE`): every `project_shell_run` command is classified `allow`, `ask` or `deny`.
  - `balanced` (default): hard-deny rules refuse the command; ask rules need approval; routine dev-workspace commands run; anything unclassified needs approval.
  - `strict`: like `balanced`, but only a read-only / workspace-local allowlist runs without approval.
  - `permissive`: ask rules and unclassified commands run without a prompt, but a hard-deny match is **not** silently allowed — it becomes an approval request (`ask.deny.<rule>`). Good default for a trusted single-user machine.
  - `off`: **the shell policy is disabled** — every command runs, nothing is asked or denied (only `secret_env` injection still asks). Prints a startup warning; use only in a trusted environment. Previous `permissive` behaviour (v1.14.4) = `off`.
  - Hard-deny (12 rules): disk destroy, filesystem mount/overwrite, shutdown/reboot, fork bomb, pipe download to shell, privilege escalation (sudo/doas/runas), `rm -rf` of `/` or `~`, `chmod 777 /`, Windows drive-wide and wildcard mass delete, self-approval (touching the approve CLI or approval store), protected credential/key files.
  - Ask (21 rules): command substitution, reads/writes/`cd` outside the workspace, network access, package mutation, git history rewrite, container/VM control and state, process control and `taskkill /f`, secret dumps, dynamic execution and wrapper commands, `find -delete/-exec`, destructive recursive/force deletes (`Remove-Item -Recurse -Force`, `rd /s /q`, `del /f /q`; prefer `project_delete_path`), PowerShell `-EncodedCommand`, attribute reset, infinite writes to NUL, unresolved file arguments.
  - Deny always wins over ask.
- **Secrets**: AES-256-GCM encrypted at rest; values never in tool metadata; `secret_env` requires human approval; expired secrets refused.
- **Provider DLP**: Secretlint scans PR/CI request args and HTTP payloads; detected credentials blocked before sending, withheld from response.
- **Audit trail**: all ops (including failures) written to SQLite WAL; `project_read_audit` for post-mortems.
- **Token transport**: provider token in `Authorization` header only; dropped on cross-origin redirect.

**Approvals — what needs a human, and how it is granted**

| Gate | Triggers when | Switch (default) |
|---|---|---|
| Shell `deny` | A hard-deny rule matches: refused outright, no approval possible | — (hard-deny becomes an approval request in `permissive`; not applied in `off`) |
| Shell `ask` | An ask rule matches, or the command is unclassified in `balanced` / `strict` | `VENIRA_SHELL_MODE` (`balanced`) |
| Secret injection | `project_shell_run` with `secret_env` | always asks, in every mode |
| `project_execute_js` | Every call | `VENIRA_ALLOW_JS_EXEC` (`0`: tool not registered) · `VENIRA_JS_EXEC_APPROVAL` (`1`) |
| Secret plaintext | `project_secret` with `reveal=1` | `VENIRA_SECRET_ALLOW_REVEAL` (`0`) |
| Self-install | `project_install_self` writes another client's config | `VENIRA_ALLOW_SELF_INSTALL` (`0`) |
| Named shell override | `ALLOW_GIT_PUSH` / `ALLOW_ENV_READ` | `VENIRA_SHELL_OVERRIDES` (unset), plus `override` and a `reason` on the call |

Granting a shell or JS approval:

1. The call fails with `[approval_required]` and returns `data.approval_id` (valid for 5 minutes) together with the command or code, the rule and the reason.
2. A person runs `npx venira-mcp --approve <approval_id>` in an interactive terminal (it refuses without a TTY), reviews the request and answers `y`. `--yes` skips the prompt. `--session` extends the grant to the same command group until it expires, but only for rules in `VENIRA_SESSION_GRANT_RULES` (built-in: `cd_outside_workspace`).
3. The agent retries the same call with `approval_id`. The grant is HMAC-signed, tied to the session, bound to the exact command / shell / cwd / `secret_env` / rule (or code / argv for JS), and single-use.

Alternative (off by default, `project_shell_run` only): `VENIRA_SHELL_ELICIT=1` shows a confirmation dialog in MCP clients that support elicitation, and accepting it records the grant for you.

Removed in v1.15: `approval_token` and `VENIRA_SHELL_AUTO_APPROVE_TOKEN`. Passing `approval_token` now returns `[approval_invalid]` with a hint to use `approval_id`; setting the env var only logs a warning and is ignored.

Approvals are a guard rail, not a sandbox: a process running as the same OS user can read the approval key.

**Threats this does NOT protect against**: a malicious prompt can still instruct the agent to run destructive commands. Use a container/VM for untrusted workspaces.

## 8. Envelopes & error codes

Success:

```jsonc
{ "ok": true, "status": "completed", "kind": "file_read", "data": { … }, "hint": "Next chunk: …", "elapsed_ms": 2.57 }
```

Failure:

```jsonc
{ "ok": false, "error": { "code": "not_found", "message": "…", "retryable": false }, "hint": "Check with project_list_files first" }
```

Common codes: `not_found`, `invalid_request`, `old_text_not_found`, `old_text_ambiguous`, `stale_content`, `path_escape`, `resource_limit`, `sensitive_result`, `unsupported`, `internal`.

## 9. Agent instructions (paste into `AGENTS.md` / `CLAUDE.md`)

```text
Venira MCP rules:
1. Unfamiliar task: call project_plan_read_batch first, then run steps[0].
2. Read with project_read_batch (up to 8 items). Never re-read a file a tool already returned.
3. Prefer project_edit_file / project_edit_batch over project_write_file; pass `reason` on every mutation.
4. Snapshot before multi-file or destructive changes.
5. Short commands: project_shell_run with background: 0. Long jobs: background: 1, then poll project_shell_status.
6. Do not call project_execute_js unless the user asked for JS; it needs per-call approval.
7. On failure, follow the envelope's hint. Treat ok:false + retryable:false as final.
8. Report only what the tool returned.
```

## 10. Development

```bash
npm run build       # tsc → dist/
npm run smoke       # in-process sanity check
npm run doctor      # 13 preflight checks
npm run verify      # 423 behavioural + security checks
npm run bench:mcp   # end-to-end numbers
```

**Adding a tool**:
1. Register in `tools/project.ts` → `registerProjectTools`, use the `config()` helper.
2. Read-only: route through `executeCached`; mutations: add to `MUTATING` set.
3. Envelope: use `buildEnvelope` / `errorEnvelope` from `lib/output.ts`.
4. Add a check in `scripts/verify.ts`; update the decision tree in `server.ts` INSTRUCTIONS.
5. `npm run build && npm run verify && npm run bench:mcp` — paste numbers in the PR.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `not_found` on a path that looks fine | Run `npm run doctor`; confirm `VENIRA_WORKSPACE` points where you think |
| `path_escape` | Path resolves outside workspace; use a workspace-relative path |
| Shell command not finishing | `project_shell_status` with `wait_seconds: 30`; check `project_health` → `shells.active` |
| `better-sqlite3` build failure | Unusual platform; run `npm rebuild better-sqlite3` with build tools, or use the Docker image |
| `venira.db` won't open | Another process has the WAL locked; make sure only one server writes to the same data dir |
| Everything slow | `project_health` → `queue.depth` and per-op p95 |

## 12. Changelog (latest)

**v1.14.0** (2026-11-05) — Rust support in dependency graph; per-mode tools; TOCTOU guard;
search relevance ranking; tool consolidation (`project_read_ranges`→`project_read_file`,
`project_create_directory`→`project_create`, `project_file_symbols`→`project_outline_symbol`,
`project_safe_edit`→`project_edit_file`); `project_delete_path` in both modes; shell hard-deny
for `rm -rf`/`rd /s`/`Remove-Item -Recurse -Force`.

**v1.12.2** (2026-11-03) — Code Mode rules for OpenCode `execute` tool.

**v1.12.0** (2026-11-02) — Per-call human approval for `project_execute_js`.

**v1.11.0** (2026-11-02) — Pentest hardening: protected file guard, `isProtectedPath` NTFS fix,
`ask.unresolved_file_argument` shell rule, `project_delete_path` root guard, JS exec redaction + network block.

**v1.9.0** (2026-11-02) — `project_dependency_graph` + `project_change_impact` + `project_ci_wait`.

Full history: see `git log` in the repo.

## License

Dual-licensed **MIT OR Apache-2.0** — [`LICENSE-MIT`](./LICENSE-MIT) · [`LICENSE-APACHE`](./LICENSE-APACHE)
