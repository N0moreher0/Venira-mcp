---
title: Tool modes
description: Expose 18, 31 or 44 tools - every schema byte is on every prompt, so the tool set is a setting.
order: 2
---

# Tool modes

Every tool schema is sent to the model on every prompt. Forty-four tools with full descriptions can cost more of your context window than the code you are working on, so the tool set is a configuration choice, not a fixed list.

Switch modes with the `VENIRA_TOOL_MODE` environment variable:

| Mode | Tools | Good for | Contents |
|---|---|---|---|
| `core` | 18 | Small models and tight context | Shell, read, search, edit, snapshot, git, memory |
| `default` | 31 | Everyday coding | Core plus code intelligence, no CI/CD |
| `expert` | 44 | Full workflows | Default plus pull requests and CI |

Each mode has one tool fewer when `execute_js` is switched off (17 / 30 / 43) - set `VENIRA_JS_EXEC_MODE=off` if you never want the agent to run JavaScript in-process.

## How the modes relate

`core` is an allowlist: it is the smallest set that still covers a full read - search - edit - verify - undo loop, including `snapshot` for rollback, the `git` tool (status, diff, log, commit, push) and the shared `memory` note.

`default` adds the code-intelligence layer (`outline_symbol`, `symbol_references`, `dependency_graph`) for agents that navigate unfamiliar code.

`expert` adds the workflow layer: pull requests and the CI integrations (GitHub, GitLab, Bitbucket) with bounded waiting.

Setup-only tools (first-run installer helpers) join the set when `VENIRA_SETUP_TOOLS=1`.

## Picking a mode

- Running a small local model, or a client that puts the schemas on a tight system prompt? Use `core`.
- Everyday coding with a mid-size or large model? `default` covers it; you are not missing PR/CI automation unless you actually use it.
- Doing release work, PR sweeps or CI triage through the agent? `expert`.

The mode is read at server start; change the variable and restart your client to apply it.
