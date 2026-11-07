import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { CoreHost, queryRecentFiles } from "../lib/corehost.js";
import {
  errorEnvelope,
  newRequestId,
  toolResult,
} from "../lib/output.js";
import type { ToolResult } from "../lib/output.js";
import {
  toHostPath,
  WORKSPACE,
  isProtectedPath,
} from "../lib/workspace.js";
import { readTextFile } from "./project-codeintel.js";
import type { RecentFilesDeps } from "./project-recent.js";
import { dataDirFor, type HealthDeps } from "./project-health.js";
import type { HybridDeps } from "./project-hybrid.js";
import type { BatchDeps } from "./project-batch.js";
import { SHELL_ELICIT, type ShellDeps } from "./project-shell.js";
import { createWorkflowRunners } from "./project-workflow.js";
import { createOperationRunners } from "./project-operations.js";
import { createShellRunRegistry } from "./project-shell-registry.js";
import { createCachedExecutor } from "./project-executor.js";
import { createCodeIntelRunners } from "./project-codeintel-runners.js";
import { createReadPlanRunner } from "./project-read-plan.js";
import { applyDisabledTools } from "./project-tool-mode.js";
import { createProjectSessionRuntime } from "./project-session-runtime.js";
import { prepareRequest } from "./project-request.js";
import { createBackendExecutor } from "./project-backend.js";
import { createProjectWarmUp } from "./project-startup.js";
import { MAX_BATCH_RESPONSE_BYTES, createCacheLayer, envInt, stableKey } from "./project-cache.js";
import type { Args } from "./project-cache.js";
import { registerVcsTools } from "./project-register-vcs.js";
import { registerFileTools } from "./project-register-files.js";
import { registerShellTools } from "./project-register-shell.js";
import { registerOpsTools } from "./project-register-ops.js";
import { registerCodeIntelTools } from "./project-register-codeintel.js";
import { registerWorkflowTools } from "./project-register-workflow.js";
import { SESSION_ID } from "../lib/session.js";

const PERMISSION_MODE = process.env.VENIRA_PERMISSION_MODE ?? "allow_all";
// allow_all grants the "chat-terminal" scope when there is no Project (same as the native app).
// Defined in lib/session.ts (so handler modules can import it without a cycle).
export { SESSION_ID };

const MAX_BATCH_ITEM_BYTES = envInt("VENIRA_BATCH_ITEM_BYTES", 512 * 1024);
const STARTED_AT = Date.now();

const host = new CoreHost();
export const closeHost = () => host.close();

const sessionRuntime = createProjectSessionRuntime({
  callHost: (method, params, timeoutMs) => host.call(method, params, timeoutMs),
  sessionId: SESSION_ID,
  permissionMode: PERMISSION_MODE,
});
const { capabilityReady, capabilityState } = sessionRuntime;

export async function closeScope(): Promise<void> {
  await sessionRuntime.closeScope();
}

export async function cancelAllShellRuns(): Promise<void> {
  try {
    await host.call("project_tool.shell.cancel_session", { session_id: SESSION_ID }, 5_000);
  } catch {
    /* host not started or already dead: nothing to cancel */
  }
}

// ---------------------------------------------------------------------------
// Request/response
// ---------------------------------------------------------------------------

const execute = createBackendExecutor({
  callHost: (method, params, timeoutMs) => host.call(method, params, timeoutMs),
  runtime: sessionRuntime,
  sessionId: SESSION_ID,
});

// ---------------------------------------------------------------------------
// Cache layer lives in ./project-cache.ts (step 5h). It receives the uncached executor and path
// helpers through CacheDeps and never imports this module.
// ---------------------------------------------------------------------------
const cache = createCacheLayer({
  execute: (operation, args) => execute(operation, args),
  prepare: prepareRequest,
  toHostPath,
});
export const warmUp = createProjectWarmUp({
  capabilityReady,
  readFileCached: cache.readFileCached,
  searchCached: cache.searchCached,
  workspace: WORKSPACE,
});

// Files written/edited in this session (project_recent_files returns session_edits).
const recentEdits = new Set<string>();
function rememberEdit(absolutePath: string): void {
  recentEdits.delete(absolutePath);
  recentEdits.add(absolutePath);
  while (recentEdits.size > 50) {
    const oldest = recentEdits.values().next().value;
    if (oldest === undefined) break;
    recentEdits.delete(oldest);
  }
}

// The mutable shell-run map is private to this registry; execution records
// transitions while project_health receives a read-only snapshot.
const shellRegistry = createShellRunRegistry();

const executeCached = createCachedExecutor({
  cache,
  execute: (operation, args) => execute(operation, args),
  rememberEdit,
  clearRecentEdits: () => recentEdits.clear(),
  trackShell: (operation, data) => shellRegistry.track(operation, data),
});

// Tool handlers
// ---------------------------------------------------------------------------
const { runOne, runCreate } = createOperationRunners({ executeCached });

// project_search hybrid mode lives in ./project-hybrid.ts; it reaches the backend search through
// the shared response cache owned by this module.
const hybridDeps: HybridDeps = {
  execute: (operation, args) => executeCached(operation, args),
};

// project_read_batch / project_edit_batch live in ./project-batch.ts; same cached executor plus the
// batch response budget (also used by this module's caches).
const batchDeps: BatchDeps = { ...hybridDeps, maxBatchResponseBytes: MAX_BATCH_RESPONSE_BYTES };

// project_shell_run (approval flow + elicitation) and project_shell_cancel_session live in
// ./project-shell.ts. Shell registry state is private in ./project-shell-registry.ts.
const shellDeps: ShellDeps = {
  execute: (operation, args) => executeCached(operation, args),
  callHost: (method, params, timeoutMs) => host.call(method, params, timeoutMs),
};

// project_recent_files lives in ./project-recent.ts; wire it to the shared TTL
// cache and to the session edit log (recentEdits), which this module owns.
// ---------------------------------------------------------------------------
const recentFilesDeps: RecentFilesDeps = {
  lookup: cache.recent.lookup,
  store: cache.recent.store,
  recentEdits,
};

// project_health lives in ./project-health.ts. The providers below expose the state
// owned here plus the shell registry's read-only snapshot.
// ---------------------------------------------------------------------------
const healthDeps: HealthDeps = {
  hostSnapshot: () => host.snapshot(),
  refreshCapability: capabilityReady,
  capability: () => {
    const { value, opening } = sessionRuntime.capabilitySnapshot();
    return value
      ? {
          state: capabilityState(value),
          project_id: value.projectId,
          opened_ago_ms: Date.now() - value.openedAt,
        }
      : { state: opening ? "opening" : "closed" };
  },
  queue: sessionRuntime.queue,
  caches: cache.report,
  shells: shellRegistry.snapshot,
  startedAt: STARTED_AT,
  permissionMode: PERMISSION_MODE,
  shellElicit: SHELL_ELICIT,
};

// ---------------------------------------------------------------------------
/** Path of the audit DB (lives in the corehost data dir). */
const auditDbPath = (): string => path.join(dataDirFor(host.snapshot().exe), "venira.db");

async function runSecret(args: Args): Promise<ToolResult> {
  // One tool, four verbs: the transport-level `action` maps to the single
  // `secret` host operation so the audit trail stays grouped and consistent
  // with `project_snapshot`.
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  if (!["get", "set", "list", "delete"].includes(action)) {
    const requestId = newRequestId();
    return toolResult(
      errorEnvelope(
        "secret",
        new Error(
          `[invalid_request] action must be get|set|list|delete. Received: ${JSON.stringify(args.action)}. Hint: action=set to store, action=get for metadata, action=list for names.`,
        ),
        { requestId, elapsedMs: 0 },
      ),
      true,
    );
  }
  return runOne("secret", args);
}

const { runSymbolReferences, runSelectiveSearch } = createCodeIntelRunners({
  execute: (operation, args) => execute(operation, args),
  executeCached: (operation, args) => executeCached(operation, args),
  readTextFile,
  toHostPath,
  isProtectedPath,
  referenceCache: cache.references,
  stableKey,
});

const runPlanReadBatch = createReadPlanRunner({
  execute: (operation, args) => execute(operation, args),
  queryRecentFiles,
  workspaceRoot: WORKSPACE,
});

export function registerProjectTools(server: McpServer): void {
  const workflowRunners = createWorkflowRunners({ runOne });
  applyDisabledTools(server);
  registerFileTools(server, {
    runOne,
    hybridDeps,
    recentFilesDeps,
    batchDeps,
    maxBatchItemBytes: MAX_BATCH_ITEM_BYTES,
  });

  registerShellTools(server, { runOne, shellDeps });

  registerOpsTools(server, { runOne, runCreate, healthDeps, auditDbPath, shellDeps });

  // -------------------------------------------------------------------------
  // P2/P3: code intelligence + workflow
  // -------------------------------------------------------------------------

  registerCodeIntelTools(server, { runOne, runSymbolReferences, runSelectiveSearch });

  registerWorkflowTools(server, {
    ...workflowRunners,
    runPlanReadBatch,
  });

  registerVcsTools(server, { runOne, runSecret });
}
