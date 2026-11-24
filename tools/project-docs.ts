import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editFuzzyEnabled } from "../lib/env.js";
import { JS_EXEC_MODE, type JsExecMode } from "../lib/workspace.js";
import { renderDescription } from "./project-schema.js";
import { getToolMode } from "./project-tool-mode.js";
import { sdkContractDts } from "../lib/sdk-registry.js";

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
    about: "List files and directories (depth 1-3, limit up to 200). include_ignored=true also lists ignored folders.",
    use: "you need the directory tree or want to confirm a path exists.",
    avoid: "you know the file (read_file) or want what changed lately (recent_files).",
    out: "entries[] {relative_path, kind, size_bytes}, truncated.",
  },
  read_file: {
    about: "Read a text file, whole or by line range, or several files in ONE call (`requests[]`, max 8, each with read_file's own arguments). ranges[] for several disjoint ranges of one file.",
    use: "you need one (or several) file(s)' content. When truncated, call again with start_line=next_start_line. Multi-file: pass requests[]; each item runs exactly like its own read_file call and one failing item does not stop the rest.",
    avoid: "you only want size/mtime without content (get_file_info).",
    out: "single-file: text (as preview in compact mode; preview_truncated marks a cut), first_line, last_line, truncated, next_start_line, total_bytes, sha256 (whole-file, safe as expected_sha256). Multi-file (requests[]): data.responses[] each {ok, response|error}, count, total_bytes_returned; one item failing answers status:'partial' with ok:false. Missing path gives not_found.",
  },
  get_file_info: {
    about: "Return kind, size and modification time of a path. `missing_ok=true` answers ok with `data.exists:false` for a missing path instead of `not_found`.",
    use: "you need to know whether a path exists or how big it is. Use missing_ok=true to probe existence without failing the call.",
    avoid: "you need the content (read_file).",
    out: "kind, size_bytes, modified_unix_seconds, exists when missing_ok=true. Missing path gives not_found (or ok with exists:false and missing_ok=true).",
  },
  search: {
    about: "Search code or paths. Regex is on by default; set regex=false for exact text. searches[] batches independent content/path-glob searches; queries[] is advanced weighted ranking.",
    use: "locate code or text before reading; narrow relative_path for speed.",
    avoid: "use read_file for known paths, outline_symbol for structure, or symbol_references for usages.",
    out: "hits[] with paths, line numbers and snippets; complete, total_match_lines, files_matched. files_only returns paths. queries[] adds score/matched.",
  },
  recent_files: {
    about: "List recently modified files, newest first, plus session_edits (files you wrote in this session).",
    use: "you start or resume a task, or finished a build, format or git step and want to see what changed. Feed the top paths into read_file (its requests[] reads several at once).",
    avoid: "you need the full tree (list_files) or a content search (search).",
    out: "entries[] {relative_path, size_bytes, modified_ago_seconds}, session_edits, truncated.",
  },

  // ---- write --------------------------------------------------------------
  write_file: {
    about: "Write a file. mode=create (makes the parent folders too, fails if the path exists), overwrite, or append. create_dirs=true creates parent folders (implied by mode=create).",
    use: "you create a file (with its folder, e.g. `a/b/c.txt`), replace one entirely, or append. expected_sha256 refuses the write if the file changed since you read it.",
    avoid: "you change a few lines (edit_file). overwrite is immediate and not undoable: snapshot first when the file is not in git.",
    out: "action (created|overwritten|appended), bytes_written, sha256_after. mode=create on an existing path gives conflict.",
  },
  edit_file: {
    about: "Replace exact text: old_text to new_text, or edits[] for several replacements. Any edits[] item may carry its own relative_path: the whole call then edits every touched file all-or-nothing (atomic, with automatic rollback) — the former edit_batch mode.",
    use: "you make a targeted change. old_text must match exactly once unless replace_all=true. Pass expected_sha256 (read_file's sha256 or your last sha256_after) to refuse stale content and get a verified re-read.",
    avoid: "you rewrite the whole file (write_file).",
    out: "Single file: replacements, sha256_after, verified (when expected_sha256 is given); failures leave the file unchanged (mismatch is numbers only; context.text shows the nearby lines). Multi-file (edits[] with per-item relative_path): data.responses[] each {ok, response|error}, atomic, rollback_succeeded, total_bytes_returned.",
  },
  delete_path: {
    about: "Delete a file or directory (recursive=true is required for directories). Not undoable.",
    use: "you remove files or folders. Take a snapshot first when they are not in git.",
    avoid: "the target is uncertain (check with get_file_info or list_files).",
    out: "entries_deleted, bytes_deleted. Missing path gives not_found.",
  },
  create: {
    about: "Create a directory; missing parents are created unless create_dirs=false.",
    use: "you need an empty directory. For a file use write_file, which also creates parent folders.",
    avoid: "you edit existing content (edit_file).",
    out: "directory_created {relative_path, created, parents_created}.",
  },
  move_path: {
    about: "Move or rename a file or directory inside the workspace. overwrite=true replaces an existing file, never a directory; create_dirs (default true) makes missing parents of `to`.",
    use: "you rename or relocate files or folders. Not undoable: take a snapshot first when they are not in git.",
    avoid: "you duplicate (copy_path) or remove (delete_path).",
    out: "from, to, kind, overwritten, entries, bytes. Missing source gives not_found, an existing target without overwrite gives conflict.",
  },
  copy_path: {
    about: "Copy a file, or a directory with recursive=true, inside the workspace. overwrite=true replaces an existing file; symbolic links and protected files inside a directory are skipped.",
    use: "you duplicate a file or folder, for example to start from a template.",
    avoid: "you move or rename (move_path).",
    out: "from, to, kind, overwritten, entries, bytes, skipped_symlinks/skipped_protected when any. Missing source gives not_found, an existing target without overwrite gives conflict.",
  },
  apply_patch: {
    about: "Apply a unified diff (git apply compatible) to one or more files, all-or-nothing. Every file is validated in memory before anything is written; a failing hunk rolls every file back from an automatic checkpoint, like edit_batch. dry_run=true validates and reports without writing.",
    use: "a change arrives as a diff (git diff, a patch file, another tool's output) and must land completely or not at all — files created, modified, deleted or renamed.",
    avoid: "you have no diff (edit_file) or only need a new file (write_file). Not for directories or symbolic links.",
    out: "dry_run: files[] {action, relative_path, hunks, bytes} plus added/modified/deleted/renamed counts; nothing is written. success: same list plus sha256_after per file. Failure: nothing is changed; data carries rollback_succeeded and, for a mismatching hunk, nearest_context lines for the file and hunk that failed.",
  },

  git: {
    about: "Local git in one call: `action` = status | diff | log | branch | commit | stash | push. status: parsed worktree state (branch, ahead/behind, per-file staged/unstaged/untracked, counts, clean). diff: staged (`staged=true`) or worktree diff: per-file action (added|modified|deleted|renamed) + hunks; unified text opt-in via `include_patch=true` (byte-capped by max_bytes). log: commit list or `--blame` for one file (`path` + `blame=true`); filters ref/author/grep. branch: `sub` = list|current|create|switch|delete (name/from/include_remote/force). commit: message (required, first line = subject, max 1000 chars); stages paths[] first, else commits already-staged; `allow_empty`/`amend` opt-in. stash: `sub` = push|list|apply|pop|drop|show (selector stash@{N}, message max 1000 chars, include_untracked=1 for -u). push: one local branch (`ref`, default current) to a configured remote NAME (`remote`, not a URL; default its remote/origin); `set_upstream`, `tags`, `dry_run`; no force/delete (shell_run, approval); credentials non-interactive; refused under strict profile. Audited reason needed for mutations.",
    use: "you need the repo state, a diff, history/blame, a branch/stash, a commit or a push. blame for who last touched lines; log with author/grep for filtered history; diff (not shell_run git) for hunk previews.",
    avoid: "you need a force-push, delete-push or a push to a URL (shell_run, approval), or a remote host's CI status (ci_status).",
    out: "status: ok, branch/detached, upstream (gone flag), ahead/behind, files[] {path, old_path?, staged, unstaged, untracked, unmerged, kind, status, index_status/worktree_status}, counts{}, clean. diff: files[] {old_path|null, new_path|null, action, hunks[] {old_start, old_lines, new_start, new_lines, section}}, counts{}, patch_bytes, patch/patch_truncated when include_patch=true. log: commits[] {sha, short_sha, author, email, authored_at, committer, subject, body} (blame mode: entries[] {line, commit, author, authored_at, summary}). branch: list -> current, branches[]; create/switch/delete -> created/switched/deleted/force (missing branch -> not_found; duplicate -> conflict). commit: sha, short_sha, subject, files_changed, files, amend (no staged changes -> invalid_request; pass allow_empty=true). stash: pushed, message, selector, output / entries[] {selector, sha, subject}, count. push: remote, branch, pushed, up_to_date, dry_run, updates[] {flag, ref, status new|pushed|forced|up_to_date|rejected, summary}; rejected -> conflict, no credentials -> invalid_request, slow remote -> timeout (120s).",
  },

  // ---- shell & JS ---------------------------------------------------------
  shell_run: {
    about: "Run a shell command in the workspace (shell, relative_cwd, timeout_s). Default is background: returns run_id, poll shell_status. background=false blocks until exit and returns stdout/stderr.",
    use: "you build, test, run git or install packages. background=false for short commands you need now.",
    avoid: "you read or edit files (file tools) or run a tiny JS calculation (execute_js).",
    out: "run_id, kill_key, running, exit_code, timed_out, stdout/stderr (background=false) or stdout_tail/stderr_tail. ok=true only means the call ran; status (completed|failed|running|cancelled) and command_status describe the command. shell_path/shell_kind name the binary that ran it (on Windows bash may be the WSL launcher). approval_required: ask the user to approve, then retry once with approval_id. repeated_failure: the identical invocation already failed; read data.previous.stderr_tail, then change the command or pass retry_failed=true.",
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
    use: "you debug slowness or errors, or want the security warnings before risky work. include_audit=false skips the audit query.",
    avoid: "normal file work.",
    out: "One key per report section (see sections); with sections set, also sections_requested and sections_unknown.",
  },
  switch_workspace: {
    about: "Re-root the workspace to another directory at runtime. Follows VENIRA_SECURITY_PROFILE: trusted/off (or VENIRA_UNRESTRICTED=1) switch anywhere existing; strict/balanced only inside VENIRA_WORKSPACE (unset = spawn only).",
    use: "the client spawned the server once (e.g. Claude Desktop) and the user changed to a different project folder; switch instead of restarting the client.",
    avoid: "one-shot tasks in the spawn directory, or under strict/balanced without VENIRA_WORKSPACE (the call is refused).",
    out: "workspace_root (the new root), allowed_roots. All subsequent path guards and caches operate on the new root.",
  },
  cache_clear: {
    about: "Clear in-process caches (all, read, info, list, search, recent, negative, graph, shell).",
    use: "reads look stale because a tool changed files outside Venira.",
    avoid: "normal flow: writes already invalidate caches.",
    out: "cleared entry counts per cache.",
  },
  trace_status: {
    about: "Show recent traced tool calls (tracing is always on).",
    use: "you want to see what ran recently without opening the log file.",
    avoid: "tracing is off (the buffer is empty).",
    out: "enabled, file, buffered, recent[] (newest first, timestamp_ms is epoch milliseconds).",
  },
  memory: {
    about: "Read or overwrite this workspace's handoff note at <workspace>/.venira/memory.md (action=read|write; write replaces it all, max 10000 bytes).",
    use: "a task starts or resumes (read, after recent_files); before you finish or run out of context (write: goal, decisions, files touched, next steps).",
    avoid: "lasting docs (write_file) or history (git action=log). Plain text on disk: no secrets.",
    out: "read: exists, content, bytes, version, updated_at_ms. write: replaced, previous_bytes, bytes, version, updated_at_ms (pass if_version from the last read: a changed note gives conflict and nothing is written). Over the cap or empty content: invalid_request, old note kept.",
  },
  read_audit: {
    about: "Read recent audit-log rows, newest first: what each job was asked and returned. Filter by session_id, operation, outcome, request_id, parent_call_id, since_unix; verify=true checks the hash chain.",
    use: "you review what ran and how it ended, look one job up by request_id, or list every op one `execute_js` snippet ran.",
    avoid: "you want live metrics (health).",
    out: "rows[] {session_id, operation, outcome, reason_code, reason, args_hash, command, request_id, started_at_ms, completed_at_ms, elapsed_ms, args_summary, result_summary, result_bytes}, count, truncated, chain_ok (verify=true). Output mode full adds redacted args and result per row; bulk text is kept as its length only. Timestamps are epoch milliseconds (since_unix filters in seconds). args_hash identifies the call, command is the redacted command line.",
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
    avoid: "you need usages of one symbol (symbol_references) or arbitrary text (search).",
    out: "nodes[], edges[] {from, to, type, confidence}, external[] (top 50), unresolved[] (top 10), stats {externals, unresolved_imports}, limited, truncated. dot and mermaid return data.graph.",
  },

  // ---- workflow -----------------------------------------------------------
  plan_read_batch: {
    about: "Turn a task description into ranked candidate files and a ready-to-run read_file requests[] call (keyword search plus recent files; deterministic, returns no file contents).",
    use: "you start in an unfamiliar area: run steps[0] instead of guessing files.",
    avoid: "you know the files (read_file) or only need one string or name (search).",
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
    use: "before multi-file refactors or overwriting/deleting files git does not hold. Keep paths narrow and check file_count and skipped. Roll back with restore dry_run=true, then restore with verify=true.",
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
    about: "Add the Venira MCP server entry to a client's config. Atomic write with a backup at <file>.venira-bak. dry_run=true previews.",
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
    avoid: "the value is plain config (use .env or the config file). reveal=true prints plaintext and needs VENIRA_SHELL_MODE=permissive or off.",
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
 *
 * Mode `minimal` (ROADMAP_MINIMAL_MODE.md Phase 2): `execute_js` is the one door, so its
 * description also carries the JS SDK contract (a rendered `.d.ts` of `venira.*`, generated
 * from lib/sdk-registry.ts - the same registry `venira.help()` serves). The other modes keep
 * the TOOL_DOCS description byte-for-byte, so their schema budget does not move.
 */
export function applyToolDocs(server: McpServer): void {
  const original = server.registerTool.bind(server) as (name: string, cfg: RegisterConfig, ...rest: unknown[]) => unknown;
  server.registerTool = ((name: string, cfg: RegisterConfig, ...rest: unknown[]) => {
    const doc = TOOL_DOCS[name];
    if (name === "execute_js" && getToolMode() === "minimal") {
      // The default Use/Avoid text points at shell_run and file tools. This mode does not register them.
      const about =
        "Run a Node.js snippet in the workspace. Top-level await works. This mode has no separate file or shell tools: call venira.* (read, search, list, edit, write, git, snapshot, shell) and batch them in this one snippet.";
      const use =
        "any file, search, edit, git, snapshot or command. Keep each snippet batched. Print a short summary, not whole files.";
      const avoid =
        "one venira.* call per turn, or assuming another tool exists outside this one. Background commands return run_id and kill_key; poll them next turn with the outer shell_status tool.";
      const out =
        "stdout_tail, stderr_tail, exit_code, timed_out. ok=true only means the snippet process ran: check exit_code. Inside the snippet, venira.* returns full data (text, hits, entries), not a compact preview.";
      const merged: RegisterConfig = {
        ...cfg,
        description: `${renderDescription(about, { use_when: use, avoid_when: avoid, output_kind: out })}\n\n${sdkContractDts()}`,
        _meta: {
          ...(cfg._meta ?? {}),
          venira: { ...(cfg._meta?.venira ?? {}), use_when: use, avoid_when: avoid, output_kind: out },
        },
      };
      return original(name, merged, ...rest);
    }
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
