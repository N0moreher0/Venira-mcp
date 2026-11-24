# Venira MCP benchmark — tool-mode context cost

Measured 2026-11-24 (Asia/Bangkok) on Windows 11 (platform reported by the host), Node v24.20.0, `venira-mcp@6.1.0`, one run of `npm run bench:modes` (also embedded in `npm run bench:mcp` under `modes`). Raw numbers: [`BENCHMARK-2026-11-24.json`](./BENCHMARK-2026-11-24.json).

## What was measured

`scripts/bench-modes.ts` starts three separate MCP stdio servers, one per `VENIRA_TOOL_MODE` (`default`, `core`, `minimal`), each pointed at its own copy of the same five-file fixture workspace. Each mode then performs the **same task**: read the five files, add a `// touched` line to every one, and run `echo refactor-ok`.

- `default` and `core` use the plain tool surface: one `read_file` batch, one `edit_file` batch, one `shell_run` (3 model→server turns).
- `minimal` uses one `execute_js` snippet: `venira.read([...])`, `venira.edit([...])`, `venira.shell(...)` (1 model→server turn).

All three modes reported `task_ok: true`: the five files were actually edited and the shell command ran in every case.

## Results

| Mode | Tools | Surface (instructions + tools/list) | Turns | Task calls + results | Total (est.) | Task |
|---|---:|---:|---:|---:|---:|---|
| `default` | 31 | 84,784 B (~21,196 tok) | 3 | 5,741 B (~1,436 tok) | **~22,632 tok** | MATCH |
| `core` | 18 | 60,256 B (~15,064 tok) | 3 | 5,742 B (~1,436 tok) | **~16,500 tok** | MATCH |
| `minimal` | 2 | 10,439 B (~2,610 tok) | 1 | 1,130 B (~283 tok) | **~2,893 tok** | MATCH |

Per-mode raw fields:

| Field | `default` | `core` | `minimal` |
|---|---:|---:|---:|
| `tool_count` | 31 | 18 | 2 |
| `instructions_bytes` | 12,071 | 12,068 | 1,988 |
| `tools_list_bytes` | 72,713 | 48,188 | 8,451 |
| `surface_bytes` | 84,784 | 60,256 | 10,439 |
| `call_bytes` | 703 | 703 | 902 |
| `result_bytes` | 5,038 | 5,039 | 228 |
| `task_ms` | 328.4 | 266.0 | 458.5 |

## Method & caveats

- **Surface** = the server `instructions` string plus the complete `tools/list` JSON (names, descriptions, input schemas). In `minimal` the `execute_js` description also carries the generated `.d.ts` SDK contract, which is why its tool count is 2 but its surface is not zero.
- **Task calls + results** = serialized arguments sent for the reference plan plus the response text returned by those same calls. Nothing is estimated from a mock: the task runs against the real server.
- **Tokens = bytes / 4**, the same rough ratio `scripts/test-schema-budget.ts` uses. This is a context-cost estimate, not a tokenizer run: no model is called, so the numbers are reproducible (response byte counts can vary by a byte or two).
- One machine, one run. The shell latency is not the point here and is dominated by process spawn; see section 1 of [`benchmarks.md`](./benchmarks.md) for latency rows.

## What these numbers mean

For this task the `minimal` preset costs ~7.8× fewer estimated context tokens than `default` and ~5.7× fewer than `core`. Nearly all of the saving is the advertised surface (84.8 KB vs 10.4 KB); the executed work is the same, and `minimal` also returns one envelope instead of three. Safety is unchanged: `venira.*` calls still pass through workspace scope, the security profile, Secretlint and the audit table, and each audit row now records which `execute_js` call ran it (`parent_call_id`).

Reproduce from the repository root:

```powershell
npm run build
npm run bench:modes   # or: npm run bench:mcp (adds this block plus the latency rows)
```
