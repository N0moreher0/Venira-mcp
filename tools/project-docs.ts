import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderDescription } from "./project-schema.js";

/**
 * Single source of truth for the model-facing wording of every tool.
 *
 * Style rules (keep them when adding a tool):
 * - `about`: what it does, in one sentence, with the one limit or default that matters.
 * - `use`: the trigger, as a short clause. Name the follow-up when there is one.
 * - `avoid`: the better sibling tool, by name. Not a list of fears.
 * - `out`: the fields the caller reads, plus how failure shows up when it is not obvious.
 * - Say a thing once. Safety protocol for checkpoints lives in `project_snapshot` only.
 * - No speed or batch commentary: that is machine metadata (`_meta.venira`), not prose.
 *
 * The inline strings passed to `config()` at each registration are the fallback for tools that
 * have no entry here; scripts/verify checks that every registered tool does.
 */
export type ToolDoc = { about: string; use: string; avoid: string; out: string };

export const TOOL_DOCS: Record<string, ToolDoc> = {
  // ---- read ---------------------------------------------------------------
  project_list_files: {
    about: "List files and directories (depth 1-3, limit up to 200). include_ignored=1 also lists ignored folders.",
    use: "you need the directory tree or want to confirm a path exists.",
    avoid: "you know the file (project_read_file) or want what changed lately (project_recent_files).",
    out: "entries[] {relative_path, kind, size_bytes}, truncated.",
  },
  project_read_file: {
    about: "Read a text file, whole or by line range (start_line/end_line, 1-based; ranges[] for several disjoint ranges of one file).",
    use: "you need one file's content. When truncated, call again with start_line=next_start_line.",
    avoid: "you need 2+ files (project_read_batch) or only size/mtime (project_get_file_info).",
    out: "text, first_line, last_line, total_bytes, truncated, next_start_line (when truncated). Missing path gives not_found.",
  },
  project_get_file_info: {
    about: "Return kind, size and modification time of a path.",
    use: "you need to know whether a path exists or how big it is.",
    avoid: "you need the content (project_read_file).",
    out: "kind, size_bytes, modified_unix_seconds. Missing path gives not_found.",
  },
  project_search: {
    about: "Search by kind: file_name, directory_name, literal_content (regex=1 for regex) or definition (symbol declaration lines).",
    use: "you must locate code, strings or symbols before reading. hybrid=1 tags each hit with source and confidence.",
    avoid: "you know the path (project_read_file) or want files ranked by several keywords (project_selective_search).",
    out: "hits[] {relative_path, line_number, snippet}, complete, total_match_lines, files_matched. No match is ok with empty hits.",
  },
  project_recent_files: {
    about: "List recently modified files, newest first, plus session_edits (files you wrote in this session).",
    use: "you start or resume a task, or finished a build, format or git step and want to see what changed. Feed the top paths into project_read_batch.",
    avoid: "you need the full tree (project_list_files) or a content search (project_search).",
    out: "entries[] {relative_path, size_bytes, modified_ago_seconds}, session_edits, truncated.",
  },
  project_read_batch: {
    about: "Run up to 8 read-only ops in one call. operation is the short name (list_files|read_file|get_file_info|search) mapping to project_list_files|project_read_file|project_get_file_info|project_search; arguments hold exactly that tool's parameters.",
    use: "you need 2+ reads or mixed read steps. Items run in order and one failing item does not stop the rest.",
    avoid: "a single read (project_read_file) or any edit (project_edit_batch).",
    out: "responses[] each {ok, response | error}, total_bytes_returned.",
  },

  // ---- write --------------------------------------------------------------
  project_write_file: {
    about: "Write a file. mode=create (fails if it exists), overwrite, or append. create_dirs=1 creates parent folders.",
    use: "you create a file, replace one entirely, or append. expected_sha256 refuses the write if the file changed since you read it.",
    avoid: "you change a few lines (project_edit_file). overwrite is immediate and not undoable: project_snapshot first when the file is not in git.",
    out: "action (created|overwritten|appended), bytes_written, sha256_after. mode=create on an existing path gives conflict.",
  },
  project_edit_file: {
    about: "Replace exact text: old_text to new_text, or edits[] for several replacements in one file (edits[] wins). Fuzzy matching of old_text needs VENIRA_EDIT_FUZZY=1 on the host.",
    use: "you make a targeted change. old_text must match exactly once; replace_all=1 replaces every match. guard=sha256 requires expected_sha256 and makes it atomic and verified.",
    avoid: "you rewrite the whole file (project_write_file) or change several files at once (project_edit_batch).",
    out: "replacements, sha256_before, sha256_after, verified (guard mode). Failures: old_text_not_found, old_text_ambiguous (returns each match with line context).",
  },
  project_edit_batch: {
    about: "Apply edits across one or more files all-or-nothing. Each item takes edit_file arguments (relative_path, old_text, new_text, ...). The first failure rolls back every touched file from an automatic snapshot and skips the rest.",
    use: "a change spans several files or sections and must land completely or not at all.",
    avoid: "you make one edit (project_edit_file).",
    out: "success: per-edit {relative_path, replacements, sha256_after}. Failure: ok=false, error batch_failed, data {executed, skipped, rollback_succeeded, snapshot_id}.",
  },
  project_delete_path: {
    about: "Delete a file or directory (recursive=1 is required for directories). Not undoable.",
    use: "you remove files or folders. Take a project_snapshot first when they are not in git.",
    avoid: "the target is uncertain (check with project_get_file_info or project_list_files).",
    out: "entries_deleted, bytes_deleted. Missing path gives not_found.",
  },
  project_create: {
    about: "Create a directory, or a file (kind=directory|file; a file takes content, mode and create_dirs like project_write_file).",
    use: "you need a directory. For files use project_write_file (the one path for file content).",
    avoid: "you edit existing content (project_edit_file).",
    out: "directory_created or file_written.",
  },

  // ---- shell & JS ---------------------------------------------------------
  project_shell_run: {
    about: "Run a shell command in the workspace (shell: powershell|cmd|bash, relative_cwd, timeout_ms). Default is background: it returns run_id at once and you poll project_shell_status. background=0 blocks until exit and returns stdout and stderr.",
    use: "you build, test, run git or install packages. Use background=0 for short commands whose output you need now.",
    avoid: "you read or edit files (use the file tools) or run a tiny JS calculation (project_execute_js).",
    out: "run_id, kill_key, running, exit_code, timed_out, stdout/stderr (background=0) or stdout_tail/stderr_tail (still running). ok=true only means the command ran: a failed one adds a hint, so read exit_code (PowerShell reports 1 for any failing native command). approval_required means ask the user to approve, then retry once with approval_id. Pass secrets with secret_env=[NAME], never in the command.",
  },
  project_shell_status: {
    about: "Return the state and output tail of a shell run. wait_seconds (0-30) waits up to that long for it to finish.",
    use: "after a background project_shell_run: poll until running=false, then read exit_code.",
    avoid: "you have no run_id yet.",
    out: "running, exit_code, stdout_tail, stderr_tail. Unknown run_id gives not_found (run ids only live for this session).",
  },
  project_shell_cancel: {
    about: "Kill a running command and its child processes. Needs run_id and kill_key from project_shell_run.",
    use: "a command hangs or its result is no longer needed.",
    avoid: "the run already finished (project_shell_status).",
    out: "accepted, cleanup_complete.",
  },
  project_shell_cancel_session: {
    about: "Kill every shell run started in this session.",
    use: "you tear down a stuck session with several running commands.",
    avoid: "only one run must stop (project_shell_cancel).",
    out: "cancelled_run_ids[], count.",
  },
  project_execute_js: {
    about: "Run a short Node.js snippet in the workspace. Top-level await and require work, timeout defaults to 30s (max 10 min). Behaviour depends on `VENIRA_JS_EXEC_MODE`: `ask` needs per-call approval (first call returns approval_required: ask the user, then retry once with approval_id) and is contained; `semi-auto` needs no approval but is contained (network modules, fetch/WebSocket and reads outside the workspace are blocked, env is scrubbed); `auto` needs no approval and is not contained (full network, filesystem and env).",
    use: "you need a quick computation, data transform or prototype.",
    avoid: "you need a shell pipeline or a long-running process (project_shell_run), or a file edit (file tools).",
    out: "stdout_tail, stderr_tail, exit_code, timed_out. The envelope ok=true only means it ran: check data.ok and exit_code.",
  },

  // ---- diagnostics --------------------------------------------------------
  project_health: {
    about: "Server diagnostics: version, workspace, security posture and warnings, caches, queue, running shells, latency, snapshot store, audit status.",
    use: "you debug slowness or errors, or want the security warnings before risky work. include_audit=0 skips the audit query.",
    avoid: "normal file work.",
    out: "server, corehost, queue, caches, shells, posture {level, findings}, snapshots, metrics.",
  },
  project_cache_clear: {
    about: "Clear in-process caches (all, read, info, list, search, recent, negative, graph, shell).",
    use: "reads look stale because a tool changed files outside Venira.",
    avoid: "normal flow: writes already invalidate caches.",
    out: "cleared entry counts per cache.",
  },
  project_trace_status: {
    about: "Show recent traced tool calls and the trace configuration (needs VENIRA_TRACE=1).",
    use: "you want to see what ran recently without opening the log file.",
    avoid: "tracing is off (the buffer is empty).",
    out: "enabled, file, buffered, recent[] (newest last).",
  },
  project_read_audit: {
    about: "Read recent audit-log rows, newest first. Filter by session_id, operation, outcome, since_unix; verify=1 checks the hash chain.",
    use: "you review what was done and why (the reason field), in this or an earlier session.",
    avoid: "you want live metrics (project_health).",
    out: "rows[], count, truncated, chain_ok (verify=1).",
  },

  // ---- code intelligence --------------------------------------------------
  project_outline_symbol: {
    about: "List a source file's top-level symbols (functions, classes, types, interfaces) with line numbers.",
    use: "you want a file's structure before reading or refactoring it.",
    avoid: "you need usages (project_symbol_references) or the text itself (project_read_file).",
    out: "total_symbols, symbols[] {name, kind, line, signature}.",
  },
  project_diff_files: {
    about: "Unified diff between two workspace files.",
    use: "you compare two versions of a file, such as a backup and the current one.",
    avoid: "binary files, or git history (run git with project_shell_run).",
    out: "lines_added, lines_removed, unified_diff, truncated.",
  },
  project_symbol_references: {
    about: "Find occurrences of a symbol name. scope=file needs relative_path (one file); scope=workspace (default) searches all files. limit caps the workspace scan, max_references caps the returned list.",
    use: "you check where a symbol is used before renaming or changing it.",
    avoid: "you only need its declaration (project_outline_symbol) or arbitrary text (project_search).",
    out: "count, references[] {relative_path, line_number, context}.",
  },
  project_selective_search: {
    about: "Rank files by how well they match several patterns (must, weight, fuzzy score) within files_hint or a shallow listing.",
    use: "you must find the right module among candidates using several keywords.",
    avoid: "you search for one literal (project_search).",
    out: "hits[] {relative_path, line_number, text, score, matched}, total_files, total_hits.",
  },
  project_dependency_graph: {
    about: "Build the import and reference graph for TypeScript/JavaScript, Python, Rust, Go, Java and Kotlin. format: json, dot or mermaid.",
    use: "you want module structure or what a subtree depends on. Narrow with relative_path, depth, languages.",
    avoid: "you need usages of one symbol (project_symbol_references) or the impact of an edit (project_change_impact).",
    out: "nodes[], edges[] {from, to, type, confidence}, external[], unresolved[], stats, truncated. dot and mermaid return data.graph.",
  },
  project_change_impact: {
    about: "List the files and symbols affected by changing given files or symbols (direction: dependents, dependencies or both). At least one of files/symbols; a symbol seed takes {name, relative_path} (file is an alias).",
    use: "you are about to rename or change something and need which files to read and which tests to run.",
    avoid: "you want the whole graph (project_dependency_graph).",
    out: "affected[] {id, distance, path, confidence}, summary {affected_files, affected_symbols, tests_affected}, unresolved[].",
  },

  // ---- workflow -----------------------------------------------------------
  project_plan_read_batch: {
    about: "Turn a task description into ranked candidate files and a ready-to-run project_read_batch call (keyword search plus recent files; deterministic, returns no file contents).",
    use: "you start in an unfamiliar area: run steps[0] instead of guessing files.",
    avoid: "you already know the files (project_read_batch).",
    out: "keywords[], candidates[] {relative_path, reason, hits}, steps[] {tool, arguments, why}.",
  },
  project_explain_error: {
    about: "Match an error or log tail against known failure signatures (TypeScript, Python, git, npm, GitHub, Venira codes) and return the likely cause, fixes and ready next_actions. Offline rules, no model call.",
    use: "a command, build or provider call failed and the cause is unclear. Pass error_text or log_tail.",
    avoid: "you already know the cause.",
    out: "matched, summary, diagnoses[] {title, likely_cause, suggested_fix[], next_actions[]}.",
  },
  project_snapshot: {
    about: "Checkpoint and roll back workspace files. action: create (label, paths) | list | restore (id) | delete (id) | mirror (copy to VENIRA_SNAPSHOT_MIRROR_DIR). Content-addressed, deduplicated, SHA-256 verified.",
    use: "before multi-file refactors, or before overwriting or deleting files that git does not hold. Scope paths to what you will touch, keep the returned id and check file_count and skipped. Roll back with restore dry_run=1 (path and size preview only), then restore the same id with verify=1; keep delete_extra=0 unless files created after the checkpoint must go.",
    avoid: "tiny single-file edits, generated output, or states git already holds.",
    out: "create: id, file_count, total_bytes, truncated, skipped[]. restore: restored[], deleted_count, skipped[]. Unknown id gives invalid_request.",
  },
  project_detect_harnesses: {
    about: "Find MCP client configs on this machine (OpenCode, Claude Desktop, Cursor, Codex, Kimi, DeepSeek, Antigravity).",
    use: "before project_install_self, to see which configs exist.",
    avoid: "you already know the config path.",
    out: "harnesses[] {harness, detected, config_path, format, note}.",
  },
  project_install_self: {
    about: "Add the Venira MCP server entry to a client's config. Atomic write with a backup at <file>.venira-bak. dry_run=1 previews.",
    use: "the user asks to install Venira into a client.",
    avoid: "the config path is unknown (project_detect_harnesses first).",
    out: "harness, config_path, status (installed|already_present|config_missing|error), needs_restart.",
  },

  // ---- git provider: PRs --------------------------------------------------
  project_pr_create: {
    about: "Open a pull/merge request (GitHub, GitLab, Bitbucket). head defaults to the current branch, base to the repo default.",
    use: "the change is pushed and the user asked for a PR.",
    avoid: "the branch is not pushed, or a PR already exists (project_pr_comment).",
    out: "number, url, state, draft, head, base.",
  },
  project_pr_comment: {
    about: "Comment on a PR: a thread comment, or an inline note on a file line (path + line, optional start_line and side).",
    use: "you report status, answer a review, or leave a line note.",
    avoid: "the PR does not exist yet, or you want to change code (edit tools).",
    out: "comment_id, url, inline.",
  },
  project_pr_merge: {
    about: "Merge a PR (method: merge, squash or rebase) and optionally delete the head branch. Refuses closed or conflicting PRs.",
    use: "CI is green and the user asked to land the PR.",
    avoid: "checks are still running (project_ci_status first).",
    out: "merged, method, sha, branch_deleted.",
  },
  project_pr_list: {
    about: "List PRs by state (default open), head or base branch.",
    use: "you need a PR number or an overview.",
    avoid: "you already have the number.",
    out: "prs[] {number, title, state, draft, head, base, author, url}, total.",
  },
  project_pr_close: {
    about: "Close a PR without merging. Idempotent.",
    use: "the PR is superseded or abandoned.",
    avoid: "the change should land (project_pr_merge).",
    out: "state, closed, url.",
  },
  project_pr_reopen: {
    about: "Reopen a closed PR (GitHub, GitLab; Bitbucket returns unsupported).",
    use: "the PR was closed by mistake.",
    avoid: "the branch was deleted or force-pushed away (project_pr_create).",
    out: "state, reopened, url.",
  },

  // ---- git provider: CI ---------------------------------------------------
  project_ci_status: {
    about: "Read CI state: recent runs (filter by branch or workflow), one run with its jobs (run_id), or check-runs for a PR or ref (pr, ref). Selector precedence: ref > pr > run_id > branch/workflow; give none for recent runs. GitHub Actions, GitLab pipelines, Bitbucket Pipelines.",
    use: "after a push or trigger, to see whether checks passed.",
    avoid: "you need the failure detail (project_ci_logs) or want to wait (project_ci_wait).",
    out: "overall (success|failure|in_progress|no_runs|no_checks), runs[] {id, name, status, conclusion, branch, sha, url}.",
  },
  project_ci_wait: {
    about: "Wait for a run, ref, PR or branch to reach a final state, and include the failure log tail. Selector precedence: run_id > ref > pr > branch. One call lasts at most timeout_ms (default 45s, max 110s); terminal=false means still running, so call again with the same selector.",
    use: "after project_ci_trigger or a push: the result and the failure tail in one call.",
    avoid: "you want an instant snapshot (project_ci_status) or a full job log (project_ci_logs).",
    out: "overall, terminal, changed, waited_ms, run, failure_tail.",
  },
  project_ci_logs: {
    about: "Read the tail of CI logs for a whole run or a single job. At least one of run_id/job_id; job_id wins (tail_lines default 500, max_bytes default 512 KB).",
    use: "a run failed and you need the error. Pass job_id to isolate the failing job.",
    avoid: "you only need pass or fail (project_ci_status).",
    out: "text (tail), lines, truncated, entries[].",
  },
  project_ci_trigger: {
    about: "Start a pipeline: GitHub workflow_dispatch (workflow required), a GitLab pipeline, or a Bitbucket custom pipeline. ref defaults to the current branch.",
    use: "you re-run a pipeline without a new commit, or dispatch a workflow with inputs.",
    avoid: "the workflow has no workflow_dispatch trigger, or a push would do.",
    out: "triggered, workflow, ref, dispatched_at. The run appears in project_ci_status within about 10s.",
  },
  project_ci_control: {
    about: "Cancel one run, or retry its failed jobs (action: cancel | retry_failed). Needs run_id and a reason. Bitbucket cannot retry.",
    use: "the user asked to stop or retry a specific run. Check it with project_ci_status first.",
    avoid: "you need a new run on another ref (project_ci_trigger).",
    out: "action, run_id, request_submitted. The effect is asynchronous: confirm with project_ci_status.",
  },

  // ---- credentials --------------------------------------------------------
  project_github_connect: {
    about: "Connect GitHub with Device Flow. action=start returns verification_uri and user_code: show them to the user, then action=poll with pending_id after they authorize. Tokens go to the encrypted vault and are never returned.",
    use: "the user wants to connect or replace the GitHub credential without pasting a token.",
    avoid: "you only need public read access, or a token is already configured.",
    out: "start: verification_uri, user_code, pending_id, expiry. poll: pending | denied | expired | connected.",
  },
  project_secret: {
    about: "Store and inspect tokens without exposing them (AES-256-GCM at rest). action: set | get (metadata only) | list | delete. Inject into commands with project_shell_run secret_env=[NAME]; the GitHub tools read GITHUB_TOKEN on their own.",
    use: "you save a non-GitHub token, check expiry or rotation, or remove one. Prefer value_env over value so the secret never appears in chat.",
    avoid: "the value is plain config (use .env or the config file). reveal=1 prints plaintext and needs VENIRA_SECRET_ALLOW_REVEAL=1.",
    out: "set: name, length, expires_at, days_left. get and list: metadata only.",
  },
};

type RegisterConfig = { description?: string; _meta?: { venira?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>;

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
      description: renderDescription(doc.about, { use_when: doc.use, avoid_when: doc.avoid, output_kind: doc.out }),
      _meta: {
        ...(cfg._meta ?? {}),
        venira: { ...(cfg._meta?.venira ?? {}), use_when: doc.use, avoid_when: doc.avoid, output_kind: doc.out },
      },
    };
    return original(name, merged, ...rest);
  }) as unknown as typeof server.registerTool;
}
