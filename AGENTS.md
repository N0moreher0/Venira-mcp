# AGENTS.md — venira-mcp (standalone MCP server)

Repo-specific notes for coding agents. `README.md` (user docs) and `CONTRIBUTING.md` (release
process) are loaded too; this file only holds what is slow to re-derive.

## How to work in this repo

This is the MCP server the other agents talk to; an edit that breaks its contract, breaks every
client. Follow the same loop the skills teach, scoped to the server itself:

1. **Orient** — `recent_files` for what moved; `list_files`/`search` for
   exact layout. In unfamiliar territory call `plan_read_batch` and run its suggestion
   (`read_batch`, max 8 files per call).
2. **Checkpoint** — `snapshot action=create` with a narrow `paths` set and a descriptive
   label before touching behavior, config, or more than one file. Git is the floor, snapshots
   are the ceiling.
3. **Edit** — smallest change that fixes the problem; no drive-by cleanups. Prefer
   `edit_file` (exact `old_text`, `expected_sha256` on re-reads); `apply_patch` /
   `edit_batch` for a multi-file change that cannot land half-written. Routine git
   (`add`, `commit`, `merge`, `rebase`, plain `push`) runs without approval; force / delete /
   URL pushes do not — see `README.md` § Approvals.
4. **Verify** — read the diff (`git_diff`), build if you compiled anything
   (`npm run build`), then the narrowest check first: `npm run test:<suite>`. Full gate =
   `npm run verify` (must be green) plus `npm run doctor` on host-sensitive changes. If a check
   fails, read the log first and only then edit; do not retry the identical command blindly.

## Shape of the repo

- One npm package, no monorepo. `server.ts` = MCP entrypoint (stdio transport + the model-facing
  `INSTRUCTIONS` block). `lib/` = backend implementation. `tools/` = MCP tool layer.
  `scripts/` = test/bench/release scripts. `dist/` = build output (git-ignored).
- Request path: `tools/project.ts` wires everything; tool groups register in
  `tools/project-register-{files,shell,ops,codeintel,workflow,vcs}.ts` → cached executor
  (`tools/project-cache.ts`) → `lib/corehost*.ts`, a **pure-Node** implementation of the
  `project_tool.*` operations (no external binary — the old Rust corehost is gone).
- Envelopes (`ok/kind/data/hint`) are built only via `lib/output.ts` (`buildEnvelope`,
  `errorEnvelope`, `batchEnvelope`); never hand-roll one.
- Tool schemas: shared zod fragments + the `config()` helper live in `tools/project-schema.ts`.
  The model-facing wording for every tool lives in `tools/project-docs.ts` (`TOOL_DOCS`).
- Shell command classification (allow/ask/deny) lives in `lib/shell-policy*.ts` — many small
  modules, one per rule family (`shell-policy-tables.ts` is the rule tables).
- Local git is a first-class capability (`tools/project-git*` + `lib/git-local*.ts`): status,
  diff, log, blame, branch, commit, stash. Read-only git runs free; plain push is allowed;
  everything else with an effect still respects the shell policy.
- Routines are cache-aware: write/move/apply/edit invalidate the whole cache; list/search are
  TTL-cached. `recent_files`, `read_batch` etc. are served warm; distorted
  behaviour usually means the binary changed but the running server did not — re-ask or
  restart the client.

## Commands

```
npm ci                     # better-sqlite3 is native: prebuild, else `npm rebuild better-sqlite3`
npm run build              # tsc -> dist/  (REQUIRED before verify/doctor; see below)
npx tsc --noEmit           # type-check only
npm run check:source-shape # no file in lib/scripts/tools may be a single line >2 KB
npm run check:docs         # README/tool-count/version/env-doc gate (first step of `verify`)
npm run verify             # behavioural suite (many focused scripts + scripts/verify.ts)
npm run smoke              # in-process sanity check
npm run doctor             # preflight: workspace, data dir, ripgrep, tool count, health, shell
npm run bench:mcp          # end-to-end numbers for PRs
```

- **`npm run build` first.** `scripts/verify.ts` and `scripts/doctor.ts` launch `node dist/server.js`,
  so they test the *build*, not your source. `npm run verify` does not build for you.
- Single suites: `npm run test:<name>` — current list in `package.json` under `scripts`.
  `test:shell-*`, `test:balanced-read-only`, `test:restore-checkpoint`, `test:audit-fallback`
  are **not** in the `verify` chain; run them by hand when the area changes.
- CI order (`.github/workflows/ci.yml`): build → `tsc --noEmit` → `check:source-shape` → smoke →
  doctor → verify → `test:policy-corpus` → `bench:mcp`. Matrix: ubuntu/windows/macOS × Node 20/22/24.
- `npm run coverage:shell` needs Node >= 22.8 (the coverage flags do not exist on Node 20);
  it skips the floors on older Node instead of failing.

## Contracts that break CI when broken

- **New or renamed tool** — four places, all enforced:
  1. register it in the right `tools/project-register-*.ts` using `config()` from
     `tools/project-schema.ts`;
  2. add a `TOOL_DOCS` entry in `tools/project-docs.ts` (`test:tool-schema` fails otherwise);
  3. record its `tools/list` size in `scripts/schema-budget.json`
     (`npm run test:schema-budget -- --update --allow-increase`; a tool with no recorded
     ceiling fails the check, and ceilings otherwise only ratchet **down**);
  4. tool counts changed → update the README count strings **and**
     `scripts/check-docs.ts` (`EXPECTED_DEFAULT_TOOLS` / `EXPECTED_EXPERT_TOOLS`) together.
     README says 36 default / 49 expert (+1 with `execute_js`); `schema-budget.json`
     records 37/50 because it registers the JS tool.
- **Version bump** — `package.json`, `package-lock.json` (both `version` and `packages[""].version`),
  `server.json` (both `version` and `packages[]`) and `lib/version.ts` must all agree;
  `check:docs` fails otherwise.
- **New `VENIRA_*` variable** — add it to `ENV_REGISTRY` in `lib/env-registry.ts`
  (`test:env-registry` compares the registry against the runtime source) *and* to the README
  env table (`check:docs` compares the docs against the source).
- Every boolean tool flag is the integer `0|1` (`flag01` in `tools/project-schema.ts`), every
  parameter needs a non-empty description, and `reason` (max 400 chars) is audit-logged on
  mutating calls.
- Shell policy changes need `npm run test:policy-corpus` (corpus: `scripts/policy-corpus.json`
  + `scripts/policy-corpus-extra.ts`) — the corpus pins tier **and** rule id per command.

## Quirks

- ESM + TypeScript strict: relative imports end in `.js` even though the source is `.ts`.
  `tsconfig` has `rootDir: "."`, so `dist/` mirrors the tree (`dist/lib/…`, `dist/scripts/…`).
- Any script under `scripts/` that touches `VENIRA_*` must `import "./clean-env.js"` **first** —
  inherited `VENIRA_*` vars from the launching agent session leak in and cause false failures.
- zod v4 (`z.looseObject`, `.meta()`); `tools/list` serves zod's JSON Schema, which is what
  the schema-budget script measures.
- `lib/output.ts` reads `VENIRA_OUTPUT_MODE` at module load — env changes need a restart.
- Node >= 20 (`engines`); CI covers 20/22/24.
- Git-ignored local-only files — do not treat as canonical and do not commit:
  `.mcp.json`, `mcp.json`, `Bug.txt`, `ROADMAP*.md`, `PUSH-NOTES.md`, `docs/`, `set-secret.js`,
  `wait-ci.js`.
- `G:\Venira\Venira-mcp-skills\` (outside this repo) holds the Claude-skills versions of the
  workflows in this file (`venira-coding-workflow`, `venira-add-tool`, `venira-debug-ci`,
  `venira-git-pr`). If you are asked to follow those skills, prefer the exact text there —
  this file is deliberately a compact index, not a copy.
- Commits follow conventional commits (`feat(scope):`, `fix(scope):`, `chore(release):`).
  A release = bump the version in the four places above, then
  `npm run build && npm run check:docs && npm run check:source-shape && npm run verify`,
  then tag `v<x.y.z>` (tag push triggers `.github/workflows/release.yml`).

## Working on this repo with the Venira MCP tools

The repo's own client config (`.mcp.json`, local only) runs `dist/server.js`, so **rebuild after
source edits** or the MCP tools serve the old build.

- Start with `recent_files` (limit 10–20) instead of guessing files; feed the paths
  into `read_batch` (max 8 items). `plan_read_batch` returns a ready batch call
  for an unfamiliar area.
- 2+ reads → one `read_batch`. One file → `read_file` with `start_line/end_line`
  or `ranges[]` (max 16); follow `next_start_line` when truncated.
- Prefer `edit_file` (exact `old_text`→`new_text`, `expected_sha256` for a verified
  re-read) over `write_file`; `edit_batch` for multi-file, all-or-nothing edits.
- Take a `snapshot` before multi-file/overwrite/delete work. Restore with
  `dry_run=1` first, then `verify=1, delete_extra=0`; never `delete_extra=1`.
- Pass `reason` ("why", <=400 chars) on every write/edit/delete/snapshot/PR/CI call — it lands in
  the audit trail.
- `shell_run` returns `run_id`; poll `shell_status` until `running=false`, or use
  `background: 0` for short commands whose output you need now. `ok=true` only means the call
  completed — read `command_status`/`exit_code`.
- `approval_required`: stop, show the user `approval_id` and `approve_command`, retry once after
  they confirm. Never approve it yourself and never loop.
- Treat `ok:false` + `retryable:false` as final; follow the envelope's `hint`/`next_actions`.

<!-- venira-skills:begin -->
<!-- generated by build-clients.ps1; do not edit by hand. edit skills/<skill>/SKILL.md and rerun. -->

# Venira skills (auto-activated heuristics; call tools by name if unsure)

<!-- venira-skill:venira-add-tool -->
---
name: venira-add-tool
description: End-to-end guide for adding a new tool to a Venira-style MCP server codebase (tool file, registration, input schema, verification script, docs, changelog). Use this skill whenever the user wants to add, extend, rename, or register a tool, a project_* command, or an MCP endpoint in the Venira server, even if they just say "thêm tool" or "new tool" without more detail.
---

# Add a tool to the Venira MCP server

New tools must look and behave like the existing ones, because clients and agents rely on consistent descriptions, schemas, and error shapes. Learn the conventions from the code, then copy them.

## 1. Learn the conventions first

- `recent_files` and `list_files` on the `tools/`, `lib/`, and `scripts/verify/` folders.
- Read one or two tools close to the new one (for example a small read-only tool and a mutating one) with `read_batch`.
- Find where tools are registered: `search` (kind `literal_content`) for an existing tool name, and follow it to the registry.
- Note the helpers the existing tools share: workspace path validation, error codes, audit logging, output-mode trimming.

## 2. Design the tool

- Name: `project_<verb>_<noun>`, consistent with neighbours.
- Description: follow the house style seen in existing tools: one line of what it does, then `Use when:`, `Avoid when:`, and `Output:`.
- Input schema: bounded numbers (min/max), `0/1` flags the way existing tools do them, and an optional `reason` for the audit log if the tool mutates anything.
- Decide read-only vs mutating up front. Mutating tools need path safety and snapshot or rollback advice in their description.

## 3. Implement

Checkpoint first with `snapshot` (include the registry file, README, and CHANGELOG in `paths`). Then create the tool file with `write_file` (`mode=create`) and register it with `edit_file`. Reuse shared helpers instead of re-implementing path checks or error handling.

## 4. Verify

- Add a case to the matching script under `scripts/verify/` (or a dedicated test script) covering success, a not-found or invalid input, and any size limits.
- Run the type-check/build and the verify script with `shell_run`. Feed failures to `explain_error`.
- Run the project's doctor or consistency script if one exists, since it often cross-checks the tool list against docs.

## 5. Document

Update the README tool list and add a CHANGELOG entry. Then review everything with `git_diff` and report: tool name, files touched, snapshot id, and which checks passed.

<!-- /venira-skill:venira-add-tool -->

<!-- venira-skill:venira-coding-workflow -->
---
name: venira-coding-workflow
description: Standard workflow for any code change made through the Venira MCP project tools - orient, checkpoint, edit surgically, verify, roll back, report. Use this skill whenever the user asks to write, modify, refactor, fix, review, move or delete code or files in a workspace, or mentions Venira, snapshot, rollback, diff, "sửa code", "viết code", "thêm tính năng" or "fix bug", even if no tool is named.
---

# Venira coding workflow

Venira tools make edits auditable and reversible. Follow this loop so every change is small, checkpointed and verified, and a mistake costs one restore instead of an hour of cleanup.

Clients may prefix tool names (for example `mcp__venira__read_file`). The tool name (without the server prefix) is the stable name.

## Ground rules

- Stay inside the workspace. Paths are workspace-relative; forward slashes work on Windows too.
- Read before you write. Never edit from memory of a file. Re-read when anything else may have touched it.
- Make the smallest change that solves the task. No drive-by reformatting or unrelated cleanups.
- Never put secrets in files, commands or chat. Store tokens with `secret` (prefer `value_env`) and inject them with `secret_env` on `shell_run`.
- Delete, overwrite, move-over and destructive git operations only when the user asked, and only after a snapshot.
- If intent is ambiguous and the change is hard to undo, ask one short question. Otherwise proceed and state your assumptions in the report.

## 1. Orient

- `recent_files` (depth 2-3, limit 20-30) shows what moved lately and which files are in play.
- In an unfamiliar area, `plan_read_batch` with a one-line task description, then run the `read_batch` it proposes (max 8 files per call).
- For big files use `outline_symbol` first, then `read_file` with `start_line`/`end_line` or `ranges`.
- Never guess paths. Use `search` (`file_name`, `literal_content`, `definition`) or `list_files`.
- Read project instructions if they exist (AGENTS.md, CONTRIBUTING.md, README) before the first edit.

## 2. Checkpoint

Create a snapshot (`snapshot`, `action=create`, narrow `paths`, label like `before <what>`) before edits that span several files, deletes, moves or overwrites of anything git does not hold, and large refactors. Skip it for a tiny single-file edit already covered by git. Check `truncated` and `skipped` in the result, and keep the snapshot id for the report and for any rollback (see §5).

## 3. Edit

| Need | Tool |
|---|---|
| One targeted change | `edit_file` with exact `old_text`, plus `expected_sha256`; use `edits[]` for several replacements in one file |
| Several files that must land together | `edit_batch` (all-or-nothing, automatic rollback) |
| Change that arrives as a diff | `apply_patch`, `dry_run=1` first |
| New file | `write_file` `mode=create`, `create_dirs=1` |
| Replace a whole file | `write_file` `mode=overwrite` with `expected_sha256`, after a snapshot |
| Rename or move | `move_path` (not undoable, snapshot first) |
| Duplicate | `copy_path` |
| Delete | `delete_path` (`recursive=1` for folders), only on request, snapshot first |

Before changing a shared symbol, signature or file name, run `change_impact` (pass `symbols` or `files`) to list dependents and the tests affected. Pass a short `reason` on mutating calls so the audit trail explains why.

## 4. Verify

- Review the change with `git_diff` (`include_patch=1`) or `diff_files`.
- Run the narrowest check first (type-check or one test), then the full suite once before finishing. Use `shell_run` with `background=0` for short commands. For long ones use `background=1`, then `shell_status` with `wait_seconds` until `running=false`.
- Pick the shell explicitly when syntax matters. Windows PowerShell 5.1 has no `&&`: chain with `;`, or use `pwsh` or `bash`.
- On failure, pass the stderr to `explain_error`, confirm the cause in the code, then fix. Do not retry blindly.
- Fix and re-verify until clean. If you cannot run a check, say so instead of implying it passed.

## 5. Roll back

`snapshot` `action=restore` with the id: first `dry_run=1` to preview, then `verify=1`. Use `paths` to restore only some files. Use `delete_extra=1` only when you really want files created after the snapshot removed. Restore beats hand-reverting because it is exact.

## Error recovery

| Signal | Meaning | Do this |
|---|---|---|
| `not_found` | Wrong path | `search` for the name. Do not guess. |
| `old_text_not_found` | File changed, or whitespace or line endings differ | Read `data.mismatch` and `data.context`, re-read that range, retry with exact text |
| `old_text_ambiguous` | Text matches several places | Widen `old_text` with surrounding lines. `replace_all=1` only if every match should change |
| `expected_sha256` refused | File changed since you read it | Re-read, re-apply the change. Never force it |
| `conflict` | Target already exists | Choose another path, or snapshot then `overwrite` if intended |
| `batch_failed` | Everything was rolled back (`rollback_succeeded`) | Fix the item named in `data.executed` and `data.skipped`, rerun the batch |
| `approval_required` | A human must approve | Tell the user, give `data.approval.approve_command` or use `approval_wait_ms`, retry once with `approval_id`. Do not work around it |
| `repeated_failure` | The identical command already failed | Read `data.previous.stderr_tail` and change the command. `retry_failed=1` only for flaky or environmental failures |
| `truncated: true` | Output was cut | Continue with `start_line=next_start_line`, or narrow `relative_path`, `limit` or `depth` |
| Odd or stale results | Cache out of sync after external changes | `cache_clear`, then `health` (sections `warnings`, `posture`) |

A `trimmed` flag or "Output mode compact" hint only means the payload was shortened. It is not an error.

## Final report

Keep it short and factual: files changed, snapshot id (if any), checks run and their result, and anything left undone or assumed.

<!-- /venira-skill:venira-coding-workflow -->

<!-- venira-skill:venira-debug-ci -->
---
name: venira-debug-ci
description: Diagnose and fix failing builds, tests, type errors, and CI runs using Venira tools (explain_error, ci_status, ci_logs, ci_wait, ci_control). Use this skill whenever the user reports a red build, failing test, CI failure, a stack trace or error message, "lỗi build", "CI fail", or asks why a pipeline or command broke, even if they only paste an error.
---

# Debug builds and CI with Venira

Find the root cause from evidence (logs, error text), fix it, and prove the fix. Retrying without reading the log wastes CI minutes and hides real problems.

## 1. Get the evidence

- Local failure: reproduce with `shell_run` (`background=0` for short commands). Capture the stderr tail.
- CI failure: `ci_status` with `pr`, `branch`, or `ref` to find the failing run. Pass `run_id` to see its jobs, then `ci_logs` with the failing `job_id` (start with the default tail, widen `tail_lines` only if needed).

## 2. Classify the failure

Pass the error block to `explain_error`. It matches known signatures (TypeScript, Python, git, npm, GitHub) offline and returns likely cause plus next actions. Treat that as a hypothesis and confirm it against the code:
- Locate the failing file and line with `search` and `read_file` (ranges).
- If the failure points at a changed symbol, check `change_impact`.
- Separate three causes: a code bug, a flaky or environment problem (timeouts, network, cache), and a config or dependency drift. Each has a different fix.

## 3. Fix

Follow the venira-coding-workflow habits: snapshot if the fix is multi-file, edit surgically, then re-run the exact failing command locally. If `shell_run` answers `repeated_failure`, read `data.previous.stderr_tail` and change the approach instead of passing `retry_failed=1`.

## 4. Confirm on CI

- Push (via `shell_run`, e.g. `git push`), then `ci_wait` on the branch or PR. If `terminal=false`, call again with the same selector.
- Use `ci_control` with `retry_failed` only for confirmed flaky jobs, and always give a `reason`.
- Use `ci_trigger` only when a workflow supports manual dispatch or no new commit is available.

## Report

State the root cause in one or two sentences, the fix, and the evidence that it works (local command result and CI overall status). If it was flaky or environmental, say so plainly rather than claiming a code fix.

<!-- /venira-skill:venira-debug-ci -->

<!-- venira-skill:venira-git-pr -->
---
name: venira-git-pr
description: Git and pull-request workflow using Venira tools - inspect status, branch, commit, push, open a PR, watch CI, comment, and merge. Use this skill whenever the user wants to commit, create a branch, stash, open or update a pull request, check PR status, merge, or says "commit", "tạo PR", "push code", "merge", even if they do not mention Venira.
---

# Git and PR workflow with Venira

Make each step explicit and reversible. Merging and pushing change shared state, so do them only when the user asked.

## 1. Inspect

Call `git_status` (branch, ahead/behind, changed files) and `git_diff` to see exactly what would be committed. Use `git_log` for recent commit style so new messages match the repo.

## 2. Branch

- New work goes on a branch: `git_branch` action `create` (optionally `from`), then `switch`.
- Need to pause? `git_stash` push (add `include_untracked=1` when needed), then `apply` over `pop` so a copy is kept until you are sure.

## 3. Commit

- Stage and commit with `git_commit`, passing explicit `paths` so unrelated files stay out.
- Write an imperative subject line, matching the repo's convention from the log. Put the why in the body.
- Amend only when the user asks. Never use it to rewrite commits that were already pushed.

## 4. Push and open the PR

`git_commit` does not push. Push with `shell_run` (`git push -u origin <branch>`). Under the current policy: plain push is allowed without approval everywhere except `strict` (needs approval there); force pushes (`--force`, `+ref`, `--force-with-lease`), delete pushes, `--mirror`, and pushes to URLs need approval in `balanced` and `strict`, and run freely in `permissive` and `off`. If one asks for approval, tell the user instead of trying to dodge it.

Then `pr_create` with a one-line imperative title and a body holding a summary and a test plan. Use `draft=1` if the work is unfinished.

## 5. Watch CI and respond

- `ci_wait` with the `pr` selector. On failure, switch to the venira-debug-ci skill.
- Reply to reviewers with `pr_comment` (use `path` and `line` for inline notes).
- `pr_close` / `pr_reopen` for abandoned or mistakenly closed PRs.

## 6. Merge only on request

Merge with `pr_merge` only when the user asked and `ci_status` is green. Ask or infer the method (`merge`, `squash`, `rebase`) and whether to delete the branch. Report the resulting sha.

<!-- /venira-skill:venira-git-pr -->

<!-- venira-skills:end -->


