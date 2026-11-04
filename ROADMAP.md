# Venira-mcp — Engineering Roadmap

> Written 2026-11-05. Complements `TODO.md` (release history) and §14 of the README.
> Each phase ships independently; every phase ends with `tsc` clean, `npm run verify`,
> `npm run check:docs`, `npm run check:source-shape`, `npm run test:shell-security` green,
> and CI on all 6 OS × Node combos. Tool counts only change in Phase C (if a new tool
> is added) and require the Default/Expert exclusion lists to be updated in the same commit.

## Phase A — correctness & observability (this cycle, unreleased v1.14.0)

Done in the current working tree (commit that carries this file):

- **Proactive capability refresh.** `capabilityReady()` reopens the scope after
  `SCOPE_TTL_MS / 2` instead of letting the first tool call past the 2 h mark observe
  `capability_expired`. No call can hit the expiry boundary anymore; the old scope is
  left to be reaped by the host at its 2 h TTL.
- **`project_health` capability state is truthful.** Reports `open` / `refreshing` /
  `expired` from the module-level scope age instead of the previous always-`"open"`.
  `runHealth` also triggers the transparent refresh, so long-lived servers report
  `"open"` unless something bypassed `capabilityReady()`.
- **`project_create` now invalidates caches.** It was writing through `execute()`
  directly, bypassing the mutation handling in `executeCached()` (the `MUTATING` set).
  It now goes through `executeCached("write_file" | "create_directory")`, which also
  records the file in `session_edits` for `project_recent_files`.

Open items carried over:

- **`project_cache_clear` is not a capability tool.** Documented so nobody mistakes a
  cache flush for a scope fix (the cache contains no scope state).
- **Doctor stays strict:** `health_capability_open` passes because health triggers the
  refresh, not because state is fake.

## Phase B — search cache validation & parity (next, small)

The search cache (3 s TTL, `VENIRA_SEARCH_CACHE_MS`, `VENIRA_CACHE_SEARCH_ONLY`,
0-hits never cached, inflight dedup, wiped on mutations) exists but was only exercised
indirectly. Make it provable:

- Add verify checks that a repeated identical search is served from cache and that a
  write invalidates it (extend the existing `search_hits` / `search_hits_invalidate_after_write` pattern to `project_search`, plus `project_symbol_references(scope="workspace")`).
- Bench `project_search` cold vs warm (`bench-mcp.ts`) and record the numbers in the README benchmark table.
- **Negative-cache telemetry:** expose `negative_entries` and `age` in `project_health.caches`
  (the data is already in `negativeReadCache`; only the report is missing).
- **Index-mismatch warning:** when a hits-capped result (`truncated: true`) is returned,
  attach a `hint` naming the cap so the agent knows the index was incomplete.

## Phase C — search hybrid router (opt-in, medium)

Motivation: an agent searching for a symbol today gets either the symbol index or a
content search, never both merged with provenance. Proposal (adapted to this codebase,
which already has an async ripgrep adapter from v1.13.7 and `project_symbol_references`):

1. Fan out **in parallel**: native ripgrep (`\b<query>\b` with `--include` inference from
   the language hint) and `project_symbol_references({ scope: "workspace" })`.
2. Merge hits by `(relative_path, line_number)`; tag each with
   `source: "native" | "venira"` and `confidence: "exact_match" | "symbol_index"`
   (same shape as `project_change_impact`'s confidence model).
3. `Promise.allSettled`; if one side fails, return the other with a `warning` field —
   best-effort, never a hard failure.
4. **Retry-scope fallback:** if the symbol index returns 0 but a content search hits,
   transparently widen to `scope: "workspace"` and note it in the hint.
5. Exposed as `project_search` with `hybrid: 1` (or `semantic_boost`), **not** a new tool —
   the Default/Expert tool counts and the README §4 table stay stable. A new tool is only
   added if the hybrid path proves itself in benchmarks and agents need it discoverable.

Explicitly rejected:

- "Call `project_cache_clear({type:'all'})` before every search" — the anti-pattern of
  thrashing a cache that is already short-TTL and mutation-invalidated. Freshness is an
  existing switch: `VENIRA_SEARCH_CACHE_MS=0`.
- Global `Promise.all` fan-out without failure isolation — must be `allSettled`.

## Phase D — shell cache allowlisting (opt-in, medium)

Today `lib/shell-cache.ts` holds a 100-entry, 5 s LRU for **every** command, keyed by
`cwd::command`. That is fine for `git log`/`rg` and wrong for anything mutating.

- Allowlist of **read-only** patterns (git read subcommands, `rg`, `ls`, file readers,
  `git status --short`) with 5–30 s TTL.
- Everything else: never cached. The decision is made on the parsed argv, not a regex
  substring.
- Opt-in flag `VENIRA_SHELL_CACHE_READ_ONLY=1` (default off until proven).

## Deferred / rejected (with reasons)

| Item | Verdict | Reason |
|---|---|---|
| Cache persistence across restarts | Deferred | Stale data + scope binding; marginal win over the 3–5 s TTL design. |
| `listFilesCache` TTL 1.5 s → 5 s | Measure first | Wipe-on-mutation already bounds staleness; bump only if bench shows hit-rate gains. |
| Auto `project_cache_clear` on errors | Rejected | Already covered by TTLs and mtime validation; masks real staleness bugs. |
| New `project_hybrid_search` tool | Only after Phase C benchmarks | Tool counts are a contract (Default 31 / Expert full). |
| Framework-level telemetry collector (OpenTelemetry) | Rejected for now | `project_health` + `VENIRA_TRACE` are sufficient at this size. |

## Acceptance criteria per phase

- `tsc --noEmit`, `npm run verify` (389/391 locally, 2 approval-gated Windows flakes excluded), `npm run check:docs`, `npm run check:source-shape`, `npm run test:shell-security` all green.
- README §3.5/§4 updated whenever a user-visible flag or behaviour ships; `check:docs` contract kept.
- No tool added/removed/renamed without the Default/Expert lists, README §4.0, and `scripts/check-docs.ts` updated in the same commit.
- CI matrix (ubuntu/windows/macos × Node 20/22) green; macos-22 runner flakes are environmental (GitHub has auto-cancelled it twice), not code.
