# venira-mcp

Fast, workspace-scoped MCP server for coding agents (OpenCode, Claude Desktop, any MCP client).
Three tool modes — **Core** (32 tools: coding set minus code intelligence, for small models) · **Default** (39 coding tools + shell, no CI/CD) · **Expert** (52 tools: default + CI/CD). `VENIRA_JS_EXEC_MODE=off` hides `execute_js` in every mode (52 → 51, 39 → 38, 32 → 31); otherwise it is registered and approval-gated. `VENIRA_SETUP_TOOLS=1` adds the two setup tools `detect_harnesses` and `install_self` (+2); `npx venira-mcp --install` and `--print-config` do the same from a terminal.
Pure Node, 1 native dependency (better-sqlite3), no GUI, no external binary.

> **Security scope.** Venira is a guard rail with an audit trail, not a sandbox. It runs with the privileges of the OS user that started it. The workspace lock limits the paths the file tools can touch (unless `VENIRA_UNRESTRICTED=1`), not what a shell command does: commands are classified by rules (allow / ask / deny) and every call is audited, but a malicious prompt can still steer the agent into running a harmful command that the active profile lets through (with `off`, every command runs). Anything running as the same OS user can read the keys in `VENIRA_DATA_DIR`. For untrusted workspaces, or whenever you need a real isolation boundary, run Venira in a container or VM. Details: [`SECURITY.md`](./SECURITY.md).

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
3. Restart the client. Then call health to verify.
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

In this repo `.vscode/mcp.json` is git-ignored because it holds machine-specific settings (and may relax security flags). Copy `.vscode/mcp.example.json` to `.vscode/mcp.json` and adjust it locally.
## 2. Client configs (copy-paste)

The examples use two environment variables: the workspace and the tool set. Everything else has a safe default, so you only add a `VENIRA_*` variable when you want to change that default (see [Config recipes](#config-recipes)).

**OpenCode / VS Code / Cursor / Claude / Kimi / DeepSeek / Antigravity** — use the wrapper format supported by your client:

```jsonc
// OpenCode: "mcp" > "venira" > "environment"
{
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["npx", "--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "enabled": true,
      "environment": {
        "VENIRA_WORKSPACE": "/absolute/path/to/project",
        "VENIRA_TOOL_MODE": "expert",
        // Small model / restricted context? Uncomment to slim tools/list:
        // "VENIRA_TOOL_MODE": "core"
      }
    }
  }
}

// VS Code: "servers" > "venira" > "env"; ${workspaceFolder} expands automatically.
{
  "servers": {
    "venira": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "${workspaceFolder}",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}

// Claude / Cursor and compatible clients: "mcpServers" > "venira" > "env"
{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "/absolute/path/to/project",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}
```

### Generic MCP JSON example

For clients that accept the common `mcpServers` JSON shape, use the example for the user's operating system as a realistic starting point. Replace the example paths with paths on the user's machine; `VENIRA_DATA_DIR` is optional and can point to any writable directory. Keep this file private if it contains local paths or credentials.

Windows:

```json
{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "C:\\Users\\YourName\\Projects\\my-app",
        "VENIRA_DATA_DIR": "C:\\Users\\YourName\\AppData\\Local\\venira",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}
```

Linux:

```json
{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "/home/yourname/projects/my-app",
        "VENIRA_DATA_DIR": "/home/yourname/.local/share/venira-mcp",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}
```

`mcpServers` is a common client configuration shape, but some clients use a different outer key or file format. Preserve the Venira command, args, and environment values when adapting the example. The approval command returned at runtime uses the effective data directory from this configuration, so users and agents should copy `data.approval.approve_command` instead of constructing a path themselves.

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.venira]
command = "npx"
args = ["--yes", "--package=venira-mcp@latest", "venira-mcp"]

[mcp_servers.venira.env]
VENIRA_WORKSPACE = "C:\\path\\to\\project"
VENIRA_TOOL_MODE = "expert"
```

### Config recipes

Pick one block and put its variables in the `env` section of your client config. Every other variable keeps its default.

| Recipe | Variables |
|---|---|
| Minimal (recommended) | `VENIRA_WORKSPACE`, `VENIRA_TOOL_MODE=expert` |
| Fewer prompts on a personal machine | Minimal, plus `VENIRA_SECURITY_PROFILE=trusted` |
| Full trust (isolated or personal machine only) | Minimal, plus `VENIRA_SECURITY_PROFILE=off` |

`off` keeps full trust: shell checks off (hard-deny included), no workspace lock (`VENIRA_UNRESTRICTED=1`), `VENIRA_JS_EXEC_MODE=auto` as the default JS mode, no elicitation, full env passed to shell, `reveal=1` prints secrets and nothing prompts. A variable you set yourself always wins over the profile (e.g. `VENIRA_JS_EXEC_MODE=off` stays `off`). Deliberate opt-ins are never implied: `VENIRA_SHELL_OVERRIDES`, `VENIRA_ALLOW_SELF_INSTALL` and `VENIRA_SECRET_KEYCHAIN`.

Do not write a variable just to restate its default (for example `VENIRA_OUTPUT_MODE=full`, `VENIRA_USE_RIPGREP=1` or `VENIRA_SECURITY_PROFILE=balanced`).

### Security profiles

| `VENIRA_SECURITY_PROFILE` | Shell policy | Use |
|---|---|---|
| `strict` | `strict` | Read-only and workspace-local allowlist runs without approval |
| `balanced` (default) | `balanced` | Recommended general-purpose setting |
| `trusted` | `permissive` | Ask-rule and unclassified commands run; hard-deny commands require approval |
| `off` | `off` | Full trust: shell checks off, no workspace lock, JS exec `auto`, no elicitation, full env passed to shell. Prints a warning and audits shell commands. Replaces setting those variables one by one; any of them you set explicitly still wins |

`VENIRA_SHELL_MODE` is an advanced override and takes precedence over the profile. `VENIRA_JS_EXEC_MODE` separately gates the JavaScript tool: `off` (default) hides it, `ask` registers it with per-call human approval (skipped when `VENIRA_PERMISSION_MODE=allow_all`), `semi-auto` registers it without approval but keeps the containment (workspace-only fs, scrubbed env, no child processes; network is always open), `auto` registers it without approval and without any containment (full fs access, inherited env; personal machines only). `switch_workspace` follows the profile the same way: `trusted`/`off` (and an explicit `VENIRA_UNRESTRICTED=1`) switch to any existing directory; `strict`/`balanced` switch only inside `VENIRA_WORKSPACE_ROOTS`, which unset locks switching to the spawn workspace.

> Choose `trusted` when you want fewer prompts on a personal machine. Choose `off` only when you intentionally accept that shell checks are disabled; JS exec is still gated by `VENIRA_JS_EXEC_MODE` (a human gate for `execute_js` only counts when that mode is `ask` and `VENIRA_PERMISSION_MODE` is not `allow_all`). The `secret_env` gate remains active in every profile. Elicitation hangs off the shell mode: `strict` never prompts (CLI grant only), `balanced` prompts for every unclassified ask-rule command, `permissive` never prompts at all (only the `command_substitution` always-ask rule, hard-deny commands downgraded to `ask.deny.*`, and `secret_env` still prompt), `off` never prompts.

### Advanced configuration

| Variable | Default | Change when |
|---|---|---|
| `VENIRA_SHELL_MODE` | Profile mapping | You need to override only the shell policy (`strict`, `balanced`, `permissive`, or `off`) |
| `VENIRA_JS_EXEC_MODE` | `off` | `ask` registers `execute_js` with per-call approval (skipped when `VENIRA_PERMISSION_MODE=allow_all`); `semi-auto` registers it without approval but contained; `auto` registers it without approval and without containment |
| `VENIRA_UNRESTRICTED` | `0` | Keep workspace path restrictions enabled; do not set to `1` in production |

See the full environment reference in §6 for caching, shell, provider, and diagnostic options.

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

### Agent tool-path benchmark: Venira MCP vs Codex `exec_command`

Measured on 2026-11-07 on one Windows 11 build 26200 machine (Intel Core i5-1035G1,
8 logical processors, 11.8 GiB RAM, Node v24.20.0). Each workload used 20 paired
samples per phase, alternating call order. Venira used the persistent MCP connection;
each native `exec_command` call launched a fresh PowerShell process. Cache-miss samples
cleared Venira's in-process cache; warm samples reused it. The OS filesystem cache stayed
warm.

| Workload | Phase | Venira p50 / p95 | `exec_command` p50 / p95 | Ratio of p50s |
|---|---|---:|---:|---:|
| Read first lines of 8 files in one batch | Cache miss | 53.5 / 72 ms | 962 / 1,121 ms | 17.98× |
| Read first lines of 8 files in one batch | Warm | 39 / 60 ms | 1,103.5 / 1,549 ms | 28.29× |
| Search `VENIRA_WORKSPACE` across the workspace (49 hits) | Cache miss | 118.5 / 188 ms | 1,034.5 / 1,507 ms | 8.73× |
| Search `VENIRA_WORKSPACE` across the workspace (49 hits) | Warm | 34.5 / 152 ms | 1,018 / 1,383 ms | 29.51× |

Both workloads matched exactly in all 20 pairs: normalized text for the 8-file batch and
sorted file/line locations for search. These are practical agent tool-path timings, not
raw filesystem timings. A separate 100-sample component benchmark shows native
PowerShell can be faster for simple uncached reads; the largest Venira gains are on warm
list/search and avoiding a fresh shell process. The p95 estimates are rough with 20
samples, and results from this one machine are not a general performance guarantee.

See the [full methodology and results](./BENCHMARK-2026-11-07.md) and
[raw samples](./BENCHMARK-2026-11-07.json). Reproduce the component benchmark from the
repository root with `npm run bench:tools -- --runs=100`.

## 4. Three tool modes

Three tool modes set which tools the client sees. Set via `VENIRA_TOOL_MODE` env var or
`"toolMode"` in `venira.config.json` (env wins). `VENIRA_DISABLE_TOOLS` hides additional tools on top.
`core` is the small-model / restricted-context preset (the old `VENIRA_PROFILE=core`, now folded into this one variable).

| Mode | Tools | Includes |
|---|---|---|
| `core` | **32** | `default` minus the code-intelligence tools: `dependency_graph`, `change_impact`, `outline_symbol`, `diff_files`, `symbol_references`, `recent_files`, `execute_js` |
| `default` | **39** | Read/write/edit/search, code intel, snapshots, shell, `delete_path`, `execute_js` — **no** CI/CD; `explain_error` and `plan_read_batch` are expert-only |
| `expert` | **52** | Everything in default + `pr_*`, `ci_*`, `explain_error`, `plan_read_batch` |

`delete_path` is always available. In `balanced` / `strict` mode, shell `rm -rf /` / `~` and Windows drive-wide deletes are hard-denied, and recursive/force deletes (`Remove-Item -Recurse -Force`, `rd /s /q`, `del /f /q`) need approval. `permissive` mode lets ordinary ask-rule and unclassified commands run without a prompt, but hard-denies require approval and uninspectable command substitutions require approval in every policy-enabled mode.

## 5. Tools quick reference

All tools return the standard envelope (`ok`, `kind`, `data`, `hint`, `elapsed_ms`).

**Read (batch-safe, cached)**

| Tool | Purpose |
|---|---|
| `list_files` | List files/dirs, depth 1–3, limit ≤ 200 |
| `read_file` | Read a file by line range; optional `ranges[]` (up to 16) |
| `get_file_info` | File/dir metadata (kind, size, mtime); `missing_ok=1` answers ok with `exists:false` for missing paths (works in `read_batch`) |
| `search` | Search by file/dir name, content, regex, or symbol; `hybrid: 1` tags hits with `source`+`confidence`; `queries[]` ranks files by AND/OR/NOT patterns |
| `recent_files` | Recently modified files (index-first, scan-fallback) |
| `read_batch` | Up to 8 read-only ops in one call; each item takes the same arguments as its standalone tool (`search` items support `regex`, `case_sensitive`, `hybrid`, ...) |
| `health` | Diagnostics: capability, queue, cache hit-rates, p50/p95, security limits notice, and `server.workspace_switching` (`enabled`, `profile`, `allowed_roots`) |
| `switch_workspace` | Re-root the workspace to another directory mid-session — for clients that spawn the server once (e.g. Claude Desktop). Follows `VENIRA_SECURITY_PROFILE`: `trusted`/`off` switch to any existing directory; `strict`/`balanced` only inside `VENIRA_WORKSPACE_ROOTS` (unset = locked to the spawn workspace) |
| `read_audit` | Read recent audit log rows |
| `memory` | One handoff note per workspace that outlives the chat: `action=read` at the start of a task, `action=write` (full overwrite, max 6000 bytes) before finishing or running out of context. Plain markdown at `<workspace>/.venira/memory.md` (follows `switch_workspace`; legacy data-dir note is still read as a fallback). Not encrypted, so keep secrets out |

**Whole-file hashes.** `read_file` returns `sha256` = the hash of the **whole file** (`sha256_scope: "file"`), even when the call returned only a slice, and `text_sha256` = the hash of the text that was returned. `sha256` is therefore safe to send back as `expected_sha256`; `text_sha256` is not. The hash covers the raw bytes, so a file with a BOM round-trips. When a write or edit refuses a stale hash (`stale_content`), the file is left untouched and the response asks for a fresh read: re-read the file, rebuild the patch against the current content and send the new hash - never replay the same edit unchanged. In `compact` mode the text arrives as `preview` (`preview_truncated` marks a cut); the hash fields are always there.

**Recovery that fits the tool.** A failure names the call that can recover from it: a missing secret points at `secret action=list`, a missing device flow at `github_connect action=start`, a missing checkpoint at `snapshot action=list`, a missing file at the file tree. A read batch that lost one item is marked `partial: true` and reports `failed_count` and `succeeded_count`, so the successful reads stay visible. `health` in compact mode keeps whole sections and names the ones it dropped, and `sections` asks for exactly the parts you need.

**A failed edit answers with a diagnosis, not a dump.** When `old_text` is not in the file, the error says **where** it went wrong and how small the gap is: `mismatch` carries the file, the line, the first differing character, how many characters the line is off, and the two lines it compared. `context` carries three lines before and three after the wrong spot - without line numbers, so it can be copied straight into `old_text` (`numbered` has the numbers for orientation). The payload stays under a kilobyte even for a long edit, and the file is never changed by a refused edit. `indentation` and `line_endings` say whether the file uses tabs or spaces and CRLF or LF - the two things plain text cannot show.

**Snippets that run.** `execute_js` gives a snippet with a top-level `await` the same `require` it has in CommonJS mode, so the two are not mutually exclusive. A static `import` of a network module is refused before the snippet runs (in the contained modes) with the way out; a `require` of one is blocked at runtime, so a snippet that proves the block still runs. A top-level `return`, a timeout and a failed snippet all come back with a reason you can act on, and the envelope carries `command_status: "failed"`.

**Write (mutating, pass `reason`)**

| Tool | Purpose |
|---|---|
| `write_file` | Create/overwrite/append; `expected_sha256` guards blind overwrites |
| `edit_file` | Replace `old_text`→`new_text`; `edits[]` (up to 64); fuzzy edit opt-in |
| `edit_batch` | Multiple edits; stops at first failure and attempts checkpoint rollback. Check `data.atomic` and `data.rollback_succeeded`; snapshot failure/incompleteness or a partial restore means changes may remain. A batch that rolled back cleanly removes its own checkpoint (`data.checkpoint_deleted: true`), so a failed attempt does not eat a `VENIRA_SNAPSHOT_KEEP` slot; a **failed** rollback keeps the checkpoint - it is the recovery path. |
| `create` | Create a directory (missing parents are created; use `write_file` for file content) |
| `move_path` | Move or rename a file/dir; `overwrite=1` replaces a file (never a directory); **not undoable** |
| `copy_path` | Copy a file, or a directory with `recursive=1`; skips symbolic links and protected files inside a directory |
| `apply_patch` | Apply a unified diff (create/modify/delete/rename), all-or-nothing; `dry_run=1` to validate first; rolls back every file on failure |
| `delete_path` | Delete file/dir; **not undoable** |

**Checkpoints (git-free rollback)**

`snapshot` — `create`/`list`/`restore`/`delete`. Content-addressed, deduplicated, atomic per-file restore. The id carries the **local** timestamp (`snap-20261113-001500-3f9ac2`); the exact instant is `created_at_ms` (epoch milliseconds).

**Code intelligence**

| Tool | Purpose |
|---|---|
| `outline_symbol` | Parse a file's symbols (functions, classes, types) with line numbers |
| `diff_files` | Unified diff between two files |
| `symbol_references` | Find all occurrences of a named symbol |
| `dependency_graph` | TS/JS/Python/Rust/Go/Java/Kotlin import/symbol graph (JSON/DOT/Mermaid) |
| `change_impact` | "What breaks if I edit this?" — bounded reverse/forward closure |

**Two caps, two names.** `symbol_references` has `max_references` (how many references come back - the token bill, default 100) and `limit` (how many workspace hits are scanned - the work, default: `max_references`). The result says which one bit: `count` (found), `returned`, `omitted`, `scan_limit` and `limited`.

**`change_impact` says what it could not resolve.** `unresolved[]` holds the **seeds** that did not resolve (the symbol is not declared, or the name is ambiguous in N files) with a `next_step`; the graph-wide unresolved imports are only counted (`stats.unresolved_imports`), because they say nothing about the seeds and cost tokens on every call.

**The graph's side lists are short and counted.** `dependency_graph` returns the 50 most used `external[]` entries and the 10 first `unresolved[]` ones; `stats.externals` and `stats.unresolved_imports` hold the full counts, and `limited: true` says that a list was cut.

**Shell (async, policy-gated)**

| Tool | Purpose |
|---|---|
| `shell_run` | Run a command; `background: 0` blocks for final output; `1` returns `run_id`. `shell`: `powershell` (Windows PowerShell 5.1), `pwsh` (PowerShell 7+), `cmd` or `bash`; omitted → `VENIRA_DEFAULT_SHELL`, else `cmd` on Windows and `$SHELL`/`bash` elsewhere |
| `shell_status` | Poll a running command (not queued, not audit-logged) |
| `shell_cancel` | Kill a running command by `run_id` |
| `shell_cancel_session` | Kill all shell runs in this session |

**Repeated-failure guard.** A shell invocation is fingerprinted (normalized command, shell, resolved cwd and the non-secret inputs; `secret_env` contributes its names only) and the fingerprint is remembered per session when the run fails or times out. The identical invocation is then **not** run again: the call fails with `repeated_failure` and carries `data.previous` (exit code, timed-out flag, bounded stderr tail, failure count). Nothing is stored but the hash - never the command text, never a secret value - so a repeat with secrets is reported as "same command and inputs", never as an exact match of the secret values. Change the command, the shell, the cwd or the inputs and it runs normally; a deliberate rerun of the identical command is `retry_failed: 1`. A successful run clears the memory.

**What the shell really did.** The response names the binary that ran the command (`shell_path`, `shell_kind`: `native`, `wsl`, `git-bash` or `unknown`) - on Windows `bash` is often the WSL launcher, which runs the command inside a Linux distro and reports its own messages in UTF-16 (those are decoded for you, and a WSL without a distribution comes back with a `shell_hint`). `cmd.exe` receives the command verbatim, so double quotes survive; PowerShell reports the **native** exit code of the last command (`git status` outside a repository reports 128, not 1), while a failing cmdlet still reports 1.

**Choosing a shell on Windows.** `powershell` starts `powershell.exe` (5.1), which has no `&&` / `||` pipeline-chain operators; `pwsh` starts PowerShell 7+ (`winget install --id Microsoft.PowerShell`), which has them. `pwsh` must be on the `PATH` of the server process, so restart the MCP client after installing it. Policy treats both as the same PowerShell dialect: every segment of an `&&` / `||` chain is classified on its own, so a denied command after `&&` is still denied (`policy_adv_dialect_pwsh_chain_operators`). `pwsh` starts slower than `cmd`; set `VENIRA_DEFAULT_SHELL=pwsh` only if you want it for every call. A shell binary that is not installed fails with `[shell_unavailable]` and an install hint instead of returning exit code -1. In PowerShell an unquoted `(...)`, `@(...)` or `{...}` counts as a substitution the policy cannot inspect, so a command that carries one always asks for approval in policy-enabled modes, including `permissive`: PowerShell evaluates the group before the command runs, so `git status (Remove-Item -Recurse -Force $HOME)` would otherwise delete while looking like read-only git (`policy_adv_dialect_powershell_grouping_expressions`).

**Local git (this repo)**

| Tool | Purpose |
|---|---|
| `git_status` | Parsed worktree status: branch/detached, upstream (+ `upstream_gone`), ahead/behind, per-file `{path, old_path?, staged, unstaged, untracked, unmerged, kind, status, index_status, worktree_status}` + `counts`; `clean` flag; `paths[]` limits |
| `git_diff` | Parsed diff (`staged=1` for the index): per-file `action` (`added|modified|deleted|renamed`) + `hunks[]` (`old_start/old_lines`, `new_start/new_lines`, `section`), `counts`, `patch_bytes`; `include_patch=1` adds the unified text capped at `max_bytes` |
| `git_log` | Commit list (`ref`, `limit`, `paths[]`, `author`, `grep`) — or `blame=1` with `path` for per-line blame (`line, commit, author, authored_at, summary, prev_*`); `max_lines` caps blame |
| `git_branch` | `action=list` (local; `include_remote=1` for remotes), `current`, `create` (`from=` optional), `switch`, `delete` (`force=1`) |
| `git_commit` | Commit staged changes, or stage `paths[]` first; `amend=1` / `allow_empty=1` opt-in; reports `sha`, `files_changed`, `files` |
| `git_stash` | `action=push|list|apply|pop|drop|show` (`stash@{N}`); `include_untracked=1` includes untracked files |

Read-only git (`status`, `diff`, `log`/blame, `branch` list/current, `stash` list/show) needs no `reason`; mutating calls do. Mutations invalidate the whole cache (worktree-wide change). Local only against the workspace repository root (`git rev-parse --show-toplevel`; paths stay workspace-relative); **push is never performed by these tools** — routine git pushes need no approval, force/delete/URL pushes ask one, and `ALLOW_ENV_READ` is the only remaining named override.

**Git provider: PR/CI (GitHub, GitLab, Bitbucket)**

`pr_create/comment/merge/list/close/reopen`, `ci_status/trigger/logs/wait`, `ci_control` (cancel / retry-failed; Bitbucket supports cancel only) — same tool args across providers; token from `secret` or env vars.

CI reads are bounded and never hide a cap:

- **Pagination** — status/job/check-run/step lists follow the provider's next-page link (`Link` header on GitHub/GitLab, body `next` on Bitbucket) for at most 5 pages / 200 items, stay on the configured API origin, and never fetch the same page twice. When a cap or the provider total stops the walk, the result says so (`truncated` / `partial`) instead of reporting a partial list as complete.
- **Verdicts** — a finished Bitbucket pipeline/step is read from `state.result` (not just `COMPLETED`), so a failed run is never shown green.
- **Logs** — failing steps/jobs are read first; archives and entries are byte-capped (see `VENIRA_GIT_LOG_*`), and a log whose declared size is over the cap is refused before it is downloaded.
- **`ci_wait`** — one bounded long-poll (no polling loop). Returns `summary` (one line), `next_step` (`wait_again` · `merge_or_continue` · `fix_failing_step_then_push` · `read_logs` · `inspect_status`), `failing_jobs` (max 5) and, on failure, a `failure_tail` of the first failing job (numeric ids on GitHub/GitLab, UUID step ids on Bitbucket).

**Secrets (encrypted at rest)**

`secret` — store/inspect/remove credentials by name; AES-256-GCM; rotation metadata; expired secrets refused.
`github_connect` — GitHub Device Flow, tokens in vault.

**Diagnostics & planning**

`explain_error` — turn an error into a cause + next tool calls (rule table, no model).
`plan_read_batch` — plan which files to read for a task, returns ready `read_batch` call.
`cache_clear` — clear the in-process caches (all / read / info / list / search / recent / negative / graph / shell) when reads look stale because a tool changed files outside Venira.
`trace_status` — show recent traced tool calls and the trace configuration; tracing is always on (`VENIRA_TRACE` was removed), and `VENIRA_TRACE_FILE` additionally appends to a rotating file.

**JS execution**

`execute_js` — run synchronous JS (opt-in via `VENIRA_JS_EXEC_MODE`). The mode decides both the approval step and how much the snippet is contained:

| Mode | Approval per call | Network | Filesystem | Environment |
|---|---|---|---|---|
| `off` (default) | tool not registered | n/a | n/a | n/a |
| `ask` | yes (skipped when `VENIRA_PERMISSION_MODE=allow_all`) | open (every mode) | workspace only | scrubbed |
| `semi-auto` | no | open (every mode) | workspace only | scrubbed |
| `auto` | no | **open** | **unrestricted** | **inherited** |

- **Contained** (`ask`, `semi-auto`): Node's permission model limits reads and writes to the workspace and denies child processes and workers; only `PATH`, `TERM` and `NODE_PATH` are passed (`HOME` and `USERPROFILE` are empty). Network access is open in every mode. This is best-effort containment, not a sandbox.
- **`auto`** drops all of the above: the snippet has the full network, the full filesystem, child processes and the server's environment (including any tokens in it). Use it only on a personal machine you trust. `health` reports `js.exec_without_approval` (a warning) for both `semi-auto` and `auto`; it does not distinguish the two.
- `semi-auto` is the old behaviour of `auto`. If your config says `VENIRA_JS_EXEC_MODE=auto` and you want the snippet to stay contained, change it to `semi-auto`.
- Output is still redacted for obvious secret assignments, and the timeout (default 30 s, max 10 min) applies in every mode.

## 6. Environment variables (key ones)

Full reference: the source reads 80+ distinct supported `VENIRA_*` names; this table lists the documented ones. See the source or `npx venira-mcp --help` for the rest.

| Variable | Default | What it does |
|---|---|---|
| `VENIRA_WORKSPACE` | `process.cwd()` | Workspace root; all paths resolve against it |
| `VENIRA_TOOL_MODE` | `default` | `core` (32 tools) / `default` (39 tools) / `expert` (52 tools); +2 with `VENIRA_SETUP_TOOLS=1` |
| `VENIRA_OUTPUT_MODE` | `full` | `full` or `compact` (summarize/trim payloads > 8 KiB; generic payloads use `preview_text`) |
| `VENIRA_AUDIT_DETAIL` | `summary` | What `read_audit` can show per job: `off` stores nothing extra, `summary` keeps one args line and one result line, `full` also keeps redacted JSON args/result (up to 16 KiB per job). Long or sensitive values (file content, `old_text`/`new_text`, secret values) are stored as a length only |
| `VENIRA_UNRESTRICTED` | `"0"` | `"1"` disables workspace lock (never in production) |
| `VENIRA_SECURITY_PROFILE` | `balanced` | Selects the shell policy: `strict`, `balanced`, `trusted`, or `off` |
| `VENIRA_SHELL_MODE` | Profile mapping | Advanced override for shell policy: `strict`, `balanced`, `permissive`, or `off` |
| `VENIRA_DEFAULT_SHELL` | `cmd` on Windows, `$SHELL` / `bash` elsewhere | Shell used when a call does not name one: `powershell` (5.1), `pwsh` (7+), `cmd`, `bash` |
| `VENIRA_SHELL_TAIL_MAX` | `2000` | Characters kept in a shell run's stdout/stderr **tail** (minimum `256`); the head of huge output is dropped so the exit code and last lines survive |
| `VENIRA_SHELL_MAX_OUTPUT_BYTES` | `262144` | Per-stream cap (stdout and stderr each) that a shell run records |
| `VENIRA_SHELL_MAX_TIMEOUT_MS` | `1800000` | Upper bound for a caller-supplied shell timeout (`timeout_s`); larger values are clamped to this |
| `VENIRA_JS_EXEC_MODE` | `"off"` | `"off"` hides `execute_js` · `"ask"` registers it with per-call approval (skipped when `VENIRA_PERMISSION_MODE=allow_all`) · `"semi-auto"` registers it without approval, contained (workspace-only fs, scrubbed env, no child processes; network always open) · `"auto"` registers it without approval and without containment |
| `VENIRA_USE_RIPGREP` | `"1"` | `"1"` uses ripgrep if installed (faster on big repos) |
| `VENIRA_SEARCH_MAX_FILES` | `"50000"` | Max files collected by the JS fallback walker before it stops and reports `complete: false`. Bounds searches rooted at huge trees (e.g. with `VENIRA_UNRESTRICTED=1` and an absolute path outside the workspace) |
| `VENIRA_CACHE` | `"all"` | `all` every TTL cache on · `list` only directory listings · `search` only searches · `off` always fresh (slower) |
| `VENIRA_EDIT_FUZZY` | `"0"` | `"1"` enables fuzzy-match fallback for `old_text`, and adds `fuzzy_distance`, `ignore_indentation` and `case_insensitive` to the `edit_file` / `edit_batch` schemas. `tools/list` changes with this flag, so reconnect the client after changing it. With `"0"` those options are not advertised and a call that still sends them is refused with `[unsupported]` |
| `VENIRA_DATA_DIR` | per-user OS path | Where audit DB + encrypted secrets live |
| `VENIRA_SNAPSHOT_ROOT` | `<per-user data dir>/snapshots` | Shared checkpoint root for every project and client; each workspace gets its own sub-folder (absolute path) |
| `VENIRA_SNAPSHOT_DIR` | unset | Exact checkpoint store for a single project, no sub-folders; wins over `VENIRA_SNAPSHOT_ROOT` (absolute path) |
| `VENIRA_SNAPSHOT_KEEP` | `20` | Checkpoints kept per project (oldest pruned on create) |
| `VENIRA_SNAPSHOT_MIRROR_DIR` | unset | Optional append-only copy of the checkpoint store in this existing folder (OneDrive/Dropbox, NAS share, USB drive, rclone mount); absolute path, must be outside the store and the workspace |
| `VENIRA_SNAPSHOT_MIRROR_TIMEOUT_MS` | `20000` after `create`, `100000` for `action=mirror` | Time budget of one mirror run; it stops between files (`partial`) and the next run resumes |
| `VENIRA_DISABLE_TOOLS` | unset | Comma-separated tool names to hide from `tools/list` |
| `VENIRA_GIT_PROVIDER` | inferred | `github` / `gitlab` / `bitbucket` |
| `VENIRA_GIT_TOKEN` | unset | Fallback token when no provider-specific secret found |
| `VENIRA_GIT_TIMEOUT_MS` | `60000` | Per-request timeout for provider JSON calls (1 000–600 000) |
| `VENIRA_GIT_RETRIES` | `1` | Retries for safe GET reads only (0–3); POSTs are never replayed |
| `VENIRA_GIT_LOG_TIMEOUT_MS` | `90000` | Timeout for CI log downloads (1 000–900 000) |
| `VENIRA_GIT_LOG_ZIP_BYTES` | `33554432` | Max bytes of a CI log archive; larger declared sizes are refused before download |
| `VENIRA_GIT_LOG_ENTRY_BYTES` / `VENIRA_GIT_LOG_TEXT_BYTES` | `4194304` / `8388608` | Per-entry and total decoded log text caps |
| `VENIRA_SHELL_OVERRIDES` | unset | Operator allowlist: `ALLOW_ENV_READ` (the `ALLOW_GIT_PUSH` override was removed) |
| `VENIRA_PERMISSION_MODE` | `allow_all` | Permission mode passed when the session scope opens (`manual` / `best_effort` / `allow_all`); `allow_all` also skips the `VENIRA_JS_EXEC_MODE=ask` approval prompt; shown in `health` |
| `VENIRA_SESSION_ID` | auto | Set for test/verify runs to separate audit rows |
| `VENIRA_SESSION_GRANT_RULES` | built-in: `cd_outside_workspace` | Extra ask-rule ids (comma-separated) that may be approved with `--approve --session` |
| `VENIRA_SHELL_APPROVAL_TTL_MS` | `600000` (10 min) | Lifetime of an in-memory `--session` grant; pending approvals always expire after a fixed 5 minutes |
| `VENIRA_SETUP_TOOLS` | `"0"` | `"1"` advertises `detect_harnesses` and `install_self` in `tools/list` (changes the tool list after a restart) |
| `VENIRA_ALLOW_SELF_INSTALL` | `"0"` | `"1"` lets `install_self` write other clients' config files |
| `VENIRA_SHELL_POLICY_FILE` | unset | Path to a JSON shell policy file (allow/ask/deny rules); never read from the workspace automatically |
| `VENIRA_TOOL_POLICY_JSON` / `VENIRA_TOOL_POLICY_FILE` | unset | Per-tool policy rules, inline JSON or a file (see `lib/tool-policy.ts`) |

### Advanced tuning knobs (all optional)

Sensible defaults; leave any of these unset unless you know why you set them.

| Variable | Default | What it does |
|---|---|---|
| `VENIRA_PRETTY` | `"0"` | Pretty-print JSON envelopes |
| `VENIRA_BATCH_ITEM_BYTES` | `524288` | Per-item response budget inside `read_batch`; larger items are trimmed |
| `VENIRA_SHELL_ENV_ALLOW` | unset | Extra environment variable names passed through to shell runs, beyond the scrubbed baseline |
| `VENIRA_SHELL_CACHE` | `"1"` | Cache read-only shell results |
| `VENIRA_SHELL_CACHE_READ_ONLY` | `"1"` | Compatibility flag (shell output caching is always read-only — nothing mutating is ever cached) |
| `VENIRA_CONFIG_FILE` | unset | Explicit path of the JSON config file (git provider settings); never auto-read from a workspace |
| `VENIRA_WORKSPACE_ROOTS` | unset | Allowlist of roots `switch_workspace` may reach under `strict`/`balanced` (absolute paths, both `,` and `;` separators). Unset = locked to the spawn workspace. Ignored under `trusted`/`off`/`VENIRA_UNRESTRICTED=1` (those switch to any existing directory) |
| `VENIRA_CACHE_LIST_ONLY` | unset | Enable only the directory-listing cache |
| `VENIRA_CACHE_SEARCH_ONLY` | unset | Enable only the search cache |
| `VENIRA_LIST_CACHE_MS` | `1500` | Directory-listing cache lifetime |
| `VENIRA_NEGATIVE_CACHE_MS` | `500` | Lifetime of cached not-found results |
| `VENIRA_RECENT_CACHE_MS` | `2000` | `recent_files` cache lifetime |
| `VENIRA_SEARCH_CACHE_MS` | `3000` | Search cache lifetime |
| `VENIRA_TTL_CACHE_BYTES` | `8388608` | Size cap of each list / search / recent / references cache |
| `VENIRA_CACHE_RACY_MS` | `30` | Files modified this recently are re-read instead of served from the read cache (`0` disables) |
| `VENIRA_READ_CACHE_BYTES` | `67108864` | Total size cap of the file-read cache |
| `VENIRA_AUDIT_STRICT` | `"0"` | `"1"` fails a tool call when its audit row cannot be written (default: audit failure is a warning) |
| `VENIRA_AUDIT_KEEP_DAYS` | `90` | Audit rows older than this many days are pruned |
| `VENIRA_SNAPSHOT_MAX_BYTES` | `536870912` | Total size cap of a project checkpoint |
| `VENIRA_SNAPSHOT_MAX_FILE_BYTES` | `33554432` | Largest single file a checkpoint captures |
| `VENIRA_SNAPSHOT_MAX_FILES` | `0` | File-count cap of a checkpoint (`0` keeps the built-in limit) |
| `VENIRA_GIT_MAX_BYTES` | built-in | Largest provider API response accepted |
| `VENIRA_GIT_LOG_MAX_BYTES` | built-in | Total CI log bytes returned per call |
| `VENIRA_GIT_MAX_REDIRECTS` | built-in | Redirects followed (same-origin only) |
| `VENIRA_GIT_ALLOW_HTTP` | `"0"` | Allow plain-HTTP provider URLs (tokens may travel in clear text) |
| `VENIRA_GITHUB_ALLOW_HTTP` | `"0"` | Deprecated alias of `VENIRA_GIT_ALLOW_HTTP`; the `GIT_*` name wins, prints a one-time note |
| `VENIRA_GIT_ALLOWED_HOSTS` | unset | Extra API hosts the provider client may call |
| `VENIRA_GIT_API_URL` | unset | Provider API base URL (self-hosted instances) |
| `VENIRA_GITHUB_API_URL` | unset | Deprecated alias of `VENIRA_GIT_API_URL`; the `GIT_*` name wins, prints a one-time note |
| `VENIRA_GIT_PROXY` | unset | HTTP(S) proxy for provider calls |
| `VENIRA_GIT_REPO` | unset | Repository slug override (`owner/name`) |
| `VENIRA_GITHUB_REPO` | unset | GitHub repository slug override |
| `VENIRA_GITLAB_REPO` | unset | GitLab project path override |
| `VENIRA_BITBUCKET_REPO` | unset | Bitbucket repository slug override |
| `VENIRA_GIT_SECRET_NAME` | unset | Name of the stored secret holding the provider token (default `GITHUB_TOKEN`) |
| `VENIRA_GIT_TOKEN_ENV` | unset | Name of another environment variable holding the provider token (e.g. `GITHUB_TOKEN`) |
| `VENIRA_GIT_USERNAME` | unset | Username for providers that need one (Bitbucket app passwords) |
| `VENIRA_GITHUB_TOKEN` | unset | GitHub token (falls back to `GITHUB_TOKEN` / `GH_TOKEN`) |
| `VENIRA_GITLAB_TOKEN` | unset | GitLab token (falls back to `GITLAB_TOKEN` / `GL_TOKEN`) |
| `VENIRA_BITBUCKET_TOKEN` | unset | Bitbucket token (falls back to `BITBUCKET_TOKEN` / `BB_TOKEN`) |
| `VENIRA_SECRET_KEYCHAIN` | `"auto"` | Windows keychain for the secret store key (`auto` / `off` / `required`) |
| `VENIRA_TRACE_FILE` | unset | Also append the trace to this file (rotates at 10 MB) |

## 7. Security model

**Conservative by default:**
- **Workspace lock**: all paths validated inside `VENIRA_WORKSPACE`; `../` escape rejected (`path_escape`).
- **Security profile** (`VENIRA_SECURITY_PROFILE`, default `balanced`): sets the shell policy. `VENIRA_SHELL_MODE` can override it. Every `shell_run` command is classified `allow`, `ask` or `deny`.
  - `balanced` (default): hard-deny rules refuse the command; ask rules need approval; routine dev-workspace commands run; anything unclassified needs approval.
  - `strict`: like `balanced`, but only a read-only / workspace-local allowlist runs without approval.
  - `permissive` (the `trusted` profile): ordinary ask-rule and unclassified commands run without a prompt; hard-deny matches become approval requests (`ask.deny.<rule>`), and uninspectable command substitutions always require approval.
  - `off`: **the shell policy is disabled** — every command runs, nothing is asked or denied (only `secret_env` injection still asks). Prints a startup warning; use only in a trusted environment. Previous `permissive` behaviour (v1.14.4) = `off`.
  - Hard-deny (14 rules): disk destroy, filesystem mount/overwrite, shutdown/reboot, fork bomb, pipe download to shell, privilege escalation (sudo/doas/runas), filesystem root/drive-home delete (`rm -rf /`, `rm -rf C:\`, `Remove-Item -Recurse -Force $HOME`, …), `chmod 777 /`, Windows drive-wide and wildcard mass delete, encoded PowerShell commands, self-approval (touching the approve CLI or approval store), protected credential/key files.
  - Ask (20 rules): command substitution, reads/writes/`cd` outside the workspace, network access, package mutation, git history rewrite, container/VM control and state, process control and `taskkill /f`, secret dumps, dynamic execution and wrapper commands, `find -delete/-exec`, destructive recursive/force deletes (`Remove-Item -Recurse -Force`, `rd /s /q`, `del /f /q`; prefer `delete_path`), attribute reset, infinite writes to NUL, unresolved file arguments.
  - Deny always wins over ask.
- **Secrets**: AES-256-GCM encrypted at rest; values never in tool metadata; `secret_env` requires human approval; expired secrets refused.
- **Provider DLP**: Secretlint scans PR/CI request args and HTTP payloads; detected credentials blocked before sending, withheld from response.
- **Audit trail**: all ops (including failures) written to SQLite WAL; `read_audit` for post-mortems.
- **Token transport**: provider token in `Authorization` header only; dropped on cross-origin redirect.

**Approvals — what needs a human, and how it is granted**

| Gate | Triggers when | Switch (default) |
|---|---|---|
| Shell `deny` | A hard-deny rule matches: refused outright, no approval possible | `VENIRA_SECURITY_PROFILE` (`balanced`; `trusted` asks; `off` disables shell checks) |
| Shell `ask` | An ask rule matches, or the command is unclassified in `balanced` / `strict` | `VENIRA_SECURITY_PROFILE` (`balanced`) · advanced override: `VENIRA_SHELL_MODE` |
| Secret injection | `shell_run` with `secret_env` | always asks, in every mode |
| `execute_js` | Every call | `VENIRA_JS_EXEC_MODE` (`off`: tool not registered; `ask`: per-call approval, skipped when `VENIRA_PERMISSION_MODE=allow_all`; `semi-auto`: no approval, contained; `auto`: no approval, no containment) |
| Secret plaintext | `secret` with `reveal=1` | `VENIRA_SHELL_MODE` (`off` / `permissive`) |
| Self-install | `install_self` writes another client's config | `VENIRA_ALLOW_SELF_INSTALL` (`0`) |
| Named shell override | `ALLOW_ENV_READ` | `VENIRA_SHELL_OVERRIDES` (unset), plus `override` and a `reason` on the call |

Routine git (`status`, `diff`, `log`, `add`, `commit`, `rm`, `push` fast-forward with publish flags, `pull`, `fetch`, `clone`, `merge`, `rebase`, `cherry-pick`, `revert`, `tag`, `branch`, `reset` without `--hard`/`--keep`, `checkout`, `switch`, `stash`) runs in `balanced` without an approval; force/delete/URL pushes and the other git history rewrites (`reset --hard`, `clean -fd`, `branch -D`, `filter-branch`, `reflog`) stay in `git_history_rewrite` and still need one. The removed `ALLOW_GIT_PUSH` override no longer exists; setting it fails closed with `[config_invalid] VENIRA_SHELL_OVERRIDES accepts only: ALLOW_ENV_READ`. `ALLOW_ENV_READ` covers exactly one plain `.env` file in the workspace (no globs, no redirects, no substitutes); overrides require a `reason` and win for exactly one call.

Granting a shell or JS approval:

1. The call fails with `[approval_required]` and returns `data.approval_id` (valid for 5 minutes) together with the command or code, the rule and the reason. Shell and JS share one payload, `data.approval`: `{ approval_id, gate, rule, reason, subject_preview, expires_at, approve_command, retry_with: { tool, arguments } }`.
2. A person copies `data.approval.approve_command` exactly into an interactive PowerShell terminal (the returned command includes the server data directory and works in Windows PowerShell and PowerShell 7), reviews the request and answers `y`. The CLI refuses without a TTY. `--yes` skips the prompt. `--session` extends the grant to the same command group until it expires, but only for rules in `VENIRA_SESSION_GRANT_RULES` (built-in: `cd_outside_workspace`). The command runs the **installed** build (`node <install>/bin/venira-mcp.js ...`), so the human approves the same version the agent is talking to; it never downloads a package from the registry.
3. The agent retries the same call with `approval_id`. The grant is HMAC-signed, tied to the session, bound to the exact command / shell / cwd / `secret_env` / rule (or code / argv for JS), and single-use. Concurrent retries of the same id cannot both run: consumption is an atomic file claim, so exactly one wins.

**TTL behavior:** the pending request (`approval_id`) is valid for a fixed 5 minutes and cannot be revived by retrying. A `--session` grant lasts 10 minutes by default (`VENIRA_SHELL_APPROVAL_TTL_MS`) and lives only in this server process; restarting the server clears it.

Agent helpers:
- `shell_run` with `dry_run: 1` returns the tier, rule and `would_run` / `requires_approval` without running anything or creating an approval, so an agent knows beforehand which command will be asked.
- `approval_wait_s` (max 45) on `shell_run` / `execute_js` keeps the call open while the human approves; a grant that arrives in time runs the command in the same call, otherwise you get the normal `[approval_required]` (the pending `approval_id` stays valid). Keep it below the client's request timeout.
- `health` reports `approvals` (mode, JS gate, elicitation, session rules, TTL, max wait), the shared `posture` report (`level`, stable finding ids such as `workspace.unrestricted`, `profile.off`, `combo.unrestricted_open_shell`, `js.exec_without_approval`) and the flat `warnings` list. Posture findings are warnings only; invalid values already fail closed at startup. `doctor` surfaces the same report.

Alternative (in `balanced` mode, `shell_run` only): ask-rule commands the policy cannot statically clear prompt through a confirmation dialog in MCP clients that support elicitation, and accepting it records the grant for you. In `permissive` the prompt is reserved for the always-ask `command_substitution`, hard-deny commands (which arrive as `ask.deny.*`) and `secret_env`; ordinary ask-rule commands run without a prompt. `strict` never prompts; `off` never prompts.

Removed in v1.15: `approval_token` and `VENIRA_SHELL_AUTO_APPROVE_TOKEN`. Passing `approval_token` now returns `[approval_invalid]` with a hint to use `approval_id`; setting the env var only logs a warning and is ignored.

Removed: `VENIRA_ALLOW_JS_EXEC` and `VENIRA_JS_EXEC_APPROVAL` — use `VENIRA_JS_EXEC_MODE` (`off` / `ask` / `semi-auto` / `auto`) instead; `VENIRA_SHELL_EXIT_EARLY`, `VENIRA_SHELL_TIMEOUT_POLICY` (always `hard`), `VENIRA_SHELL_ENV_PASS_ALL`, `VENIRA_SHELL_ELICIT`, `VENIRA_SECRET_ALLOW_REVEAL`, `VENIRA_AUDIT_FAST`, `VENIRA_CACHE_ALL` and `VENIRA_TRACE` (always on) — see `CHANGELOG.md` (merged into `VENIRA_SHELL_MODE`/`VENIRA_PERMISSION_MODE`). Setting an old var only logs a warning and is ignored.

Approvals are a guard rail, not a sandbox: a process running as the same OS user can read the approval key.

**Snapshot store (checkpoints)**

Checkpoints live outside every workspace, in one shared per-user folder, so every MCP client that opens the same project sees the same history:

```
%LOCALAPPDATA%\venira\snapshots\        (Linux: ~/.local/share/venira/snapshots, macOS: ~/Library/Application Support/venira/snapshots)
  my-app\              project.json  index\  blobs\
  my-app-6cb89aac\     a second workspace that is also called "my-app"
```

- Folder name = workspace folder name. The first workspace to claim a name keeps it (recorded in `project.json`); a different workspace with the same name gets a `-<hash8>` suffix. The same workspace always maps to the same folder, whatever the path casing or 8.3/symlink spelling.
- Override with `VENIRA_SNAPSHOT_ROOT` (shared root) or `VENIRA_SNAPSHOT_DIR` (exact folder, single project). Both must be absolute paths; a relative one fails with `[config_invalid]`.
- The file tools (read, write, edit, search, delete) refuse anything under the snapshot root or exact dir, the same way they refuse the data dir. Only `snapshot` touches the store.
- Retention is per project (`VENIRA_SNAPSHOT_KEEP`), so one busy project cannot push out another's checkpoints.
- Shell commands are guarded too: any read, write or delete operand inside the snapshot store is a hard deny in `balanced` / `strict` (`deny.protected_file_access`) and needs approval in `permissive`. `off` disables shell policy entirely, so keep checkpoints you cannot afford to lose in a separate backup as well.
- Unreadable checkpoints are reported, never dropped silently. `snapshot action=list` adds `unreadable[]` (`snapshot_version_unsupported` = written by a newer venira-mcp, `snapshot_corrupt` = broken index file) and a hint. While any index is unreadable, blob cleanup is paused (`gc_skipped: "unreadable_manifests"` on delete), because that index still owns blobs this build cannot enumerate. For the first case upgrade venira-mcp; for the second, remove the broken `index\<id>.json.gz` yourself (agent shell access to the store is denied by design) and cleanup resumes.
- Manifests carry a `version`. Older layouts are upgraded in memory when read (`MIGRATIONS` in `lib/snapshot-store.ts`); the file on disk is never rewritten.

**Backing up the store**

The store is plain files: immutable content-addressed `blobs\<ab>\<sha256>`, gzip manifests in `index\` written by write-then-rename, and `project.json` naming the owning workspace. A backup is a folder copy; a restore is copying it back to the same location (a checkpoint only restores into the workspace recorded in its manifest).

- Run the copy yourself, outside the agent: shell policy denies the store to agent commands.
- Copy the shared root (`VENIRA_SNAPSHOT_ROOT`) to cover every project, or one project folder. Windows: `robocopy "%LOCALAPPDATA%\venira\snapshots" "D:\backup\venira-snapshots" /E`; Linux/macOS: `rsync -a ~/.local/share/venira/snapshots/ /mnt/backup/venira-snapshots/` (macOS: the `Application Support` path above).
- Do it while no agent is creating or deleting checkpoints. If you copy in two passes, take `index\` first and `blobs\` second: a blob is always written before the manifest that references it, so that order cannot capture a manifest without its blobs, while the reverse order can. Blobs without a manifest are harmless leftovers.
- After restoring a backup, `snapshot action=list` should show the expected count and no `unreadable` entries.

**Mirroring the store (optional)**

Set `VENIRA_SNAPSHOT_MIRROR_DIR` to an existing absolute folder and venira keeps a second copy there, with no cloud SDKs, credentials or network code of its own (point it at a OneDrive/Dropbox folder, NAS share, USB drive or rclone mount and let that tool move the bytes).

- Same layout as the store (`<mirror>\<project>\project.json`, `index\`, `blobs\`), so restoring is copying the folder back to the store location; there is no separate format.
- After every `snapshot action=create` the result carries `mirror` (`status`, `copied_blobs`, `copied_indexes`, `bytes`, `failed[]`, `error`). It is best-effort: a mirror problem never changes the checkpoint's own status. `snapshot action=mirror` runs the same sync on demand; add `verify=1` to re-hash every blob already at the mirror and re-copy bad ones.
- Order is blobs, then indexes, then `project.json`, so the mirror never holds a checkpoint whose blobs are missing. Every copy is verified (blob sha256 equals its file name; index bytes equal the source) before it gets its final name. A corrupt local blob blocks only the checkpoints that use it.
- Append-only: venira never deletes anything at the mirror. A checkpoint pruned locally (`VENIRA_SNAPSHOT_KEEP`) or deleted stays at the mirror until you remove it by hand, so expect it to grow; the only overwrite is `verify=1` replacing a file that no longer matches its source.
- Bounded: a run stops between files once its time budget is spent and reports `partial` / `timed_out`; run it again to resume (only missing files are copied). A first sync of a large store may need a few runs.
- Refused (`[config_invalid]`): a relative path, a folder that does not exist (venira never creates the mirror root, so an unmounted drive is not silently replaced by a local folder), and a folder that equals, contains or sits inside the local store or sits inside the workspace. A mirror folder already owned by a different workspace fails with `[mirror_conflict]`.
- The mirror folder is a protected root like the store: file tools refuse it and shell commands that read, write or delete inside it are denied.
- To restore after losing the store: copy `<mirror>\<project>` back to the store location (for example `%LOCALAPPDATA%\venira\snapshots\<project>`) with venira stopped, then `snapshot action=list`. Unreadable local indexes are not mirrored (they are counted in `skipped_unreadable`).

**Threats this does NOT protect against**: a malicious prompt can still instruct the agent to run destructive commands. Use a container/VM for untrusted workspaces — see [`ISOLATION.md`](./ISOLATION.md) for Docker, WSL 2 and Windows Sandbox setups, including mounts, network controls and their limits.

## 8. Envelopes & error codes

Success:

```jsonc
{ "ok": true, "status": "completed", "kind": "file_read", "data": { … }, "hint": "Next chunk: …", "elapsed_ms": 2.57 }
```

Failure:

```jsonc
{ "ok": false, "status": "failed", "error": { "code": "not_found", "message": "…", "retryable": false }, "hint": "Check with list_files first", "next_actions": [{ "tool": "list_files", "arguments": { "relative_path": "." } }] }
```

`ok` describes the tool operation. For `shell_run`, a command that ran and exited non-zero still has `ok: true`, but the envelope `status` names the command: `completed`, `failed`, `running`, `cancelled` (or `unknown` when the shell never reported an exit code). `command_status` repeats the same outcome in the shell vocabulary (`succeeded` / `failed` / `running` / `cancelled`) and `hint` says what to do next. A read batch with failed items reports top-level `ok: false`, `status: "partial"`, and `error.code: "batch_partial_failure"`; inspect `data.responses` for each result.

**Timestamps and ordering.** Every timestamp a tool reports is epoch **milliseconds** and says so in its field name (`started_at_ms`, `completed_at_ms`, `created_at_ms`, `timestamp_ms`); the only exception is the `since_unix` filter of `read_audit`, which takes seconds. Every "recent list" reads **newest first**: the audit rows, the checkpoints and the trace buffer.

**Counts vs. caps.** A tool that caps a list says so: `count` is what was found, `returned` is what came back, `omitted` is what the cap cut, and `limited: true` marks the cut (`symbol_references`, `search`, `list_files`).

In `compact` mode, shortened payloads set `trimmed: true` and `truncated: true`; `summary` describes omitted content. For an otherwise unsupported large payload, `data.preview_text` contains a bounded JSON-text preview and `summary` reports the original size and shape. Large error messages or attached error data are also explicitly marked as trimmed. Use `full` when the complete payload is required.

Common codes: `not_found`, `invalid_request`, `old_text_not_found`, `old_text_ambiguous`, `stale_content`, `repeated_failure`, `command_denied`, `shell_unavailable`, `path_escape`, `resource_limit`, `sensitive_result`, `unsupported`, `internal`.

## 9. Agent instructions (paste into `AGENTS.md` / `CLAUDE.md`)

```text
Venira MCP rules:
1. Unfamiliar task: call plan_read_batch first, then run steps[0].
2. Read with read_batch (up to 8 items). Never re-read a file a tool already returned.
3. Prefer edit_file / edit_batch over write_file; pass `reason` on every mutation.
4. Snapshot before multi-file or destructive changes.
5. Short commands: shell_run with background: 0. Long jobs: background: 1, then poll shell_status.
6. Do not call execute_js unless the user asked for JS; in `ask` mode it needs per-call approval. Network access is always open in every mode; in `semi-auto` the filesystem is limited to the workspace and the environment is scrubbed, in `auto` the containment is dropped.
7. On failure, follow the envelope's hint. Treat ok:false + retryable:false as final.
8. Report only what the tool returned.
9. On [approval_required]: stop, tell the user the approval_id and approve_command, do not loop or approve it yourself; retry once with data.approval.retry_with after they confirm. Use dry_run: 1 to preview a command's tier.
```

## 10. Development

```bash
npm run build       # tsc → dist/  (verify launches dist/server.js, so rebuild before verifying)
npm run smoke       # in-process sanity check
npm run doctor      # 15 preflight checks
npm run verify      # 579 behavioural + security checks
npm run coverage:shell  # V8 coverage for lib/shell-*.ts (report only, no thresholds)
npm run bench:mcp   # end-to-end numbers
```

**Adding a tool**:
1. Register in `tools/project.ts` → `registerProjectTools`, use the `config(title, meta, annotations)` helper (`meta` is only `speed_profile` + `batch_safe`), and add the model-facing wording (about / use / avoid / out) to `TOOL_DOCS` in `tools/project-docs.ts`; `test:tool-schema` fails for a tool without an entry.
2. Read-only: route through `executeCached`; mutations: add to `MUTATING` set.
3. Envelope: use `buildEnvelope` / `errorEnvelope` from `lib/output.ts`.
4. Add a check in the matching section module under `scripts/verify/` (`scripts/verify.ts` only orchestrates); update the decision tree in `server.ts` INSTRUCTIONS.
5. `npm run build && npm run verify && npm run bench:mcp` — paste numbers in the PR.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `not_found` on a path that looks fine | Run `npm run doctor`; confirm `VENIRA_WORKSPACE` points where you think |
| `path_escape` | Path resolves outside workspace; use a workspace-relative path |
| Shell command not finishing | `shell_status` with `wait_seconds: 300`; check `health` → `shells.active` |
| `better-sqlite3` build failure | Unusual platform; run `npm rebuild better-sqlite3` with build tools, or use the Docker image |
| SQLite binding unavailable | The server still starts. Audit writes are skipped in the default best-effort mode; set `VENIRA_AUDIT_STRICT=1` to fail operations that cannot be recorded. Install/rebuild `better-sqlite3` to restore the audit trail. |
| `venira.db` won't open | Another process has the WAL locked; make sure only one server writes to the same data dir |
| Everything slow | `health` → `queue.depth` and per-op p95 |

## License

Licensed under the **GNU Affero General Public License v3.0 (AGPLv3)** — see [`LICENSE`](./LICENSE).

Free for developers, individual use, and open-source projects. Embedding Venira into proprietary closed-source services or commercial agent platforms requires a commercial license from the author.
