# venira-mcp

> Fast, workspace-scoped **MCP server for coding agents** (OpenCode, Claude Desktop, any MCP client). 16 tools, structured JSON envelopes, validated read caches, async shell, and full SQLite audit trail — **pure Node, no external binary, no GUI, no network.**

```
┌──────────────┐   stdio (MCP)   ┌────────────────────────────────────────────┐
│ MCP client    │ ◄──────────────► │  venira-mcp (Node, single process)        │
│ (OpenCode,    │                  │  16 tools · read caches · async shell    │
│  Claude, ...) │                  │  SQLite audit (WAL) · p50/p95 metrics   │
└──────────────┘                  └────────────────────────────────────────────┘
```

- **Zero external dependencies.** Only Node ≥ 20 + `@modelcontextprotocol/sdk` + `zod` +
  `better-sqlite3`. No Rust binary, no database server, no network.
- **Workspace-locked by default.** Every path is validated inside the workspace; `../` escape
  is rejected with `path_escape`.
- **Validated read cache.** Reads are cached and re-validated by `mtime + size`, so external
  edits or deletes never return stale content.
- **Async shell.** `project_shell_run` returns a `run_id` in ~5 ms; poll with
  `project_shell_status` (5–30 s observation window, deliberately non-queued).
- **Full observability.** `project_health` reports capability state, queue depth, cache
  hit-rates, active shells, and p50/p95/max per operation.
- **Audit trail.** Every operation (including failures, shell runs, and cancellations) is
  written to a SQLite WAL table (`project_tool_audit`).

## 1. Table of contents

- [Quick start](#2-quick-start)
- [MCP client configuration (JSON)](#3-mcp-client-configuration-json)
- [Tools](#4-tools-16)
- [Architecture](#5-architecture)
- [Security model](#6-security-model)
- [Benchmark](#7-benchmark)
- [Envelopes, hints, and error codes](#8-envelopes-hints--error-codes)
- [Pros / cons (honest)](#9-what-this-project-does-well--what-it-does-not)
- [Interesting details](#10-interesting-details--things-you-should-know)
- [Development workflow](#11-development-workflow)
- [Troubleshooting](#12-troubleshooting)
- [Contributing](#13-contributing)
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
        "VENIRA_DATA_DIR": "C:\\path\\to\\data",
        // Lock every path to the workspace. KEEP this unset (or "0") in normal use.
        "VENIRA_UNRESTRICTED": "0",
        // Default shell for project_shell_run: "powershell" | "cmd" | "bash"
        "VENIRA_DEFAULT_SHELL": "powershell",
        // "full" | "compact" | "summary" (default "full")
        "VENIRA_OUTPUT_MODE": "full",
        // Set to "1" for pretty-printed JSON in tool results (costs bytes; leave off for agents).
        "VENIRA_PRETTY": "0"
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
| `VENIRA_OUTPUT_MODE` | `full` | `full` = complete payloads · `compact` = summary when >8 KB · `summary` = always trimmed previews. |
| `VENIRA_PRETTY` | `"0"` | `"1"` = 2-space pretty JSON in tool results. |
| `VENIRA_SESSION_ID` | auto (`opencode-<pid>-<rand>`) | Session tag; audit rows are grouped by it. Useful for verification / parallel test runs. |
| `VENIRA_READ_CACHE_BYTES` | `67108864` (64 MiB) | Budget for read + info caches. |
| `VENIRA_LIST_CACHE_MS` | `1500` | TTL for directory listing cache. |
| `VENIRA_SEARCH_CACHE_MS` | `3000` | TTL for search result cache. |
| `VENIRA_RECENT_CACHE_MS` | `2000` | TTL for recent-files cache. |
| `VENIRA_BATCH_ITEM_BYTES` | `524288` (512 KB) | Per-item cap inside `project_read_batch`. |
| `VENIRA_DEBUG_STARTUP` | `"0"` | `"1"` = startup errors go to stderr instead of the protocol-safe stdout event. |

---

## 4. Tools (16)

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
| `project_recent_files` | Files modified recently (bounded filesystem scan, skips `node_modules`/`target`/`.git`) | TTL cache 2 s; includes `session_edits` — files you wrote in this session |
| `project_read_batch` | Run up to **8 read-only ops in one call** (`list_files`, `read_file`, `get_file_info`, `search`) | Sequential + cached; response budget enforced per item |
| `project_health` | Server diagnostics: capability, queue, cache hit-rates, active shells, p50/p95 per op, audit DB stats | `include_audit=false` skips the DB query (~2 ms) |

### 4.2 Mutate family (destructive, invalidates caches)

| Tool | Purpose | Notes |
|---|---|---|
| `project_write_file` | Create / overwrite / append a file | `mode: "create"` errors if file exists; `expected_sha256` guards against blind overwrites |
| `project_edit_file` | Replace exact text: one `old_text`/`new_text` pair **or** up to 64 `edits[]` | `replace_all` supported; `expected_sha256` available |
| `project_create_directory` | Create a directory tree | `create_parents` defaults to `true` |
| `project_create` | Create a **file or directory in one call** | `kind: "file"` requires `content`; `kind: "directory"` ignores `content` |
| `project_delete_path` | Delete a file or directory tree | `recursive: true` for directories. **Not undoable.** |

### 4.3 Shell family (async, non-blocking)

| Tool | Purpose | Notes |
|---|---|---|
| `project_shell_run` | Run a shell command; returns `run_id` in ~5 ms | `shell`: `powershell` / `cmd` / `bash`; `relative_cwd` optional. stdout/stderr tail captured in-process. |
| `project_shell_status` | Poll a running command | `wait_seconds` 0–30 is an *observation window*, not a timeout. Deliberately **not queued** behind other calls, not audit-logged (prevents orphan "running" rows). |
| `project_shell_cancel` | Kill a running command by `run_id` | Also used at MCP shutdown to avoid orphan processes. |

### 4.4 How the model is told to pick the right tool

At connect time the server advertises an `instructions` block (MCP SDK ≥ 1.32) containing a
**decision tree** the model can read. A condensed version:

```
1. Two+ reads or mixed read-only steps → project_read_batch (max 8, sequential + cached)
2. One file → project_read_file; large file → start_line/end_line or project_read_ranges;
   follow next_start_line when truncated
3. Find code → project_search (kind=literal_content or definition), then project_read_ranges around hits
4. Directory tree → project_list_files (depth 1..3, limit ≤200). "What changed lately?" → project_recent_files
5. Write whole file → project_write_file; small precise change → project_edit_file;
   delete → project_delete_path (destructive, not undoable)
6. Build/test/long command → project_shell_run (returns run_id immediately),
   then poll project_shell_status (wait_seconds 5..30); project_shell_cancel to stop
7. Debug latency/errors → project_health
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
│   └── project.ts            # 16 tool registrations, serial queue, caches, shell tracking,
│                             #   audit-DB inspection, project_health, project_create
├── lib/
│   ├── corehost.ts           # In-process backend: file I/O, search, async shell,
│   │                         #   scope capability, SQLite WAL audit (better-sqlite3)
│   ├── workspace.ts          # Workspace path resolution + escape validation
│   ├── output.ts             # Envelope builder, output modes, hint inference, error parser
│   ├── metrics.ts            # Ring-buffer p50/p95/max per operation (256 samples each)
│   ├── types.ts              # Shared host snapshot types
│   └── version.ts            # Exported VERSION constant
├── scripts/
│   ├── smoke.ts              # In-process backend sanity check
│   ├── bench.ts              # In-process backend benchmark
│   ├── bench-mcp.ts          # End-to-end MCP benchmark
│   ├── verify.ts             # ~30 end-to-end checks (cache, batch, shell, audit, modes)
│   └── doctor.ts             # 7 preflight checks (workspace, data dir, tools, health, shell)
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
| **Audit** | ON | Every operation (including failures and cancellations) is written to `project_tool_audit` in a SQLite WAL database. |
| **`sensitive_result`** | — | The envelope carries `retryable: false` and a "do not retry" hint when content is withheld by policy. |
| **`expected_sha256`** | opt-in | `project_write_file` / `project_edit_file` / `project_create` accept a content hash; a mismatch aborts with `conflict` — protects against blind overwrites when the agent re-applies an old edit. |
| **Destructive ops** | labelled | Every mutating tool advertises `destructiveHint: true` in its MCP annotations; `project_delete_path` additionally documents that it is not undoable. |

**Threats this does NOT protect against:** a malicious prompt can still instruct the agent to
run destructive shell commands (`rm -rf`, `format`…). The audit log and `project_health` make that
visible *after* the fact; the workspace lock only bounds filesystem access, not shell side-effects.
If you need hard boundaries, run the MCP server in a container / VM, or drop `VENIRA_DEFAULT_SHELL`
to a restricted shell profile.

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
> tree in [§4.4](#44-how-the-model-is-told-to-pick-the-right-tool) is designed to exploit.

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
- **No git/diff tooling yet.** `project_diff_files`, `project_file_symbols`, and
  `project_symbol_references` are on the roadmap (see [`TODO.md`](./TODO.md)) but not implemented.
- **Search is a line scanner, not an index.** `project_search` reads every file in scope
  (bounded at 1 MiB/file) and matches line-by-line. It's fine for typical project sizes;
  for a monorepo with thousands of files, p95 will climb.
- **`project_recent_files` is a bounded scan**, not an index: it caps at 4 000 files / 300
  directories and skips `node_modules`, `target`, `dist`, `.git`, etc.
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
- **`project_recent_files` is pure Node.** No backend needed: bounded BFS with `readdir` +
  `stat` in chunks of 64, symlinks skipped, ignored dirs pruned, results sorted by mtime
  descending. The `session_edits` field additionally lists files *this* session wrote
  (up to 20), so the model knows what it already touched.
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
npm run doctor       # preflight: 7 checks incl. audit DB and shell smoke
npm run verify       # behavioural regression suite (~30 checks, ~60 s)
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
2. Read [`TODO.md`](./TODO.md) — the next milestones are already scoped (cache toggles,
   request tracing, `project_read_audit`, shell UX, fuzzy edit, symbol tools).
3. Keep the invariants from [§10](#10-interesting-details--things-you-should-know):
   serial queue for `execute`, long-lived capability, asymmetric search cache, bounded scans.
4. Add a `verify.ts` check for every new tool; keep the suite green before opening a PR.
5. Run `npm run bench:mcp` and paste the numbers in the PR description when touching
   `tools/project.ts` or `lib/corehost.ts`.

---

## License

Dual-licensed under **MIT OR Apache-2.0** — pick whichever fits your project.

- MIT license text: [`LICENSE-MIT`](./LICENSE-MIT)
- Apache-2.0 full text: [`LICENSE-APACHE`](./LICENSE-APACHE)

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project shall be dual-licensed as above, without any
additional terms or conditions.
