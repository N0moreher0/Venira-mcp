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
Every call returns a JSON envelope: { ok, status, request_id, kind, data, truncated?, summary?, hint?, cached?, elapsed_ms }. On failure: { ok:false, error:{ code, message, retryable }, hint } and the MCP result has isError=true. Read "hint" first; it says how to fix the request.

Decision tree
1. Two or more reads, or mixed read-only steps -> project_read_batch (max 8, sequential + cached). Do not fire many single reads.
2. One file -> project_read_file; large file -> start_line/end_line or project_read_ranges; follow next_start_line.
3. Find code -> project_search (kind=literal_content or definition), then project_read_ranges around hits.
4. Directory tree -> project_list_files (depth 1..3, limit <=200). "What changed lately?" -> project_recent_files.
5. Code structure -> project_outline_symbol / project_file_symbols; usages of one symbol -> project_symbol_references; whole-file dependencies -> project_dependency_graph; "what breaks if I edit this?" -> project_change_impact (files=[...] or symbols=[...], direction=dependents).
6. Write whole file -> project_write_file; small precise change -> project_edit_file; delete -> project_delete_path (destructive, not undoable).
7. Before a large/multi-file change chain -> project_snapshot action=create (paths default ["."]); if it goes wrong -> action=restore id=<id> (dry_run first if unsure). No git needed.
8. Build/test/long command -> project_shell_run (returns run_id immediately), then poll project_shell_status with wait_seconds 5..30 until running=false; project_shell_cancel to stop. Need the final output in this call? Pass background=0: it blocks until the command exits (do not start other work while waiting); keep it under the client request timeout or use the async run plus polling.
9. GitHub connection -> project_github_connect action=start, show the user the GitHub verification link/code, and poll only after they authorize. Never ask for a token in chat. Other tokens -> project_secret (action=set|get|list|delete); never paste a key into a command.
10. Pull requests -> project_pr_create (open), project_pr_comment (thread reply, or an inline note with path + line), project_pr_merge (land, optionally delete the branch).
11. CI -> project_ci_status (runs + jobs; pr/ref for branch-protection check-runs), project_ci_control (explicit cancel/retry_failed with run_id + reason; provider may return unsupported), project_ci_trigger (workflow_dispatch), project_ci_logs (bounded tail), project_ci_wait (bounded long-poll; failure tail).
12. Something failed and the cause is unclear -> project_explain_error with error_text or log_tail; then apply the first diagnosis (it returns ready next_actions).
13. Starting an unfamiliar task -> project_plan_read_batch(task_description, files_hint?) and run steps[0] (a ready read_batch) instead of guessing files.
14. Debug latency/errors or check host/audit DB -> project_health.
15. Unsure which tool exists -> use the Code Mode tool-discovery helper (findTools; named search in older builds), not a Venira tool.

Rules
- Prefer Venira for read-heavy/batch work; single tiny native operations are fine either way.
- Paths are workspace-relative (absolute inside the workspace also works). Never invent @grant paths unless list_files returned them.
- project_read_batch and project_list_files/search results are cached briefly; mutations invalidate caches automatically.
- project_dependency_graph and project_change_impact are disabled in VENIRA_PROFILE=core. Their node ids are workspace-relative; change_impact reports tests separately as tests_affected, and ambiguous bare symbol names downgrade affected entries to confidence=possible (pass {name, file} to pin one).
- project_ci_wait is a bounded long-poll, not a push notification (MCP stdio cannot wake the model): terminal=false means "nothing changed before the timeout", so call it again with the same selector; keep timeout_ms below the client request timeout (~60s). It is unqueued, so other tools keep working, and VENIRA_NETWORK=0 refuses it before a socket opens.
- Always pass \`reason\` ("why", e.g. "fix null pointer at line 45") on write/edit/delete/create/snapshot/pr/ci: it is stored in the audit trail (redacted, single line, <=400 chars), so future sessions know the intent. Read it back with project_read_audit.
- Checkpoints are content-addressed and deduplicated: repeating action=create after a small edit costs only the changed bytes; restore is sha256-verified per file and only rewrites captured paths (delete_extra is opt-in and capped at 500).
- Secrets are encrypted at rest and never logged: project_secret get returns metadata (length + sha256 prefix, expires_at/days_left, last_used_at/use_count), values reach processes only via secret_env, and shell output/audit text is scrubbed of stored values. Expired secrets fail with secret_expired before a child starts.
- Git provider payloads and responses are checked locally with Secretlint's recommended credential rules. A detected secret blocks the outbound request or withholds the provider response; scanner errors fail closed. A response-side block can happen after a mutation completed, so never retry solely because of that block. Never include a real credential in a PR, comment, or CI input.
- GitHub tools resolve the repo from \`repo\` -> VENIRA_GITHUB_REPO -> .git/config origin; the token comes from secret GITHUB_TOKEN or VENIRA_GITHUB_TOKEN (expiry is enforced, use tracking is recorded). VENIRA_NETWORK=0 disables all outbound calls.
- project_github_connect uses GitHub Device Flow and the \`repo offline_access\` OAuth scopes for private-repository support and refreshable access. The access/refresh tokens are stored encrypted locally and never returned to the agent; users authorize Venira at github.com.
- project_explain_error and project_plan_read_batch are deterministic (no model call): explain_error maps signatures to next_actions, plan_read_batch returns a ready batch call.
- Never loop on a non-retryable error (not_found, scope_denied, invalid_request, sensitive_result, audit_unavailable). Read the hint and change the request or tell the user.
- Output modes: VENIRA_OUTPUT_MODE=full|compact (default full). compact trims payloads over 8 KB; use full when you need complete data.
- Shell modes: VENIRA_SHELL_MODE=balanced|strict|permissive|off (default balanced). Hard-deny rules stay active in strict/balanced; permissive turns hard-deny into an approval request; off disables all checks (operator opt-in, trusted environments only).
- Approvals: when project_shell_run or project_execute_js returns approval_required, STOP. Tell the user the approval_id and data.approval.approve_command (a human grants it via \`npx venira-mcp --approve <id>\` or client elicitation); do not loop, poll or try to approve it yourself. After the user confirms, retry once with data.approval.retry_with. Use project_shell_run dry_run=1 to learn beforehand whether a command would be allowed, asked or denied (nothing runs). approval_wait_ms (<=45000) makes the call wait for the human and run in the same call; keep it under the client request timeout. approval_token was removed; use approval_id.
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
