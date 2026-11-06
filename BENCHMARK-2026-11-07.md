# Venira MCP benchmark — Windows agent tool path

Measured 2026-11-07 (Asia/Bangkok) on Windows 11 build 26200, Intel Core i5-1035G1, 8 logical processors, 11.8 GiB RAM, Node v24.20.0, PowerShell 5.1.26100.8655, Venira 1.15.1.

## Live Codex tool comparison

Twenty paired samples per phase. Each pair alternated call order. Venira calls used the persistent MCP connection in this Codex session. Each native `exec_command` call launched a fresh PowerShell process. The cold phase cleared the relevant Venira in-process cache before each sample; the warm phase primed and reused it. Windows filesystem cache stayed warm in both phases.

| Workload | Phase | Venira p50 / p95 | `exec_command` p50 / p95 | Ratio by p50 | Exact output parity |
|---|---|---:|---:|---:|---|
| Read first lines of 8 files in one batch | Cache miss | 53.5 / 72 ms | 962 / 1,121 ms | 17.98× | 20/20 pairs |
| Read first lines of 8 files in one batch | Warm | 39 / 60 ms | 1,103.5 / 1,549 ms | 28.29× | 20/20 pairs |
| Search `VENIRA_WORKSPACE` across workspace (49 hits) | Cache miss | 118.5 / 188 ms | 1,034.5 / 1,507 ms | 8.73× | 20/20 pairs |
| Search `VENIRA_WORKSPACE` across workspace (49 hits) | Warm | 34.5 / 152 ms | 1,018 / 1,383 ms | 29.51× | 20/20 pairs |

The read comparison checked normalized file text for `package.json`, `README.md`, `lib/corehost.ts`, `server.ts`, `tsconfig.json`, `opencode.example.json`, `tools/project.ts`, and `scripts/smoke.ts` (same line limits on each path). The search comparison checked exact sorted file and line-number pairs. Both workloads had zero mismatches.

## Component benchmark

Separately, `npm run bench:tools -- --runs=100` ran 100 samples per cache phase through a persistent local MCP stdio client and compared them with native PowerShell operations measured inside one PowerShell process. This isolates tool/server work more than the live comparison and does not include a fresh PowerShell startup for every native sample. OS filesystem cache remained warm.

| Workload | Phase | Venira MCP end-to-end p50 | PowerShell operation p50 | Parity |
|---|---|---:|---:|---|
| Read 25 lines from `package.json` | Cache miss | 3.24 ms | 0.97 ms | Match |
| Read 25 lines from `package.json` | Warm | 1.08 ms | 0.97 ms | Match |
| Read batch of 3 files | Cache miss | 7.92 ms | 2.64 ms | Match |
| Read batch of 3 files | Warm | 1.38 ms | 2.64 ms | Match |
| File metadata | Cache miss | 1.91 ms | 1.37 ms | Match |
| File metadata | Warm | 0.80 ms | 1.37 ms | Match |
| List `lib/` | Cache miss | 2.14 ms | 3.25 ms | Match |
| List `lib/` | Warm | 0.83 ms | 3.25 ms | Match |
| Literal search in `lib/corehost.ts` | Cache miss | 38.12 ms | 39.64 ms | Match |
| Literal search in `lib/corehost.ts` | Warm | 1.32 ms | 39.64 ms | Match |

## What these numbers mean

The live comparison measures practical tool-path latency: a persistent MCP connection versus a new PowerShell process for every Codex `exec_command`. It does not measure raw filesystem speed in isolation. The component benchmark shows that native PowerShell can be faster for simple uncached reads; Venira gains most on repeated warm list/search calls. The live p95 is based on only 20 samples and is rough. This is one Windows machine and one run, not a cross-platform guarantee.

Reproduce the component benchmark from the repository root with:

```powershell
npm run bench:tools -- --runs=100
```

Detailed summaries and the live raw samples are in [`BENCHMARK-2026-11-07.json`](./BENCHMARK-2026-11-07.json).
