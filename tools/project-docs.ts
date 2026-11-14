import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editFuzzyEnabled } from "../lib/env.js";
import { JS_EXEC_MODE, type JsExecMode } from "../lib/workspace.js";
import { renderDescription } from "./project-schema.js";

/**
 * Single source of truth for the model-facing wording of every tool.
 *
 * Style rules (keep them when adding a tool):
 * - `about`: what it does, in one sentence, with the one limit or default that matters.
 * - `use`: the trigger, as a short clause. Name the follow-up when there is one.
 * - `avoid`: the better sibling tool, by name. Not a list of fears.
 * - `out`: the fields the caller reads, plus how failure shows up when it is not obvious.
 * - Say a thing once. Safety protocol for checkpoints lives in `snapshot` only.
 * - No speed or batch commentary: that is machine metadata (`_meta.venira`), not prose.
 *
 * The inline strings passed to `config()` at each registration are the fallback for tools that
 * have no entry here; scripts/verify checks that every registered tool does.
 */
export type ToolDoc = { about: string; use: string; avoid: string; out: string };

export const TOOL_DOCS: Record<string, ToolDoc> = {
  // ---- read ---------------------------------------------------------------
  list_files: {
    about: "List files and directories (depth 1-3, limit up to 200). include_ignored=1 also lists ignored folders.",
    use: "you need the directory tree or want to confirm a path exists.",
    avoid: "you know the file (read_file) or want what changed lately (recent_files).",
    out: "entries[] {relative_path, kind, size_bytes}, truncated.",
  },
  read_file: {
    about: "Read a text file, whole or by line range (start_line/end_line, 1-based; ranges[] for several disjoint ranges of one file).",
    use: "you need one file's content. When truncated, call again with start_line=next_start_line.",
    avoid: "you need 2+ files (read_batch) or only size/mtime (get_file_info).",
    out: "text (as preview in compact mode; preview_truncated marks a cut), first_line, last_line, total_bytes, truncated, next_start_line (when truncated). sha256 hashes the whole file and is safe as expected_sha256; text_sha256 covers only the returned text. Missing path gives not_found.",
  },
  get_file_info: {
    about: "Return kind, size and modification time of a path.",
    use: "you need to know whether a path exists or how big it is.",
    avoid: "you need the content (read_file).",
    out: "kind, size_bytes, modified_unix_seconds. Missing path gives not_found.",
  },
  search: {
    about: "Search by kind: file_name, directory_name, literal_content (regex=1 for regex) or definition (symbol declarations). `queries` instead ranks matching lines by several weighted patterns (must/weight).",
    use: "you must locate code, strings or symbols before reading. Keep relative_path narrow: a scan stops at 50000 files.",
    avoid: "you know the path (read_file), want a file's structure (outline_symbol), a symbol's usages (symbol_references) or an executable on PATH (shell_run: `where <name>`).",
    out: "hits[] {relative_path, line_number, snippet}, complete, total_match_lines, files_matched. With queries: hits also carry score/matched, plus total_files/total_hits. No match is ok with empty hits.",
  },
  recent_files: {
    about: "List recently modified files, newest first, plus session_edits (files you wrote in this session).",
    use: "you start or resume a task, or finished a build, format or git step and want to see what changed. Feed the top paths into read_batch.",
    avoid: "you need the full tree (list_files) or a content search (search).",
    out: "entries[] {relative_path, size_bytes, modified_ago_seconds}, session_edits, truncated.",
  },
  read_batch: {
    about: "Run up to 8 read-only ops in one call. operation is the short name (list_files|read_file|get_file_info|search) mapping to list_files|read_file|get_file_info|search; arguments hold exactly that tool's parameters.",
    use: "you need 2+ reads or mixed read steps. Items run in order and one failing item does not stop the rest.",
    avoid: "a single read (read_file) or any edit (edit_batch).",
    out: "responses[] each {ok, response | error}, total_bytes_returned.",
  },

  // ---- write --------------------------------------------------------------
  write_file: {
    about: "Write a file. mode=create (fails if it exists), overwrite, or append. create_dirs=1 creates parent folders.",
    use: "you create a file, replace one entirely, or append. expected_sha256 refuses the write if the file changed since you read it.",
    avoid: "you change a few lines (edit_file). overwrite is immediate and not undoable: snapshot first when the file is not in git.",
    out: "action (created|overwritten|appended), bytes_written, sha256_after. mode=create on an existing path gives conflict.",
  },
  edit_file: {
    about: "Replace exact text: old_text to new_text, or edits[] for several replacements in one file (edits[] wins).",
    use: "you make a targeted change. old_text must match exactly once unless replace_all=1. Pass expected_sha256 (read_file's sha256 or your last sha256_after) to refuse stale content and get a verified re-read.",
    avoid: "you rewrite the whole file (write_file) or change several files at once (edit_batch).",
    out: "replacements, sha256_before, sha256_after, verified (when expected_sha256 is given). Failures leave the file unchanged: old_text_not_found (data.mismatch locates the first difference, data.context shows the nearby lines) and old_text_ambiguous (lists each match with context).",
  },
  edit_batch: {
    about: "Apply edits across one or more files all-or-nothing. Each item takes edit_file arguments (relative_path, old_text, new_text, ...). The first failure rolls back every touched file from an automatic snapshot and skips the rest.",
    use: "a change spans several files or sections and must land completely or not at all.",
    avoid: "you make one edit (edit_file).",
    out: "success: per-edit {relative_path, replacements, sha256_after}. Failure: ok=false, error batch_failed, data {executed, skipped, rollback_succeeded, snapshot_id}.",
  },
  delete_path: {
    about: "Delete a file or directory (recursive=1 is required for directories). Not undoable.",
    use: "you remove files or folders. Take a snapshot first when they are not in git.",
    avoid: "the target is uncertain (check with get_file_info or list_files).",
    out: "entries_deleted, bytes_deleted. Missing path gives not_found.",
  },
  create: {
    about: "Create a directory; missing parents are created unless create_dirs=0.",
    use: "you need an empty directory. For a file use write_file, which also creates parent folders.",
    avoid: "you edit existing content (edit_file).",
    out: "directory_created {relative_path, created, parents_created}.",
  },
  move_path: {
    about: "Move or rename a file or directory inside the workspace. overwrite=1 replaces an existing file, never a directory; create_dirs (default 1) makes missing parents of `to`.",
    use: "you rename or relocate files or folders. Not undoable: take a snapshot first when they are not in git.",
    avoid: "you duplicate (copy_path) or remove (delete_path).",
    out: "from, to, kind, overwritten, entries, bytes. Missing source gives not_found, an existing target without overwrite gives conflict.",
  },
  copy_path: {
    about: "Copy a file, or a directory with recursive=1, inside the workspace. overwrite=1 replaces an existing file; symbolic links and protected files inside a directory are skipped.",
    use: "you duplicate a file or folder, for example to start from a template.",
    avoid: "you move or rename (move_path).",
    out: "from, to, kind, overwritten, entries, bytes, skipped_symlinks/skipped_protected when any. Missing source gives not_found, an existing target without overwrite gives conflict.",
  },
  apply_patch: {
    about: "Apply a unified diff (git apply compatible) to one or more files, all-or-nothing. Every file is validated in memory before anything is written; a failing hunk rolls every file back from an automatic checkpoint, like edit_batch. dry_run=1 validates and reports without writing.",
    use: "a change arrives as a diff (git diff, a patch file, another tool's output) and must land completely or not at all — files created, modified, deleted or renamed.",
    avoid: "you have no diff (edit_file/edit_batch) or only need a new file (write_file). Not for directories or symbolic links.",
    out: "dry_run: files[] {action, relative_path, hunks, bytes} plus added/modified/deleted/renamed counts; nothing is written. success: same list plus sha256_after per file. Failure: nothing is changed; data carries rollback_succeeded and, for a mismatching hunk, nearest_context lines for the file and hunk that failed.",
  },

  git_status: {
    about: "Parsed local git status: branch, ahead/behind vs upstream, and every changed file with staged/unstaged/untracked state and staged/worktree status letters.",
    use: "you need the current repo state in a parseable form (before committing, stashing or opening a PR).",
    avoid: "you only need the raw command (shell_run) or a remote host’s CI status (ci_status).",
    out: "ok, branch/detached, upstream (gone flag), ahead/behind, files[] {path, old_path?, staged, unstaged, untracked, unmerged, kind, status, index_status/worktree_status}, counts{}, clean.",
  },
  git_diff: {
    about: "Parsed git diff (staged or worktree): files + hunks (old_start/lines, new_start/lines, section). Patch text is opt-in via include_patch=1.",
    use: "you need per-file hunk info for review/preview or a test, not free text.",
    avoid: "you need a raw unified blob (use include_patch=1 or diff_files) or a PR diff (provider tools).",
    out: "files[] {old_path|null, new_path|null, action (added|modified|deleted|renamed), binary, hunks[] {old_start, old_lines, new_start, new_lines, section}}, counts{}, patch_bytes, patch/patch_truncated when include_patch=1.",
  },
  git_log: {
    about: "Local commit log, or per-line blame when blame=1 with path. Filters: ref, author, grep, paths.",
    use: "you need recent commits or who last touched lines (blame).",
    avoid: "you need tags/remote refs only (git branch --all) or a remote CI’s log (ci_logs).",
    out: "mode=log: commits[] {sha, short_sha, author, email, authored_at, committer, subject, body}, count. mode=blame: entries[] {line, commit, author, authored_at, summary}, lines.",
  },
  git_branch: {
    about: "List local (and optionally remote-tracking) branches, or create/switch/delete one.",
    use: "you need the current branch, want to branch off HEAD, switch branches, or prune a merged branch.",
    avoid: "you need the worktree state (git_status) or a remote PR’s head branch (pr_list).",
    out: "list: current, branches[] {name, current, commit, upstream, track, remote}, branch_count. create/switch/delete: branch, commit/created/switched/deleted/force. Missing branch gives not_found; duplicate name gives conflict.",
  },
  git_commit: {
    about: "Commit changes. Without paths: commit whatever is staged (paths given to it are staged first with git add). Amend is opt-in.",
    use: "your edits are ready to be committed locally.",
    avoid: "nothing should be committed (git only stages when paths are given, or you already staged). Merge/rebase and push are not performed.",
    out: "sha, short_sha, subject, files_changed, files, amend. No staged changes gives invalid_request (pass paths or stage first).",
  },
  git_stash: {
    about: "Stash push/list/apply/pop/drop/show. Push stashes staged+unstaged tracked changes (add include_untracked=1 for untracked files).",
    use: "you need to pause work to switch branches or commit selectively.",
    avoid: "you need to stash and keep a copy (stash keeps one; use apply over pop) or drop permanently (prefer apply, then commit).",
    out: "push: pushed, message, selector, output. list: entries[] {selector, sha, subject}, count. apply/pop/drop: applied/dropped. show: files[], count.",
  },

  // ---- shell & JS ---------------------------------------------------------
  shell_run: {
    about: "Run a shell command in the workspace (shell, relative_cwd, timeout_s). Default is background: returns run_id, poll shell_status. background=0 blocks until exit and returns stdout/stderr.",
    use: "you build, test, run git or install packages. background=0 for short commands you need now.",
    avoid: "you read or edit files (file tools) or run a tiny JS calculation (execute_js).",
    out: "run_id, kill_key, running, exit_code, timed_out, stdout/stderr (background=0) or stdout_tail/stderr_tail. ok=true only means the call ran; status (completed|failed|running|cancelled) and command_status describe the command. shell_path/shell_kind name the binary that ran it (on Windows bash may be the WSL launcher). approval_required: ask the user to approve, then retry once with approval_id. repeated_failure: the identical invocation already failed; read data.previous.stderr_tail, then change the command or pass retry_failed=1.",
  },
  shell_status: {
    about: "Return the state and output tail of a shell run. wait_seconds (0-300) waits up to that long for it to finish.",
    use: "after a background shell_run: poll until running=false, then read exit_code.",
    avoid: "you have no run_id yet.",
    out: "running, exit_code, stdout_tail, stderr_tail. Unknown run_id gives not_found (run ids only live for this session).",
  },
  shell_cancel: {
    about: "Kill a running command and its child processes. Needs run_id and kill_key from shell_run.",
    use: "a command hangs or its result is no longer needed.",
    avoid: "the run already finished (shell_status).",
    out: "accepted, cleanup_complete.",
  },
  shell_cancel_session: {
    about: "Kill every shell run started in this session.",
    use: "you tear down a stuck session with several running commands.",
    avoid: "only one run must stop (shell_cancel).",
    out: "cancelled_run_ids[], count.",
  },
  execute_js: {
    about: "Run a short Node.js snippet in the workspace. Top-level await and require work, timeout defaults to 30s (max 10 min).",
    use: "you need a quick computation, data transform or prototype.",
    avoid: "you need a shell pipeline or a long-running process (shell_run), or a file edit (file tools).",
    out: "stdout_tail, stderr_tail, exit_code, timed_out. The envelope ok=true only means it ran: check data.ok and exit_code.",
  },

  // ---- diagnostics --------------------------------------------------------
  health: {
    about: "Server diagnostics: version, workspace, security posture and warnings, caches, queue, running shells, latency, snapshot store, audit status.",
    use: "you debug slowness or errors, or want the security warnings before risky work. include_audit=0 skips the audit query.",
    avoid: "normal file work.",
    out: "One key per report section (see sections); with sections set, also sections_requested and sections_unknown.",
  },
  switch_workspace: {
    about: "Re-root the workspace to another directory at runtime (on by default; any existing directory unless VENIRA_WORKSPACE_ROOTS is set, then only inside it; VENIRA_DYNAMIC_WORKSPACE=0 opts out).",
    use: "the client spawned the server once (e.g. Claude Desktop) and the user changed to a different project folder; switch instead of restarting the client.",
    avoid: "one-shot tasks in the spawn directory, or when VENIRA_DYNAMIC_WORKSPACE=0 (the call is refused).",
    out: "workspace_root (the new root), allowed_roots. All subsequent path guards and caches operate on the new root.",
  },
  cache_clear: {
    about: "Clear in-process caches (all, read, info, list, search, recent, negative, graph, shell).",
    use: "reads look stale because a tool changed files outside Venira.",
    avoid: "normal flow: writes already invalidate caches.",
    out: "cleared entry counts per cache.",
  },
  trace_status: {
    about: "Show recent traced tool calls and the trace configuration (needs VENIRA_TRACE=1).",
    use: "you want to see what ran recently without opening the log file.",
    avoid: "tracing is off (the buffer is empty).",
    out: "enabled, file, buffered, recent[] (newest first, timestamp_ms is epoch milliseconds).",
  },
  read_audit: {
    about: "Read recent audit-log rows, newest first: what each job was asked and returned. Filter by session_id, operation, outcome, request_id, since_unix (seconds); verify=1 checks the hash chain.",
    use: "you review what ran and how it ended, or look one job up by request_id.",
    avoid: "you want live metrics (health).",
    out: "rows[] {session_id, operation, outcome, reason_code, reason, args_hash, command, request_id, started_at_ms, completed_at_ms, elapsed_ms, args_summary, result_summary, result_bytes}, count, truncated, chain_ok (verify=1). Output mode full adds redacted args and result per row; bulk text is kept as its length only. Timestamps are epoch milliseconds (since_unix filters in seconds). args_hash identifies the call, command is the redacted command line.",
  },

  // ---- code intelligence --------------------------------------------------
  outline_symbol: {
    about: "List a source file's top-level symbols (functions, classes, types, interfaces) with line numbers.",
    use: "you want a file's structure before reading or refactoring it.",
    avoid: "you need usages (symbol_references), a text search (search) or the text itself (read_file).",
    out: "total_symbols, symbols[] {name, kind, line, signature}.",
  },
  diff_files: {
    about: "Unified diff between two workspace files.",
    use: "you compare two versions of a file, such as a backup and the current one.",
    avoid: "binary files, or git history (run git with shell_run).",
    out: "lines_added, lines_removed, unified_diff, truncated.",
  },
  symbol_references: {
    about: "Find occurrences of a symbol name. scope=file needs relative_path (one file); scope=workspace (default) searches all files.",
    use: "you check where a symbol is used before renaming or changing it.",
    avoid: "you only need its declaration (outline_symbol) or arbitrary text (search).",
    out: "count (matches found), returned (how many came back), omitted (cut by the cap), scan_limit (workspace only), references[] {relative_path, line_number, context}.",
  },
  dependency_graph: {
    about: "Build the import and reference graph for TypeScript/JavaScript, Python, Rust, Go, Java and Kotlin. format: json, dot or mermaid.",
    use: "you want module structure or what a subtree depends on. Narrow with relative_path, depth, languages.",
    avoid: "you need usages of one symbol (symbol_references) or the impact of an edit (change_impact).",
    out: "nodes[], edges[] {from, to, type, confidence}, external[] (top 50), unresolved[] (top 10), stats {externals, unresolved_imports}, limited, truncated. dot and mermaid return data.graph.",
  },
  change_impact: {
    about: "List the files and symbols affected by changing given files or symbols (direction: dependents, dependencies or both). At least one of files/symbols; a symbol seed takes {name, relative_path} (file is an alias).",
    use: "you are about to rename or change something and need which files to read and which tests to run.",
    avoid: "you want the whole graph (dependency_graph).",
    out: "affected[] {id, distance, path, confidence}, summary {affected_files, affected_symbols, tests_affected}, unresolved[] (the seeds that did not resolve: symbol, reason, next_step), stats.unresolved_imports.",
  },

  // ---- workflow -----------------------------------------------------------
  plan_read_batch: {
    about: "Turn a task description into ranked candidate files and a ready-to-run read_batch call (keyword search plus recent files; deterministic, returns no file contents).",
    use: "you start in an unfamiliar area: run steps[0] instead of guessing files.",
    avoid: "you know the files (read_batch) or only need one string or name (search).",
    out: "keywords[], candidates[] {relative_path, reason, hits}, steps[] {tool, arguments, why}.",
  },
  explain_error: {
    about: "Match an error or log tail against known failure signatures (TypeScript, Python, git, npm, GitHub, Venira codes) and return the likely cause, fixes and ready next_actions. Offline rules, no model call.",
    use: "a command, build or provider call failed and the cause is unclear. Pass error_text or log_tail.",
    avoid: "you already know the cause.",
    out: "matched, summary, diagnoses[] {title, likely_cause, suggested_fix[], next_actions[]}.",
  },
  snapshot: {
    about: "Checkpoint and roll back workspace files. action: create (label, paths) | list | restore (id) | delete (id) | mirror (copy to VENIRA_SNAPSHOT_MIRROR_DIR).",
    use: "before multi-file refactors or overwriting/deleting files git does not hold. Keep paths narrow and check file_count and skipped. Roll back with restore dry_run=1, then restore with verify=1.",
    avoid: "tiny single-file edits or states git already holds.",
    out: "create: id, file_count, total_bytes, truncated, skipped[]. restore: restored[], deleted_count, skipped[].",
  },
  detect_harnesses: {
    about: "Find MCP client configs on this machine, for the harnesses install_self supports.",
    use: "before install_self, to see which configs exist.",
    avoid: "you already know the config path.",
    out: "harnesses[] {harness, detected, config_path, format, note}.",
  },
  install_self: {
    about: "Add the Venira MCP server entry to a client's config. Atomic write with a backup at <file>.venira-bak. dry_run=1 previews.",
    use: "the user asks to install Venira into a client.",
    avoid: "the config path is unknown (detect_harnesses first).",
    out: "harness, config_path, status (installed|already_present|config_missing|error|would_merge|would_create), needs_restart, dry_run, note.",
  },

  // ---- git provider: PRs --------------------------------------------------
  pr_create: {
    about: "Open a pull/merge request (GitHub, GitLab, Bitbucket). head defaults to the current branch, base to the repo default.",
    use: "the change is pushed and the user asked for a PR.",
    avoid: "the branch is not pushed, or a PR already exists (pr_comment).",
    out: "number, url, state, draft, head, base.",
  },
  pr_comment: {
    about: "Comment on a PR: a thread comment, or an inline note on a file line (path + line, optional start_line and side).",
    use: "you report status, answer a review, or leave a line note.",
    avoid: "the PR does not exist yet, or you want to change code (edit tools).",
    out: "comment_id, url, inline.",
  },
  pr_merge: {
    about: "Merge a PR (method: merge, squash or rebase) and optionally delete the head branch. Refuses closed or conflicting PRs.",
    use: "CI is green and the user asked to land the PR.",
    avoid: "checks are still running (ci_status first).",
    out: "merged, method, sha, branch_deleted.",
  },
  pr_list: {
    about: "List PRs by state (default open), head or base branch.",
    use: "you need a PR number or an overview.",
    avoid: "you already have the number.",
    out: "prs[] {number, title, state, draft, head, base, author, url}, total.",
  },
  pr_close: {
    about: "Close a PR without merging. Idempotent.",
    use: "the PR is superseded or abandoned.",
    avoid: "the change should land (pr_merge).",
    out: "state, closed, url.",
  },
  pr_reopen: {
    about: "Reopen a closed PR (GitHub, GitLab; Bitbucket returns unsupported).",
    use: "the PR was closed by mistake.",
    avoid: "the branch was deleted or force-pushed away (pr_create).",
    out: "state, reopened, url.",
  },

  // ---- git provider: CI ---------------------------------------------------
  ci_status: {
    about: "Read CI state: recent runs (filter by branch or workflow), one run with its jobs (run_id), or check-runs for a PR or ref (pr, ref). Pass at most one of run_id/ref/pr/branch (workflow narrows); none = recent runs. GitHub Actions, GitLab pipelines, Bitbucket Pipelines.",
    use: "after a push or trigger, to see whether checks passed.",
    avoid: "you need the failure detail (ci_logs) or want to wait (ci_wait).",
    out: "overall (success|failure|in_progress|no_runs|no_checks), runs[] {id, name, status, conclusion, branch, sha, url}.",
  },
  ci_wait: {
    about: "Wait for a run, ref, PR or branch to reach a final state, and include the failure log tail. Pass exactly one of run_id/ref/pr/branch. One call lasts at most timeout_ms (default 45s, max 110s); terminal=false means still running, so call again with the same selector.",
    use: "after ci_trigger or a push: the result and the failure tail in one call.",
    avoid: "you want an instant snapshot (ci_status) or a full job log (ci_logs).",
    out: "overall, terminal, changed, waited_ms, run, failure_tail.",
  },
  ci_logs: {
    about: "Read the tail of CI logs for a whole run or a single job. At least one of run_id/job_id; job_id wins (tail_lines default 500, max_bytes default 512 KB).",
    use: "a run failed and you need the error. Pass job_id to isolate the failing job.",
    avoid: "you only need pass or fail (ci_status).",
    out: "text (tail), lines, truncated, entries[].",
  },
  ci_trigger: {
    about: "Start a pipeline: GitHub workflow_dispatch (workflow required), a GitLab pipeline, or a Bitbucket custom pipeline. ref defaults to the current branch.",
    use: "you re-run a pipeline without a new commit, or dispatch a workflow with inputs.",
    avoid: "the workflow has no workflow_dispatch trigger, or a push would do.",
    out: "triggered, workflow, ref, dispatched_at. The run appears in ci_status within about 10s.",
  },
  ci_control: {
    about: "Cancel one run, or retry its failed jobs (action: cancel | retry_failed). Needs run_id and a reason. Bitbucket cannot retry.",
    use: "the user asked to stop or retry a specific run. Check it with ci_status first.",
    avoid: "you need a new run on another ref (ci_trigger).",
    out: "action, run_id, request_submitted. The effect is asynchronous: confirm with ci_status.",
  },

  // ---- credentials --------------------------------------------------------
  github_connect: {
    about: "Connect GitHub with Device Flow. action=start returns verification_uri and user_code: show them to the user, then action=poll with pending_id after they authorize. Tokens go to the encrypted vault and are never returned.",
    use: "the user wants to connect or replace the GitHub credential without pasting a token.",
    avoid: "you only need public read access, or a token is already configured.",
    out: "start: verification_uri, user_code, pending_id, expiry. poll: pending | denied | expired | connected.",
  },
  secret: {
    about: "Store and inspect tokens without exposing them (AES-256-GCM at rest). action: set | get (metadata only) | list | delete. Inject into commands with shell_run secret_env=[NAME]; the GitHub tools read GITHUB_TOKEN on their own.",
    use: "you save a non-GitHub token, check expiry or rotation, or remove one. Prefer value_env over value so the secret never appears in chat.",
    avoid: "the value is plain config (use .env or the config file). reveal=1 prints plaintext and needs VENIRA_SHELL_MODE=permissive or off.",
    out: "set: name, length, expires_at, days_left. get and list: metadata only.",
  },
};

type RegisterConfig = { description?: string; _meta?: { venira?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>;

/**
 * Appended to the `edit_file` description only when VENIRA_EDIT_FUZZY=1, the same condition that
 * puts the fuzzy options into its schema (ROADMAP_TOOL_SCHEMA.md, phase 3). With fuzzy off the model is not
 * told about a feature it cannot use.
 */
const EDIT_FUZZY_ABOUT = " With no exact match it falls back to fuzzy matching (fuzzy_distance, ignore_indentation, case_insensitive).";

/**
 * Appended to the `execute_js` description: only the mode that is on (VENIRA_JS_EXEC_MODE), like the fuzzy
 * note above. The tool is not registered at all when the mode is `off`.
 */
const JS_EXEC_ABOUT: Record<Exclude<JsExecMode, "off">, string> = {
  ask: " Per-call approval: first call returns approval_required; ask the user, retry with approval_id. Skipped when VENIRA_PERMISSION_MODE=allow_all. Contained: workspace-only fs, scrubbed env, no child processes; network open.",
  "semi-auto": " No approval; contained: workspace-only fs, scrubbed env, no child processes; network open.",
  auto: " No approval step and no containment (full network, filesystem and env).",
};

/** The `about` line served for a tool: its TOOL_DOCS entry plus any note that depends on the environment. */
export function aboutFor(name: string, doc: ToolDoc): string {
  if (name === "edit_file" && editFuzzyEnabled()) return doc.about + EDIT_FUZZY_ABOUT;
  if (name === "execute_js" && JS_EXEC_MODE !== "off") return doc.about + JS_EXEC_ABOUT[JS_EXEC_MODE];
  return doc.about;
}

/**
 * Replace each registered tool's description with its TOOL_DOCS entry. Patches `registerTool` in
 * place (same approach as applyDisabledTools), so call it before the register* functions run.
 */
export function applyToolDocs(server: McpServer): void {
  const original = server.registerTool.bind(server) as (name: string, cfg: RegisterConfig, ...rest: unknown[]) => unknown;
  server.registerTool = ((name: string, cfg: RegisterConfig, ...rest: unknown[]) => {
    const doc = TOOL_DOCS[name];
    if (!doc) return original(name, cfg, ...rest);
    const merged: RegisterConfig = {
      ...cfg,
      description: renderDescription(aboutFor(name, doc), { use_when: doc.use, avoid_when: doc.avoid, output_kind: doc.out }),
      _meta: {
        ...(cfg._meta ?? {}),
        venira: { ...(cfg._meta?.venira ?? {}), use_when: doc.use, avoid_when: doc.avoid, output_kind: doc.out },
      },
    };
    return original(name, merged, ...rest);
  }) as unknown as typeof server.registerTool;
}
