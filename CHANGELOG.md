# Changelog

Local release notes for venira-mcp. Not published (not listed in `package.json` `files`) and not pushed to git.

## 1.21.0 — 2026-11-10

### Breaking
- Tool schema Phase 5 removed the last three deprecated arguments (`ROADMAP_TOOL_SCHEMA.md`). None is silently ignored: a client that caches `tools/list` still gets its old arguments to the handler (the tools are registered as loose objects), and the handler refuses them with `[unsupported]` plus a `Hint:` naming the replacement.

  | Removed | Use instead | What the old call does now |
  |---|---|---|
  | `project_snapshot.scope` | `paths` (same list of workspace-relative paths; `paths` defaults to `["."]`) | refused; no checkpoint is created (before, it narrowed the capture) |
  | `project_edit_file.guard`, `project_edit_batch.edits[].guard` | `expected_sha256` (verification is implied by it) | `edit_file`: refused, file untouched; `edit_batch`: rejected as an unknown item key before any edit runs |
  | `project_create.kind="file"`, `content`, `mode`, `expected_sha256` | `project_write_file` (`mode` is `create|overwrite|append`) | refused; nothing is created (before, it wrote the file) |

  `project_create` creates directories only, so a call that used to write a file must move to `project_write_file`. `old_text_fuzzy` stays accepted: no handler ever read it, so it is harmless.

### Added
- `npm run check:docs` now also fails when `package.json`, `package-lock.json`, `server.json` and `lib/version.ts` carry different versions (the 1.20.0 mistake), and it runs as the first step of `npm run verify`, so CI and the Release workflow enforce it before anything is published.
- `npm run test:schema-budget` (in `verify`): measures what each tool adds to `tools/list` and fails when the expert or default total, or any single tool, grows past the ceilings in `scripts/schema-budget.json`. `-- --update` ratchets the ceilings down; `-- --table` only prints. Plan: `ROADMAP_TOOL_SCHEMA.md`.
- `npm run test:edit-verify` (in `verify`): pins the edit verification behavior below.
- `npm run test:edit-fuzzy-gate` (in `verify`): pins how `project_edit_file` / `edit_batch` items answer fuzzy options when `VENIRA_EDIT_FUZZY` is off or on (8 checks).

### Changed
- `project_edit_file` and `project_edit_batch` no longer advertise `guard` or `old_text_fuzzy` (about 0.5 KB less in `tools/list`). Verification is now implied by `expected_sha256`: when it is given, the file is checked first and re-read after the write, and the result reports `verified` and `verified_sha256`. `guard` was then removed entirely in Phase 5 (see Breaking); `old_text_fuzzy` stays accepted at runtime and was never read by any handler. `project_edit_file` is registered as a loose object (see the Phase 3 entry below), so both keys reach the handler there, as they do in `edit_batch` items.
- `project_snapshot` accepted `scope` as an alias for `paths` while the removal was announced; Phase 5 removed it (see Breaking).
- Hint texts that said `guard=sha256` (`safe_edit` removal, out-of-memory diagnosis, tool docs) now say `expected_sha256`.
- Tool schema Phase 2 (first part), `tools/list` 70247 -> 69580 B (expert) and 52983 -> 52316 B (default):
  - One shared `path_` description (`PATH_DESC`): workspace-relative, `.` is the root, absolute or `..` outside the workspace is rejected (unless `VENIRA_UNRESTRICTED=1`).
  - `flag01` no longer carries the generic "1=on, 0=off."; every flag says what `1` does (`edit_batch` items `replace_all` was the last bare one).
  - `project_snapshot` and `project_shell_run`: shorter model-facing docs (`TOOL_DOCS`) and shorter parameter descriptions; detail that the result already carries (`command_status`, `shell_unavailable` fix text) is not repeated.
  - Phase 2 second part, +368 B on purpose (clearer wording, expert 69580 -> 69948 B, default 52316 -> 52663 B): `search.limit` says default/max 200; `change_impact.depth` is hops from the seeds; `dependency_graph.max_edges` says excess sets `truncated`; `cache_clear.type` explains `negative` and `graph`; `pr_merge.commit_message` points to `commit_title`; the "Avoid when" lines of `search`, `outline_symbol`, `selective_search` and `plan_read_batch` now name the sibling tool to use instead.
- `test:schema-budget` now measures what `tools/list` serves (it applies `TOOL_DOCS` to the fake server like `registerProjectTools` does). Before, it measured the inline fallback descriptions, so `TOOL_DOCS` edits were invisible. Ceilings were re-based with `--update --allow-increase`; per-tool numbers moved both ways because of the measuring change.
- Tool schema Phase 3, `tools/list` 69948 -> 68929 B (expert) and 52663 -> 51644 B (default), -1019 B each: `fuzzy_distance`, `ignore_indentation` and `case_insensitive` are only advertised in `project_edit_file` and in every `project_edit_batch` item when `VENIRA_EDIT_FUZZY=1`, like `project_execute_js` and `VENIRA_JS_EXEC_MODE`. With the variable off (the default) they are gone from the schema, and the model-facing text drops the sentence about fuzzy matching (`TOOL_DOCS` appends it only when the variable is on).
  - A call that still sends one while fuzzy is off (a client with a cached tool list, an old script) is refused with `[unsupported] ... Set VENIRA_EDIT_FUZZY=1 on the host ...`, naming every offending option, and the file is not touched. Before, the options were silently ignored and the edit failed as `old_text_not_found`. An explicit `0`/`false` asks for nothing and is not refused. In `edit_batch` the refusal fails that item, so the batch rolls back like any other item error.
  - To make that reachable, `project_edit_file` is now registered as a loose object (unknown keys pass through, like `edit_batch` items). Before, the MCP SDK stripped keys the schema did not list, so the handler never saw a fuzzy option. Side effect: a legacy `guard` key also reaches the handler there, which is what let Phase 5 refuse it with a clear error instead of having the SDK drop it silently.
  - The schema now depends on the environment: a client that caches `tools/list` sees the fuzzy options appear or disappear only after the server restarts with a different `VENIRA_EDIT_FUZZY` and the client refetches the list. Documented in the README env table and in the env registry.
  - Internals: `editBatchItem` became `editBatchItemFor(fuzzy)`, `editFuzzyShape(enabled)` is shared by both tools, `EDIT_ITEM_FUZZY_KEYS` and `fuzzyEditArgsUsed()` live in `lib/arg-hints.ts`, `editFuzzyEnabled()` in `lib/env.ts` (read at call time). Ceilings in `scripts/schema-budget.json` ratcheted down.
- Tool schema Phase 4, `tools/list` 68929 -> 68154 B (expert) and 51644 -> 50869 B (default), -775 B each: `project_create` and `project_shell_run.background` now match the documented convention.
  - `project_create` stops advertising `kind`, `content`, `mode` and `expected_sha256`; `relative_path`, `create_dirs` and `reason` remain. Registering it as a loose object is what kept those arguments reachable for Phase 5, which turned the transitional `kind=file` alias into the refusal described in Breaking.
  - `project_shell_run.background` is advertised as the integer 0|1 like every other flag, instead of a `number | boolean | string` union. `.meta()` overrides only the JSON Schema, so the handler still normalises `true`/`false`, `"1"`/`"0"` and `"true"`/`"False"` from a cached client. `npm run verify` pins both the integer schema and the legacy inputs.
  - `TOOL_DOCS`, the README tool table, the `server.ts` decision tree and the snapshot-discipline line no longer describe `project_create` as a file writer.
  - Ceilings in `scripts/schema-budget.json` ratcheted down; `test:tool-schema` +2 checks (15), `test:tool-envelopes` +1 check (create defaults to a directory).
- Tool schema Phase 5, `tools/list` 68154 -> 67975 B (expert) and 50869 -> 50690 B (default), -179 B each: the deprecated arguments are gone from the schema and their handlers (Breaking above).
  - `project_snapshot` lost `scope`; both it and `project_create` keep `z.looseObject`, so a cached client's removed key reaches the handler and gets `[unsupported]` + a `Hint:` naming `paths` / `project_write_file` rather than being stripped (which would have captured the whole workspace, or created an empty directory).
  - `guard` left `EDIT_ITEM_KEYS` / `EDIT_ITEM_LEGACY_KEYS`: `project_edit_batch` now rejects it as an unknown item key before anything runs, and `project_edit_file` answers `[unsupported]`. Internally the boolean is `verifyMode`, derived from `expected_sha256` only.
  - The transitional `deprecated` field is gone from `project_snapshot` and `project_create` results, and `withCreateFileDeprecation` plus three now-unreachable hint mappings in `lib/output.ts` were deleted.
  - Pinned checks rewritten: `test:tool-schema` asserts `scope`/`guard` are absent from the schema but still reach the handlers, and `test:edit-verify` / `test:snapshot-lifecycle` / `test:tool-envelopes` / `verify` assert the refusals (and that the file, the checkpoint count and the backend call are untouched).

### Fixed
- `npm run verify` had been red since Phase 2, on two pins that no longer matched the repo: `snapshot_tool_teaches_safe_rollback` required the old snapshot wording ("path and size preview", "delete_extra=0") that the Phase 2a trim removed, so it now checks the behaviour the description does teach (`dry_run=1`, `verify=1`, `file_count`, `skipped`); and the per-tool schema ceiling (5000 B) was below `project_read_batch` (5071 B, kept typed on purpose), so it is 5100 B and the "Measured" comment carries the current numbers (expert 63803 B, default 47277 B).

## 1.20.1 — 2026-11-10

### Fixed
- 1.20.0 shipped with `lib/version.ts` still at `1.19.0`, so the server reported the wrong version at runtime and the `doctor` preflight (and therefore CI and the Release workflow) failed with "server version mismatch: 1.19.0 (expected 1.20.0)". npm cannot overwrite a published version, so the correction ships as 1.20.1; use 1.20.1 instead of 1.20.0.
- Read/info cache (`tools/project-cache.ts`), three review findings:
  - The shared byte budget now evicts from the cache that holds the bytes. It used to compare entry counts, so a few large `get_file_info` entries could survive while many small read entries were dropped.
  - The list/search/recent/references TTL caches now have a byte cap per cache (`VENIRA_TTL_CACHE_BYTES`, default 8 MB) on top of the 64-entry cap, which alone allowed ~64 MB per cache.
  - Stat-only validation could serve stale content when a file was rewritten with the same size inside one filesystem timestamp tick. Entries whose mtime is within `VENIRA_CACHE_RACY_MS` (default 30, `0` disables) of caching are now re-read on the next lookup, and a file is stat'ed before and after the read so a file changed mid-read is not cached. Writes made through Venira already invalidated their path; this covers edits by other programs.
- New `npm run test:cache-layer` (7 checks, in `verify`).
- `npm run coverage:shell` no longer fails on Node 20 with "bad option: --test-coverage-lines". Those flags need Node 22.8+, so on older Node the shell suites still run and must pass but the coverage floors are skipped (CI still enforces them on Node 22 and 24).
- Coverage floor margin raised from 4 to 6 points and `scripts/coverage-floors.json` regenerated: Node 22 reports some shell modules 4-5 points lower than Node 24 (e.g. `shell-cmd-switches.ts` 84.35% vs 89.12%), so floors derived on Node 24 failed the Node 22 CI jobs.
- `scripts/test-shell-session-cache.ts`: the Windows-path case now names the `powershell` dialect. It passed on Windows only, because the default dialect follows the host OS, and failed on Linux and macOS CI.
- `scripts/policy-corpus-extra.ts`: the five obfuscated `.env` cases (`.e{nv}`, `('.e'+'nv')`) now expect `ask.command_substitution`, the rule that fires first since the command-substitution hardening. The tier is unchanged (`ask`), so no policy behavior changed.

## 1.20.0 — 2026-11-10

### Breaking
- `project_execute_js` is now gated by a single setting, `VENIRA_JS_EXEC_MODE`: `off` (default, tool hidden) | `ask` | `semi-auto` | `auto`. The old flags `VENIRA_ALLOW_JS_EXEC` and `VENIRA_JS_EXEC_APPROVAL` are removed and no longer read.
- Migration: `ask` = per-call approval plus containment. `semi-auto` = no approval, containment kept (network blocked). `auto` = no approval and no containment, so a config that used `auto` before now runs uncontained; set `semi-auto` to keep the previous behavior.

### Added
- `semi-auto` mode and contained JS execution (`JS_EXEC_CONTAINED` in `lib/workspace.ts`, `contained` option in `lib/js-executor.ts`).
- `lib/config-posture.ts` and `lib/env-registry.ts` report the JS exec mode and warn on uncontained setups.
- New test `npm run test:js-executor` (24 checks), included in `npm run verify`.
- Short actionable hints and `next_actions` for every tool error code; fail-fast key validation with did-you-mean for `edit_batch` / `read_batch`.
- Shell policy: `ALLOW_GIT_PUSH` covers add/commit then push (never force, delete or hook bypass); `shell: "pwsh"` supported.
- Mirror status in `project_health`, per-module coverage floors in `verify`, hybrid symbol bench, PR/MR URL fuzz.
- Tool schema and description clarity pass (roadmap item 16).

### Changed
- Docs (README, SECURITY.md, shell-security.md) rewritten to match the real JS execution and containment behavior.

### Security
- Hardened `shell_run` policy against 4 HIGH pentest findings; command substitutions and PowerShell `( )` / `@( )` / `{ }` now require approval or are treated as uninspectable (`[shell_unavailable]`).

### Verification
- `tsc` clean, `npm run verify`: 520 checks passed.

## 1.19.0 — 2026-11-08

### Added
- Public catalog metadata: `glama.json` (Glama maintainer claim), `mcpName` in `package.json` and `server.json` for the official MCP registry (`io.github.N0moreher0/venira-mcp`).
- Optional snapshot mirror: set `VENIRA_SNAPSHOT_MIRROR_DIR` (absolute, existing folder) and the checkpoint store is copied there in its own layout, append-only (blobs, then indexes, then `project.json`; every copy verified before it gets its final name). Runs after `project_snapshot action=create` (reported as `mirror{}` in the result, never changes the checkpoint's status) and on demand with `action=mirror` (`verify=1` re-hashes and repairs the mirror). Time-bounded by `VENIRA_SNAPSHOT_MIRROR_TIMEOUT_MS`; a stopped run is `partial` and the next run resumes. Closes the 1.18.0 "Still open" item.
- The mirror folder is a protected root for file tools and shell commands, like the store.
- New test `npm run test:snapshot-mirror` (15 checks), included in `npm run verify`.

## 1.18.0 — 2026-11-08

### Added
- Checkpoint manifests are versioned. Older layouts are upgraded in memory through `MIGRATIONS` in `lib/snapshot-store.ts`; the file on disk is never rewritten.
- Unreadable checkpoints are reported instead of silently disappearing: `snapshot_version_unsupported` (written by a newer venira-mcp) and `snapshot_corrupt` (broken index file). `project_snapshot action=list` and `project_health` expose `unreadable[]` plus a hint.
- README: "Backing up the store" section (copy `index\` before `blobs\`, run outside the agent, verify with `action=list`).
- New test `npm run test:snapshot-lifecycle` (14 checks), included in `npm run verify`.

### Changed
- Blob gc is skipped (`gc_skipped: "unreadable_manifests"`) on delete and after retention pruning while any manifest is unreadable, because that manifest still owns blobs this build cannot enumerate. gc resumes once nothing is unreadable.
- The checkpoint store is a protected path for shell commands, not just for the file tools (`deny.protected_file_access` in balanced/strict, `ask` in permissive).

### Fixed
- CI on Linux/macOS: the Windows-path adversarial shell-policy cases (`C:\Users`, `Remove-Item`) now run in the PowerShell dialect instead of the host default (bash), so they no longer depend on the runner OS.
- Build: `lib/secrets.ts` imports the optional `keytar` package through a variable, so `tsc` no longer fails when npm drops it after a failed native install (hit ubuntu Node 20/24 and the `package` job).

### Verification
- `npm run verify`: 518 checks passed. `tsc --noEmit` and `npm run check:docs` clean.
- GitHub CI on `main` (commit 19e8251): 10 of 11 jobs green. `test (windows-latest, 22)` fails in `npm ci` because `better-sqlite3` prebuilt download timed out (infrastructure, not code).

### Still open
- Automated off-machine mirroring of the checkpoint store (only manual backup guidance exists).
