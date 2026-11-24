# C2 Workspace Epoch

## Purpose

Prevent cache invalidation for verified read-only shell commands while preserving conservative invalidation for commands whose workspace effect cannot be proven. The default remains backwards-compatible: shell completion bumps the workspace epoch unless `VENIRA_SHELL_EPOCH=auto` is enabled.

## Workspace effects

The server-side classifier returns one of `read_only`, `mutating`, or `unknown`. It uses a small allowlist for unambiguous read-only commands. Composition operators, wrappers, code-execution forms, and unrecognized commands resolve to `unknown` (default-deny).

## Epoch modes

- `auto`: skip the epoch bump only for `read_only`; bump for `mutating` and `unknown`.
- `always`: bump after a completed shell, preserving the previous behavior.
- `off`, `0`, or `false`: disable shell-triggered epoch bumps.
- Unset: `always`, for compatibility during rollout.

## Background shell lifecycle

The process registry stores `workspace_effect` with the process record at `shell_run` time. Later `shell_status` and `shell_cancel` calls reuse that metadata even when the terminal response does not repeat it. Terminal state also stores `epoch_bumped`, so repeated polling cannot invalidate the cache more than once. Unknown run ids remain default-deny.

## Verification

The focused suite covers synchronous read-only shells, `always` compatibility, background metadata retention, unknown/mutating background shells, failure/cancel, duplicate terminal polls, and epoch-off behavior. Current results: `npm run test:cache-epoch` (10 checks passed), `npm run test:cache-layer` (7 checks passed), `npm run build` (passed), and `git diff --check` (passed).

`npm run verify` currently has two unrelated environment assertions in `test:js-executor`: unset and empty JS mode resolve to `semi-auto` in this environment while those legacy checks expect `off`.
