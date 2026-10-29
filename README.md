# venira-mcp

> Fast, workspace-scoped **MCP server for coding agents** (OpenCode, Claude Desktop, any MCP client). 37 tools, structured JSON envelopes, validated read caches, async shell, code-intelligence (outline/symbols/diff/references/selective search), fuzzy edit, SQLite recent-files index, **git-free checkpoints/rollback**, **audit reasons ("why")**, **pull requests + GitHub Actions**, **encrypted secrets with rotation metadata**, **deterministic error diagnosis + read planning**, and full SQLite audit trail — **pure Node, no external binary, no GUI.**

```
┌──────────────┐   stdio (MCP)   ┌────────────────────────────────────────────┐
│ MCP client    │ ◄──────────────► │  venira-mcp (Node, single process)        │
│ (OpenCode,    │                  │  37 tools · read caches · async shell     │
│  Claude, ...) │                  │  SQLite audit (WAL) · p50/p95 metrics     │
└──────────────┘                  └────────────────────────────────────────────┘
```

- **Zero external dependencies.** Only Node ≥ 20 + `@modelcontextprotocol/sdk` + `zod` +
  `better-sqlite3`. No Rust binary, no database server, no `gh`/`git` binary for the
  API tools (`project_git` reads `.git/config` directly).
- **Network is opt-in by policy, off by switch.** Filesystem/shell/checkpoint tools never
  leave the machine. Only `project_pr_*` / `project_ci_*` talk to GitHub, and
  `VENIRA_NETWORK=0` turns every outbound call into `network_disabled`.
- **Workspace-locked by default.** Every path is validated inside the workspace; `../` escape
  is rejected with `path_escape`.
- **Validated read cache.** Reads are cached and re-validated by `mtime + size`, so external
  edits or deletes never return stale content.
- **Async shell.** `project_shell_run` returns a `run_id` in ~5 ms; poll with
  `project_shell_status` (5–30 s observation window, deliberately non-queued).
- **Full observability.** `project_health` reports capability state, queue depth, cache
  hit-rates, active shells, and p50/p95/max per operation.
- **Audit trail.** Every operation (including failures, shell runs, and cancellations) is
  written to a SQLite WAL table (`project_tool_audit`). Mutations accept a `reason` ("why"),
  stored in the same row so the intent survives later conversations.
- **Checkpoints without git.** `project_snapshot` stores content-addressed copies of the
  workspace (deduplicated) and restores them atomically — roll back a risky refactor in one call.
- **Pull requests and CI in the same loop.** `project_pr_create` / `project_pr_comment` /
  `project_pr_merge` and `project_ci_status` / `project_ci_trigger` / `project_ci_logs`
  drive GitHub REST + Actions without shelling out to `gh`.
- **Secrets that never appear in a transcript.** `project_secret` keeps tokens encrypted
  (AES-256-GCM) at rest and injects them into commands via `secret_env`, so a token never
  lands in a command string, the audit log or the model context.

## 1. Table of contents

- [Quick start](#2-quick-start)
- [MCP client configuration (JSON)](#3-mcp-client-configuration-json)
- [Tools](#4-tools-37)
- [Architecture](#5-architecture)
- [Security model](#6-security-model)
- [Benchmark](#7-benchmark)
- [Envelopes, hints, and error codes](#8-envelopes-hints--error-codes)
- [Pros / cons (honest)](#9-what-this-project-does-well--what-it-does-not)
- [Interesting details](#10-interesting-details--things-you-should-know)
- [Development workflow](#11-development-workflow)
- [Troubleshooting](#12-troubleshooting)
- [Contributing](#13-contributing)
- [Changelog & roadmap](#14-changelog--roadmap)
- [CI/CD](./CI-CD.md)
- [Docker](./DOCKER.md)

---

## 2. Quick start

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20.0 | Ships `node:sqlite` (audit inspection) and full ESM |
| Git | any | — |

That's it. There is no external binary to build or download.

### Run in 30 seconds (npm, recommended)

```bash
npm install -g venira-mcp             # or: npx venira-mcp (no install)
```

Once the package is published, `npx` fetches it to a temp dir and runs it —
no local clone or build needed:

```bash
npx venira-mcp                        # start the MCP server (stdio)
npx venira-mcp --doctor               # run the preflight suite
npx venira-mcp --verify               # run the behavioural regression suite
npx venira-mcp --version              # print the version
npx venira-mcp --help                 # list flags + environment variables
```

The `bin` entry in `package.json` exposes both `venira` and `venira-mcp`.
`npx` resolves packages by name, so the short form must name the package
explicitly — `npx -p venira-mcp venira` — or install it once globally with
`npm i -g venira-mcp` and then call `venira`.

### Run from source (developers)

```bash
git clone https://github.com/N0moreher0/Venira-mcp.git venira-mcp
cd venira-mcp
npm install
npm run build          # tsc → dist/
npm start              # stdio MCP server (attach via your MCP client, or pipe JSON manually)
```

### Run in Docker (no Node on the host)

```bash
# Build locally
docker build -t venira-mcp .

# Run your project as the workspace
docker run --rm -it \
  -v /path/to/your/project:/workspace \
  -e VENIRA_WORKSPACE=/workspace \
  -e VENIRA_DATA_DIR=/workspace/data \
  venira-mcp

# Preflight inside the container (same flags as the npx CLI)
docker run --rm -v /path/to/your/project:/workspace venira-mcp --doctor
```

Published images are also available from GitHub Container Registry:

```bash
docker run --rm -it -v "$PWD:/workspace" ghcr.io/n0moreher0/venira-mcp:latest
```

See [`DOCKER.md`](./DOCKER.md) for multi-arch builds and MCP-client
integration over Docker.

### One-shot sanity checks (no MCP client required)

```bash
npm run smoke    # in-process: list a dir, read package.json, verify path-escape is blocked
npm run doctor   # 7 preflight checks: workspace, data dir, tool count, health, shell, version
npm run verify   # end-to-end MCP test suite (~30 checks: cache, batch, shell, audit, modes)
npm run bench    # in-process corehost-tier benchmark (read throughput, batch, parallel)
npm run bench:mcp# end-to-end MCP benchmark (first call, batch 8, search, health, …)
```

---

## 3. MCP client configuration (JSON)

### 3.1 OpenCode (`opencode.jsonc` or `.opencode/opencode.jsonc`)

The simplest form (uses `npx`, no local install needed):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["npx", "venira-mcp"],
      "enabled": true,
      "environment": {
        "VENIRA_WORKSPACE": "C:\\path\\to\\your-project",
        "VENIRA_UNRESTRICTED": "0"
      }
    }
  }
}
```

Or point at a local build (after `git clone` + `npm install` + `npm run build`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["node", "C:\\path\\to\\venira-mcp\\dist\\server.js"],
      "enabled": true,
      "environment": {
        // Root of the workspace. All relative paths resolve against this.
        // Defaults to the server's process.cwd() when unset.
        "VENIRA_WORKSPACE": "C:\\path\\to\\your-project",
        // Where the audit DB (venira.db) lives. Defaults to <workspace>/data.
        "VENIRA_DATA_DIR": "C:/path/to/data",
        // Lock every path to the workspace. KEEP this unset (or "0") in normal use.
        "VENIRA_UNRESTRICTED": "0",
        // Default shell for project_shell_run: "powershell" | "cmd" | "bash"
        "VENIRA_DEFAULT_SHELL": "powershell",
        // Shell policy: balanced | strict | permissive | off
        "VENIRA_SHELL_MODE": "balanced",
        // Tool permission mode: manual | best_effort | allow_all
        "VENIRA_PERMISSION_MODE": "allow_all",
        // "full" | "compact" | "summary" (default "full")
        "VENIRA_OUTPUT_MODE": "full",
        // Set to "1" for pretty-printed JSON in tool results (costs bytes; leave off for agents).
        "VENIRA_PRETTY": "0",
        // Enable optional JS execution tool (default "1"). Set "0" to disable.
        "VENIRA_ALLOW_JS_EXEC": "1",
        // Set to "1" for fast audit DB mode.
        "VENIRA_AUDIT_FAST": "1",
        // Read cache budget in bytes (default 64 MiB).
        "VENIRA_READ_CACHE_BYTES": "67108864",
        // P1: cache control. "0" disables the listed caches (strict "always fresh").
        "VENIRA_CACHE_ALL": "1",
        // P1: request tracing to stderr.
        "VENIRA_TRACE": "0",
        // P1: shell UX — tail cap, early-exit poll, soft|hard timeout policy.
        "VENIRA_SHELL_TAIL_MAX": "4000",
        "VENIRA_SHELL_EXIT_EARLY": "0",
        "VENIRA_SHELL_TIMEOUT_POLICY": "soft",
        // P2: fuzzy edit fallback for project_edit_file.
        "VENIRA_EDIT_FUZZY": "0"
      }
    }
  }
}
```

> This repo ships a ready-to-edit copy at [`opencode.example.json`](./opencode.example.json).

### 3.2 Claude Desktop / any MCP client (`claude_desktop_config.json` or `.mcp.json`)

```jsonc
{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "C:\\path\\to\\your-project",
        "VENIRA_DATA_DIR": "C:\\path\\to\\your-project\\data",
        "VENIRA_UNRESTRICTED": "0",
        "VENIRA_DEFAULT_SHELL": "powershell"
      }
    }
  }
}
```

> For a local build (not yet published to npm), use
> `"command": "node", "args": ["C:\\path\\to\\venira-mcp\\dist\\server.js"]`
> instead of `npx`.

### 3.3 Environment variables (full reference)

| Variable | Default | Description |
|---|---|---|
| `VENIRA_WORKSPACE` | `process.cwd()` | Root of the workspace. All relative paths resolve against this; absolute paths outside it are rejected unless unrestricted. |
| `VENIRA_DATA_DIR` | `<workspace>/data` | Where the audit DB (`venira.db`) is created/updated. |
| `VENIRA_UNRESTRICTED` | `"0"` | `"1"` disables workspace locking (absolute paths anywhere work). **Do not set in production.** |
| `VENIRA_DEFAULT_SHELL` | platform default | `powershell` / `cmd` / `bash` used when `project_shell_run` receives no `shell` argument. |
| `VENIRA_PERMISSION_MODE` | `"allow_all"` (MCP standalone) | `"manual"` / `"best_effort"` / `"allow_all"` permission mode for coding tool calls. |
| `VENIRA_ALLOW_JS_EXEC` | `"1"` | `"0"` disables optional `project_execute_js` (code execution capability). |
| `VENIRA_SHELL_MODE` | `balanced` | Shell policy mode: `balanced` (deny catastrophes, ask on high risk, allow the rest) · `strict` (allow list + approval for everything else) · `permissive` (only hard denials) · `off` (no policy at all). |
| `VENIRA_SHELL_POLICY_FILE` | unset | **Explicit** path to a JSON policy (`{ mode, allow[], ask[], deny[] }`). Never read from the workspace, so a cloned repo cannot ship its own permissive policy. |
| `VENIRA_SHELL_APPROVAL_TTL_MS` | `600000` (10 min) | Lifetime of approval tokens and session grants. |
| `VENIRA_SHELL_ELICIT` | `"0"` | `"1"` = ask the user through MCP elicitation (when the client supports it) instead of only returning `approval_required`. |
| `VENIRA_SHELL_MAX_OUTPUT_BYTES` | `1048576` (1 MiB) | Per-stream cap; the excess is dropped and reported as `dropped_bytes`. |
| `VENIRA_SHELL_MAX_TIMEOUT_MS` | `1800000` (30 min) | Upper bound for `timeout_ms` (0 = no timeout unless the caller asks for one). |
| `VENIRA_SHELL_ENV_PASS_ALL` | `"0"` | `"1"` passes the full parent environment to the child. Default: allow list only, so agent secrets never reach a command. |
| `VENIRA_SHELL_ENV_ALLOW` | unset | Extra comma-separated env var names to pass through (e.g. `GITHUB_TOKEN`). |
| `VENIRA_DISABLE_TOOLS` | unset | Comma-separated tool names to keep out of `tools/list` entirely (e.g. `project_shell_run,project_delete_path`). |
| `VENIRA_OUTPUT_MODE` | `full` | `full` = complete payloads · `compact` = summary when >8 KB · `summary` = always trimmed previews. |
| `VENIRA_PRETTY` | `"0"` | `"1"` = 2-space pretty JSON in tool results. |
| `VENIRA_SESSION_ID` | auto (`opencode-<pid>-<rand>`) | Session tag; audit rows are grouped by it. Useful for verification / parallel test runs. |
| `VENIRA_READ_CACHE_BYTES` | `67108864` (64 MiB) | Budget for read + info caches. |
| `VENIRA_LIST_CACHE_MS` | `1500` | TTL for directory listing cache. |
| `VENIRA_SEARCH_CACHE_MS` | `3000` | TTL for search result cache. |
| `VENIRA_RECENT_CACHE_MS` | `2000` | TTL for recent-files cache. |
| `VENIRA_BATCH_ITEM_BYTES` | `524288` (512 KB) | Per-item cap inside `project_read_batch`. |
| `VENIRA_DEBUG_STARTUP` | `"0"` | `"1"` = startup errors go to stderr instead of the protocol-safe stdout event. |
| `VENIRA_CACHE_ALL` | `"1"` (on) | P1: `"0"` disables **every** read-side cache (strict "always fresh" mode). |
| `VENIRA_CACHE_LIST_ONLY` | `"1"` (on) | P1: `"0"` disables only the `list_files` TTL cache. |
| `VENIRA_CACHE_SEARCH_ONLY` | `"1"` (on) | P1: `"0"` disables only the `search` TTL cache. |
| `VENIRA_TRACE` | `"0"` | P1: `"1"` logs every tool call (op, args, ms, cached, ok/fail) to stderr. |
| `VENIRA_TRACE_FILE` | unset | P1: write trace logs to a file instead of stderr. |
| `VENIRA_SHELL_TAIL_MAX` | `4000` | P1: tail buffer cap in bytes for `project_shell_run`/`status` output. |
| `VENIRA_SHELL_EXIT_EARLY` | `"0"` | P1: `"1"` — `project_shell_status` returns as soon as the exit code is known, without waiting out the full `wait_seconds` window. |
| `VENIRA_SHELL_TIMEOUT_POLICY` | `soft` | P1: `soft` (default) = an expired command only warns and is left to finish; `hard` = kill the whole process tree at the timeout. |
| `VENIRA_EDIT_FUZZY` | `"0"` | P2: `"1"` enables fuzzy matching in `project_edit_file` (Levenshtein fallback when the exact `old_text` is not found). |
| `VENIRA_SNAPSHOT_KEEP` | `20` | Checkpoints kept before the oldest are pruned (and unreferenced blobs garbage-collected). |
| `VENIRA_SNAPSHOT_MAX_FILES` | `4000` | Per-checkpoint file cap; exceeding it marks the checkpoint `truncated` (never silent). |
| `VENIRA_SNAPSHOT_MAX_FILE_BYTES` | `33554432` (32 MiB) | Files larger than this are skipped and reported in `skipped[]`. |
| `VENIRA_SNAPSHOT_MAX_BYTES` | `536870912` (512 MiB) | Per-checkpoint logical byte cap (the caller can lower it, never raise it). |
| `VENIRA_NETWORK` | `"1"` | `"0"` is a hard kill switch: `project_pr_*` / `project_ci_*` return `network_disabled` and never open a socket. |
| `VENIRA_GITHUB_API_URL` | `https://api.github.com` | API base (GitHub Enterprise: `https://<host>/api/v3`). Must be **https**; plain http is only accepted for localhost mock servers (or with `VENIRA_GITHUB_ALLOW_HTTP=1`, for tests). |
| `VENIRA_GITHUB_ALLOW_HTTP` | unset | `"1"` allows a non-https API base. Only for local test servers — tokens over plaintext are a leak. |
| `VENIRA_GITHUB_REPO` | unset | Fallback `owner/name` when the caller omits `repo`. Resolution order: `repo` arg → this env → `.git/config` `origin` URL. |
| `VENIRA_GITHUB_TOKEN` | unset | Fallback token when the encrypted secret store has no `GITHUB_TOKEN`. The token is attached as a header and dropped on cross-origin redirects. |
| `VENIRA_SECRET_ALLOW_REVEAL` | unset | `"1"` allows `project_secret action=get reveal=true` to return plaintext. Off by default: agents get metadata (length + sha256 prefix) only. |

---

## 4. Tools (37)

Every tool returns the standard envelope ([§8](#8-envelopes-hints--error-codes)):

```jsonc
{
  "ok": true,
  "status": "completed",
  "request_id": "8f3a…c2",
  "kind": "file_read",
  "data": { … },
  "truncated": false,        // optional
  "hint": "Next chunk: …",   // optional, self-explanatory next action
  "cached": true,            // optional, true when served from cache
  "elapsed_ms": 2.57
}
```

### 4.1 Read family (read-only, batch-safe, cached)

| Tool | Purpose | Notes |
|---|---|---|
| `project_list_files` | List files/dirs, depth 1–3, limit ≤ 200 | TTL cache 1.5 s, invalidated on any mutation |
| `project_read_file` | Read a text file, by line range (1-based) | mtime+size-validated cache; `next_start_line` when truncated; optional `line_numbers` prefix |
| `project_read_ranges` | Read **multiple disjoint line ranges of one file** in a single call (max 16) | Reuses the read cache per range |
| `project_get_file_info` | File/dir metadata: kind, size, mtime | Very fast; cached |
| `project_search` | Search by file name, dir name, literal content, regex, or symbol definition | TTL cache 3 s; respects `glob`, `exclude_glob`, `context_lines`, `count_only` |
| `project_recent_files` | Files modified recently (SQLite index first, bounded scan fallback) | `source: "index" | "fallback_scan"`; includes `session_edits` — files you wrote in this session |
| `project_read_batch` | Run up to **8 read-only ops in one call** (`list_files`, `read_file`, `get_file_info`, `search`) | Sequential + cached; response budget enforced per item |
| `project_health` | Server diagnostics: capability, queue, cache/trace/shell config, active shells, p50/p95 per op, audit DB stats | `include_audit=false` skips the DB query (~2 ms) |
| `project_read_audit` | Read recent rows from the SQLite audit log (filter by session/operation/outcome) | Bounded; `audit_unavailable` fallback if the DB is locked |
| `project_trace_status` | Show the most recent traced tool calls + trace config | In-memory ring buffer, no file read |

### 4.2 JS Execution family (code execution, sandboxed by workspace)

| Tool | Purpose | Notes |
|---|---|---|
| `project_execute_js` | Run synchronous JavaScript code; spawns `node` in the workspace with `require` support | `code`: the JS script string (required) · `timeout_ms`: 1–600_000 ms (default 30_000) · `argv`: additional arguments passed to `node` · stdout/stderr tails capped at 1 MiB. Inherits a whitelist env (PATH, HOME, TERM); NODE_PATH points to workspace's `node_modules`. Use for lightweight JS computation, file I/O via `fs`, or quick prototyping. Avoid when you need a shell pipeline or a long-running process (`project_shell_run` is the right tool). The tool has `destructiveHint: true` because code execution can have unexpected side effects. |

### 4.3 Code intelligence family (P2/P3, regex/LCS-based, no external indexer)

| Tool | Purpose | Notes |
|---|---|---|
| `project_outline_symbol` | Parse a source file and return its symbol outline (functions, classes, types, interfaces) with line numbers | Fast single-file regex scan; `max_symbols` cap |
| `project_file_symbols` | Extract **all** symbols (fn/def/class/struct/interface) from one source file | Optional `language` hint; `include_functions`/`include_classes` filters |
| `project_diff_files` | Unified (git-style) diff between two workspace files | LCS-based; `lines_added`/`lines_removed`; `context_lines` + `max_lines` caps; `truncated` flag |
| `project_symbol_references` | Find every occurrence of a named symbol | `scope: "file"` (fast, single file) or `scope: "workspace"` (bounded content search); `limit`/`max_references` caps |
| `project_selective_search` | Smart multi-query search: combine patterns with AND/NOT + fuzzy scoring | Bounded to a file set (`files_hint` or shallow listing); scored hits sorted by relevance; `limit` cap |

### 4.4 Write family (mutating)

| Tool | Purpose | Notes |
|---|---|---|
| `project_write_file` | Create / overwrite / append a file | `mode: "create"` errors if file exists; `expected_sha256` guards against blind overwrites; `reason` recorded in the audit log |
| `project_edit_file` | Replace exact text: one `old_text`/`new_text` pair **or** up to 64 `edits[]` | `replace_all` supported; `expected_sha256` available; `reason` (e.g. "fix null pointer at line 45") recorded in the audit log; **P2 fuzzy edit** (`VENIRA_EDIT_FUZZY=1`): `old_text_fuzzy`, `fuzzy_distance`, `ignore_indentation`, `case_insensitive` args |
| `project_create_directory` | Create a directory tree | `create_parents` defaults to `true`; optional `reason` |
| `project_create` | Create a **file or directory in one call** | `kind: "file"` requires `content`; `kind: "directory"` ignores `content`; optional `reason` |
| `project_delete_path` | Delete a file or directory tree | `recursive: true` for directories. **Not undoable.** Optional `reason` |

### 4.5 Checkpoints (snapshot + rollback, no git)

| Tool | Purpose | Notes |
|---|---|---|
| `project_snapshot` | Save the current state before a large edit chain; roll back in one call | `action: "create"` (paths default `["."]`) → `id`; `action: "list"`; `action: "restore"` (`id`, optional `dry_run`, `verify=true`, `delete_extra=false`, `paths[]` filter); `action: "delete"` (`id`) |

Content-addressed and deduplicated: blobs live under `snapshots/blobs/<ab>/<sha256>`, manifests
(`.json.gz`) under `snapshots/index/<id>.json.gz` in `VENIRA_DATA_DIR` (default `<workspace>/data`).
A second checkpoint after a small edit only stores the changed bytes. Restore is atomic per file
(temp + rename), concurrency 4, sha256-verified by default, and only rewrites paths that were
captured (it never touches anything else unless `delete_extra=true`, which is capped at 500 files).
`.git`, `node_modules`, `dist`, `build`, `.next`, virtualenvs, `__pycache__`, the checkpoint store,
the audit DB, and the secret store (`secrets.json` / `secrets.key`) are skipped by default; symlinks
are never followed (and a restore refuses a
captured path whose parent directory became a symlink after the checkpoint); a checkpoint only
restores into the workspace it was created from; old checkpoints are pruned
(`VENIRA_SNAPSHOT_KEEP`, default 20).

```jsonc
// create  → { id: "snap-20261029-090309-cce15f", file_count: 42, total_bytes: 3312, new_blob_bytes: 3312 }
project_snapshot({ action: "create", paths: ["src"], label: "before auth refactor", reason: "try a risky refactor" })
// ...edits...
project_snapshot({ action: "restore", id: "snap-…", dry_run: true })   // inspect first
project_snapshot({ action: "restore", id: "snap-…" })                  // roll back
```

### 4.6 Git provider: pull requests (GitHub REST, no `gh` binary)

| Tool | Purpose | Notes |
|---|---|---|
| `project_pr_create` | Open a pull request for the current (or explicit) branch | `title` required · `head` defaults to the current branch · `base` defaults to the repo default branch (cached 5 min) · `body`, `draft`, `repo`, `reason`. Returns `number`, `url`, `state`, `head`, `base`. |
| `project_pr_comment` | Post a comment on a PR: general thread comment **or inline review note** | `pr` accepts a number **or** a full PR URL · `body` (markdown) · for an inline note add `path` + `line` (plus optional `start_line`, `side: RIGHT\|LEFT`, `commit_id`) and it switches to the pull review-comment API · `commit_id` defaults to the **PR head sha** (GitHub requires it whenever `line` is used) · `repo`, `reason`. Returns `inline`, `path`, `line`, `commit_id`, `comment_id`, `url`. |
| `project_pr_merge` | Merge a PR and optionally delete the head branch | `method: merge \| squash \| rebase` · `commit_title`, `commit_message`, `delete_branch` · `repo`, `reason`. A closed/already-merged PR returns `already_merged` instead of an error; a conflicting PR returns `conflict`. |

The token comes from `project_secret` (`GITHUB_TOKEN`), then `VENIRA_GITHUB_TOKEN`, then
`GITHUB_TOKEN` / `GH_TOKEN`. Owner/name are validated against `[A-Za-z0-9._-]`, so a crafted
`repo` value cannot inject a path or query string. Requests go over `node:https` with a timeout,
a response-size cap and manual redirect handling: the `Authorization` header is only attached
while the request still targets the API host.

```jsonc
project_pr_create({ title: "Add provider tools", head: "feature/x", reason: "open PR for review" })
// → { repo: "acme/demo", number: 7, url: "https://github.com/acme/demo/pull/7", state: "open", created: true }
project_pr_merge({ pr: 7, method: "squash", delete_branch: true })
```

### 4.7 CI provider: GitHub Actions (status / trigger / logs)

| Tool | Purpose | Notes |
|---|---|---|
| `project_ci_status` | Read the latest runs for a branch/workflow, one run **with its jobs**, or branch-protection **check-runs** | `branch`, `workflow` (file name or id), `limit` ≤ 50 → workflow runs; `run_id` → run + `jobs[]`; `ref` (sha/branch) or `pr` (resolved to the head sha) → `check_runs[]`. Returns `overall` (`success \| failure \| in_progress \| no_runs \| no_checks`). |
| `project_ci_trigger` | Dispatch a `workflow_dispatch` | `workflow` required · `ref` defaults to the current branch → default branch · `inputs` (≤ 10 string/number/boolean values), `reason`. |
| `project_ci_logs` | Read the tail of a run's or job's logs | `run_id` (ZIP parsed **in memory**) or `job_id` (narrower, cheaper) · `tail_lines` (default 500) · `max_bytes` (default 512 KB, cap 4 MB). Archive cap 32 MB, per-entry cap 4 MB, unsupported/encrypted entries are reported in `entries[].skipped`. |

Logs are never extracted to disk (no zip-slip) and never fully returned: the response is the
tail plus `entries[]`, `lines`, `truncated`, `dropped_lines` and `dropped_bytes`. The download
redirects to a pre-signed storage URL, and the token is dropped on that hop by design.

```jsonc
project_ci_status({ branch: "feature/x", limit: 3 })
// → { overall: "failure", runs: [{ id: 99, conclusion: "failure", url: "…/runs/99" }, …] }
project_ci_logs({ run_id: 99, tail_lines: 50 })   // or { job_id: 2 } to isolate a failing job
```

### 4.8 Secrets (encrypted at rest, never in the transcript)

| Tool | Purpose | Notes |
|---|---|---|
| `project_secret` | Store / inspect / remove credentials by env-var name, with rotation metadata | `action: "set"` (`value` or **`value_env`** to read it from the host env; optional `expires_in_days` or `expires_at`) · `"get"` (metadata only: `length`, `sha256_12`, `updated_at`, `expires_at`, `expired`, `days_left`, `last_used_at`, `use_count`, `rotated_at`) · `"list"` (same metadata per name) · `"delete"`. `reveal: true` returns plaintext **only** when the host sets `VENIRA_SECRET_ALLOW_REVEAL=1`. |

Rotation is tracked automatically: every successful injection (or provider token read) bumps
`last_used_at` / `use_count`; a re-`set` is a rotation that overwrites the value, resets the
counter and keeps the previous expiry unless a new one is given. Expired secrets are **refused**
before a child process starts (`secret_expired`, with a rotate hint), so a dead token can never
silently fail as a `401`.

Values are encrypted with **AES-256-GCM** in `<VENIRA_DATA_DIR>/secrets.json`, with the key in
`secrets.key` (mode `0600`, written via temp file + rename). The preferred way to *use* a secret
is injection, not disclosure:

```jsonc
project_secret({ action: "set", name: "NPM_TOKEN", value_env: "NPM_TOKEN" })  // value never in the call
project_shell_run({ command: "npm publish --dry-run", shell: "bash", secret_env: ["NPM_TOKEN"] })
// → the child gets NPM_TOKEN in its environment; the tool returns secret_env: ["NPM_TOKEN"],
//   and every stored value is scrubbed from the output tails and the audit text ([REDACTED]).
```

- Names must match `[A-Za-z_][A-Za-z0-9_]{0,63}`; loader-hijacking names (`NODE_OPTIONS`,
  `LD_PRELOAD`, `DYLD_*`, `PYTHONSTARTUP`, `PYTHONPATH`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`,
  `GIT_SSH_COMMAND`) are rejected.
- `secret_env` takes ≤ 16 names, is validated **before** the policy gate and decrypted only
  **after** approval — so a denied command never sees a value.
- Values ≥ 8 chars are redacted from `stdout_tail` / `stderr_tail` and from the audit
  `command`/`reason` columns. The secret store itself is excluded from checkpoints and
  `delete_extra`, so a rollback can never copy ciphertext (or the key) elsewhere.

### 4.9 Diagnostics & read planning (deterministic, no model call)

| Tool | Purpose | Notes |
|---|---|---|
| `project_explain_error` | Turn a failure into a cause + next tool calls | Feed `error_text` or `log_tail` (e.g. the tail from `project_ci_logs` / `project_shell_status`). Matches a rule table (POSIX errno, TypeScript/Python/pytest, git, npm, GitHub, venira codes) and returns `matched`, `summary`, `error_line`, `language`, `diagnoses[]` (`rule_id`, `likely_cause`, `suggested_fix[]`, `retry_hint`, `next_actions[]`) and a deduped `next_actions[]`. Unknown signatures return `matched: false` with a triage note — never an error. |
| `project_plan_read_batch` | Plan which files to read for a task, in one call | `task_description` (one line) → keywords (quoted terms, identifiers, words) → up to 3 bounded content searches → candidates ranked by hit count (+ `files_hint`, + recent edits when the search is thin) → `steps[]` with a **ready-to-send** `project_read_batch` call, `estimated_ms`. Build/vendor dirs and DB/log/binary artifacts are excluded from candidates. `max_files` ≤ 8, `include_search: false` to plan from hints only. |

Both are pure local logic: no network, no model, no file contents in the response (the plan points
at files; you decide which step to run). They exist to cut the "guess → read → repeat" loop that
costs the most round-trips in an unfamiliar codebase.

```jsonc
project_explain_error({ log_tail: "Error: connect ECONNREFUSED 127.0.0.1:5432" })
// → { matched: true, diagnoses: [{ rule_id: "net.econnrefused", likely_cause: "Nothing is listening …",
//      suggested_fix: ["Start the dependency …", "Confirm the port …"] }] }

project_plan_read_batch({ task_description: "add retry handling to the GitHub client" })
// → { keywords: ["retry", "github", …], candidates: [{ relative_path: "lib/git-provider.ts", hits: 3 }],
//      steps: [{ tool: "project_read_batch", arguments: { requests: [ … ] }, why: "read the ranked candidates" }] }
```

### 4.10 Shell family (async, non-blocking, policy-gated)

| Tool | Purpose | Notes |
|---|---|---|
| `project_shell_run` | Run a shell command; returns `run_id` in ~5 ms | `shell`: `powershell` / `cmd` / `bash` · `relative_cwd` · `timeout_ms` (kills the **process tree**) · `secret_env: ["NAME"]` (inject stored secrets as env vars; values never enter the command, audit log or output) · `approval_token` + `approval_scope` for the approval flow. stdout/stderr tails captured in-process with a 1 MiB per-stream cap. P1 UX: `VENIRA_SHELL_TAIL_MAX`, `VENIRA_SHELL_EXIT_EARLY`, `VENIRA_SHELL_TIMEOUT_POLICY` (soft/hard). |
| `project_shell_status` | Poll a running command | `wait_seconds` 0–30 is an *observation window*, not a timeout. Deliberately **not queued** behind other calls, not audit-logged (prevents orphan "running" rows). Reports `timed_out`, `dropped_bytes` and the policy decision. |
| `project_shell_cancel` | Kill a running command by `run_id` | Kills the whole tree (`taskkill /T` on Windows, process group on POSIX). Also used at MCP shutdown to avoid orphan processes. |
| `project_shell_cancel_session` | Cancel **all** shell runs tracked in this session | P1; kills every process tree in the session at once. |

`project_shell_run` passes a policy gate before anything is spawned:

```jsonc
// 1) The command needs approval: nothing ran, a token comes back.
{ "ok": false, "error": { "code": "approval_required", "retryable": false },
  "data": { "rule": "ask.writes_outside_workspace", "reason": "This command writes or deletes outside the workspace.",
            "approval_token": "v1.1793…​.9xQ…", "expires_at": 1793176040000,
            "retry_with": { "tool": "project_shell_run", "arguments": { … } } },
  "hint": "Ask the user to confirm … retry project_shell_run with approval_token=…" }

// 2) The user approved: retry once with the token (optionally scope=session).
project_shell_run({ command: "…", approval_token: "v1.…", approval_scope: "session" })
```

Tokens are HMAC-signed, single-use, bound to the session **and** the exact command
hash, and expire after `VENIRA_SHELL_APPROVAL_TTL_MS`. `approval_scope: "session"`
additionally grants the same *rule + command head* (e.g. `git push`) for that TTL, so
an agent is not blocked on every invocation. Catastrophic commands are refused with
`command_denied` in every mode — no token can unlock them.

### 4.11 How the model is told to pick the right tool

At connect time the server advertises an `instructions` block (MCP SDK ≥ 1.32) containing a
**decision tree** the model can read. A condensed version:

```
1. Two+ reads or mixed read-only steps → project_read_batch (max 8, sequential + cached)
2. One file → project_read_file; large file → start_line/end_line or project_read_ranges;
   follow next_start_line when truncated
3. Find code → project_search (kind=literal_content or definition), then project_read_ranges around hits
4. Directory tree → project_list_files (depth 1..3, limit ≤200). "What changed lately?" → project_recent_files
5. Understand a file's structure → project_outline_symbol / project_file_symbols;
   find every usage → project_symbol_references; compare two files → project_diff_files;
   rank many files by several keywords → project_selective_search
6. Write whole file → project_write_file; small precise change → project_edit_file
   (fuzzy match via VENIRA_EDIT_FUZZY=1); delete → project_delete_path (destructive, not undoable)
   — always pass `reason` ("why") so the audit trail explains intent later
7. Before a large/multi-file change chain → project_snapshot action=create; if it goes wrong
   → action=restore id=… (dry_run first when unsure)
8. Build/test/long command → project_shell_run (returns run_id immediately),
   then poll project_shell_status (wait_seconds 5..30); project_shell_cancel to stop
9. A token/credential → project_secret action=set (prefer value_env; expires_in_days for
   rotation) or action=get/list for metadata; inject with project_shell_run secret_env=["NAME"]
   — never paste the value. Expired secrets are refused (secret_expired)
10. Open a PR → project_pr_create; discuss it → project_pr_comment (path+line for an inline note);
    land it → project_pr_merge
11. Pipeline state → project_ci_status (pr/ref for check-runs); re-run → project_ci_trigger;
    failure detail → project_ci_logs (pass job_id to isolate the failing job)
12. Something failed and the cause is unclear → project_explain_error (error_text / log_tail),
    then follow its first diagnosis + next_actions
13. Starting an unfamiliar task → project_plan_read_batch(task_description, files_hint?),
    then run steps[0] (a ready read_batch) instead of guessing files
14. Debug latency/errors → project_health; inspect the audit trail → project_read_audit
```

Every tool also carries machine-readable metadata in its description (`Use when:` / `Avoid when:` /
`Speed:` / `Output:` / `Batch-safe:`) and a `_meta.venira` object with the same fields, so both
prompt-driven and tool-discovery-driven clients get the same signal.

---

## 5. Architecture

```
venira-mcp/
├── server.ts                 # MCP entry point: McpServer + StdioTransport, warm-up, shutdown
├── tools/
│   └── project.ts            # 37 tool registrations, serial queue, caches, shell tracking,
│                             #   audit-DB inspection, project_health, code-intelligence,
│                             #   diagnostics and read-planning handlers
├── lib/
│   ├── corehost.ts           # In-process backend: file I/O, search, async shell,
│   │                         #   scope capability, SQLite WAL audit (better-sqlite3),
│   │                         #   fuzzy edit, recent-files index, secret_env injection
│   ├── git-provider.ts       # GitHub REST + Actions: PR create/comment/merge,
│   │                         #   CI status/dispatch/logs (in-memory ZIP), repo detection,
│   │                         #   https-only client with redirect token hygiene
│   ├── secrets.ts            # Encrypted secret store (AES-256-GCM, atomic writes),
│   │                         #   rotation metadata (expiry / last use / use count),
│   │                         #   expired-secret guard, redaction of values in output/audit
│   ├── diagnostics.ts        # Deterministic error rules (errno, TS/Python, git, npm,
│   │                         #   GitHub, venira codes) -> cause + ready next_actions
│   ├── read-plan.ts          # Deterministic read planner: keywords -> ranked candidates
│   │                         #   -> a ready project_read_batch call + estimate
│   ├── symbol-diff.ts        # P2/P3 code intelligence: symbol extraction, outline,
│   │                         #   unified diff (LCS), selective multi-query search
│   ├── snapshots.ts          # Checkpoints: content-addressed blobs + gzip manifests,
│   │                         #   create/list/restore/delete, sha256 verify, safe path scoping
│   ├── tracer.ts             # P1 request tracing (VENIRA_TRACE / VENIRA_TRACE_FILE)
│   ├── workspace.ts          # Workspace path resolution + escape validation + cache toggles
│   ├── output.ts             # Envelope builder, output modes, hint inference, error parser
│   ├── metrics.ts            # Ring-buffer p50/p95/max per operation (256 samples each)
│   ├── types.ts              # Shared host snapshot types
│   └── version.ts            # Exported VERSION constant
├── scripts/
│   ├── smoke.ts              # In-process backend sanity check
│   ├── bench.ts              # In-process backend benchmark
│   ├── bench-mcp.ts          # End-to-end MCP benchmark
│   ├── verify.ts             # 214 end-to-end checks (cache, batch, shell, audit, modes,
│   │                         #   snapshots, secrets/rotation, GitHub PR/CI/check-runs/inline
│   │                         #   comments against a local mock, diagnostics + read planning)
│   ├── github-mock.ts        # In-process GitHub API + pre-signed-blob mock (no network, no token)
│   └── doctor.ts             # 12 preflight checks (workspace, data dir, tools, health, shell, P1 config)
├── opencode.example.json     # Ready-to-edit OpenCode MCP config
├── package.json / tsconfig.json
└── dist/                     # Build output (committed to the npm package, gitignored in repo)
```

**Key design decisions**

- **In-process backend.** The `CoreHost` class in `lib/corehost.ts` implements every
  `project_tool.*` operation in pure Node — no JSON-Lines IPC, no child process. The
  `tools/project.ts` layer still funnels calls through a **serial queue** because
  SQLite WAL audit writes are cheap but not free; keeping one writer at a time is
  simpler and deterministic than racing on `better-sqlite3` transactions.
- **Long-lived capability.** The workspace scope (capability token, TTL 2 h) is opened
  **once** at startup (in parallel with the MCP handshake) and reused for every request.
  A capability expiry triggers exactly one re-open-and-retry.
- **Cache strategy.** Reads and file-info are cached and validated by `mtime + size`
  (immune to external edits and deletions). List / search / recent use short TTLs
  (1.5 s / 3 s / 2 s) and are wiped on any mutation. Search results with 0 hits are
  *not* cached (prevents stale "no match"). Read + info caches are bounded by
  `VENIRA_READ_CACHE_BYTES` (default 64 MiB) with LRU eviction.
- **Audit, not just logging.** `better-sqlite3` opens `venira.db` in WAL mode.
  Every `execute` op gets a `running` row on start and a `succeeded`/`failed`
  row on completion. `shell_status` is the only op intentionally *not* audited —
  a long poll must never leave an orphan `running` row. `project_health`
  (with `include_audit`) reports orphan rows as a post-mortem signal.

---

## 6. Security model

This project is intentionally **conservative by default**:

| Control | Default | How it works |
|---|---|---|
| **Workspace lock** | ON | `lib/workspace.ts` resolves every path against `VENIRA_WORKSPACE` (or `process.cwd()`). A path that escapes (`../..`, absolute outside root) throws `path_escape`. |
| **Unrestricted mode** | OFF | `VENIRA_UNRESTRICTED=1` disables the lock (use only when you fully understand the consequences — the agent can read/write anywhere on the machine). |
| **Shell cwd** | workspace | `project_shell_run` with no `relative_cwd` runs in the workspace root; the command itself is still whatever the agent passes. |
| **Shell policy** | `balanced` | Hard-coded catastrophes are always denied; risky operations (writes outside workspace, network fetches, package mutation, history rewrite…) require `ask` and receive a single-use, HMAC-signed approval_token. `VENIRA_SHELL_MODE` can be (`strict` / `permissive` / `off`) to adjust granularity. conversation can mark a command known-safe (allow-list) after guidance (the UI does not show raw commands). |
| **Audit** | ON | Every operation (including failures and cancellations) is written to `project_tool_audit` in a SQLite WAL database. |
| **`sensitive_result`** | — | The envelope carries `retryable: false` and a "do not retry" hint when content is withheld by policy. |
| **`expected_sha256`** | opt-in | `project_write_file` / `project_edit_file` / `project_create` accept a content hash; a mismatch aborts with `conflict` — protects against blind overwrites when the agent re-applies an old edit. |
| **Destructive ops** | labelled | Every mutating tool advertises `destructiveHint: true` in its MCP annotations; `project_delete_path` additionally documents that it is not undoable. |
| **Network (GitHub/CI)** | opt-in per call, kill switch | Only `project_pr_*` / `project_ci_*` make outbound calls. `VENIRA_NETWORK=0` disables all of them; the API base must be **https** (http only for localhost/tests), so a token is never sent in plaintext. |
| **Token transport** | header only | The GitHub token travels as an `Authorization` header, never in a command string or a URL. On the pre-signed log-download redirect it is **dropped** because the origin changed. |
| **Secrets at rest** | AES-256-GCM | Values are encrypted in `secrets.json`; `secrets.key` is `0600` and written atomically. `get`/`list` return metadata only unless `VENIRA_SECRET_ALLOW_REVEAL=1` *and* `reveal=true` are both set. |
| **Secret leakage** | redacted | Stored values (≥ 8 chars) are scrubbed from shell tails and from the audit `command`/`reason` columns; external ops log a summary (`PUT /pulls/7/merge repo=… method=squash`) instead of the body. Checkpoints and `delete_extra` skip the secret store. |

**Threats this does NOT protect against:** a malicious prompt can still instruct the agent to
run destructive shell commands (`rm -rf`, `format`…). The audit log and `project_health` make that
visible *after* the fact; the workspace lock only bounds filesystem access, not shell side-effects.
If you need hard boundaries, run the MCP server in a container / VM, or drop `VENIRA_DEFAULT_SHELL`
to a restricted shell profile.

---

### 6.1 Shell policy (hardening for `project_shell_run`)

`venira-mcp` ships with a built‑in policy that guards against the most common destructive patterns while
still enabling useful workflows:

| Level | What it does | When to use |
|---|---|---|
| `balanced` (default) | Never runs a command whose rule is `deny`. Commands matching **ask rules** (writes outside workspace, network access, package mutations, `git push --force`, etc.) return `approval_required` with a signed token. All other commands run. | General interaction with the workspace. |
| `strict` | Only commands on the **allow‑list** run without approval. Everything else requires approval. Allows a safe environment when you know exactly what tools an agent can invoke. | High‑value or public workspaces where you want to whitelist allowed tools. |
| `permissive` | Only the hard-coded `deny` rules block execution. All other commands run immediately. *Caution:* this removes the ask protection. | Internal debugging or trusted agents with strict code review. |
| `off` | No policy at all. Every shell command runs exactly as written. | Development workspaces where you control the sandbox manually. |

The exact list of ask / deny rules is documented in `lib/shell-policy.ts` and can be overridden by a JSON file at **`VENIRA_SHELL_POLICY_FILE`**:
```jsonc
{
  "mode": "balanced",
  "allow": [{ "command": "npm", "subcommands": ["ci", "test"] }],
  "ask": [{ "command": "git", "subcommands": ["push"], "reason": "Can rewrite history" }],
  "deny": [{ "command": "sh", "args_regex": ".*\\|.*\\s+curl.*" }]
}
```
The policy is **never read from the workspace** itself (a cloned repo cannot ship a permissive config).

Approval flow (what the UI sees)

1. An agent calls `project_shell_run`. The server evaluates the command.
2. If the result is `deny` → an `approved: false` envelope with `code: "command_denied"` (non‑retryable).
3. If the result is `ask` → an `approved: false` envelope with:
   - `code: "approval_required"`
   - `data.approval_token`: HMAC‑signed, bound to the session + command + issue time (expires after `VENIRA_SHELL_APPROVAL_TTL_MS`)
   - `data.rule` and `data.reason` (human‑readable)
   - `data.retry_with.tool` and `arguments.approval_token`
   - optional `data.retry_with.arguments.approval_scope`: `session` upgrades to a TTL grant for the same rule + command head (`git push` ≈ grant for push actions).
4. The UI can elicit input directly (`VENIRA_SHELL_ELICIT=1` uses `elicitInput` on a client that advertises `elicitation`) or can present a summarized one‑time rule (e.g., "Run `git push`?").
5. The user confirms. The UI retries `project_shell_run` with `approval_token` and optionally `approval_scope: "session"`.

Approvals are per‑session, per‑rule, per‑command hash. A token cannot be transferred between sessions.
`V1.<timestamp>.<HMAC>` format makes the token easy to parse but impossible to forge.

Runtime hardening (all modes)

- Process tree kill: timeouts and cancellations invoke `killTree()`, which on Windows uses `taskkill /F /PID /T` and on POSIX sends `SIGKILL` to the whole group. This prevents children (e.g., `npm test` → test runner) from surviving after the parent timeout.
- Output cap: by default 1 MiB per stream. Surplus is dropped and reported via `dropped_bytes`. Helps runaway builds from exhausting server memory.
- Environment whitelist: by default the shell inherits only `PATH`, `HOME`, `TERM`, `CI`, and a few other safe variables. Set `VENIRA_SHELL_ENV_PASS_ALL=1` or `VENIRA_SHELL_ENV_ALLOW=VAR1,VAR2` to broaden this.
- Timeout clamp: a caller can specify `timeout_ms`. The server caps it at `VENIRA_SHELL_MAX_TIMEOUT_MS` (default 30 min) and kills the process tree when exceeded.

Audit coverage (all shell calls)

Every shell command run is logged in `project_tool_audit` with columns:
- `decision` ("deny" | "ask" | "allow")
- `policy_rule` (e.g., `deny.pipe_download_to_shell`, `ask.cd_outside_workspace`)
- `command` (redacted for secrets)
- `approver` ("pending" | "user:token" | "user:session")

Audit reasons (all mutations)

Mutating tools (`project_write_file`, `project_edit_file`, `project_create`, `project_create_directory`,
`project_delete_path`, `project_snapshot`) accept an optional `reason` string — *why* the change was made
(e.g. `"sua loi null pointer o dong 45"`). It is normalized to a single line, secrets are redacted, the
length is capped at 400 chars, and it is stored in the additive `reason` column of `project_tool_audit`
(old DBs are migrated in place). `project_read_audit` returns the field, so a later session can ask
"what changed and why" without re-reading the diff.

```jsonc
project_edit_file({ relative_path: "src/auth.ts", old_text: "value == null", new_text: "value == null → guard",
                    reason: "fix null pointer at line 45" })
project_read_audit({ session_id: "…", operation: "edit_file" })
// → rows: [{ operation: "edit_file", outcome: "succeeded", reason: "fix null pointer at line 45", … }]
```

A long‑running command that times out or is killed is recorded with `reason_code: "timed_out"` (or `output_capped`). The `project_health` output includes `shells.policy` (mode, builtin rule counts) and `shells.policy.stats` (evaluated/asked/denied/approved/timed_out).

### 6.2 Secrets and outbound network (GitHub / CI)

These are the only two surfaces that leave the workspace, so they are deliberately narrow.

**Secrets.** `project_secret` is a small credential vault, not a config file:

1. `set` encrypts the value (AES-256-GCM, random IV per write) into `secrets.json` under the data
   dir, and writes the key to `secrets.key` (`0600`, temp file + rename) on first use. Prefer
   `value_env` so the value comes from the host environment and never appears in a tool call.
2. `get` / `list` return **metadata only** — name, byte length, `sha256_12`, `updated_at` — enough
   for an agent to confirm a credential exists without putting it in the transcript.
3. Plaintext is returned only when the caller passes `reveal=true` **and** the host sets
   `VENIRA_SECRET_ALLOW_REVEAL=1`; otherwise it fails with `reveal_denied`.
4. `project_shell_run secret_env: ["NAME"]` decrypts **after** the policy gate and adds the value
   to the child's environment. The command string, the audit row, `stdout_tail`/`stderr_tail` and
   `project_health` never contain the value; stored values (≥ 8 chars) are replaced with
   `[REDACTED]`.
5. Names are allow-listed (`[A-Za-z_][A-Za-z0-9_]{0,63}`) and loader-hijack names
   (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `PYTHONSTARTUP`, `PYTHONPATH`, `BASH_ENV`, `ENV`,
   `PROMPT_COMMAND`, `GIT_SSH_COMMAND`) are refused. `secrets.json` / `secrets.key` are excluded
   from checkpoints, restores and `delete_extra`.

**Network.** `project_pr_*` and `project_ci_*` talk to GitHub over `node:https`:

- `VENIRA_NETWORK=0` → every call returns `network_disabled` before a socket is opened.
- `VENIRA_GITHUB_API_URL` must be `https:` (http is accepted only for `localhost`/`127.0.0.1`
  test mocks, or when `VENIRA_GITHUB_ALLOW_HTTP=1` is explicitly set).
- Redirects are followed manually (max 5). The `Authorization` header is attached only while the
  request targets the API origin, so GitHub's 302 to a pre-signed log blob does not leak the token.
- Every request has a timeout; responses are size-capped; log archives are parsed in memory
  (32 MB archive / 4 MB entry / 8 MB text) with no extraction to disk.
- Errors are shaped for recovery: `auth_missing`, `auth_failed`, `not_found`, `conflict`,
  `rate_limited`, `forbidden`, `network_error`, `timeout`, `resource_limit`.

---

## 7. Benchmark

Numbers below are from a Windows 11 / NVMe / Node 20 machine, standalone build, 2026-10-27.
See [`benchmarks.md`](./benchmarks.md) for the full table and historical comparison.

### 7.1 End-to-end MCP (`npm run bench:mcp`)

| Scenario | avg | p50 | p95 | max |
|---|---|---|---|---|
| **First call** (post warm-up) | — | **2.5 ms** | — | — |
| `project_read_file` ×50, same file (cached) | 1.93 ms | 1.01 ms | 2.65 ms | 3.07 ms |
| `project_read_file` ×8, distinct files | 2.37 ms | 1.92 ms | 5.78 ms | 5.78 ms |
| `project_read_batch` ×3 (8 items each) | **4.18 ms** | 3.71 ms | 6.08 ms | 6.08 ms |
| `project_get_file_info` ×30 | 1.11 ms | 1.02 ms | 2.63 ms | 2.97 ms |
| `project_search` ×10 (literal content) | 3.38 ms | 1.26 ms | 21.76 ms | 21.76 ms |
| `project_read_ranges` (2 ranges) | 3.6 ms | — | — | — |
| `project_recent_files` | 5.0 ms | — | — | — |
| `project_health` (no DB query) | **1.8 ms** | — | — | — |

> **Reading the batch row:** 8 distinct reads cost **4.2 ms total** as one batch call,
> vs. ~8 × 2.4 ms ≈ 19 ms issued individually. That is the round-trip saving the decision
> tree in [§4.10](#410-how-the-model-is-told-to-pick-the-right-tool) is designed to exploit.

### 7.2 In-process tier (`npm run bench`)

| Scenario | Value |
|---|---|
| Direct first read (cold, includes capability open) | 19.96 ms |
| `read_file` sequential ×50 | avg 0.72 ms · p50 0.59 ms · p95 1.88 ms |
| 8-file batch sequential | 11.0 ms total |
| Parallel ×8 | 2.9 ms total |
| `get_file_info` ×50 | avg 0.30 ms |
| `list_files` | 12.7 ms |
| `search` (literal, `*.ts`) | 9.8 ms |
| `shell_run` + `shell_status` round-trip | ~930 ms (2 s wait budget dominates) |

### 7.3 Rust-backend v0.3.0 → standalone v1.0.0

| Metric | v0.3.0 (Rust IPC) | v1.0.0 (standalone) | Why |
|---|---|---|---|
| First MCP call | 6.3 ms | **2.5 ms** | No subprocess spawn |
| Cached read p50 | 2.57 ms | **1.01 ms** | In-process file I/O |
| 8-file batch avg | 19.11 ms | **4.18 ms** | No IPC + no audit lock |
| `project_health` | 5.5 ms | **1.8 ms** | In-process |
| Install surface | Rust binary + Node | **Node only** | `npm install` is the whole setup |

---

## 8. Envelopes, hints, and error codes

Every success and every failure is a single JSON object. On failure, the MCP result has
`isError: true` and the envelope looks like:

```jsonc
{
  "ok": false,
  "status": "failed",
  "request_id": "…",
  "kind": "read_file",
  "error": {
    "code": "not_found",
    "message": "Path does not exist: .verify-tmp/missing.txt",
    "retryable": false
  },
  "hint": "Check the path with project_list_files or project_search first; do not retry the same path.",
  "elapsed_ms": 4.12
}
```

| `error.code` | `retryable` | What it means |
|---|---|---|
| `not_found` | ✗ | Path does not exist |
| `invalid_request` | ✗ | Bad argument names/types |
| `conflict` | ✓ | File changed since read, or edit ambiguous — re-read and retry |
| `path_escape` | ✗ | Path outside the workspace (use `VENIRA_UNRESTRICTED=1` to opt out) |
| `scope_denied` | ✗ | Capability / permission mismatch |
| `resource_limit` | ✗ | Batch item too large or response budget exhausted — narrow the request |
| `io_error` | ✓ | File locked or disk busy — retry once |
| `audit_unavailable` | ✗ | Audit row could not be written — stop retrying |
| `capability_expired` | ✓ | Scope re-opens automatically on next call — retry once |
| `host_timeout` | ✓ | Backend didn't answer in time — check `project_health`, retry once |
| `host_unavailable` | ✓ | Backend is unavailable; it recovers on the next call — retry once |
| `sensitive_result` | ✗ | Content withheld by policy — do not retry or work around it |
| `unsupported` | ✗ | Operation unavailable in current permission mode |
| `internal` | ✗ | Unexpected error — check `project_health` and stderr |

Hints are **actionable next steps**, not prose: "Next chunk: `project_read_file({ relative_path:
"src/foo.ts", start_line: 1000 })`", "Poll `project_shell_status({ run_id: "r123", wait_seconds: 5 })`",
etc. The model is expected to read `hint` first.

---

## 9. What this project does well & what it does not

**Strengths**

- **Speed at the MCP layer.** ~2.5 ms first call, ~1 ms p50 cached reads, ~4.2 ms for an
  8-file batch. The in-process backend removes the IPC hop and the audit lock contention
  that dominated the v0.3.0 (Rust) profile.
- **Zero install friction.** `npm install && npm run build` is the entire setup. No Rust
  toolchain, no prebuilt binary, no database server.
- **Correctness of reads.** mtime+size validation means the cache can never serve content
  that no longer exists on disk (deleted, renamed, or edited externally).
- **Self-diagnosis.** `project_health` + `doctor.ts` + `verify.ts` give three independent
  viewpoints: runtime state, preflight, and behavioural regression.
- **Audit-grade traceability.** Every op, including failures and cancellations, lands in a
  SQLite table tagged by session — useful for post-mortems on what an agent actually did.
- **Agent-friendly contracts.** Envelopes, hints, `_meta` annotations, and a decision-tree
  `instructions` block mean the model rarely has to guess.

**Limitations (be honest about these)**

- **macOS CI-only, not dev-tested.** CI runs on `macos-latest` (x64 + arm64) for both Node
  20 and 22, but no developer has day-to-day macOS. Path handling is POSIX-correct
  (verified on Linux), but Spotlight / Gatekeeper / SIP quirks are untested.
- **No git/diff tooling yet.** ~~`project_diff_files`, `project_file_symbols`, and
  `project_symbol_references` are on the roadmap~~ → **now implemented** in v1.3.0 (P2/P3)
  — see [`TODO.md`](./TODO.md).
- **Search is a line scanner, not an index.** `project_search` reads every file in scope
  (bounded at 1 MiB/file) and matches line-by-line. It's fine for typical project sizes;
  for a monorepo with thousands of files, p95 will climb.
- **`project_recent_files` is index-first, scan-fallback.** It prefers the SQLite
  `project_file_index` (maintained on write/edit/delete); when the index is empty it
  falls back to a bounded scan capped at 4 000 files / 300 directories, skipping
  `node_modules`, `target`, `dist`, `.git`, etc.
- **Shell is tail-only.** `project_shell_run` returns a bounded tail of stdout/stderr, not a
  live stream. Long outputs are truncated by design.
- **One workspace per server instance.** The workspace, data dir, and permission mode are
  fixed at process start. To serve multiple workspaces concurrently, run multiple instances.
- **`better-sqlite3` is a native module.** Prebuilt binaries cover the common Node ×
  platform × arch combos (Node 20/22 on Linux x64/arm64, macOS x64/arm64, Windows x64).
  Unusual platforms (musl, Alpine, ARM Windows, exotic archs) will compile from source
  on `npm install` and need `python3` + a C compiler. The Docker image and the
  standalone `.zip` in the release sidestep this entirely.

---

## 10. Interesting details & things you should know

- **Serial queue, by design.** The MCP layer funnels every `execute` through a promise
  queue so the SQLite audit writer is single-threaded. `shell_status` and `cancel` are
  deliberately *unqueued* so a long poll never blocks anything else.
- **Warm-up races the MCP handshake.** `warmUp()` opens the capability scope immediately
  and in parallel with `server.connect()`. The first tool call therefore costs ~2.5 ms
  instead of ~20 ms (capability open alone is ~17 ms).
- **Search cache is asymmetric on purpose.** A search that *found* hits is cached (TTL 3 s).
  A search that *found none* is not — because the absence of a hit is exactly what can
  become stale the instant a file is written. (`verify.ts` guards this with
  `search_cache_invalidated`.)
- **`project_recent_files` is index-first, scan-fallback.** P2 added a SQLite
  `project_file_index` (maintained on write/edit/delete). The tool queries it first
  (`source: "index"`); when empty it falls back to bounded BFS with `readdir` + `stat`
  in chunks of 64 (`source: "fallback_scan"`), symlinks skipped, ignored dirs pruned,
  results sorted by mtime descending. The `session_edits` field additionally lists files
  *this* session wrote (up to 20), so the model knows what it already touched.
- **Code intelligence is regex/LCS, not an indexer.** `project_outline_symbol`,
  `project_file_symbols`, `project_diff_files`, `project_symbol_references`, and
  `project_selective_search` all run over plain UTF-8 text in `lib/symbol-diff.ts` —
  no external indexer, safe on any workspace file.
- **Fuzzy edit is opt-in and audited.** `VENIRA_EDIT_FUZZY=1` makes `opEditFile` fall
  back to a Levenshtein match when the exact `old_text` is not found; the envelope
  sets `fuzzy_used: true` so the audit trail records it.
- **P1 observability surfaces.** `project_health` now reports `cache` / `trace` / `shell`
  config sections; `project_trace_status` returns the in-memory trace ring;
  `project_read_audit` reads the SQLite audit log directly (bounded, WAL-safe,
  `audit_unavailable` fallback).
- **Audit DB is inspected read-only.** `project_health` opens `venira.db` with
  `readonly: true` via `better-sqlite3` and counts rows for the session, including
  `orphan_running` (rows stuck at `running` — a sign of an unclean shutdown).
- **Metrics are ring buffers, not histograms.** `lib/metrics.ts` keeps the last 256
  samples per operation (p50/p95/max/avg). Deliberately tiny: the goal is "what happened
  this session", not "90-day SLO tracking".
- **Output modes are cheap.** `summary` mode replaces payloads with 8 KB previews + a
  `summary` object; `compact` only adds a `summary` when the payload exceeds 8 KB. The
  model can request full data back via a follow-up call when it truly needs it.
- **Shutdown is defensive.** On `SIGINT`/`SIGTERM`/stdin close the server cancels all
  running shells, closes the scope, and marks the audit DB cleanly — no orphans, no stuck WAL.

---

## 11. Development workflow

```bash
npm run build        # type-check + emit dist/
npm run smoke        # in-process sanity (backend reachable, path lock works)
npm run doctor       # preflight: 12 checks incl. audit DB, shell smoke, P1 config surface
npm run verify       # behavioural regression suite (214 checks, ~90 s)
npm run bench        # in-process numbers
npm run bench:mcp    # end-to-end numbers
```

**Adding a new tool**

1. Register it in `tools/project.ts` with `registerProjectTools` — use the `config()` helper
   so `Use when` / `Avoid when` / `Speed` / `Output` / `Batch-safe` land in the description
   *and* in `_meta.venira`.
2. Read-only ops: route through `executeCached` so they automatically participate in
   cache invalidation (mutations wipe list/search/recent caches).
3. New backend ops: add the handler in `lib/corehost.ts` under `operations`, and add an
   audit row (or mark it read-only like `shell_status` if it's a long poll).
4. Add a case to `scripts/verify.ts` (the suite already checks instruction blocks,
   annotations, envelope shape, and audit rows for new tool names).
5. Update the decision tree in `server.ts` (`INSTRUCTIONS`) and the tool table in
   `README.md`.

**Testing conventions**

- `verify.ts` uses a fixed `VENIRA_SESSION_ID` so its audit rows are separable from real
  sessions.
- `bench.ts` uses a unique `request_id` tag per run — the audit table has a UNIQUE
  constraint on `request_id`, and reusing one across runs would produce
  `audit_unavailable`.
- Do not commit to `dist/`, `node_modules/`, `test/`, or `*.log` (see `.gitignore`).

---

## 12. Troubleshooting

| Symptom | First things to check |
|---|---|
| `not_found` on a path that looks fine | Run `npm run doctor`; confirm `VENIRA_WORKSPACE` points where you think. |
| `path_escape` on a path that looks fine | The path contains `../` that resolves outside the workspace. Use a workspace-relative path; set `VENIRA_UNRESTRICTED=1` only when you truly need it. |
| Read cache seems stale | It should not — reads are mtime+size validated. If you see it, check that the filesystem timestamp updates (some network drives delay `mtime`). |
| Shell command not finishing | `project_shell_status` with `wait_seconds: 30`; check `project_health` → `shells.active` to see which `run_id` is still running. |
| `better-sqlite3` build failure on install | You're on an unusual platform (musl, exotic arch). Run `npm rebuild better-sqlite3` with build tools (`python3`, `make`, `g++`), or use the Docker image / prebuilt standalone zip instead. |
| `npx venira-mcp` not found | The package is not published yet. Use a local build: `node <repo>/dist/server.js`. |
| `venira.db` won't open in `project_health` | Another process has the WAL locked; make sure only one server instance writes to the same data dir. |
| Everything slow | Run `project_health` — `queue.depth`, `pending_requests`, and per-op p95 will tell you if it's a bottleneck or a stuck command. |

---

## 13. Contributing

1. Fork and clone; `npm install && npm run build && npm run doctor`.
2. Read [`TODO.md`](./TODO.md) — P1 (cache control, tracing, audit, shell UX) and
   P2/P3 (code intelligence, fuzzy edit, recent-files index) are complete; the next
   milestone is `project_explain_error` / `project_plan_read_batch` (deferred, need LLM).
3. Keep the invariants from [§10](#10-interesting-details--things-you-should-know):
   serial queue for `execute`, long-lived capability, asymmetric search cache, bounded scans.
4. Add a `verify.ts` check for every new tool; keep the suite green before opening a PR.
5. Run `npm run bench:mcp` and paste the numbers in the PR description when touching
   `tools/project.ts` or `lib/corehost.ts`.

---

## 14. Changelog & roadmap

The full history, in order — from the standalone rewrite to the provider, secrets, diagnostics and planning releases.

### 14.1 Timeline

| Date | Version | Milestone |
|---|---|---|
| 2026-10-27 | **v1.0.0** | **Standalone rewrite.** The Rust `corehost` binary and JSON-Lines IPC were replaced by an in-process pure-Node backend (`lib/corehost.ts`). SQLite WAL audit via `better-sqlite3`, async shell with process-tree kill, long-lived capability scope, structured envelopes with hints, validated read caches, batch reads. Ships as `npm i venira-mcp` (no binary, no GUI). |
| 2026-10-28 | v1.0.1–v1.0.7 | Release plumbing: npm metadata, OIDC trusted publishing, Docker multi-stage image, `--version` / `--help`, doctor works from any directory, zod 4 + MCP SDK 1.32 (security advisory fix), standard `LICENSE-MIT` / `LICENSE-APACHE` filenames, `scripts/` shipped in the image. |
| 2026-10-28 | v1.1.0 | Shell policy hardening: `balanced` / `strict` / `permissive` / `off`, HMAC-signed single-use approval tokens, session grants, policy file loaded from an explicit env path only (never from the workspace). |
| 2026-10-28 | v1.1.3 | `project_execute_js` — sandboxed synchronous JS in the workspace (whitelist env, output caps). |
| 2026-10-28 | v1.1.7 | Audit writer compatible with legacy DB schemas (in-place migration instead of failed writes). |
| 2026-10-28 | v1.1.9 | CLI `--workspace/-w` and `--data-dir` (no config switching), `VENIRA_PERMISSION_MODE`. |
| 2026-10-28 | **v1.2.0** | P1: cache controls (`VENIRA_CACHE_ALL`, `VENIRA_CACHE_LIST_ONLY`, `VENIRA_CACHE_SEARCH_ONLY`), request tracing (`VENIRA_TRACE` / `project_trace_status`), `project_read_audit`, shell UX (`VENIRA_SHELL_TAIL_MAX`, `VENIRA_SHELL_EXIT_EARLY`, `VENIRA_SHELL_TIMEOUT_POLICY`, `project_shell_cancel_session`). Verify/doctor raised to 25 tools. |
| 2026-10-28 | **v1.3.0** | P2/P3 code intelligence: `project_outline_symbol`, `project_file_symbols`, `project_diff_files`, `project_symbol_references`, `project_selective_search`; fuzzy edit (`VENIRA_EDIT_FUZZY`); SQLite recent-files index (`project_file_index`, index-first + bounded fallback). |
| 2026-10-29 | (post-1.3.0) | P2.5 self-install: `project_detect_harnesses` + `project_install_self` (OpenCode / Claude / Cursor / Codex / Kimi / DeepSeek / Antigravity), atomic config merge + backup. |
| 2026-10-29 | **v1.4.0** | **Checkpoints + audit reasons + Git/PR + CI + encrypted secrets.** `project_snapshot` (content-addressed, deduplicated, sha256-verified rollback), `reason` on mutations stored in the audit trail, GitHub pull-request and Actions tools, an AES-256-GCM secret store with `secret_env` injection, and a network safety layer. **35 tools**, verify **186/186**. |
| 2026-10-29 | **v1.5.0** | **Inline review comments + check-runs + secret rotation + deterministic diagnostics.** `project_pr_comment` pins notes to a file/line (`path`, `line`, `start_line`, `side`, `commit_id`); `project_ci_status` reads branch-protection **check-runs** (`ref` / `pr`); the secret store tracks `expires_at` / `last_used_at` / `use_count` / `rotated_at` and refuses expired credentials; new `project_explain_error` (rule table → next actions) and `project_plan_read_batch` (task → ready read batch). **37 tools**, verify **211/211**. |
| 2026-10-29 | **v1.5.1** | **Inline review-comment fix (found by a live E2E run).** GitHub requires `commit_id` whenever `line` is used (a bare `line` is rejected with 422 "line is not a permitted key"); `project_pr_comment` now resolves the PR head sha automatically (one extra API call only for inline notes) and honours an explicit `commit_id`. Verify **212/212**. |
| 2026-10-29 | **v1.5.2** | **Read-planner artifact filter (found by the live E2E re-run).** `project_plan_read_batch` ranked `data/venira.db` (36 hits) above source because the audit DB contains every command; candidates now exclude build/vendor dirs and DB/log/binary extensions, both when collecting and when planning. Verify **214/214**. |

### 14.2 What v1.5.0 added

- **Inline PR review comments** — `project_pr_comment` keeps its general thread behaviour and
  switches to the pull review-comment API when `path` + `line` are given. Optional
  `start_line` (multi-line range), `side: RIGHT | LEFT`, `commit_id` (defaults to the PR head).
  `line` without `path` (or `path` without `line`) is rejected with an actionable error instead
  of silently posting to the wrong endpoint.
- **Branch-protection check-runs** — `project_ci_status` keeps the Actions surface (`branch`,
  `workflow`, `run_id`) and adds `ref` (sha/branch) or `pr` (resolved to the head sha), which hit
  `GET /commits/{ref}/check-runs` instead. The result is `source: "check-runs"` with
  `check_runs[]` (`name`, `status`, `conclusion`, `app`, `url`, `summary`) and
  `overall: success | failure | in_progress | no_checks`. The ref is validated (no `..`,
  restricted charset) before it reaches the URL.
- **Secret rotation metadata** — every stored secret now carries `expires_at`, `expired`,
  `days_left`, `last_used_at`, `use_count` and `rotated_at`. `action=set` accepts
  `expires_in_days` (1–3650) or `expires_at` (epoch ms / ISO-8601); a re-`set` is a rotation
  (value overwritten, counter reset, previous expiry kept unless a new one is supplied).
  Expiry is enforced at every injection point (`secret_env` and the provider token) *before*
  decryption, so a dead credential fails as `secret_expired` with a rotate hint instead of
  surfacing later as a `401`. Use tracking is fire-and-forget (1 s debounce) and never fails
  the call that used the secret.
- **`project_explain_error`** — a deterministic rule table (~28 signatures: POSIX/Node errno,
  TypeScript, JavaScript, Python/pytest, git, npm, GitHub 401/403/429, SQLite locks and venira's
  own codes) maps an error block or log tail to `likely_cause`, `suggested_fix[]`,
  `retry_hint` and **ready-to-send** `next_actions` (e.g. a `project_read_ranges` call built from
  the failing `file:line`). `matched: false` is a normal result with a triage note, never an
  error. No model call, no network, < 1 ms.
- **`project_plan_read_batch`** — extracts keywords from a one-line task (quoted phrases,
  identifiers, then words), runs up to three bounded content searches, folds in `files_hint`
  and the recent-files index when the search is thin, ranks candidates by hit count and returns
  `steps[]` whose first entry is a complete `project_read_batch` request (plus an outline step
  for files > 256 KB and a tree/search fallback). Also no model call: it plans, you execute.
- **Test infrastructure** — the GitHub mock gained the check-runs endpoint, inline-comment route
  and a PR head `sha`; `npm run verify` grew to **211 checks** (rotation metadata, expired
  refusal, inline payload shape, check-run summarisation + ref validation, diagnostics and
  planning), and the tool-count expectations moved to 37 (36 when one is disabled).
- **Docs** — README (tools 37, new §4.9, roadmap), TODO.md, `package.json` metadata and the
  server's MCP instructions/decision tree (now 14 steps) updated in the same change.

**Fix shipped in v1.5.1 (found by a live E2E run):** GitHub requires `commit_id` whenever `line`
is used — a bare `line` returns `422 "line is not a permitted key"`. `project_pr_comment` now
resolves the PR head sha automatically (one extra API call, inline notes only) and still honours
an explicit `commit_id` (e.g. anchoring to an older revision). The response echoes `commit_id`.

**Fix shipped in v1.5.2 (found by the live E2E re-run):** `project_plan_read_batch` ranked
`data/venira.db` first (36 hits) because the audit DB stores every command, so its bytes match
keyword searches. Candidates now drop build/vendor directories (`node_modules`, `dist`, `.git`,
`__pycache__`, …) and DB/log/binary extensions (`.db`, `.sqlite`, `.log`, `.map`, images, …) at
both collection and planning time; source files rank as intended.

### 14.3 What v1.4.0 added

- **Checkpoints (`project_snapshot`)** — `action: create | list | restore | delete`. Blobs are
  content-addressed (`snapshots/blobs/<ab>/<sha256>`) and deduplicated: a second checkpoint after
  a small edit only writes the changed bytes. Restore is per-file atomic (temp + rename),
  concurrency 4, sha256-verified, and only rewrites captured paths. Defaults skip `.git`,
  `node_modules`, build output, virtualenvs, `__pycache__`, the checkpoint store, the audit DB
  and the secret store; symlinks are never followed; pruning via `VENIRA_SNAPSHOT_KEEP` (20).
- **Audit reasons** — mutating tools accept `reason` ("why"), normalized to one line, redacted,
  capped at 400 chars, stored in the additive `reason` column (old DBs migrate in place) and
  returned by `project_read_audit`.
- **Git provider** — `project_pr_create`, `project_pr_comment`, `project_pr_merge` over GitHub
  REST. Repo resolution: `repo` arg → `VENIRA_GITHUB_REPO` → `.git/config` `origin`
  (worktrees via `commondir`). Token: secret `GITHUB_TOKEN` → `VENIRA_GITHUB_TOKEN` →
  `GITHUB_TOKEN` → `GH_TOKEN`. Action-shaped errors (`auth_missing`, `not_found`, `conflict`,
  `rate_limited`, …). Closed/already-merged PRs return `already_merged`; branch delete is
  best-effort and never fails a successful merge.
- **CI provider** — `project_ci_status` (runs for branch/workflow, or one run + jobs),
  `project_ci_trigger` (`workflow_dispatch` with validated inputs), `project_ci_logs` (whole run
  or one job). Log archives are downloaded (32 MB cap), parsed **in memory** by a minimal ZIP
  reader (EOCD + central directory, stored + deflate, 4 MB/entry) and returned as a tail
  (`tail_lines` default 500, `max_bytes` default 512 KB / cap 4 MB). Nothing is extracted to disk.
- **Secrets** — `project_secret` (`action: get | set | list | delete`) backed by AES-256-GCM
  (`secrets.json` + `secrets.key`, 0600, atomic writes). `get`/`list` are metadata-only
  (length + sha256 prefix + update time); plaintext requires `reveal=true` **and**
  `VENIRA_SECRET_ALLOW_REVEAL=1`. `value_env` keeps values out of tool arguments;
  `project_shell_run secret_env=[...]` (≤ 16) injects them after approval. Stored values
  (≥ 8 chars) are scrubbed from shell tails and audit text.
- **Network safety** — `VENIRA_NETWORK=0` kill switch; https-only API base (http only for
  localhost or `VENIRA_GITHUB_ALLOW_HTTP=1`); manual redirects that drop `Authorization` on a
  cross-origin hop (pre-signed log blobs); `node:http(s)` client with timeouts and response caps
  (deliberately not global `fetch`); size caps on every response.
- **Test infrastructure** — `scripts/github-mock.ts` serves the API and a second-origin blob
  server (stored + deflated ZIP entries), recording every request and `Authorization` header.
  `npm run verify` grew to **186 checks** covering secrets, PR/CI, redirect token hygiene,
  network kill switch, audit summaries and "secret value never logged".
- **Docs** — README/repo docs updated to 35 tools, new env vars, security §6.2; `project_health`
  reports `secrets` and `network.github` sections (never the token).

### 14.4 Roadmap

| Item | Status | Notes |
|---|---|---|
| `project_explain_error` | ✅ shipped (v1.5.0) | Deterministic rule table + ready `next_actions`; no model call. |
| `project_plan_read_batch` | ✅ shipped (v1.5.0) | Keywords → bounded search → ranked candidates → ready batch call. |
| Inline PR review comments (file/line) | ✅ shipped (v1.5.0) | `project_pr_comment` with `path`, `line`, `start_line`, `side`, `commit_id`. |
| PR checks API (`check-runs`) in `project_ci_status` | ✅ shipped (v1.5.0) | `ref` / `pr` → `GET /commits/{ref}/check-runs`. |
| Secret rotation metadata (expiry, last used) | ✅ shipped (v1.5.0) | `expires_at`, `days_left`, `last_used_at`, `use_count`, `rotated_at`; expired secrets refused. |
| GitLab / Bitbucket providers | 💡 v1.6 candidate | The provider layer is isolated in `lib/git-provider.ts`; a second dialect would mirror it. |
| Multi-repo workspaces | 💡 v1.6 candidate | Today: one repo inferred from the workspace `.git`, override per call via `repo`. |

---

## License

Dual-licensed under **MIT OR Apache-2.0** — pick whichever fits your project.

- MIT license text: [`LICENSE-MIT`](./LICENSE-MIT)
- Apache-2.0 full text: [`LICENSE-APACHE`](./LICENSE-APACHE)

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project shall be dual-licensed as above, without any
additional terms or conditions.
