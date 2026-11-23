---
title: Audit and snapshots
description: Every call is audited, every refactor is a checkpoint away from undone - no git required.
order: 4
---

# Audit and snapshots

Two mechanisms give you the paper trail: the audit trail answers *what happened*, snapshots answer *make it not have happened*.

## The audit trail

Every tool call is written to a SQLite (WAL mode) audit trail inside the workspace. Mutating tools accept an optional `reason`, which is stored with the call - so the trail reads like a changelog, not just a log of tool names.

`read_audit` returns the entries for a time window. Between the reason field, the policy decision on shell calls and the file hashes recorded by write calls, you can reconstruct what the agent changed and why without reading its transcript.

## Checkpoints without git

`snapshot action=create` makes a content-addressed checkpoint of the paths you name. Restoring is atomic, file by file, and does not care whether the folder is a git repo - useful for scratch folders, generated code and machines where git is not configured.

The workflow that has proven itself:

1. `snapshot action=create paths=["lib/", "tests/"] label="before refactor"`
2. Do the work.
3. If it went sideways: `snapshot action=restore` with `dry_run=true` first to preview exactly which files change and how, then restore for real (`verify=true`).

Snapshots are cheap; make one before any multi-file change, dependency bump or experiment. Git stays the floor - snapshots are the ceiling.

## Refusing stale edits

Concurrent writers (you and the agent, or two agents) are protected by `expected_sha256` on `write_file` and `edit_file`: pass the hash you read, and the call fails with `stale_content` if the file changed since. No silent overwrites.

## The shared memory note

`<workspace>/.venira/memory.md` is a small (10,000 byte cap) handoff note the agent reads at the start of a task and updates before finishing. Several agents can share one workspace, so 6.0.0 added an optimistic lock:

- `memory action=read` returns a `version` - the first 12 hex characters of the note's hash, or `"new"` while no note exists.
- `memory action=write` accepts `if_version`. On mismatch nothing is written and the call fails with `conflict`; re-read, merge your edits and write again.
- Writing without `if_version` keeps the old overwrite behaviour (with a hint), so older clients keep working.
