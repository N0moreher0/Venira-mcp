# Changelog

Local release notes for venira-mcp. Not published (not listed in `package.json` `files`) and not pushed to git.

## 1.20.1 — 2026-11-10

### Fixed
- 1.20.0 shipped with `lib/version.ts` still at `1.19.0`, so the server reported the wrong version at runtime and the `doctor` preflight (and therefore CI and the Release workflow) failed with "server version mismatch: 1.19.0 (expected 1.20.0)". 1.20.1 is the same code as 1.20.0 with the version constant corrected; use 1.20.1 instead of 1.20.0.
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
