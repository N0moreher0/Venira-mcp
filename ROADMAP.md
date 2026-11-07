# Venira MCP Roadmap

> Single source of truth for unfinished work. Completed features belong in the release changelog and are intentionally omitted here.
> Audited against code/docs on 2026-11-07. Current package: **1.17.2**. This roadmap is owner-maintained.

## Current state

- Released capabilities and past decisions: [README.md](README.md) changelog.
- Security claims and limits: [SECURITY.md](SECURITY.md).
- Default tool count: 32; Expert: 43 (44 with JS execution enabled).
- Phase E CI reliability and shared per-project snapshot storage are implemented.
- The security-limit notice is present in README, `doctor` and `project_health`.
- `VENIRA_NETWORK` application switch has been removed; isolation belongs to OS/container/VM policy.
- Related roadmap/TODO files are superseded by this file; do not add parallel backlogs.

## Active work

### P0 — Security evidence and correctness

1. **Shell policy adversarial coverage** (in progress)
   - Added `test:shell-policy-adversarial`: 83 table-driven cases with stable ids covering root/home delete spellings (`//`, `/./`, `~/`, `"$HOME"`, `${HOME}`, `-fr`, `-r -f`, `--recursive --force`), quoting/escapes, command paths and wrappers for privilege escalation, protected-file globs/character classes, and write-then-run sequences. Every hard-deny case asserts `deny` in balanced and `ask` in permissive; non-regressions cover workspace `rm`, broad globs and safe commands.
   - Hardened `root_delete` and `privilege_escalation` to evaluate parsed segments (not just raw regex), added PowerShell `Start-Process -Verb RunAs`, made protected-file glob matching specificity-aware (`*.env` and `.e[n]v` deny; `cat *`/`cat *.json` do not), gated `tsx`/`ts-node` like `node`, and added a filesystem-root hard deny (`rm -rf /`, `rm -rf C:\`, `Remove-Item -Recurse -Force $HOME`, …) so a broad destructive delete cannot run in `permissive` via the Windows `Remove-Item` family.
   - Remaining: research whether targets written earlier in the same session should need approval; measure false asks before changing policy. Add a stable case id for every newly reported spelling. Resolved this session: interpreter/script execution (`bash ./probe.sh`, `pwsh -File …`, `node ./probe.js`, `cmd /c *.bat`, `tsx ./probe.ts`) now has stable cases `policy_adv_just_written_executable_*` and is classified as dynamic execution / unclassified → `ask` in balanced; write-then-run was already covered by `policy_adv_write_then_run_requires_approval`. No policy change was needed, so just-written targets still require approval; permissive remains operator opt-in. Only "measure false asks" remains open.
2. **Shell policy parsers** (in progress)
   - Separate POSIX, PowerShell, and cmd parsing while preserving Windows backslashes and current safe behavior.
   - Landed so far: `lib/shell-dialect.ts` (`posix` / `powershell` / `cmd` resolver), `ParsedCommand.dialect`, `parseShellCommand(raw, { shell })`, `evaluateShellCommand(..., { shell })` and `shellOverrideMatches(..., shell)`; the tool layer now threads the selected shell into the policy gate and override checks.
   - Adversarial coverage added for per-dialect classification (`policy_adv_dialect_*`); full suites stay green. Full cross-dialect parser rewrite (PowerShell verb-noun parameter model, cmd batch flags) remains open.
   - This session landed the cmd.exe delegation layer: `cmd /c <command>` (and `/k`) is unwrapped at parse time to the inner command (`del /f /s /q …`, `git push`, `npm publish`, `powershell -enc …`) while script targets (`*.bat`, `*.ps1`, …) keep the dynamic-execution gate; destructive-delete flag matching no longer uses a leading word boundary that never matched `-Recurse`, `-Force`, `/f`, `/s`, `/q`. New adversarial cases cover the unwrap (`policy_adv_dialect_cmd`). This session also hardened interpreter script execution: interpreter + script file (`bash ./probe.sh`, `python3 ./probe.py`) now classifies as dynamic execution via `policy_adv_just_written_executable_*`. The exhaustive cross-dialect grammar (PowerShell verb-noun parameter model, cmd batch flags) remains open.

### P1 — Installation, context and policy controls

3. **Audit-store installation fallback** (in progress)
   - Make native SQLite optional with a documented fallback, add a clean-install smoke job, and include Node 24 in CI after validating compatibility.
   - Started: native `better-sqlite3` now loads lazily via `createRequire` in `lib/corehost.ts` with a type-only import, so a missing native binding degrades to the existing no-op/fail-closed path instead of crashing module load. Tests still green. Remaining: clean-install smoke job + Node 24 CI validation + documented fallback behaviour.
6. **Maintainability refactor** (in progress)
   - Split the oversized `tools/project.ts` and `lib/corehost.ts` along stable responsibilities, preserving public contracts and tests.
   - Done: `scripts/verify.ts` is now a 89-line orchestrator over `scripts/verify/harness.ts` plus nine section modules (`core`, `shell-policy`, `shell-env-audit`, `search`, `checkpoints-errors`, `secrets`, `github-ci`, `providers-config`, `audit-symbols`); mechanical split, same 509 checks in the same order. Remaining there: `github-ci.ts` is still ~69 KB and can be cut by provider (GitHub / GitLab / Bitbucket / `ci_wait`).
   - Done (behavior-preserving, verify stays green after every step: 509 checks, 510 once item 14 added its regression): `lib/corehost.ts` 2826 → ~719 lines, with search, read-side file ops, write-side file ops + recent-files index, shell run state and shell run/status/cancel moved into `lib/corehost-*.ts` modules. `tools/project.ts` 4611 → ~3230 lines: code-intel handlers (`tools/project-codeintel.ts`), `project_execute_js` (`tools/project-jsexec.ts`), `project_read_audit` + audit-DB health probe (`tools/project-audit.ts`), `project_recent_files` (`tools/project-recent.ts`) `project_health` (`tools/project-health.ts`), the hybrid search behind `project_search` (`tools/project-hybrid.ts`, step 5e), the `project_read_batch` / `project_edit_batch` runners (`tools/project-batch.ts`, step 5f), and `project_shell_run` with its approval elicitation plus `project_shell_cancel_session` (`tools/project-shell.ts`, step 5g); `SESSION_ID` now lives in `lib/session.ts`. Modules that need state owned by `tools/project.ts` receive it through injected deps/providers (`RecentFilesDeps`, `HealthDeps`, `HybridDeps`, `BatchDeps`, `ShellDeps`), never by importing back.
   - Remaining in `tools/project.ts`: the tool registration/schema block (largest), `executeCached`, and the shell run registry (`shellRuns`/`trackShell`, shared with `executeCached` and `project_health`). Next candidate: registration split by tool group (re-run the tool/schema list check after each cut).
   - Done (step 5h): moved the cache layer (`readCache`/`infoCache`/`listCache`/`searchCache`/`referencesCache`/`recentCache`/`negativeReadCache`, `readFileCached`/`fileInfoCached`/`listCached`/`searchCached`, `ttlLookup`/`ttlStore`, `invalidatePath`/`invalidateAllCaches`/`invalidateListCaches`, `cacheReport`, the `cache_clear` branch) from `tools/project.ts` into `tools/project-cache.ts` as `createCacheLayer(CacheDeps)` (`execute`, `prepare`, `toHostPath` injected; cache limits/env knobs moved with it; `clear(type)` backs `project_cache_clear`, `report()` backs `project_health`). `tools/project.ts` is now ~2835 lines. `executeCached`, `recentEdits` and the shell run registry stay in `project.ts`. tsc clean, full verify 510/510.
   - Cleanup done: the duplicated `evaluateToolPolicy(operation, args)` call in `executeCached` (the `_decision` block, identical deny/ask handling to the `decision` block that follows) was removed; `evaluateToolPolicy` is pure apart from its rule-file cache, so behavior is unchanged. The mis-indented `readFileCached` lines were fixed during step 5h.
   - Coverage gap found in step 5g: the MCP elicitation path of `project_shell_run` (`VENIRA_SHELL_ELICIT=1`) has no automated test (`scripts/verify/harness.ts` pins it to `0`). The code was moved verbatim, but a regression test with an elicitation-capable client (accept with/without `remember`, decline, client without the capability) should be added before changing that flow.

### P2 — Deeper assurance and operational improvements

7. **Property-based shell-policy fuzzing**
    - Add deterministic transformations/seeds first; every discovered issue becomes a regression case.
8. **Coverage reporting**
    - Measure relevant security modules repeatedly; report actual numbers before setting thresholds or making coverage claims.
9. **Isolation guides**
    - Document Docker, WSL, and Windows Sandbox setups, including mounts, network controls, and their limits.
10. **Snapshot lifecycle**
    - Resolve remaining open items: protection of the snapshot store from shell side effects, off-machine backup/mirroring, and migration guidance for older checkpoints.
11. **Glama catalog synchronization**
    - Refresh the public mirror and add a release checklist item so it does not drift again.
14. **Hybrid search ranking before `limit`** — **done**: `computeHybridSearch` now tags every raw hit, ranks by source (`symbol_index` > `symbol_reference` > `content`, stable tie-break on walk order), then applies `limit`; regression `search_hybrid_ranks_before_limit` added (limit 1 must return the definition and agree with the limit 8 result). Still open: measure symbol-extraction cost on a very large workspace (32-file cap unchanged).
    - Before the fix, `project_search` with `hybrid: 1` applied `limit` to the raw hits in file-walk order and only then tags them (`symbol_index` > `symbol_reference` > `content`). A definition that sits past the first `limit` raw hits is never surfaced, so the tag priority has no effect on which hits are returned. Observed in step 5d: adding one new file that mentions `CoreHost` pushed the definition out of the first 8 hits and failed `search_hybrid_returns_tagged_hits`, `batch_hybrid_returns_tagged_hits` and `batch_hybrid_shared_cache_tags_consistent`; the refactor avoided the extra mention instead of weakening the tests.
    - Plan: tag all raw hits (bounded by the internal 200-hit cap and the existing 32-file symbol-extraction cap), rank by source/confidence with a stable tie-break on walk order, then apply `limit`. Add regression cases where the definition is not among the first `limit` raw hits, and keep `batch_hybrid_*` cache-tag consistency. Measure the extra symbol-extraction cost on a large workspace before shipping.

## Demand-gated provider work

12. **Azure DevOps CI provider**
    - Do not implement without a concrete user workflow. If demand exists, run a read-only spike first covering status, timeline-to-failure mapping, bounded logs, continuation tokens, partial success, and rate-limit headers. Only proceed if the spike validates API semantics and scope.
13. **GitLab OAuth**
    - Current decision: no OAuth until a real workflow makes PATs unacceptable and a maintainer accepts ownership of the OAuth app. If both gates pass, verify device-flow support against gitlab.com and one self-managed instance; design refresh rotation/concurrency before implementation.
    - Bitbucket OAuth remains deferred unless Atlassian adds device flow or a user accepts BYO-client/callback setup.

## Product capability candidates

These are not commitments; prioritize only with demonstrated demand:

- Atomic multi-file patch application with dry-run and snapshot integration.
- Dry-run support for write/edit/delete, plus safe move/copy operations.
- Shell output streaming/resume and stdin support.
- Optional automatic checkpoints for large edit workflows.
- Tree-sitter-backed symbol parsing and ripgrep-backed search when available.
- Broader compiler/test error explainers.
- MCP resources/prompts for health and audit workflows.
- Restrictive project-local policy that can only add ask/deny rules.
- Local aggregate latency and ask/deny telemetry with no raw arguments.
- Native integration only if a supported host/runtime requires it; the typed corehost adapter already exists.

## Decisions to resolve before implementation

- What schema size budget is useful for Default/Core/Expert?
- Should the default profile change in a future major release? Require measured adoption and context data.
- Which provider/capability has real demand next?

## Release and status rules

- Update this file only for unfinished work; remove an item when code and verification prove it complete.
- Do not call research/spike work implemented.
- Record release facts and completed work in README changelog, not as permanent backlog entries.
- Run build, docs/source-shape checks, relevant verification, and cross-platform CI before claiming completion.
- Keep only this roadmap file as the ongoing roadmap/backlog.
