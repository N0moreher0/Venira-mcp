# Changelog

Local release notes for venira-mcp. Not published (not listed in `package.json` `files`) and not pushed to git.

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
