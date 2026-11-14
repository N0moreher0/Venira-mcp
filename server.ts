import "./lib/profile-env.js"; // must stay first: fills VENIRA_SECURITY_PROFILE env defaults before constants are computed
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  cancelAllShellRuns,
  closeHost,
  closeScope,
  registerProjectTools,
  SESSION_ID,
  warmUp,
} from "./tools/project.js";
import { VERSION } from "./lib/version.js";
import { UNRESTRICTED, WORKSPACE, migrateLegacyDataDirIfNeeded } from "./lib/workspace.js";
import { validateBooleanEnvironment } from "./lib/env.js";
import { enabledShellOverrides, loadShellPolicy } from "./lib/shell-policy.js";
validateBooleanEnvironment();
loadShellPolicy();
enabledShellOverrides();
migrateLegacyDataDirIfNeeded();

const INSTRUCTIONS = `Venira coding tools operate on the workspace ${WORKSPACE}.
Every call returns a JSON envelope: { ok, status, request_id, kind, data, truncated?, summary?, hint?, next_actions?, cached?, trimmed?, command_status?, elapsed_ms }. On failure: { ok:false, error:{ code, message, retryable }, hint, next_actions? } and the MCP result has isError=true. A read_batch with any failed items returns ok=false/status=partial; inspect each data.responses entry. For shell_run, ok=true means the tool call completed; command_status separately reports running/succeeded/failed/cancelled/unknown. Read "hint" and "next_actions" first; they say how to recover.

Decision tree
1. Two or more reads, or mixed read-only steps -> read_batch (max 8, sequential + cached). Do not fire many single reads.
2. One file -> read_file; large file -> start_line/end_line, or ranges=[{start_line,end_line},...] for several disjoint ranges of the same file (max 16); follow next_start_line.
3. Find code -> search (kind=literal_content or definition; pass queries=[{pattern, must?, weight?}] to rank files by AND/OR/NOT patterns instead of a single substring), then read_file with ranges around the hits (or several files in one read_batch).
4. Directory tree -> list_files (depth 1..3, limit <=200). "What changed lately / what did the user or a command just touch?" -> recent_files (cheap; make it a habit).
5. Code structure -> outline_symbol; usages of one symbol -> symbol_references; whole-file dependencies -> dependency_graph; "what breaks if I edit this?" -> change_impact (files=[...] or symbols=[...], direction=dependents).
6. Write whole file -> write_file; small precise change -> edit_file; a batch spanning several files that must land completely or not at all -> edit_batch (text replacements) or apply_patch (unified diff: create/modify/delete/rename; dry_run=1 to validate first, automatic rollback on failure); empty directory -> create; rename or relocate -> move_path; duplicate -> copy_path; delete -> delete_path (destructive, not undoable). Local git -> git_status/diff/log (blame=1) to inspect, git_commit/git_branch/git_stash to mutate (audit reason; push never happens here - plain push runs; force/delete/URL pushes need approval).
7. Before multi-file, cross-file, refactor/rename or otherwise hard-to-reverse work -> create a scoped snapshot with a descriptive label, retain its returned id, inspect file_count/truncated/skipped, then proceed. For rollback, run restore with dry_run=1 first; it previews path/size only and cannot detect same-size content changes. Treat all captured files in scope as potentially overwritten; inspect any newer user edits, then restore the exact id with verify=1 and delete_extra=0. Never set delete_extra=1 unless deleting post-checkpoint files is explicitly part of the task. Skip snapshots for a tiny, easy-to-recreate single-file edit.
8. Build/test/long command -> shell_run (returns run_id immediately), then poll shell_status with wait_seconds 5..300 until running=false; shell_cancel to stop. Need the final output in this call? Pass background=0: it blocks until the command exits (do not start other work while waiting); keep it under the client request timeout or use the async run plus polling.
9. GitHub connection -> github_connect action=start, show the user the GitHub verification link/code, and poll only after they authorize. Never ask for a token in chat. Other tokens -> secret (action=set|get|list|delete); never paste a key into a command.
10. Pull requests -> pr_create (open), pr_comment (thread reply, or an inline note with path + line), pr_merge (land, optionally delete the branch).
11. CI -> ci_status (runs + jobs; pr/ref for branch-protection check-runs), ci_control (explicit cancel/retry_failed with run_id + reason; provider may return unsupported), ci_trigger (workflow_dispatch), ci_logs (bounded tail), ci_wait (bounded long-poll; failure tail).
12. Something failed and the cause is unclear -> explain_error with error_text or log_tail; then apply the first diagnosis (expert mode only; non-expert agents read the error text + hint, which is enough for most cases).
13. Starting an unfamiliar task -> plan_read_batch(task_description, files_hint?) and run steps[0] (expert mode only; otherwise call search directly).
14. Debug latency/errors or check host/audit DB -> health.
15. Unsure which tool exists -> use the Code Mode tool-discovery helper (findTools; named search in older builds), not a Venira tool.
16. Switching project mid-session -> switch_workspace with the absolute path of the new project folder (any existing directory; VENIRA_WORKSPACE_ROOTS narrows it to an allowlist, VENIRA_DYNAMIC_WORKSPACE=0 opts out). All path guards and caches follow the new root; the client does not need to respawn the server.
17. Context that must outlive this chat -> memory. action=read at the start of a task (after recent_files) to pick up what the previous AI left; action=write before you finish or when context runs long. Write replaces the whole note, so keep it short and current: goal, decisions, files touched, next steps. No secrets.

Rules
- Make recent_files a reflex, not a last resort: call it (limit 10..20) at the start of a task, when resuming or after context loss, before editing a file the user may have changed, and after shell_run / a build / a formatter / git to see what really changed. Its session_edits field lists what you already wrote this session. Then feed the top paths straight into read_batch. Use it instead of listing a whole tree or re-searching. It is off in VENIRA_TOOL_MODE=core.
- Prefer Venira for read-heavy/batch work; single tiny native operations are fine either way.
- Paths are workspace-relative (absolute inside the workspace also works). Never invent @grant paths unless list_files returned them.
- read_batch and list_files/search results are cached briefly; mutations invalidate caches automatically.
- dependency_graph and change_impact are disabled in VENIRA_TOOL_MODE=core. Their node ids are workspace-relative; change_impact reports tests separately as tests_affected, and ambiguous bare symbol names downgrade affected entries to confidence=possible (pass {name, file} to pin one).
- ci_wait is a bounded long-poll, not a push notification (MCP stdio cannot wake the model): terminal=false means "nothing changed before the timeout", so call it again with the same selector; keep timeout_s below the client request timeout (~60s). It is unqueued, so other tools keep working, and network access follows the OS/container policy.
- Pass \`reason\` ("why", e.g. "fix null pointer at line 45") on write/edit/delete/create/snapshot/pr/ci to make the audit trail readable; when omitted the backend records an autogenerated "auto: <op> <target>" reason. Required only when VENIRA_SECURITY_PROFILE=strict. CI control actions require a reason. Read it back with read_audit.
- Snapshot discipline: before write_file mode=overwrite, multi-section/multi-file edits, edit_batch on existing files, hard-to-reverse shell/JS workspace changes, and every delete_path call, create a labeled scoped checkpoint, keep its id, and confirm required files were captured (file_count, truncated, skipped) before mutating. Before rollback, use restore dry_run=1; it previews path/size only and cannot detect same-size content changes. Treat all captured files in scope as potentially overwritten and inspect newer user edits; restore only the exact checkpoint id with verify=1 and delete_extra=0. Never enable delete_extra unless that deletion is explicitly requested. Checkpoints are content-addressed/deduplicated and SHA-256 verified by default; new-file creation and disposable generated output do not need a checkpoint.
- Secrets are encrypted at rest and never logged: secret get returns metadata (length + sha256 prefix, expires_at/days_left, last_used_at/use_count), values reach processes only via secret_env, and shell output/audit text is scrubbed of stored values. Expired secrets fail with secret_expired before a child starts.
- Git provider payloads and responses are checked locally with Secretlint's recommended credential rules. A detected secret blocks the outbound request or withholds the provider response; scanner errors fail closed. A response-side block can happen after a mutation completed, so never retry solely because of that block. Never include a real credential in a PR, comment, or CI input.
- Git provider tools (GitHub, GitLab, Bitbucket) resolve the repo from \`repo\` -> VENIRA_GIT_REPO (legacy VENIRA_GITHUB_REPO) -> git.repo in venira.config.json -> .git/config origin; the token comes from a stored secret (GITHUB_TOKEN for GitHub) or an env var (VENIRA_GIT_TOKEN, or GITHUB_TOKEN / VENIRA_GITHUB_TOKEN for GitHub) (expiry is enforced, use tracking is recorded). outbound network access follows the OS/container policy.
- github_connect uses GitHub Device Flow and the \`repo offline_access\` OAuth scopes for private-repository support and refreshable access. The access/refresh tokens are stored encrypted locally and never returned to the agent; users authorize Venira at github.com.
- explain_error and plan_read_batch (expert mode only) are deterministic (no model call): explain_error maps signatures to next_actions, plan_read_batch returns a ready batch call.
- Never loop on a non-retryable error (not_found, scope_denied, invalid_request, sensitive_result, audit_unavailable). Read the hint and change the request or tell the user.
- Repeated failure: when shell_run answers repeated_failure, the identical invocation already failed in this session and was NOT run again. Read data.previous.stderr_tail, fix the cause, then change the command or its inputs - a different command, shell, cwd or input is a different invocation and runs normally. Pass retry_failed=1 only when you deliberately want the identical command to run again.
- Freshness exception: stale_content is the one case where you MUST re-read a file. Read it again with read_file, rebuild the patch against the current content and send the new sha256 as expected_sha256; never replay the same edit unchanged. read_file.sha256 is always the whole-file hash (sha256_scope: file) and is safe to send as expected_sha256; text_sha256 covers only the returned slice.
- Output modes: VENIRA_OUTPUT_MODE=full|compact (default full). compact trims payloads over 8 KiB and marks them; generic data uses data.preview_text. Use full when you need complete data.
- Security profile: VENIRA_SECURITY_PROFILE=strict|balanced|trusted|off (default balanced) sets the shell policy and per-call JS approval together; VENIRA_SHELL_MODE=balanced|strict|permissive|off is an advanced override. Hard-deny rules stay active in strict/balanced; permissive turns hard-deny into an approval request; off disables all shell checks, hard-deny included (operator opt-in, trusted environments only).
- Approvals: when shell_run or execute_js returns approval_required, STOP. Tell the user the approval_id and data.approval.approve_command (a human grants it via \`data.approval.approve_command\` or client elicitation); do not loop, poll or try to approve it yourself. After the user confirms, retry once with data.approval.retry_with. Use shell_run dry_run=1 to learn beforehand whether a command would be allowed, asked or denied (nothing runs). approval_wait_s (<=45) makes the call wait for the human and run in the same call; keep it under the client request timeout. approval_token was removed; use approval_id.
- Named shell overrides require both an operator allowlist (VENIRA_SHELL_OVERRIDES) and a per-call override name plus non-empty reason; they are narrow and audited.`;

const server = new McpServer(
  { name: "venira-coding", version: VERSION },
  { instructions: INSTRUCTIONS },
);
registerProjectTools(server);

let shuttingDown = false;
async function shutdown(code = 0, reason = "unknown"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[venira-coding] shutdown (code ${code}, reason ${reason})`);
  await cancelAllShellRuns();
  await closeScope();
  closeHost();
  process.exit(code);
}

async function main() {
  // Open the capability scope up front, in parallel with the MCP handshake,
  // so the first tool call doesn't pay the ~15 ms scope-open cost.
  void warmUp();
  await server.connect(new StdioServerTransport());
  console.error(
    `[venira-coding] ready v${VERSION} (session ${SESSION_ID}, output ${process.env.VENIRA_OUTPUT_MODE ?? "full"}, ` +
      `workspace ${WORKSPACE}, ${UNRESTRICTED ? "unrestricted" : "locked to workspace"})`,
  );
  // Client closed stdin / killed the process: cancel shells + close the scope.
  process.stdin.on("end", () => void shutdown(0, "stdin_end"));
  process.stdin.on("close", () => void shutdown(0, "stdin_close"));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(0, signal));
  }
  process.on("unhandledRejection", (reason) => {
    console.error("[venira-coding] unhandled rejection:", reason);
    void shutdown(1, "unhandled_rejection");
  });
  process.on("uncaughtException", (error) => {
    console.error("[venira-coding] uncaught exception:", error);
    void shutdown(1, "uncaught_exception");
  });
}

main().catch((err) => {
  console.error("[venira-coding] fatal:", err);
  void shutdown(1, "fatal");
});
