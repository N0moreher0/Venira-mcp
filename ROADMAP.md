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

## Phase B — search cache validation & parity (shipped)

- `project_symbol_references(scope:"workspace")` now serves repeats from a dedicated
  `referencesCache` (3 s TTL, key = inner search args), because the host reports
  `complete: false` when it stops at the hit cap and `searchCache` only stores
  complete results — before this, warm calls re-walked the repo (~90 ms → ~0.7 ms).
  Writes invalidate it via the same mutation path (`invalidateListCaches`).
- `project_health.caches` gained `negative.ttl_ms` and `negative.oldest_age_ms`
  (plus `references.entries/hit_rate`) — the negative-cache telemetry is now visible.
- `verify.ts` covers `search_cache_hit`, `symbol_references_workspace_cache_hit`,
  `symbol_references_cache_invalidated_on_write`, `health_negative_cache_reported`
  (verify now 395 checks; "Search incomplete (raise limit max 200)" hint already
  existed at the envelope layer for hits-capped results).
- Bench recorded: search warm ≈ 1.3 ms (cold first call ≈ 100 ms), symbol_references
  workspace warm ≈ 0.74 ms (vs ~78 ms before the dedicated cache).

Rejected here:

- "Call `project_cache_clear({type:'all'})` before every search" — anti-pattern;
  `VENIRA_SEARCH_CACHE_MS=0` is the supported strict-freshness switch.
- Relaxing `searchCache` to store incomplete results — would hide later matches for
  the TTL window and changes `project_search` semantics; the dedicated cache is the
  narrow, reversible fix.

## Phase C — search hybrid router (shipped, revised)

Shipped as opt-in `project_search({ hybrid: 1 })` — **no new tool**; the Default/Expert
counts and the README §4 tables are unchanged.

Implementation differs from the first draft (deliberate engineering call, not a shortcut):
rather than a second ripgrep pass racing the first (`Promise.allSettled` over identical
args), hybrid mode runs **one** backend walk and enriches the returned hits — the
"two sides" would share the same backend anyway, so the fan-out doubled work for zero
extra information.

Per hit:

- `source: "symbol_index"` + `confidence: "exact_match"` when the line is a **definition**
  of the queried identifier (detected per file with the same parser-lite as
  `project_outline_symbol`, bounded to ≤32 files with hits),
- `source: "symbol_reference"` + `exact_match` for whole-word matches elsewhere,
- `source: "content"` + `text_match` for substring-only matches.

Fallback behaviour: a scoped (`relative_path`), identifier-like query returning zero hits
widens once to the workspace and flags `scope_widened: true` in the data — the agent
knows the scope changed instead of concluding "symbol does not exist".

Envelope stays backward-compatible (additive fields only); `hybrid: true` and
`kind: literal_content` only. Verify covers `search_hybrid_returns_tagged_hits` and
`search_hybrid_scope_widened_on_empty`.

Not shipped (deliberately):

- No second search pass / no extra MCP round-trip.
- No `source: "native" | "venira"` split — both sides would be the same backend; the
  signal would be meaningless.
- No fixture-matrix parity suite yet for the *search* path — the **symbol-extraction**
  matrix shipped (verify `symbol_extract_fixture_matrix`, 39 cases across TS/Rust/
  Python/Go), and the **search-path matrix shipped too**: verify
  `search_hybrid_symbol_index_{typescript,rust,python,go}` assert an end-to-end hybrid
  search on a fixture file tags the definition hit `symbol_index` at its line.
  Dependency graph also covers Go, Java and Kotlin (`go.mod` module resolution,
  package-import resolution, per-file declarations) — covered by verify
  `dependency_graph_go_internal_import`, `dependency_graph_go_stdlib_external`,
  `dependency_graph_go_references`, `dependency_graph_java_internal_import`,
  `dependency_graph_java_external_jdk`, `dependency_graph_kotlin_internal_import`,
  `change_impact_go_package_dependent`, `change_impact_java_package_dependent`.

Rejected (unchanged): "cache-clear before every search"; widening `searchCache` to store
partial results (changes `project_search` semantics; dedicated `referencesCache` instead).

Explicitly rejected:

- "Call `project_cache_clear({type:'all'})` before every search" — the anti-pattern of
  thrashing a cache that is already short-TTL and mutation-invalidated. Freshness is an
  existing switch: `VENIRA_SEARCH_CACHE_MS=0`.
- Global `Promise.all` fan-out without failure isolation — must be `allSettled`.

## Phase D — shell cache allowlisting (shipped)

`lib/shell-cache.ts` was rewritten to decide caching on the **parsed argv**, never on a
raw substring match. Previously *every* successful command (including `git push`, which
then reported `cache.hit` + `decision: allow` on the repeat) could be stored for 5 s.

Now, by default, only genuinely read-only commands are stored:

- `git` read subcommands — `status`, `log`, `diff`, `show`, `blame`, `rev-parse`,
  `rev-list`, `ls-files`, `ls-tree`, `cat-file`, `shortlog`, `describe`, `name-rev`,
  `var` (and all-flags invocations like `git --version`); `branch`/`tag` allowed unless a
  write flag is present (`-d`/`-m`/`-u`/`-f`/…, tag additionally `-a`/`-s`/`-m`);
  `remote` only with `-v`/`get-url`/`get` (or bare); `stash` only `list`/`show`;
  `worktree list` and `submodule status` only.
- `rg`/`ripgrep`/`fd`/`fdfind`, `ls`, `dir`, `find` (without `-delete`/`-exec`/…), `grep`,
  `findstr`, `tree`, file readers (`cat`, `head`, `tail` — never `-f`/`-Wait`; PowerShell
  `Get-Content` without `-Wait`), `pwd`, `cd`, `echo`, `wc`, `stat`, identity probes
  (`whoami`, `hostname`, `date`, `ver`, `uname`, `where`, `which`), and version probes
  (`node|npm|npx|yarn|pnpm|cargo|rustc|go|python -v|--version`).
- Any compound command — pipes `|`, chains `&&`/`;`/`&`, redirection `>`/`>>`, subshells
  and substitutions `` ` ``/`$()`/`$(`/`${` — is never cacheable, because any of those can
  mutate, hang or exfiltrate. Quote-aware scanning decides this on the raw text before
  argv tokenization, so `git log --format="%s | %s"` (pipe *inside* quotes) is fine.

`VENIRA_SHELL_CACHE_READ_ONLY=0` restores the legacy cache-everything behaviour
(deprecated, kept for transition); `VENIRA_SHELL_CACHE=0` disables the cache entirely.
Verify covers a 43-case classifier table (`shell_cache_readonly_allowlist`);
`test:shell-security` unchanged and green.

Follow-up (bug fix, same area): async shell runs trimmed their tails **once at spawn**,
so `project_shell_status` reported `stdout_tail: ""` forever for fast commands — and the
shell cache could be written with empty output. Tails are now trimmed at status-read time
and at process `close`; the cache write moved to `close` as well. (`shell_output` /
`policy_env_scrubbed` local Windows flakes disappeared after this fix.)

## Deferred / rejected (with reasons)

| Item | Verdict | Reason |
|---|---|---|
| Cache persistence across restarts | Deferred | Stale data + scope binding; marginal win over the 3–5 s TTL design. |
| `listFilesCache` TTL 1.5 s → 5 s | Measure first | Wipe-on-mutation already bounds staleness; bump only if bench shows hit-rate gains. |
| Auto `project_cache_clear` on errors | Rejected | Already covered by TTLs and mtime validation; masks real staleness bugs. |
| New `project_hybrid_search` tool | Only after Phase C benchmarks | Tool counts are a contract (Default 31 / Expert full). |
| Framework-level telemetry collector (OpenTelemetry) | Rejected for now | `project_health` + `VENIRA_TRACE` are sufficient at this size. |

## Acceptance criteria per phase

- `tsc --noEmit`, `npm run verify` (414 checks, all green locally; the two old Windows-local flakes were root-caused and fixed — async shell runs trimmed their tails at spawn instead of at `close`, so fast commands returned empty `stdout_tail`), `npm run check:docs`, `npm run check:source-shape`, `npm run test:shell-security` all green.
- README §3.5/§4 updated whenever a user-visible flag or behaviour ships; `check:docs` contract kept.
- No tool added/removed/renamed without the Default/Expert lists, README §4.0, and `scripts/check-docs.ts` updated in the same commit.
- CI matrix (ubuntu/windows/macos × Node 20/22) green; macos-22 runner flakes are environmental (GitHub has auto-cancelled it twice), not code.
