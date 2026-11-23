---
title: Security
description: Security profiles, the shell rule engine and approvals - a guard rail, not a sandbox.
order: 3
---

# Security

venira-mcp is designed so you can check what the agent did after the fact, and so dangerous commands are caught before they run. It is a guard rail, not a sandbox: it runs with the privileges of the OS user that started it. For untrusted workspaces, or whenever you need real isolation, run it in a container or VM.

## Security profiles

`VENIRA_SECURITY_PROFILE` picks the posture:

| Profile | File tools | `switch_workspace` | Best for |
|---|---|---|---|
| `balanced` (default) | Locked to the workspace | Only within the roots listed in `VENIRA_WORKSPACE` | Everyday work |
| `strict` | Locked to the workspace | Only within the roots listed in `VENIRA_WORKSPACE` | Review-sensitive repos; routine pushes are refused and need approval |
| `trusted` | Locked to the workspace | Any existing directory | Personal machines, multi-project hops |
| `off` | No path guard | Any existing directory | Disposable VMs and containers |

The workspace lock limits which paths the *file tools* touch. It does not restrict what an approved shell command does - that is what the shell rule engine is for.

## The shell rule engine

Before a `shell_run` command executes it is classified as `allow`, `ask` or `deny`. The decision comes back with the call (`policy: {decision, rule, mode}`), and it is audited like everything else.

- `rm -rf /` is denied outright in the default profile.
- Recursive force deletes and similar destructive commands need your approval.
- Ask-level calls carry `approval_id` and `approval_wait_s`: re-call with the approval id to let them through, or run them with `dry_run` first to see what they would touch.

## Git is scoped too

The `git` tool covers status, diff, log, commit and push. Plain pushes run without approval; force pushes, branch deletion and remote-URL changes do not - and under `strict`, pushes are refused and need an approval. Push credentials come only from your own git config; the tool never prompts and redacts credentials from its output.

## Checking the agent afterwards

- Every tool call lands in a SQLite audit trail; mutations can carry a `reason`.
- `read_audit` answers "what changed and why" for any time window.
- `write_file` and `edit_file` accept `expected_sha256`. If the file changed since you read it, the call fails with `stale_content` instead of overwriting newer work.

See [audit and snapshots](/docs/audit-and-snapshots/) for the undo story.
