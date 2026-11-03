# Benchmarks — venira-mcp (standalone)

Repeatable benchmarks. Regenerate with:

```bash
npm run build
npm run bench        # in-process corehost tier (pure Node, no IPC)
npm run bench:mcp    # end-to-end over MCP stdio
```

Numbers below are from **2026-11-03** on Windows 11 / NVMe / Node 20, standalone build
(`venira-mcp@1.13.8`, no external binary).

## 1. End-to-end MCP (`npm run bench:mcp`)

| Scenario | avg | p50 | p95 | max |
|---|---|---|---|---|
| **First call** (post warm-up) | — | **62.9 ms** | — | — |
| `project_read_file` ×50, same file (cached) | 1.21 ms | 1.00 ms | 2.52 ms | 5.67 ms |
| `project_read_file` ×8, distinct files | 3.53 ms | 3.84 ms | 5.06 ms | 5.06 ms |
| `project_read_batch` ×3 (8 items each) | **3.14 ms** | 3.11 ms | 3.68 ms | 3.68 ms |
| `project_get_file_info` ×30 | 0.87 ms | 0.63 ms | 2.52 ms | 4.17 ms |
| `project_search` ×10 (literal content) | 7.79 ms | 1.35 ms | 66.64 ms | 66.64 ms |
| `project_read_ranges` (2 ranges) | 7.7 ms | — | — | — |
| `project_recent_files` | 1.4 ms | — | — | — |
| `project_health` (no DB query) | **5.2 ms** | — | — | — |

**Reading the batch row:** 8 distinct reads cost **3.1 ms total** as one batch call
vs ~8 × 3.8 ms ≈ 30 ms if issued individually.

## 2. In-process corehost tier (`npm run bench`)

| Scenario | Value |
|---|---|
| Direct first read | 161.1 ms (cold, includes capability open) |
| Direct `read_file` sequential ×50 | avg 2.58 ms / p50 2.29 ms / p95 4.19 ms |
| Direct 8-file batch sequential | 24.4 ms total |
| Direct parallel ×8 | 11.9 ms total (in-process, no IPC/audit lock) |
| Direct `get_file_info` ×50 | avg 1.58 ms / p50 1.28 ms / p95 3.04 ms |
| `list_files` | 26.5 ms |
| `search` (literal, *.ts) | 71.8 ms |
| `shell_run` + `shell_status` round-trip | ~930 ms (2 s wait budget dominates) |

## 3. Historical comparison (Rust-backend v0.3.0 → standalone v1.0.0)

Same machine, same test suite:

| Metric | v0.3.0 (Rust IPC) | v1.0.0 (standalone Node) | Note |
|---|---|---|---|
| First MCP call | 6.3 ms | **2.5 ms** | no subprocess spawn |
| Cached read p50 | 2.57 ms | **1.01 ms** | in-process file I/O |
| 8-file batch avg | 19.11 ms | **4.18 ms** | no IPC + no audit lock |
| `get_file_info` p50 | 2.60 ms | **1.02 ms** | |
| `project_health` | 5.5 ms | **1.8 ms** | |
| Dependencies | Rust binary + Node | **Node only** | install surface ↓ |

> The standalone build removes the JSON-Lines IPC hop and the SQLite WAL audit lock
> contention that dominated the v0.3.0 profile. Search p95 (21.8 ms) is filesystem-bound
> and comparable across both builds.

## 4. How to add a scenario

- Keep MCP-level scenarios in `scripts/bench-mcp.ts`, in-process ones in `scripts/bench.ts`.
- Use a unique `VENIRA_SESSION_ID` / request tag per run (audit `request_id` is UNIQUE).
- Print one JSON object per run so results are easy to diff across versions.
- Record Node version, OS, and disk type in a comment at the top of `benchmarks.md`.
