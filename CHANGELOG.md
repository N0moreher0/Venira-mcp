# Changelog

Local release notes for venira-mcp. Not published (not listed in `package.json` `files`) and not pushed to git.

## Unreleased

### Added
- `project_move_path` and `project_copy_path` (`ROADMAP_TOOLS.md`, phase 1). Renaming, relocating and duplicating files no longer needs `shell_run`.
  - `project_move_path {from, to, overwrite?, create_dirs?}`: moves or renames a file or directory. `overwrite=1` replaces an existing target **file** (never a directory); `create_dirs` defaults to 1. A cross-volume move falls back to copy + remove. On Windows a change of letter case only (`Foo.ts` -> `foo.ts`) is allowed.
  - `project_copy_path {from, to, recursive?, overwrite?, create_dirs?}`: copies a file, or a directory with `recursive=1`. Symbolic links and protected files inside a directory are skipped and counted (`skipped_symlinks`, `skipped_protected`).
  - Both refuse the workspace root as source, a directory into itself, protected paths and paths outside the workspace; a missing source is `[not_found]`, an existing target without `overwrite` is `[conflict]`. Both need an audit `reason` (auto-generated unless `VENIRA_SECURITY_PROFILE=strict`) and invalidate the read/list/search caches for both paths.
  - Tool counts: default 27 -> 29, expert 40 -> 42 (30 / 43 with `VENIRA_JS_EXEC_MODE` on). `tools/list`: expert 69293 -> 72381 B, default 49483 -> 52571 B (+3088 B each, ceilings re-based on purpose).
  - Tests: new `test:move-copy` (15 checks), wired into `npm run verify`.
- `project_apply_patch` (`ROADMAP_TOOLS.md`, phase 2). A unified diff spanning multiple files now lands atomically instead of through many `project_edit_file` calls.
  - `project_apply_patch {patch, dry_run?, expected_sha256?, reason?}`: parses git-style unified diffs (`diff --git` sections or bare `---`/`+++` pairs, `/dev/null` for created/deleted files, pure renames and renames with hunks). Every file is validated in memory **before anything is written** (paths stay inside the workspace, regular files only, optional per-file `expected_sha256` check); then files are written, or on any failure rolled back from an automatic checkpoint plus manual cleanup of patch-created files (like `project_edit_batch`). CRLF files keep CRLF endings; a LF patch applies to a CRLF file.
  - The all-or-nothing guarantee has two layers: an in-memory veto (every hunk of every file is dry-applied first) aborts before a single byte is written, and a mid-apply I/O error restores all existing files from the checkpoint and deletes files the patch created. A failed rollback keeps the checkpoint and reports `rollback_succeeded: false` with the `snapshot_id`.
  - `dry_run=1` validates against the current files and reports `files[]` `{action, relative_path, hunks, bytes}` and `added/modified/deleted/renamed` counts; it writes nothing and is not audited (like `shell_status`), and needs no `reason`.
  - Results report per-file `action` (`added|modified|deleted|renamed`), `bytes`, `hunks`, `sha256_after`; a mismatching hunk fails with `[stale_content]` and `data.nearest_context` lines for the file and hunk that failed.
  - Tool counts: default 29 -> 30, expert 42 -> 43 (31 / 44 with `VENIRA_JS_EXEC_MODE` on). `tools/list`: expert 72381 -> 74404 B, default 52571 -> 54594 B (+2023 B each, ceilings re-based on purpose); `scripts/verify/core.ts` `DEFAULT_TOOL_LIST_MAX_BYTES` 50000 -> 53000 to match (its JS-off default measure is 52967 B).
  - Tests: new `test:apply-patch` (23 checks: create/modify/delete/rename, rename with hunks, CRLF/LF handling both ways, multi-file atomicity (nothing is written when one hunk fails), `expected_sha256` guard, malformed patch refusals, binary (non-UTF-8) file refusal, out-of-workspace and absolute paths, dry_run), wired into `npm run verify`.
- `project_git_status`, `project_git_diff`, `project_git_log` (blame via `blame=1`), `project_git_branch`, `project_git_commit`, `project_git_stash` (`ROADMAP_TOOLS.md`, phase 3). Local worktree git is parsed and locale-independent (`LC_ALL=C`, NUL-separated porcelain v2); push is never performed - it stays an explicit named shell override.
  - `project_git_status {paths?}`: branch/detached, upstream (+ `upstream_gone`), ahead/behind, per-file `{path, old_path?, staged, unstaged, untracked, unmerged, kind, status, index_status, worktree_status}` plus `counts` and a `clean` flag; `paths[]` limits the result.
  - `project_git_diff {staged?, paths?, context_lines?, include_patch?, max_bytes?}`: per-file `action` (`added|modified|deleted|renamed`) with parsed `hunks[]` (`old_start/old_lines`, `new_start/new_lines`, `section`), `counts`, `patch_bytes`; `include_patch=1` adds the unified text, byte-capped at `max_bytes` (`patch_truncated` when cut).
  - `project_git_log {ref?, limit?, paths?, author?, grep?}`: commits `{sha, short_sha, author, email, authored_at, committer, committed_at, subject, body}`; `blame=1` with `path` switches to per-line blame (`line, commit, author, authored_at, summary, prev_sha, prev_path`), capped by `max_lines`.
  - `project_git_branch {action=list|current|create|switch|delete, name?, from?, include_remote?, force?}`: `list` reports `current`, `branches[] {name, current, commit, short_sha, upstream, track, remote}`; `create`/`switch`/`delete` report `created`/`switched`/`deleted`; duplicate name gives `[conflict]`, missing branch gives `[not_found]`.
  - `project_git_commit {message, paths?, allow_empty?, amend?}`: stages `paths[]` first, otherwise commits what is already staged; refuses a commit with no staged changes (`invalid_request`, pass `allow_empty=1`); reports `sha`, `short_sha`, `files_changed`, `files`, `amend`.
  - `project_git_stash {action=push|list|apply|pop|drop|show, selector?, paths?, message?, include_untracked?}`: push stashes staged+unstaged tracked changes (`-u` with `include_untracked=1`); `list`/`show` are read-only; apply/pop/drop take `stash@{N}` (an invalid selector is `invalid_request`).
  - Read-only git runs without a `reason` (`status`, `diff`, `log`/blame, `git_branch` list/current, `git_stash` list/show); mutating calls require the audited `reason` path, and worktree-wide mutations invalidate the whole cache.
  - Local git runs only against the workspace **repository root** (`git rev-parse --show-toplevel`; compared by device/inode on Windows); paths stay workspace-relative and are passed after `--`; refs/branch names with a leading dash are rejected.
  - Tool counts: default 30 -> 36, expert 43 -> 49 (37 / 50 with `VENIRA_JS_EXEC_MODE` on). `tools/list`: expert 74404 -> 83661 B, default 54594 -> 63851 B; `scripts/schema-budget.json` ceilings re-based on purpose; `scripts/verify/core.ts` `DEFAULT_TOOL_LIST_MAX_BYTES` 53000 -> 63000 and `EXPERT_TOOL_LIST_MAX_BYTES` 72000 -> 85000 to match (JS-off measures ~62200 / ~82000 B).
  - Tests: new `test:git-local` (20 checks: init/clean/untracked/staged-rename-with-old_path status parsing, paths filter, staged+worktree diff hunks, log author+grep filters, blame mode, branch create/list/switch/delete round trip + duplicate-conflict and missing-branch, commit with explicit paths / nothing-to-commit refusal / allow_empty, stash push/list/show/pop round trip, no-op push, invalid selector, out-of-workspace path refusal), wired into `npm run verify`.

### Changed
- Tool-surface selection is consolidated into one variable: `VENIRA_TOOL_MODE` (breaking). `VENIRA_PROFILE` is removed; `VENIRA_TOOL_MODE` now accepts `core` | `default` | `expert`. `core` = the `default` set minus the code-intelligence tools (`project_execute_js`, `project_outline_symbol`, `project_diff_files`, `project_symbol_references`, `project_recent_files`, `project_dependency_graph`, `project_change_impact`) — the small-model/restricted-context preset; the README had documented only 5 of these 7. Setting `VENIRA_PROFILE` now logs a startup warning (`removed_var`) and is ignored. Tool counts: core **29**, default **36**, expert **49**.
- Security/behaviour flags consolidated around `VENIRA_SHELL_MODE` and `VENIRA_PERMISSION_MODE` (breaking). Removed, no alias, with registry `removed` warnings: `VENIRA_SHELL_EXIT_EARLY` (always on), `VENIRA_SHELL_TIMEOUT_POLICY` (always `hard` — kill the process tree; `soft` is gone), `VENIRA_SHELL_ENV_PASS_ALL` (full host env in `off`/`permissive` only), `VENIRA_SHELL_ELICIT` (elicitation = `balanced`: every ask-rule prompt; `permissive`: high-risk ask rules only — network/git-history-rewrite/dynamic-exec/outside-workspace I/O/command substitution/process & container control/secret dump/unresolved args; `strict` never prompts; `off` bypasses), `VENIRA_SECRET_ALLOW_REVEAL` (reveal only in `off`/`permissive`), `VENIRA_AUDIT_FAST` (always on), `VENIRA_CACHE_ALL` (alias of `VENIRA_CACHE`; gone, `VENIRA_CACHE` remains), `VENIRA_TRACE` (tracing always on; `VENIRA_TRACE_FILE` still opts into a rotating file). `VENIRA_JS_EXEC_APPROVAL`'s successor behaviour moved into `VENIRA_PERMISSION_MODE`: `allow_all` (the default) skips the `ask`-mode approval prompt; any other value keeps it. Network access is now always open in every mode, including contained JS exec; the egress guard was removed.
- Docs: the README environment reference now covers **every** supported `VENIRA_*` variable. The environment table lists the three shell caps (`VENIRA_SHELL_TAIL_MAX` — characters kept in a shell run's stdout/stderr tail; `VENIRA_SHELL_MAX_OUTPUT_BYTES`; `VENIRA_SHELL_MAX_TIMEOUT_MS`), and a new "Advanced tuning knobs (all optional)" table covers the remaining advanced variables (shell caching, ripgrep/cache TTLs, `VENIRA_AUDIT_STRICT` / `VENIRA_AUDIT_KEEP_DAYS`, snapshot size caps, git provider tuning and overrides, `VENIRA_SECRET_KEYCHAIN`, `VENIRA_TRACE_FILE`, workspace switching). The env-registry `documented` flags now match the README tables: every supported variable is `documented: true` (the registry contract — documented, or an explicit reason — is now met everywhere; `NOT_DOC` is gone). Tool/test behaviour is unchanged.
- CI: the `coverage:shell` gate now passes on Linux and macOS, not only on Windows. `lib/shell-invocation.ts` splits its win32 shell resolution into a pure `resolveOnWindows(binary, entries, exists)` with a filesystem-injectable `exists` probe (and a parameterized `pathEntries`), so `test:shell-invocation` covers the WSL / Git Bash / native / unknown classification cross-platform with a fake PATH (8 new checks; 21 total). The exported `resolveShellBinary` signature is unchanged (`platform` / `pathEnv` / `exists` are additive defaults); Windows behaviour is identical. `scripts/coverage-floors.json` is unchanged — the win32-only code is now covered, not exempted.
- CI (verify `consistency.ts`): the harness writes fixture files directly via `fs` (not through the MCP tools), so a dependency-graph cache entry built moments earlier by another verify section hid `.verify-tmp/impact/alpha.ts` from `project_change_impact` (the 5 s `INDEX_CACHE_TTL_MS` race; Node-24 runners on ubuntu-22/24, macos-24, windows-24 saw the unresolvable seed, Node-20/22 runners did not). The section now calls `project_cache_clear` with `type: "graph"` before seeding fixtures — deterministic regardless of runner speed.
- CI (Node 20): `test:js-executor` no longer hard-requires a global `WebSocket` (unflagged only in Node 22+); it asserts WebSocket availability when the runtime exposes it and its absence on Node < 22 ("JS executor tests FAILED (2 of 32)" on `ubuntu-latest, 20` and `macos-latest, 20`). Node 20 fails/passes the same elsewhere.

## 1.22.0 — 2026-11-13

### Changed
- Fewer variables in a client config (`ROADMAP_ENV_SLIM.md`, phases 1, 2a-2d). Nothing is removed: every old variable still works, an explicitly set variable always beats a preset, and a bad value still fails closed with `[config_invalid]`.
  - README: the examples keep only `VENIRA_WORKSPACE` and `VENIRA_TOOL_MODE`, a "Config recipes" section lists the minimal, trusted and full-trust setups, and no example restates a default (`VENIRA_OUTPUT_MODE=full`, `VENIRA_SECURITY_PROFILE=balanced`).
  - New security profile `open` (`lib/profile-env.ts`, imported first by `server.ts` and `native-adapter.ts`): shell policy off plus `VENIRA_UNRESTRICTED=1`, `VENIRA_PERMISSION_MODE=allow_all`, `VENIRA_JS_EXEC_MODE=auto`, `VENIRA_SHELL_ELICIT=0` and `VENIRA_SHELL_ENV_PASS_ALL=1`, for variables left unset. `VENIRA_SHELL_OVERRIDES`, `VENIRA_ALLOW_SELF_INSTALL`, `VENIRA_SECRET_ALLOW_REVEAL` and `VENIRA_SECRET_KEYCHAIN` are never implied. Posture and doctor report it as full trust.
  - New `VENIRA_CACHE=all|list|search|off` (`lib/cache-mode.ts`, default `all`). `VENIRA_CACHE_ALL`, `VENIRA_CACHE_LIST_ONLY` and `VENIRA_CACHE_SEARCH_ONLY` are aliases and win per variable when set; an unknown mode fails closed.
  - `VENIRA_GITHUB_ALLOW_HTTP` and `VENIRA_GITHUB_API_URL` are deprecated aliases of `VENIRA_GIT_ALLOW_HTTP` and `VENIRA_GIT_API_URL` (the `GIT_*` name already won). Using an old name prints a one-time stderr note (`lib/env-deprecation.ts`); behavior is unchanged.
  - Audit group reviewed and deliberately not merged: `VENIRA_AUDIT_STRICT` (failure policy), `VENIRA_AUDIT_DETAIL` (how much is stored) and `VENIRA_AUDIT_FAST` are different axes. `VENIRA_AUDIT_FAST` has no effect on audit writes (only `project_health` reports it); its registry text now says so, and it is a candidate for removal in a later breaking release.
  - Tests: `test:env-registry` +9 checks for `VENIRA_CACHE` and the alias notes (54 in total).
- `project_read_audit` now says what ran and how it ended, not only that it ran. Each job keeps a redacted one-line `args_summary` and `result_summary` (plus `result_bytes`) in a new table `project_tool_audit_detail`, keyed by `request_id`; the hash-chained audit rows are unchanged. `VENIRA_AUDIT_DETAIL` = `off` | `summary` (default) | `full` decides what is stored; `full` also keeps the redacted, size-capped (16 KiB) args and result JSON. Reads follow `VENIRA_OUTPUT_MODE`: compact returns the summaries (default `limit` 15 instead of 50, so it stays under the 8 KiB trim), full adds `args` and `result` per row within a 256 KiB total (`detail_omitted` marks rows left out; pass `request_id` for one job in full). New `request_id` filter. Bulk text (file contents, edit bodies, `value`, tokens) is stored as its length only. Also fixed: the `outcome` filter documented `success`/`failure` but the log stores `succeeded`/`failed`, so it never matched; both spellings are accepted now. Schema grew on purpose (`project_read_audit` 1549 -> ~1.9 KB), ceilings re-based. Tests: `audit_rows_carry_args_and_result_summary`, `audit_detail_never_holds_secret_value`, `audit_lookup_by_request_id`, `audit_outcome_accepts_documented_words`. Rows written before this change have no detail.
- Setup tools are opt-in (Phase 8 patch 2, `ROADMAP_TOOL_SCHEMA.md`). `project_detect_harnesses` and `project_install_self` are only advertised in `tools/list` with `VENIRA_SETUP_TOOLS=1` (default `0`, read at start-up, so restart the server after changing it). They are used once, when wiring Venira into a client, and `npx venira-mcp --install` / `--print-config` do the same from a terminal. `tools/list`: expert 70716 -> 68971 B, default 50906 -> 49161 B (-1745 B each); tool counts default 28 / expert 41 with `VENIRA_JS_EXEC_MODE` on (27 / 40 without). `project_secret` and `project_github_connect` stay listed: they have no CLI equivalent, and error hints point to them. **Migration:** a client that called these two tools must set `VENIRA_SETUP_TOOLS=1` or use the CLI. `VENIRA_ALLOW_SELF_INSTALL` still decides whether `project_install_self` may write other clients' config files.
- CI selectors are consistent (Phase 8 patch 1, `ROADMAP_TOOL_SCHEMA.md`). `project_ci_status` now rejects two or more of `run_id` / `ref` / `pr` / `branch` with `[invalid_request]` (0 selectors = recent runs, 1 = that run/ref/PR/branch; `workflow` only narrows). Before, it silently picked one by a hidden precedence (`ref > pr > run_id > branch`) and ignored the rest, so `run_id` + `ref` returned the `ref` check-runs without saying `run_id` was dropped. `project_ci_wait` already rejected this. Both tools now share one `selectorCount` (`lib/git-common.ts`), and `TOOL_DOCS` no longer mentions a precedence. **Migration:** a client that sent two selectors to `ci_status` must keep only the one it meant.
- Tool schema Phase 7 (the four items Phase 6 left open; `ROADMAP_TOOL_SCHEMA.md`), `tools/list` 71001 -> 70727 B (expert, -274 B) and 51180 -> 50906 B (default, -274 B):
  - `project_read_batch` and `project_edit_batch` no longer advertise `max_response_bytes_per_item`, but still accept it (default unchanged: 1 MiB for edit, the host budget for read). Both are registered as loose objects so the SDK keeps the key. Because zod no longer range-checks it, the handler does (`checkItemBytes`: 1024..2 MiB for read, 256..1 MiB for edit) and answers a bad value with `invalid_request` and a hint.
  - `project_read_file.start_line` and `ranges[].start_line` advertise `minimum: 1` (before, the schema showed a minimum of -9007199254740991). It is the JSON Schema only: the parser stays permissive, so `start_line=0` still reaches the handler, which refuses it with `[invalid_request]` and a hint, instead of a generic validation error.
  - `config()` is now `config(title, meta, annotations)` and `meta` is only `speed_profile` + `batch_safe`. The description text and the use/avoid/output strings it used to take were dead (`applyToolDocs` overwrote them from `TOOL_DOCS`, and they had drifted); 43 registrations lost them (129 strings). No effect on `tools/list`. README and CONTRIBUTING describe the new rule.
  - Left as is, on purpose: the `provider`/`repo` parameters of the 11 PR/CI tools. They are already shared constants with one-line descriptions; shortening them would drop the default-resolution rule the model needs.
  - Tests: `test:tool-schema` +4 checks (20), `test:p2-clarity` +1 check (30). `scripts/schema-budget.json` ceilings ratcheted down (expert 70727 B, default 50906 B).
- Tool schema Phase 6 (model-facing wording only, no behavior change; `ROADMAP_TOOL_SCHEMA.md`), `tools/list` 72869 -> 71001 B (expert, -1868 B) and 52826 -> 51180 B (default, -1646 B):
  - The shared `reason` description lost "Required only on project_ci_control.": it was repeated on 13 tools, and `project_ci_control` has its own `reason` text.
  - The checkpoint reminder is no longer repeated in the parameter text of `project_write_file.mode`, `project_edit_file.edits`, `project_edit_batch.edits`, `project_delete_path.relative_path` and `project_execute_js.code`. `project_snapshot` and `project_delete_path.recursive` still carry it (`delete_path_teaches_snapshot_first` pins the latter).
  - `project_execute_js` names only the active `VENIRA_JS_EXEC_MODE` (`aboutFor`), like the fuzzy note on `project_edit_file`; before, it described all three modes.
  - Duplicated or redundant wording trimmed in `project_read_file`, `project_edit_file`, `project_shell_run` (the list of "fast" commands), `project_read_audit` (timestamps stated twice), `project_detect_harnesses` (the client list duplicated the `project_install_self` enum), `project_create` and `project_symbol_references`.
  - `project_health` grew by 89 B on purpose (1156 -> 1245 B): `sections` now lists every report key and tells `caches`/`shells` (live state) from `cache`/`shell` (configuration).
- `scripts/schema-budget.json` ceilings re-based to the measured values (expert 71001 B, default 51180 B). They had drifted above the numbers recorded at Phase 5 (67975 / 50690 B).

### Fixed
- Model-facing text that did not match the code:
  - `project_search` with `queries`: scoring is per line, not per file; `must` is required per line, not per file; `weight` is added to the score (it is not a multiplier); there is no NOT (a negative weight only lowers the score and the line is still a hit).
  - `project_health.sections` was missing `notice`, `approvals`, `warnings` and `posture`, and its `out` line listed only some of the keys.

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
