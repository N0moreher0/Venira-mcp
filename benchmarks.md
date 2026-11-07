# Benchmarks — venira-mcp (standalone)

Repeatable benchmarks. Regenerate with:

```bash
npm run build
npm run bench        # in-process corehost tier (pure Node, no IPC)
npm run bench:mcp    # end-to-end over MCP stdio
npm run bench:tools  # paired MCP vs PowerShell command proxy
```

Environment (sections 1–2, 5–6): Windows 11 build 26200 / NVMe / Intel Core i5-1035G1 (8 logical processors) / 11.8 GiB RAM / Node v24.20.0 / PowerShell 5.1. Section 3 used Node 20. Single host — treat deltas vs a new baseline, not absolute targets.

Sections 1–2 and 5 were re-measured on **2026-11-07** with `venira-mcp@1.17.0` plus the `isProtectedPath` fix described in section 6 (working tree on top of commit `4c4b311`); section 6 also keeps the pre-fix numbers and a same-day A/B against `v1.16.2`. Section 3 is an older migration comparison of v0.3.0 → v1.0.0 plus the 2026-11-03 `v1.13.8` numbers that used to be in sections 1–2; those are **not** a same-version comparison with the current sections. The current package is `v1.17.0`.

## 0. Methodology & caveats

- **Single machine/environment.** Sections 1–2 use one host (Windows 11 / NVMe / Node 24). Latency reflects that disk/CPU; treat deltas vs a new baseline, not absolute targets.
- **Foreground shell includes process startup.** `project_shell_run` (background=0) spawns a child process and waits for exit, so `shell_foreground_ms` includes shell spawn + stdio handshake. Pure tool latency is better read from the in-process `npm run bench` row or from cached reads.
- **Warm-up required.** The first 3 `project_read_file` warm-ups attach the session cache; the reported "First call" row is post-warm-up. Cold runs (capability open) take ~100-200ms longer.
- **Cache state matters.** Cached-read rows only apply after the warm-up calls; reset with `project_cache_clear` or a fresh session before re-benchmarking.
- **p95 is only shown when n ≥ 30.** With n=3 or n=10 the p95 mostly restates the observed maximum, so it is omitted for those rows. Use `avg`/`max` for small samples instead.
- Results can be **truncated** (`complete:false` / `truncated:true`) when a limit is hit; check those flags before trusting a number.

## 1. End-to-end MCP (`npm run bench:mcp`)

Measured 2026-11-07, `venira-mcp@1.17.0` with the section 6 fix, 44 tools listed, one run of the script.

| Scenario | n | avg | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| **First call** (post warm-up) | 1 | — | **4.6 ms** | — | — |
| `project_read_file`, same file (cached) | 50 | 1.11 ms | 0.92 ms | 1.57 ms | 6.81 ms |
| `project_read_file`, distinct files | 8 | 3.39 ms | 3.24 ms | — | 5.40 ms |
| `project_read_batch` (8 items each) | 3 | **3.79 ms** | 3.37 ms | — | 4.87 ms |
| `project_get_file_info` | 30 | 0.88 ms | 0.80 ms | 1.38 ms | 2.45 ms |
| `project_search` (literal content, first 10 incl. cold) | 10 | 5.67 ms | 1.24 ms | — | 45.28 ms |
| `project_search` (literal content, repeated) | 10 | 1.40 ms | 1.36 ms | — | 2.13 ms |
| `project_symbol_references` (workspace, first 5 incl. cold) | 5 | 11.07 ms | 0.57 ms | — | 52.96 ms |
| `project_symbol_references` (workspace, repeated) | 5 | 0.80 ms | 0.70 ms | — | 1.36 ms |
| `project_read_file` (2 ranges) | 1 | 1.6 ms | — | — | — |
| `project_recent_files` | 1 | 2.8 ms | — | — | — |
| `project_health` (no DB query) | 1 | **27.6 ms** | — | — | — |
| `project_shell_run` foreground (`echo`, includes process spawn) | 1 | 2678.6 ms | — | — | — |

For rows with fewer than 30 samples, p95 is omitted; with n=3 or n=10 it would
mostly restate the observed maximum rather than provide a useful tail estimate.

**Reading the batch row:** 8 distinct reads cost **~4 ms total** as one batch call
vs ~8 × 3.4 ms ≈ 27 ms if issued individually (uncached files).

**Caveats for this run:** the `max` of the search/symbol rows is the first (cold) call, and the single-sample `project_health` / shell rows include one-off costs, so do not read them as steady state. Before the section 6 fix, distinct (uncached) reads were about 2× slower than in the 2026-11-03 `v1.13.8` run (7.27 ms vs 3.53 ms avg); with the fix they are back at 3.39 ms.

## 2. In-process corehost tier (`npm run bench`)

Measured 2026-11-07, `venira-mcp@1.17.0` with the section 6 fix, one run. This tier was **not** run on `v1.16.2`; the 2026-11-03 `v1.13.8` run (first read 161.1 ms, sequential read avg 2.58 ms, `list_files` 26.5 ms, `search` 71.8 ms) is only a rough reference. Before the fix the same tier measured sequential read avg 6.48 ms, `list_files` 197.8 ms, `search` 187.2 ms.

| Scenario | n | Value |
|---|---:|---|
| Direct first read | 1 | 883.25 ms (cold, includes capability open) |
| Direct `read_file` sequential | 50 | avg 1.74 ms / p50 1.57 ms / p95 2.64 ms |
| Direct 8-file batch sequential | 1 | 19.0 ms total |
| Direct parallel ×8 | 1 | 7.1 ms total (in-process, no IPC/audit lock) |
| Direct `get_file_info` | 50 | avg 1.21 ms / p50 1.14 ms / p95 2.33 ms |
| `list_files` | 1 | 41.8 ms |
| `search` (literal, *.ts) | 1 | 132.3 ms |
| `shell_run` + `shell_status` round-trip | 1 | ~2560 ms (wait budget dominates) |

The first-read row (~0.9 s) is dominated by cold start in this run and was ~1.0 s before the fix, so it is not affected by it; the 2026-11-03 run measured 161 ms, which this run does not reproduce.

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

### Side-by-side: v1.0.0 (part 3) vs v1.13.8 (2026-11-03 run, replaced in parts 1–2 by the v1.17.0 run)

These rows measure logically similar operations but come from **different runs, different days, and different harnesses**, so they do not prove a regression:

| Metric | v1.0.0 (part 3) | v1.13.8 (2026-11-03) | Note |
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

Results below are from `npm run bench:tools -- --runs=100` on `venira-mcp@1.17.0`
with the section 6 fix, generated 2026-11-07 on the machine described above
(pre-fix numbers for the same version are in section 6). The PowerShell
suite total is shared across all rows because one process loops all scenarios.

| Task | Cache phase | Venira server p50 | Venira MCP p50 | PowerShell op p50 | PowerShell suite total | Match | Payload bytes V / PS |
|---|---|---:|---:|---:|---:|---|---:|
| read_file | cache_miss | 3.78 ms | 4.89 ms | 1.57 ms | 10458.36 ms (shared suite) | MATCH | 1690 / 1367 |
| read_file | warm | 0.8 ms | 2.23 ms | 1.57 ms | 10458.36 ms (shared suite) | MATCH | 1704 / 1367 |
| read_batch_3_files | cache_miss | 11.65 ms | 12.98 ms | 3.61 ms | 10458.36 ms (shared suite) | MATCH | 4730 / 3565 |
| read_batch_3_files | warm | 1.44 ms | 2.31 ms | 3.61 ms | 10458.36 ms (shared suite) | MATCH | 4771 / 3565 |
| get_file_info | cache_miss | 1.69 ms | 2.19 ms | 0.63 ms | 10458.36 ms (shared suite) | MATCH | 221 / 88 |
| get_file_info | warm | 0.32 ms | 0.64 ms | 0.63 ms | 10458.36 ms (shared suite) | MATCH | 235 / 88 |
| list_files_lib | cache_miss | 1.39 ms | 1.97 ms | 3.76 ms | 10458.36 ms (shared suite) | MATCH | 3289 / 822 |
| list_files_lib | warm | 0.24 ms | 0.71 ms | 3.76 ms | 10458.36 ms (shared suite) | MATCH | 3303 / 822 |
| search_literal | cache_miss | 28.1 ms | 28.71 ms | 41.35 ms | 10458.36 ms (shared suite) | MATCH | 356 / 113 |
| search_literal | warm | 0.25 ms | 0.66 ms | 41.35 ms | 10458.36 ms (shared suite) | MATCH | 369 / 113 |

Notes:
- **PowerShell suite total (10,458.36 ms)** is the whole process looping all scenarios, not per-op. Per-op PowerShell times are much smaller (0.63–3.76 ms p50 for read/info/list, 41 ms for the workspace search).
- Native PowerShell is still faster for uncached single reads, batch reads and metadata; Venira wins on uncached directory listing and search, and on every warm row. The remaining cache-miss gap is mostly the stdio hop plus the response envelope (about 1–1.5 ms).
- The `search_literal` row above uses Venira's default backend (`VENIRA_USE_RIPGREP=1` when ripgrep is on PATH). To compare ripgrep vs JS scanner, run `VENIRA_USE_RIPGREP=0` and `VENIRA_USE_RIPGREP=1` separately through `npm run bench:mcp` and record the `project_search` rows in section 1; add an `rg`-only row here once measured. Do not claim an `rg`-specific number without measuring it.

## 6. Same-day A/B: v1.16.2 vs v1.17.0 (`npm run bench:tools -- --runs=100`)

Both runs on 2026-11-07 (the `v1.17.0` column is the build **before** the fix described below), same machine, same harness (`scripts/bench-tools.ts` from each version's own tree; `v1.16.2` ran from a detached worktree at `176036b`, `v1.17.0` from `4c4b311`). The two runs were sequential, not interleaved, so treat differences under ~30% as noise. All rows: parity MATCH.

| Task | Phase | v1.16.2 server / MCP p50 | v1.17.0 (pre-fix) server / MCP p50 | MCP ratio |
|---|---|---:|---:|---:|
| read_file | cache_miss | 3.1 / 4.0 ms | 9.71 / 11.11 ms | 2.8× |
| read_file | warm | 0.59 / 1.69 ms | 0.81 / 2.14 ms | 1.3× |
| read_batch_3_files | cache_miss | 10.57 / 11.55 ms | 27.37 / 28.94 ms | 2.5× |
| read_batch_3_files | warm | 1.14 / 1.85 ms | 2.74 / 4.33 ms | 2.3× |
| get_file_info | cache_miss | 1.56 / 1.96 ms | 10.39 / 11.38 ms | 5.8× |
| get_file_info | warm | 0.36 / 0.79 ms | 0.79 / 1.82 ms | 2.3× |
| list_files_lib | cache_miss | 1.28 / 1.81 ms | 151.99 / 152.62 ms | 84× |
| list_files_lib | warm | 0.26 / 0.86 ms | 0.28 / 0.86 ms | 1.0× |
| search_literal | cache_miss | 35.46 / 36.14 ms | 41.54 / 42.25 ms | 1.2× |
| search_literal | warm | 0.30 / 0.75 ms | 0.35 / 0.99 ms | 1.3× |

PowerShell proxy p50 was similar in both runs (e.g. `read_file` 1.56 ms vs 1.23 ms, `list_files_lib` 4.26 ms vs 2.9 ms), so the machine was not slower during the `v1.17.0` run.

**Finding (before the fix below):** `v1.17.0` was clearly slower on cache-miss file operations (single reads ~3×, `get_file_info` ~6×, `list_files` of a directory ~84×). Search and warm `list_files` are within noise. Warm reads, batch reads and `get_file_info` are 1.3–2.3× slower, but only by 0.4–2.5 ms in absolute terms; this A/B cannot separate that from run-to-run noise.

### Cause and fix

**Cause:** between `176036b` and `4c4b311`, `isProtectedPath` in `lib/workspace.ts` gained a loop over `snapshotProtectedRoots(defaultDataDir(), WORKSPACE)` (new `lib/snapshot-paths.ts`). On every path check this recomputed the checkpoint roots (including a `realpathSync.native` of the workspace for the cache key) and then canonicalised each root with exists/realpath calls, in addition to the existing data-dir canonicalisation. `list_files` checks every directory entry, so it paid this per entry. A micro-benchmark of 2000 `isProtectedPath` calls measured **2.17 ms/call on v1.17.0 vs 0.114 ms/call on v1.16.2** (19×).

**Fix:** `lib/workspace.ts` now resolves the canonical protected roots (data dir + checkpoint roots) once per input set and caches them for 2 s. The cache key includes the data dir, workspace and both snapshot env vars, so changing any of them takes effect immediately; the TTL only bounds staleness if a symlink is created or swapped under one of those folders. The per-path canonicalisation of the checked path is unchanged. After the fix the micro-benchmark gives **0.10 ms/call**, `npm run verify` passes (507 checks), and the post-fix numbers in sections 1, 2 and 5 are back at or below the v1.16.2 level.

Pre-fix v1.17.0 `bench:tools` (MCP p50, cache miss, for the record): read_file 11.11 ms, read_batch_3_files 28.94 ms, get_file_info 11.38 ms, list_files_lib 152.62 ms, search_literal 42.25 ms.
