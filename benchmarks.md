# Benchmarks — venira-mcp (standalone)

Repeatable benchmarks. Regenerate with:

```bash
npm run build
npm run bench        # in-process corehost tier (pure Node, no IPC)
npm run bench:mcp    # end-to-end over MCP stdio
npm run bench:tools  # paired MCP vs PowerShell command proxy
```

Environment: Windows 11 / NVMe / Node 24 (sections 1–2) or Node 20 (section 3). Single host — treat deltas vs a new baseline, not absolute targets.

Sections 1–2 are historical measurements from **2026-11-03**, `venira-mcp@1.13.8`. Section 3 is an older migration comparison of v0.3.0 → v1.0.0. Those migration numbers are **not** a same-version comparison with sections 1–2. The current package is `v1.14.0`.

## 0. Methodology & caveats

- **Single machine/environment.** Sections 1–2 use one host (Windows 11 / NVMe / Node 24). Latency reflects that disk/CPU; treat deltas vs a new baseline, not absolute targets.
- **Foreground shell includes process startup.** `project_shell_run` (background=0) spawns a child process and waits for exit, so `shell_foreground_ms` includes shell spawn + stdio handshake. Pure tool latency is better read from the in-process `npm run bench` row or from cached reads.
- **Warm-up required.** The first 3 `project_read_file` warm-ups attach the session cache; the reported "First call" row is post-warm-up. Cold runs (capability open) take ~100-200ms longer.
- **Cache state matters.** Cached-read rows only apply after the warm-up calls; reset with `project_cache_clear` or a fresh session before re-benchmarking.
- **p95 is only shown when n ≥ 30.** With n=3 or n=10 the p95 mostly restates the observed maximum, so it is omitted for those rows. Use `avg`/`max` for small samples instead.
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

### Side-by-side: v1.0.0 (part 3) vs v1.13.8 (parts 1–2)

These rows measure logically similar operations but come from **different runs, different days, and different harnesses**, so they do not prove a regression:

| Metric | v1.0.0 (part 3) | v1.13.8 (part 1–2) | Note |
|---|---|---|---|
| First MCP call | 2.5 ms | **62.9 ms** | v1.13.8 includes richer envelope + protected-path guard; different day/harness |
| Cached read p50 | 1.01 ms | **1.00 ms** | Nearly identical |
| 8-file batch avg | 4.18 ms | **3.14 ms** | v1.13.8 slightly faster |
| `get_file_info` p50 | 1.02 ms | **0.63 ms** | v1.13.8 faster |
| `project_health` | 1.8 ms | **5.2 ms** | v1.13.8 reports more diagnostics |
| Search p95 (MCP) | **21.8 ms** | **66.64 ms (max)** | Different suites; v1.13.8 max over n=10 |

The 21.8 ms search p95 belongs only to this historical v0.3.0/v1.0.0 test suite; it is not directly comparable to the 66.64 ms v1.13.8 MCP maximum above. Possible reasons v1.13.8 reads higher on some rows: added protected-path filtering, relevance ranking, and a richer envelope; different machine load or antivirus scan on the measurement day. A same-day run of both versions with one harness would be needed to isolate the cause. **Do not read this as a confirmed regression.**

> In the v0.3.0→v1.0.0 migration run, the standalone build removed the JSON-Lines IPC hop and reduced SQLite WAL audit-lock contention.

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

Results below are from `npm run bench:tools` (100 runs per phase), generated
2026-11-06 on Windows 11 / NVMe / Node 24. The PowerShell suite total is shared
across all rows because one process loops all scenarios.

| Task | Cache phase | Venira server p50 | Venira MCP p50 | PowerShell op p50 | PowerShell suite total | Match | Payload bytes V / PS |
|---|---|---:|---:|---:|---:|---|---:|
| read_file | cache_miss | 3.78 ms | 4.99 ms | 1.36 ms | 10872.81 ms (shared suite) | MATCH | 1689 / 1367 |
| read_file | warm | 0.46 ms | 1.33 ms | 1.36 ms | 10872.81 ms (shared suite) | MATCH | 1703 / 1367 |
| read_batch_3_files | cache_miss | 11.5 ms | 12.63 ms | 6.79 ms | 10872.81 ms (shared suite) | MATCH | 4662 / 3498 |
| read_batch_3_files | warm | 1.31 ms | 2.22 ms | 6.79 ms | 10872.81 ms (shared suite) | MATCH | 4704 / 3498 |
| get_file_info | cache_miss | 2.06 ms | 2.68 ms | 0.72 ms | 10872.81 ms (shared suite) | MATCH | 221 / 88 |
| get_file_info | warm | 0.42 ms | 0.97 ms | 0.72 ms | 10872.81 ms (shared suite) | MATCH | 235 / 88 |
| list_files_lib | cache_miss | 1.49 ms | 2.18 ms | 3.99 ms | 10872.81 ms (shared suite) | MATCH | 3010 / 745 |
| list_files_lib | warm | 0.3 ms | 1.05 ms | 3.99 ms | 10872.81 ms (shared suite) | MATCH | 3024 / 745 |
| search_literal | cache_miss | 35.11 ms | 35.97 ms | 51.06 ms | 10872.81 ms (shared suite) | MATCH | 356 / 113 |
| search_literal | warm | 0.32 ms | 0.93 ms | 51.06 ms | 10872.81 ms (shared suite) | MATCH | 369 / 113 |

Notes:
- **PowerShell suite total (10,872.81 ms)** is the whole process looping all scenarios, not per-op. Per-op PowerShell times are much smaller (0.72–6.79 ms p50).
- Once the PowerShell startup is amortized across the suite loop, the per-op gap between Venira MCP and PowerShell is small; the remaining delta is mostly the local stdio IPC hop, not filesystem work.
- The `search_literal` row above uses Venira's default backend (`VENIRA_USE_RIPGREP=1` when ripgrep is on PATH). To compare ripgrep vs JS scanner, run `VENIRA_USE_RIPGREP=0` and `VENIRA_USE_RIPGREP=1` separately through `npm run bench:mcp` and record the `project_search` rows in section 1; add an `rg`-only row here once measured. Do not claim an `rg`-specific number without measuring it.
