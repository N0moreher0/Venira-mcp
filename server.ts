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
6. Build/test/long command -> project_shell_run (returns run_id immediately), then poll project_shell_status with wait_seconds 5..30 until running=false; project_shell_cancel to stop.
7. Debug latency/errors or check host/audit DB -> project_health.
8. Unsure which tool exists -> use the Code Mode tool-discovery helper (findTools; named search in older builds), not a Venira tool.

Rules
- Prefer Venira for read-heavy/batch work; single tiny native operations are fine either way.
- Paths are workspace-relative (absolute inside the workspace also works). Never invent @grant paths unless list_files returned them.
- project_read_batch and project_list_files/search results are cached briefly; mutations invalidate caches automatically.
- Never loop on a non-retryable error (not_found, scope_denied, invalid_request, sensitive_result, audit_unavailable). Read the hint and change the request or tell the user.
- Output modes: VENIRA_OUTPUT_MODE=full|compact|summary (default full). summary trims payloads; request full data when editing.`;

const server = new McpServer(
  { name: "venira-coding", version: VERSION },
  { instructions: INSTRUCTIONS },
);
registerProjectTools(server);

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
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
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown());
  }
}

main().catch((err) => {
  console.error("[venira-coding] fatal:", err);
  void shutdown(1);
});
