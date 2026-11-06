# Benchmarks — venira-mcp (standalone)

Repeatable benchmarks. Regenerate with:

```bash
npm run build
npm run bench        # in-process corehost tier (pure Node, no IPC)
npm run bench:mcp    # end-to-end over MCP stdio
npm run bench:tools  # paired MCP vs PowerShell command proxy
```

Sections 1–2 are historical measurements from **2026-11-03** on Windows 11 / NVMe /
Node 20, `venira-mcp@1.13.8`. Section 3 is an older migration comparison of
v0.3.0 and v1.0.0. Those migration numbers are not a same-version comparison
with sections 1–2. The current package is v1.14.0.

## 0. Methodology & caveats

- **Single machine/environment.** Sections 1–2 use one host (Windows 11 / NVMe / Node 20). Latency reflects that disk/CPU; treat deltas vs a new baseline, not absolute targets.
- **Foreground shell includes process startup.** `project_shell_run` (background=0) spawns a child process and waits for exit, so `shell_foreground_ms` includes shell spawn + stdio handshake. Pure tool latency is better read from the in-process `npm run bench` row or from cached reads.
- **Warm-up required.** The first 3 `project_read_file` warm-ups attach the session cache; the reported "First call" row is post-warm-up. Cold runs (capability open) take ~100-200ms longer.
- **Cache state matters.** Cached-read rows only apply after the warm-up calls; reset with `project_cache_clear` or a fresh session before re-benchmarking.
- Results can be **truncated** (`complete:false` / `truncated:true`) when a limit is hit; check those flags before trusting a number.

## 1. End-to-end MCP (`npm run bench:mcp`)

| Scenario | n | avg | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| **First call** (post warm-up) | 1 | — | **62.9 ms** | — | — |
| `project_read_file`, same file (cached) | 50 | 1.21 ms | 1.00 ms | 2.52 ms | 5.67 ms |
| `project_read_file`, distinct files | 8 | 3.53 ms | 3.84 ms | — | 5.06 ms |
| `project_read_batch` (8 items each) | 3 | **3.14 ms** | 3.11 ms | — | 3.68 ms |
| `project_get_file_info` | 30 | 0.87 ms | 0.63 ms | 2.52 ms | 4.17 ms |
| `project_search` (literal content) | 10 | 7.79 ms | 1.35 ms | — | 66.64 ms |
| `project_read_ranges` (2 ranges) | 1 | 7.7 ms | — | — | — |
| `project_recent_files` | 1 | 1.4 ms | — | — | — |
| `project_health` (no DB query) | 1 | **5.2 ms** | — | — | — |

For rows with fewer than 30 samples, p95 is omitted; with n=3 or n=10 it would
mostly restate the observed maximum rather than provide a useful tail estimate.

**Reading the batch row:** 8 distinct reads cost **3.1 ms total** as one batch call
vs ~8 × 3.8 ms ≈ 30 ms if issued individually.

## 2. In-process corehost tier (`npm run bench`)

| Scenario | n | Value |
|---|---:|---|
| Direct first read | 1 | 161.1 ms (cold, includes capability open) |
| Direct `read_file` sequential | 50 | avg 2.58 ms / p50 2.29 ms / p95 4.19 ms |
| Direct 8-file batch sequential | 1 | 24.4 ms total |
| Direct parallel ×8 | 1 | 11.9 ms total (in-process, no IPC/audit lock) |
| Direct `get_file_info` | 50 | avg 1.58 ms / p50 1.28 ms / p95 3.04 ms |
| `list_files` | 1 | 26.5 ms |
| `search` (literal, *.ts) | 1 | 71.8 ms |
| `shell_run` + `shell_status` round-trip | 1 | ~930 ms (2 s wait budget dominates) |

## 3. Historical comparison (Rust-backend v0.3.0 → standalone v1.0.0)

Same machine and test suite within this historical v0.3.0/v1.0.0 migration run:

| Metric | v0.3.0 (Rust IPC) | v1.0.0 (standalone Node) | Note |
|---|---|---|---|
| First MCP call | 6.3 ms | **2.5 ms** | no subprocess spawn |
| Cached read p50 | 2.57 ms | **1.01 ms** | in-process file I/O |
| 8-file batch avg | 19.11 ms | **4.18 ms** | no IPC + no audit lock |
| `get_file_info` p50 | 2.60 ms | **1.02 ms** | |
| `project_health` | 5.5 ms | **1.8 ms** | |
| Dependencies | Rust binary + Node | **Node only** | install surface ↓ |

> In this migration run, the standalone build removed the JSON-Lines IPC hop and
> reduced SQLite WAL audit-lock contention. The 21.8 ms search p95 belongs only
> to this historical v0.3.0/v1.0.0 test suite; it is not directly comparable to
> the 66.64 ms v1.13.8 MCP maximum above. These two sections do not establish a
> regression or explain its cause; a same-day run of both versions with one
> harness would be needed for that conclusion.

## 4. How to add a scenario

- Keep MCP-level scenarios in `scripts/bench-mcp.ts`, in-process ones in `scripts/bench.ts`.
- Use a unique `VENIRA_SESSION_ID` / request tag per run (audit `request_id` is UNIQUE).
- Print one JSON object per run so results are easy to diff across versions.
- Record Node version, OS, and disk type in the environment line near the top of this file.

## 5. Venira MCP vs native command proxy

Run `npm run bench:tools` (default 100 samples per phase) or
`npm run bench:tools -- --runs=200`. The runner measures the same fixed read,
batch-read, metadata, directory-list, and literal-search requests through a
local MCP stdio client and through PowerShell commands. It reports server time,
MCP end-to-end time, PowerShell operation time, total PowerShell suite process
time, payload size, and whether the normalized results match. It includes both
Venira cache-miss and warm-cache phases and emits a Markdown table plus raw JSON.
Run a single scenario with, for example,
`npm run bench:tools -- --only=search_literal --runs=3`.

The PowerShell side is a repeatable native-command proxy; it does **not** invoke
Codex's built-in `exec_command` wrapper. One PowerShell process loops through the
native scenarios and reports each operation's timing; its total process time is
reported once for the suite. MCP end-to-end timing includes the local stdio
client. Use actual Codex tool calls when measuring Codex wrapper overhead, and
keep that number separate from the proxy's operation timing. Cache-miss clears
Venira's in-process cache only; the operating-system file cache remains warm.
The runner uses a temporary Venira data directory, disables network access and
JS execution, and performs read-only workspace operations.
