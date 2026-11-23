---
title: venira-mcp 5.1.0: git push lands in the tool set
description: One branch, one configured remote, no force - plus switch_workspace joins the core allowlist.
date: 2026-11-22
---

# venira-mcp 5.1.0: git push lands in the tool set

5.1.0 closes the loop that 5.0.0 opened: until now the agent could commit locally but had to hand the shell a raw `git push`, which is exactly the kind of open-ended command you do not want an agent typing. The `git` tool now has `action=push`, and it is deliberately narrow.

## What `git action=push` does

It pushes **one** local branch (`ref`, default the checked-out branch) to a configured remote **name** (`remote`, default the branch's own remote, else `origin`, else the only remote). Options are `set_upstream` (`-u`), `tags` (`--tags`) and `dry_run`.

What it will not do:

- No URLs and no option-like values in the remote field - names only.
- No force push of any kind, no branch deletion, no `--all` / `--mirror`. Those stay in `shell_run`, where the shell policy asks for approval.
- Refused outright under `VENIRA_SECURITY_PROFILE=strict` - pushes need approval there.
- Credentials come only from your git config; the tool never prompts (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode=yes` unless you set `GIT_SSH_COMMAND`), times out after 120 s and redacts credentials from the output.

The result is parsed from `git push --porcelain`: `{remote, branch, pushed, up_to_date, dry_run, set_upstream, tags, updates[]}`. Rejections surface as a `conflict` error instead of a wall of stderr.

## switch_workspace joins the core allowlist

Clients that spawn the server once - Claude Desktop, Cowork - used to be locked to the folder they started in. `switch_workspace` is now part of the `core` allowlist, so even the smallest tool mode can follow you to another project folder without a restart. Core is now **18** tools (17 with `VENIRA_JS_EXEC_MODE=off`); `default` and `expert` are unchanged at 31 / 44 because the tool was already registered there. The behaviour is still scoped by the security profile.

## The small print

- The `git` schema grew from 6,154 to 7,189 bytes for the push options; the schema budget was raised deliberately for it.
- `test:git-local` gained 10 checks against a local bare remote: dry run, `-u`, up-to-date, URL refusal, non-fast-forward, no force, strict refusal, detached HEAD, porcelain parsing and credential redaction.

Upgrade with `npx --yes venira-mcp@latest --install auto --workspace .` and restart your client.
