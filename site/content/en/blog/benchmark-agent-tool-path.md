---
title: Benchmark: the agent tool path on Windows
description: A persistent MCP connection against a fresh PowerShell per call - 20 paired samples per phase, exact output parity.
date: 2026-11-07
---

# Benchmark: the agent tool path on Windows

When an agent reads a file or searches a workspace, the interesting cost is not disk I/O - it is the *tool path*: everything between the model's decision and the bytes coming back. This benchmark measures that path for venira-mcp against the obvious alternative: letting the agent run shell commands and parse the output.

## Setup

Measured 2026-11-07 (Asia/Bangkok) on Windows 11 build 26200, Intel Core i5-1035G1 (8 logical processors, 11.8 GiB RAM), Node v24.20.0, PowerShell 5.1. Venira 1.15.1 for the live Codex comparison and 1.17.0 for the component benchmark.

Method: **twenty paired samples per phase**, with each pair alternating call order. Venira calls ran over the persistent MCP connection already open in the Codex session; each native `exec_command` call launched a fresh PowerShell process. The cold phase cleared the relevant in-process cache before each sample, the warm phase primed and reused it. Windows filesystem cache stayed warm in both phases. Both workloads were checked for exact output parity on every pair.

## Live comparison against Codex `exec_command`

| Workload | Phase | Venira p50 / p95 | `exec_command` p50 / p95 | Ratio by p50 | Parity |
|---|---|---:|---:|---:|---|
| Read first lines of 8 files in one batch | Cache miss | 53.5 / 72 ms | 962 / 1,121 ms | 17.98x | 20/20 |
| Read first lines of 8 files in one batch | Warm | 39 / 60 ms | 1,103.5 / 1,549 ms | 28.29x | 20/20 |
| Search workspace (49 hits) | Cache miss | 118.5 / 188 ms | 1,034.5 / 1,507 ms | 8.73x | 20/20 |
| Search workspace (49 hits) | Warm | 34.5 / 152 ms | 1,018 / 1,383 ms | 29.51x | 20/20 |

The read comparison compared normalized file text for eight named files; the search comparison compared exact sorted file / line-number pairs. Zero mismatches across all 40 pairs in both workloads.

The pattern is consistent: a fresh PowerShell process costs roughly a second before any work happens, while the persistent connection does the same work in tens of milliseconds - and batching eight reads into one call removes seven round trips on top.

## Component benchmark

Separately, `npm run bench:tools -- --runs=100` (100 samples per phase) compared individual tool calls through a persistent local MCP stdio client with native PowerShell operations measured *inside* one PowerShell process - so native startup cost is excluded and the comparison isolates the tool work itself:

| Workload | Phase | MCP end-to-end p50 | PowerShell p50 |
|---|---|---:|---:|
| Read 25 lines from `package.json` | Cache miss | 4.89 ms | 1.57 ms |
| Read batch of 3 files | Warm | 2.31 ms | 3.61 ms |
| List `lib/` | Cache miss | 1.97 ms | 3.76 ms |
| Literal search in one file | Warm | 0.66 ms | 41.35 ms |

This one is more honest about the trade-off: for uncached single reads and metadata, plain PowerShell is faster - the MCP layer adds a few milliseconds, which is the price of the audit trail, the path guard and the stable envelope. For warm reads, listings and especially search, venira-mcp wins even without the process-startup handicap, because the in-process cache holds results that a fresh shell has to recompute every time.

An earlier run the same day showed a cache-miss slowdown caused by repeated path canonicalisation in `isProtectedPath`; it was fixed before these numbers were taken.

## Read the fine print

This is one Windows machine, one run, and the live p95 rests on only 20 samples - treat the numbers as a direction, not a guarantee. The method, the full component table and the raw samples are published in the repository: [BENCHMARK-2026-11-07.md](https://github.com/N0moreher0/Venira-mcp/blob/main/BENCHMARK-2026-11-07.md) and [BENCHMARK-2026-11-07.json](https://github.com/N0moreher0/Venira-mcp/blob/main/BENCHMARK-2026-11-07.json).

Reproduce the component benchmark yourself:

```bash
npm run bench:tools -- --runs=100
```
