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
import { UNRESTRICTED, WORKSPACE } from "./lib/workspace.js";

const INSTRUCTIONS = `Venira coding tools operate on the workspace ${WORKSPACE}.
Every call returns a JSON envelope: { ok, status, request_id, kind, data, truncated?, summary?, hint?, cached?, elapsed_ms }. On failure: { ok:false, error:{ code, message, retryable }, hint } and the MCP result has isError=true. Read "hint" first; it says how to fix the request.

Decision tree
1. Two or more reads, or mixed read-only steps -> project_read_batch (max 8, sequential + cached). Do not fire many single reads.
2. One file -> project_read_file; large file -> start_line/end_line or project_read_ranges; follow next_start_line.
3. Find code -> project_search (kind=literal_content or definition), then project_read_ranges around hits.
4. Directory tree -> project_list_files (depth 1..3, limit <=200). "What changed lately?" -> project_recent_files.
5. Write whole file -> project_write_file; small precise change -> project_edit_file; delete -> project_delete_path (destructive, not undoable).
6. Before a large/multi-file change chain -> project_snapshot action=create (paths default ["."]); if it goes wrong -> action=restore id=<id> (dry_run first if unsure). No git needed.
7. Build/test/long command -> project_shell_run (returns run_id immediately), then poll project_shell_status with wait_seconds 5..30 until running=false; project_shell_cancel to stop.
8. Tokens/credentials -> project_secret (action=set|get|list|delete). Never paste a key into a command: store it once, then inject it with project_shell_run secret_env=["NAME"]. Set expires_in_days when the user knows the rotation window; expired secrets are refused (rotate with action=set).
9. Pull requests -> project_pr_create (open), project_pr_comment (thread reply, or an inline note with path + line), project_pr_merge (land, optionally delete the branch).
10. CI -> project_ci_status (runs + jobs; pr/ref for branch-protection check-runs), project_ci_trigger (workflow_dispatch), project_ci_logs (tail of a run or one job).
11. Something failed and the cause is unclear -> project_explain_error with error_text or log_tail; then apply the first diagnosis (it returns ready next_actions).
12. Starting an unfamiliar task -> project_plan_read_batch(task_description, files_hint?) and run steps[0] (a ready read_batch) instead of guessing files.
13. Debug latency/errors or check host/audit DB -> project_health.
14. Unsure which tool exists -> use the Code Mode tool-discovery helper (findTools; named search in older builds), not a Venira tool.

Rules
- Prefer Venira for read-heavy/batch work; single tiny native operations are fine either way.
- Paths are workspace-relative (absolute inside the workspace also works). Never invent @grant paths unless list_files returned them.
- project_read_batch and project_list_files/search results are cached briefly; mutations invalidate caches automatically.
- Always pass \`reason\` ("why", e.g. "fix null pointer at line 45") on write/edit/delete/create/snapshot/pr/ci: it is stored in the audit trail (redacted, single line, <=400 chars), so future sessions know the intent. Read it back with project_read_audit.
- Checkpoints are content-addressed and deduplicated: repeating action=create after a small edit costs only the changed bytes; restore is sha256-verified per file and only rewrites captured paths (delete_extra is opt-in and capped at 500).
- Secrets are encrypted at rest and never logged: project_secret get returns metadata (length + sha256 prefix, expires_at/days_left, last_used_at/use_count), values reach processes only via secret_env, and shell output/audit text is scrubbed of stored values. Expired secrets fail with secret_expired before a child starts.
- GitHub tools resolve the repo from \`repo\` -> VENIRA_GITHUB_REPO -> .git/config origin; the token comes from secret GITHUB_TOKEN or VENIRA_GITHUB_TOKEN (expiry is enforced, use tracking is recorded). VENIRA_NETWORK=0 disables all outbound calls.
- project_explain_error and project_plan_read_batch are deterministic (no model call): explain_error maps signatures to next_actions, plan_read_batch returns a ready batch call.
- Never loop on a non-retryable error (not_found, scope_denied, invalid_request, sensitive_result, audit_unavailable). Read the hint and change the request or tell the user.
- Output modes: VENIRA_OUTPUT_MODE=full|compact|summary (default full). summary trims payloads; request full data when editing.`;

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
