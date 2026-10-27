# Benchmarks — venira-mcp-coding (standalone)

Repeatable benchmarks. Regenerate with:

```bash
npm run build
npm run bench        # in-process corehost tier (pure Node, no IPC)
npm run bench:mcp    # end-to-end over MCP stdio
```

Numbers below are from **2026-10-27** on Windows 11 / NVMe / Node 20, standalone build
(`venira-mcp-coding@1.0.0`, no external binary).

## 1. End-to-end MCP (`npm run bench:mcp`)

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

**Reading the batch row:** 8 distinct reads cost **4.2 ms total** as one batch call
vs ~8 × 2.4 ms ≈ 19 ms if issued individually.

## 2. In-process corehost tier (`npm run bench`)

| Scenario | Value |
|---|---|
| Direct first read | 19.96 ms (cold, includes capability open) |
| Direct `read_file` sequential ×50 | avg 0.72 ms / p50 0.59 ms / p95 1.88 ms |
| Direct 8-file batch sequential | 11.0 ms total |
| Direct parallel ×8 | 2.9 ms total (in-process, no IPC/audit lock) |
| Direct `get_file_info` ×50 | avg 0.30 ms / p50 0.25 ms / p95 0.63 ms |
| `list_files` | 12.7 ms |
| `search` (literal, *.ts) | 9.8 ms |
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
