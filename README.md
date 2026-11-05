# venira-mcp

Fast, workspace-scoped MCP server for coding agents (OpenCode, Claude Desktop, any MCP client).
Two tool modes — **Default** (33 coding tools + shell/JS, no CI/CD) · **Expert** (43 tools: default + CI/CD).
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
        "VENIRA_SHELL_MODE": "permissive",   // "permissive" = no prompts · "balanced" = ask for writes/net/git push
        "VENIRA_SHELL_ENV_PASS_ALL": "0",    // "1" = pass full env to shell (build tools that need it)
        "VENIRA_SHELL_EXIT_EARLY": "1",      // poll returns as soon as exit code is known
        "VENIRA_SHELL_TIMEOUT_POLICY": "soft", // "soft" = warn on timeout · "hard" = kill process tree
        "VENIRA_ALLOW_JS_EXEC": "1",         // enable project_execute_js
        "VENIRA_JS_EXEC_APPROVAL": "0",      // "0" = auto-approve · "1" = human approval per JS call
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

> **Quick reference — what to change vs what to leave alone:**
>
> | Variable | Change when | Default |
> |---|---|---|
> | `VENIRA_WORKSPACE` | **Always** — absolute project path | — |
> | `VENIRA_TOOL_MODE` | No PR/CI needed | `default` |
> | `VENIRA_SHELL_MODE` | Shared/public repo | `balanced` |
> | `VENIRA_JS_EXEC_APPROVAL` | Want human approval per JS call | `1` |
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
| `default` | **33** (32 w/o JS) | Read/write/edit/search, code intel, snapshots, shell + JS exec, `project_delete_path` — **no** CI/CD |
| `expert` | **43** (42 w/o JS) | Everything in default + `project_pr_*`, `project_ci_*` |

`project_delete_path` is always available; shell `rm -rf` / `rd /s` / `Remove-Item -Recurse -Force` are hard-denied everywhere.

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
| `VENIRA_TOOL_MODE` | `default` | `default` (33 tools) or `expert` (43 tools) |
| `VENIRA_OUTPUT_MODE` | `full` | `full` or `compact` (trim payloads > 8 KB) |
| `VENIRA_UNRESTRICTED` | `"0"` | `"1"` disables workspace lock (never in production) |
| `VENIRA_SHELL_MODE` | `balanced` | `balanced`/`strict`/`permissive` shell policy |
| `VENIRA_ALLOW_JS_EXEC` | `"0"` | `"1"` enables `project_execute_js` |
| `VENIRA_NETWORK` | `"1"` | `"0"` = hard kill switch for all provider calls |
| `VENIRA_DATA_DIR` | per-user OS path | Where audit DB + encrypted secrets live |
| `VENIRA_DISABLE_TOOLS` | unset | Comma-separated tool names to hide from `tools/list` |
| `VENIRA_GIT_PROVIDER` | inferred | `github`/`gitlab`/`bitbucket` |
| `VENIRA_GIT_TOKEN` | unset | Fallback token when no provider-specific secret found |

## 7. Security model

**Conservative by default:**
- **Workspace lock**: all paths validated inside `VENIRA_WORKSPACE`; `../` escape rejected (`path_escape`).
- **Shell policy**: hard-deny for catastrophic commands (`rm -rf`, fork bomb, kernel module writes, bootloader tampering, credential theft, container escape, `git push --force`). Ask rules for writes outside workspace, network fetches, package installs, git history rewrites.
- **Secrets**: AES-256-GCM encrypted at rest; values never in tool metadata; `secret_env` requires human approval; expired secrets refused.
- **Provider DLP**: Secretlint scans PR/CI request args and HTTP payloads; detected credentials blocked before sending, withheld from response.
- **Audit trail**: all ops (including failures) written to SQLite WAL; `project_read_audit` for post-mortems.
- **Token transport**: provider token in `Authorization` header only; dropped on cross-origin redirect.

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
