---
title: venira-mcp 6.0.0: one workspace variable, a memory lock
description: Breaking cleanup of the workspace env axis, plus optimistic locking for the shared memory note.
date: 2026-11-23
---

# venira-mcp 6.0.0: one workspace variable, a memory lock

6.0.0 is a major release for one deliberate break, plus the fix for a bug we hit in real use the same day.

## Breaking: `VENIRA_WORKSPACE_ROOTS` is removed

The workspace axis used two variables - `VENIRA_WORKSPACE` for the root, `VENIRA_WORKSPACE_ROOTS` for the extra roots `switch_workspace` could reach. Two variables for one concept invited drift, so there is now a single `VENIRA_WORKSPACE`: absolute paths separated by `,` or `;`, where the **first** entry is the workspace root and every entry is a root `switch_workspace` may move to under `strict` / `balanced`.

Migration:

```text
VENIRA_WORKSPACE_ROOTS="C:\a;D:\b"   ->   VENIRA_WORKSPACE="C:\a;D:\b"
```

There is no alias. If the old variable is still set, the server ignores it and warns at startup with the exact replacement. One behaviour note: with `VENIRA_WORKSPACE` set, switching is now *enabled* under `strict` / `balanced` and scoped to the listed roots; before, it was locked to the spawn workspace unless the extra variable was set.

## The memory note gets an optimistic lock

`memory` is the shared handoff note agents read at task start and update before finishing. Since it replaces the whole note on write, two agents in one workspace could silently erase each other's edits - which happened here on 2026-11-23, which is why this release exists.

- `memory action=read` now returns a `version`: the first 12 hex characters of the note's hash, or `"new"` while no note exists.
- `memory action=write` accepts `if_version`. On a mismatch nothing is written and the call fails with `conflict`; re-read, merge, write again. A successful write returns the new version, so consecutive writes need no re-read.
- Writing without `if_version` keeps the old overwrite behaviour (with a hint in the response), so older clients keep working.

Also part of this: the note cap goes from 6,000 to 10,000 bytes - several agents share more context per workspace now - and the `memory` envelope is never preview-truncated in compact output mode, so a full note reads back whole.

## Also in 6.0.0

- Fixed unescaped quotes in the `workspace_switch_denied` message: the example text contained double quotes inside a double-quoted string, which broke loading `dist/lib/corehost.js` with a `SyntaxError` on affected machines.
- Verify budget: `TOOL_SCHEMA_MAX_BYTES` 6,200 -> 7,116 bytes - the 5.1.0 `git push` options grew the `git` schema past the old ceiling.
- `test:memory` grew from 24 to 37 checks.

Upgrade with `npx --yes venira-mcp@latest --install auto --workspace .`, replace any `VENIRA_WORKSPACE_ROOTS` in your client configs, and restart.
