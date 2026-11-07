import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { envFlag, parseBackgroundFlag } from "../lib/env.js";
import { CoreHost, SHELL_MAX_TIMEOUT_MS, SCOPE_TTL_MS } from "../lib/corehost.js";
import { evaluateToolPolicy } from "../lib/tool-policy.js";
import { recordMetric } from "../lib/metrics.js";
import {
  buildEnvelope,
  errorEnvelope,
  newRequestId,
  parseToolError,
  stringify,
  toolResult,
} from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { queryRecentFiles } from "../lib/corehost.js";
import {
  toHostPath,
  WORKSPACE,
  CACHE_ALL_ENABLED,
  CACHE_LIST_ONLY_ENABLED,
  CACHE_SEARCH_ONLY_ENABLED,
  isProtectedPath,
} from "../lib/workspace.js";
import { addTrace } from "../lib/tracer.js";
import { invalidateDependencyGraphCache } from "../lib/dependency-graph.js";
import { clearShellCache } from "../lib/shell-cache.js";
import { selectiveSearch } from "../lib/symbol-diff.js";
import { readTextFile, runDiffFiles, runOutlineSymbol } from "./project-codeintel.js";
import type { RecentFilesDeps } from "./project-recent.js";
import { dataDirFor, type HealthDeps } from "./project-health.js";
import type { HybridDeps } from "./project-hybrid.js";
import type { BatchDeps } from "./project-batch.js";
import { SHELL_ELICIT, type ShellDeps } from "./project-shell.js";
import { MAX_BATCH_RESPONSE_BYTES, createCacheLayer, envInt, stableKey } from "./project-cache.js";
import type { Args, Execution } from "./project-cache.js";
import { config, flag01, path_, reason_ } from "./project-schema.js";
import { registerVcsTools } from "./project-register-vcs.js";
import { registerFileTools } from "./project-register-files.js";
import { registerShellTools } from "./project-register-shell.js";
import { registerOpsTools } from "./project-register-ops.js";
import { SESSION_ID } from "../lib/session.js";
import {
  detectAllHarnesses,
  installSelf,
  type HarnessName,
  type InstallResult,
} from "../lib/self-install.js";
import { explainErrorText } from "../lib/diagnostics.js";
import {
  NAME_HIT_POINTS,
  buildReadPlan,
  extractKeywords,
  isPlannablePath,
  rankCandidates,
  type PlanCandidate,
} from "../lib/read-plan.js";

const PERMISSION_MODE = process.env.VENIRA_PERMISSION_MODE ?? "allow_all";
// allow_all grants the "chat-terminal" scope when there is no Project (same as the native app).
// Defined in lib/session.ts (so handler modules can import it without a cycle).
export { SESSION_ID };

const MAX_BATCH_ITEM_BYTES = envInt("VENIRA_BATCH_ITEM_BYTES", 512 * 1024);
const MAX_READ_BYTES = 1048576; // 1 MiB, safer than the native ceiling
const STARTED_AT = Date.now();

const host = new CoreHost();
export const closeHost = () => host.close();

// ---------------------------------------------------------------------------
// Tool-level policy (VENIRA_TOOL_POLICY_FILE).  Applied centrally so every
// tool invocation — including MCP resource reads that share the path — can
// be gated by command-level rules.  `null` means "no rule matched, allow".
// ---------------------------------------------------------------------------
let toolPolicyCache: { loaded: boolean } = { loaded: false };

// ---------------------------------------------------------------------------
// Sequential request queue: each request spawns a blocking thread that opens its
// own SQLite audit connection; parallel requests make the audit WAL lock
// contend (3-4x slower and can fail with audit_unavailable). Serial calls keep
// the thread pool warm, faster and far more stable.
// ---------------------------------------------------------------------------
let queueTail: Promise<unknown> = Promise.resolve();
let queueDepth = 0;
let peakQueueDepth = 0;
let inFlight = 0;

function serial<T>(task: () => Promise<T>): Promise<T> {
  queueDepth += 1;
  peakQueueDepth = Math.max(peakQueueDepth, queueDepth);
  const run = queueTail.then(
    () => runQueued(task),
    () => runQueued(task),
  );
  queueTail = run.catch(() => undefined);
  return run;
}

async function runQueued<T>(task: () => Promise<T>): Promise<T> {
  queueDepth = Math.max(0, queueDepth - 1);
  return task();
}

// ---------------------------------------------------------------------------
// Long-lived capability: open the scope once, reuse it for every request (TTL 2h).
// Previously each call did open_scope -> canonicalize + open handles for home
// and each drive, then close_scope right after.
// ---------------------------------------------------------------------------
const CAPABILITY_REFRESH_AFTER_MS = SCOPE_TTL_MS / 2;

/** Truthful state for reporting: after proactive refresh the module-level cap is
 * always younger than CAPABILITY_REFRESH_AFTER_MS, so "expired" only surfaces if
 * something bypasses capabilityReady(). */
function capabilityState(cap: Capability): "open" | "refreshing" | "expired" {
  const age = Date.now() - cap.openedAt;
  if (age >= SCOPE_TTL_MS) return "expired";
  if (age >= CAPABILITY_REFRESH_AFTER_MS) return "refreshing";
  return "open";
}

type Capability = { id: string; projectId: string; openedAt: number };

let capability: Capability | null = null;
let opening: Promise<Capability> | null = null;

function openCapability(): Promise<Capability> {
  return serial(async () => {
    const opened = (await host.call(
      "project_tool.scope.open",
      { session_id: SESSION_ID, project_id: null, permission_mode: PERMISSION_MODE },
      15_000,
    )) as { capability_id: string; project_id: string };
    return { id: opened.capability_id, projectId: opened.project_id, openedAt: Date.now() };
  });
}

function capabilityReady(): Promise<Capability> {
  // Refresh well before the host's 2 h scope TTL: the first tool call after
  // the expiry boundary must not observe `capability_expired` at all. After
  // CAPABILITY_REFRESH_AFTER_MS the scope is silently reopened through the
  // shared `opening` path; the old scope lingers harmlessly until the host
  // reaps it at its TTL.
  if (capability && Date.now() - capability.openedAt < CAPABILITY_REFRESH_AFTER_MS) {
    return Promise.resolve(capability);
  }
  if (!opening) {
    opening = openCapability().then(
      (value) => {
        capability = value;
        opening = null;
        return value;
      },
      (error) => {
        opening = null;
        throw error;
      },
    );
  }
  return opening;
}

function isCapabilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("capability is expired or revoked") ||
    message.includes("capability does not match") ||
    message.includes("corehost exited")
  );
}

export async function warmUp(): Promise<void> {
  try {
    await capabilityReady();
    // Cache warm-up: proactively read the handful of files that are read
    // in virtually every session, so the first real tool call hits a
    // warm cache. Only files that exist are read: a blind read of a missing
    // file still lands in the audit table as failed/not_found on every start,
    // which is noise and trips the health "loop_failures" warning.
    const candidates = ["README.md", "AGENTS.md", "CLAUDE.md", "package.json", ".env.example"];
    // Fire-and-forget: do not block server start on I/O warmup.
    void Promise.allSettled(
      candidates.map(async (name) => {
        try {
          await fs.access(path.join(WORKSPACE, name));
        } catch {
          return; // absent: nothing to warm, and nothing to audit
        }
        try {
          await readFileCached({ relative_path: name } as Args);
        } catch {
          /* raced with a delete or unreadable: best-effort only */
        }
      }),
    ).catch(() => {});
    // Pre-warm the content-search path (OS filesystem cache + search cache)
    // with a representative query so a user search's first hit is fast.
    void searchCached({ query: "project_read_file", kind: "literal_content", limit: 50 } as Args).catch(() => {});
  } catch (error) {
    console.error(
      "[venira-coding] warmup failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function closeScope(): Promise<void> {
  const current = capability;
  capability = null;
  if (!current) return;
  try {
    await host.call(
      "project_tool.scope.close",
      { session_id: SESSION_ID, project_id: current.projectId, capability_id: current.id },
      5_000,
    );
  } catch {
    /* host already dead or scope already expired */
  }
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

/**
 * Operations that talk to GitHub/CI or to the secret store. They take no
 * workspace path, so `prepare()` must not invent one for them.
 */
const EXTERNAL_OPS = new Set([
  "pr_create",
  "pr_comment",
  "pr_merge",
  "pr_list",
  "pr_close",
  "pr_reopen",
  "ci_status",
  "ci_control",
  "ci_trigger",
  "ci_logs",
  "ci_wait",
  "secret",
  "github_connect",
]);

/** Convert path fields to absolute workspace paths; drop undefined values. */
function prepare(operation: string, args: Args): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value;
  }
  if (EXTERNAL_OPS.has(operation)) {
    // No path fields: repo/PR/run ids are remote identifiers.
    return out;
  }
  if (operation === "shell_run") {
    out.relative_cwd = toHostPath(out.relative_cwd as string | undefined);
  } else if (operation.startsWith("snapshot_")) {
    // Checkpoints accept `paths[]`; resolve each entry inside the workspace
    // (absolute paths are still validated, never trusted blindly).
    if (Array.isArray(out.paths)) {
      out.paths = (out.paths as unknown[]).map((entry) => toHostPath(String(entry)));
    }
  } else if (operation === "change_impact") {
    // Impact seeds: file paths and the optional `{name, file}` symbol form.
    if (Array.isArray(out.files)) {
      out.files = (out.files as unknown[]).map((entry) => toHostPath(String(entry)));
    }
    if (Array.isArray(out.symbols)) {
      out.symbols = (out.symbols as unknown[]).map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const rawFile =
            typeof record.relative_path === "string"
              ? record.relative_path
              : typeof record.file === "string"
                ? record.file
                : undefined;
          return rawFile === undefined ? record : { ...record, relative_path: toHostPath(rawFile) };
        }
        return entry;
      });
    }
  } else if (operation !== "shell_status" && operation !== "cancel") {
    out.relative_path = toHostPath(out.relative_path as string | undefined);
  }
  return out;
}

function isForegroundShell(args: Args): boolean {
  return !parseBackgroundFlag(args.background);
}

function timeoutFor(operation: string, args: Args): number {
  if (operation === "shell_status") {
    const wait = Number(args.wait_seconds ?? 0);
    return Math.min(30, Math.max(0, Number.isFinite(wait) ? wait : 0)) * 1000 + 15_000;
  }
  // A foreground shell_run blocks until the command exits, so the host-call
  // budget must cover the shell timeout (not the 30 s default).
  if (operation === "shell_run") {
    if (isForegroundShell(args)) {
      const raw = Number(args.timeout_ms ?? 0);
      const requested = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 600_000;
      return Math.min(requested, SHELL_MAX_TIMEOUT_MS) + 15_000;
    }
    return 30_000;
  }
  // Checkpoints walk/hash/rewrite many files, so they get a larger budget.
  if (operation === "snapshot_create") return 120_000;
  if (operation === "snapshot_restore") return 120_000;
  // Network calls: GitHub can be slow, and log archives are bigger.
  if (operation === "ci_logs") return 90_000;
  // A long poll gets its own budget so the transport does not time out first.
  if (operation === "ci_wait") {
    const wait = Number(args.timeout_ms ?? 45_000);
    const bounded = Math.min(110_000, Math.max(1_000, Number.isFinite(wait) ? wait : 45_000));
    return bounded + 10_000;
  }
  if (operation === "dependency_graph" || operation === "change_impact") return 60_000;
  if (EXTERNAL_OPS.has(operation)) return 60_000;
  return 30_000;
}

/** shell_status/cancel/ci_wait are not queued: a long poll must never block other tools. */
const UNQUEUED = new Set(["shell_status", "cancel", "ci_wait"]);

async function executeOnce(operation: string, args: Args): Promise<unknown> {
  const cap = await capabilityReady();
  const payload = prepare(operation, args);
  // `reason` is the "why" of a mutation. It travels both as an envelope field
  // (the host writes it into the audit row) and inside the operation args so
  // the result can echo it back as `data.reason`.
  const reason = typeof payload.reason === "string" ? payload.reason : undefined;
  const envelope = {
    contract_version: 1,
    request_id: newRequestId(),
    session_id: SESSION_ID,
    project_id: cap.projectId,
    capability_id: cap.id,
    ...(reason !== undefined ? { reason } : {}),
    operation: { name: operation, arguments: payload },
  };
  const timeout = timeoutFor(operation, args);
  const call = () => {
    inFlight += 1;
    return host.call("project_tool.execute", envelope, timeout).finally(() => {
      inFlight = Math.max(0, inFlight - 1);
    });
  };
  if (UNQUEUED.has(operation)) return call();
  return serial(call);
}

async function execute(operation: string, args: Args): Promise<RustResponse> {
  try {
    return (await executeOnce(operation, args)) as RustResponse;
  } catch (error) {
    if (!isCapabilityError(error)) throw error;
    // The scope may have expired / the host just restarted: reopen once, then retry.
    capability = null;
    return (await executeOnce(operation, args)) as RustResponse;
  }
}

// ---------------------------------------------------------------------------
// Cache layer lives in ./project-cache.ts (step 5h). It receives the uncached executor and path
// helpers through CacheDeps and never imports this module.
// ---------------------------------------------------------------------------
const cache = createCacheLayer({
  execute: (operation, args) => execute(operation, args),
  prepare: (operation, args) => prepare(operation, args),
  toHostPath,
});
const {
  readFileCached,
  fileInfoCached,
  listCached,
  searchCached,
  invalidatePath,
  invalidateListCaches,
  invalidateAllCaches,
} = cache;

const MUTATING = new Set(["write_file", "edit_file", "delete_path"]);

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

// ---------------------------------------------------------------------------
// Shell run tracking (cho project_health)
// ---------------------------------------------------------------------------
const shellRuns = new Map<string, { running: boolean; exit_code: number | null; updated_at: number }>();

function trackShell(operation: string, data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  const payload = data as { run_id?: unknown; running?: unknown; exit_code?: unknown };
  if (typeof payload.run_id !== "string") return;
  if (operation === "shell_run" || operation === "shell_status") {
    shellRuns.set(payload.run_id, {
      running: payload.running === true,
      exit_code: typeof payload.exit_code === "number" ? payload.exit_code : null,
      updated_at: Date.now(),
    });
  } else if (operation === "cancel") {
    const previous = shellRuns.get(payload.run_id);
    if (previous) {
      previous.running = false;
      previous.updated_at = Date.now();
    }
  }
  if (shellRuns.size > 32) {
    for (const [runId, state] of shellRuns) {
      if (!state.running && Date.now() - state.updated_at > 10 * 60_000) shellRuns.delete(runId);
    }
  }
}

async function executeCached(operation: string, args: Args): Promise<Execution> {
  const started = Date.now();
  let cached = false;
  let ok = true;

  try {
    // Tool-level policy: deny → throw (non-retryable), ask → throw an
    // approval_required envelope.  When VENIRA_TOOL_POLICY_FILE is unset this
    // is a no-op and the shell policy in lib/corehost.ts still applies.
    const decision = evaluateToolPolicy(operation, args);
    if (decision) {
      if (decision.tier === "deny") {
        throw new Error(`[command_denied] ${decision.reason} (rule: ${decision.tool})`);
      }
      if (decision.tier === "ask") {
        throw new Error(`[approval_required] ${decision.reason}`);
      }
    }

    // project_cache_clear: short-circuit backend; clear in-process caches by type.
    if (operation === "cache_clear") {
      const type = (args.type as string | undefined) ?? "all";
      const cleared: Record<string, number> = {};
      const clearType = (name: string, fn: () => number | void) => {
        try {
          const n = fn();
          cleared[name] = typeof n === "number" ? n : 0;
        } catch {
          cleared[name] = 0;
        }
      };
      if (type === "all" || type === "shell") {
        clearShellCache();
        cleared.shell = -1; // not tracked by size
      }
      for (const name of ["read", "info", "list", "search", "recent", "negative"] as const) {
        if (type === "all" || type === name) clearType(name, () => cache.clear(name));
      }
      if (type === "all" || type === "graph") {
        invalidateDependencyGraphCache();
        cleared.graph = -1;
      }
      const summary = { type, cleared };
      const response: RustResponse = {
        status: "completed",
        result: { kind: "cache_clear", data: summary },
      };
      return { response, cached: false };
    }

    if (operation === "safe_edit") {
      throw new Error("[invalid_request] safe_edit tool removed. Use project_edit_file with guard=sha256 instead.");
    }

    // VENIRA_CACHE_ALL=0: bypass every read-side cache (strict fresh mode).
    const bypassAll =
      !CACHE_ALL_ENABLED && ["read_file", "get_file_info", "list_files", "search"].includes(operation);

    let execution: Execution;
    if (operation === "read_file") {
      execution = bypassAll
        ? { response: (await execute(operation, args)) as RustResponse, cached: false }
        : await readFileCached(args);
    } else if (operation === "get_file_info") {
      execution = bypassAll
        ? { response: (await execute(operation, args)) as RustResponse, cached: false }
        : await fileInfoCached(args);
    } else if (operation === "list_files") {
      execution = bypassAll || !CACHE_LIST_ONLY_ENABLED
        ? { response: (await execute(operation, args)) as RustResponse, cached: false }
        : await listCached(args);
    } else if (operation === "search") {
      execution = bypassAll || !CACHE_SEARCH_ONLY_ENABLED
        ? { response: (await execute(operation, args)) as RustResponse, cached: false }
        : await searchCached(args);
    } else {
      const response = (await execute(operation, args)) as RustResponse;
      if (MUTATING.has(operation)) {
        try {
          const absolutePath = toHostPath(args.relative_path as string | undefined);
          invalidatePath(absolutePath);
          rememberEdit(absolutePath);
        } catch {
          /* an invalid path already returned an error; no cache to clean */
        }
        invalidateListCaches();
        invalidateDependencyGraphCache();
      }
      if (operation === "snapshot_restore" || operation === "snapshot_delete") {
        invalidateAllCaches();
        recentEdits.clear();
        invalidateDependencyGraphCache();
      }
      if (operation.startsWith("shell_") || operation === "cancel") {
        trackShell(operation, response.result?.data);
      }
      execution = { response, cached: false };
    }

    cached = execution.cached;
    return execution;
  } catch (error) {
    ok = false;
    throw error;
  } finally {
    addTrace({ operation, duration_ms: Date.now() - started, ok, cached });
  }
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
async function runOne(operation: string, args: Args, options?: { line_numbers?: boolean }): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  try {
    const { response, cached } = await executeCached(operation, args);
    let result = response;
    if (options?.line_numbers && result?.result?.kind === "file_read") {
      const data = result.result.data as { text?: string; first_line?: number; line_numbers?: boolean } | undefined;
      if (data && typeof data.text === "string" && typeof data.first_line === "number" && data.first_line >= 1 && data.text) {
        const lines = data.text.split("\n");
        const trailingNewline = lines[lines.length - 1] === "";
        if (trailingNewline) lines.pop();
        const firstLine = data.first_line; // narrow type
        const lastNumber = firstLine + lines.length - 1;
        const width = Math.max(4, String(lastNumber).length);
        const numbered = lines
          .map((line, index) => {
            const num = firstLine + index;
            const prefix = num.toString().padStart(width, " ");
            return `${prefix}| ${line}`;
          })
          .join("\n");
        data.text = numbered + (trailingNewline ? "\n" : "");
        data.line_numbers = true;
      }
    }
    const elapsedMs = performance.now() - started;
    recordMetric(operation, elapsedMs, true);
    return toolResult(
      buildEnvelope(operation, result, {
        requestId,
        elapsedMs,
        cached,
        ...(result?.hint ? { hint: result.hint } : {}),
      }),
    );
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric(operation, elapsedMs, false);
    return toolResult(errorEnvelope(operation, error, { requestId, elapsedMs }), true);
  }
}

// project_search hybrid mode lives in ./project-hybrid.ts; it reaches the backend search through
// the shared response cache owned by this module.
const hybridDeps: HybridDeps = {
  execute: (operation, args) => executeCached(operation, args),
};

// project_read_batch / project_edit_batch live in ./project-batch.ts; same cached executor plus the
// batch response budget (also used by this module's caches).
const batchDeps: BatchDeps = { ...hybridDeps, maxBatchResponseBytes: MAX_BATCH_RESPONSE_BYTES };

// project_shell_run (approval flow + elicitation) and project_shell_cancel_session live in
// ./project-shell.ts. The shell run registry (shellRuns/trackShell) stays here: executeCached and
// project_health share it.
const shellDeps: ShellDeps = {
  execute: (operation, args) => executeCached(operation, args),
  callHost: (method, params, timeoutMs) => host.call(method, params, timeoutMs),
};

async function runReadRanges(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const relativePath = String(args.relative_path ?? "");
  const ranges = args.ranges as { start_line: number; end_line?: number; max_bytes?: number }[];
  const results: unknown[] = [];
  let failed = 0;
  let truncated = false;

  for (const [index, range] of ranges.entries()) {
    const itemStarted = performance.now();
    try {
      const { response, cached } = await readFileCached({
        relative_path: relativePath,
        start_line: range.start_line,
        end_line: range.end_line,
        max_bytes: range.max_bytes,
      });
      const data = (response.result?.data ?? {}) as {
        first_line?: number;
        last_line?: number;
        text?: string;
        truncated?: boolean;
        next_start_line?: number;
      };
      truncated ||= data.truncated === true;
      results.push({
        ok: true,
        index,
        start_line: data.first_line,
        end_line: data.last_line,
        text: data.text ?? "",
        truncated: data.truncated === true,
        ...(data.next_start_line !== undefined ? { next_start_line: data.next_start_line } : {}),
        cached,
      });
      recordMetric("read_file", performance.now() - itemStarted, true);
    } catch (error) {
      failed += 1;
      recordMetric("read_file", performance.now() - itemStarted, false);
      const failure = parseToolError(error);
      results.push({
        ok: false,
        index,
        start_line: range.start_line,
        error: { code: failure.code, message: failure.message, retryable: failure.retryable },
        ...(failure.hint ? { hint: failure.hint } : {}),
      });
    }
  }

  const data = {
    relative_path: toHostPath(relativePath),
    range_count: results.length,
    failed,
    truncated,
    ranges: results,
  };
  const synthetic: RustResponse = {
    status: "completed",
    truncated,
    result: { kind: "file_read_ranges", data },
  };
  const elapsedMs = performance.now() - started;
  recordMetric("read_ranges", elapsedMs, failed === 0);
  return toolResult(
    buildEnvelope("read_ranges", synthetic, {
      requestId,
      elapsedMs,
      hint:
        failed > 0
          ? "Some ranges failed; call project_read_file for the same range to see the full error."
          : undefined,
    }),
  );
}

// ---------------------------------------------------------------------------
// project_recent_files lives in ./project-recent.ts; wire it to the shared TTL
// cache and to the session edit log (recentEdits), which this module owns.
// ---------------------------------------------------------------------------
const recentFilesDeps: RecentFilesDeps = {
  lookup: cache.recent.lookup,
  store: cache.recent.store,
  recentEdits,
};

// ---------------------------------------------------------------------------
// project_create (unified file + directory, kept in sync with the native app tool).
// No backend change needed (`write_file` + `create_directory` already exist).
// ---------------------------------------------------------------------------
async function runCreate(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const kind = args.kind;
  if (kind === "directory") {
    if (args.content) {
      const fail = errorEnvelope("create", new Error("[invalid_request] kind=directory does not accept `content`. Drop content or use kind=file. Hint: use write_file for files, create_directory for directories."), { requestId, elapsedMs: performance.now() - started });
      recordMetric("create", performance.now() - started, false);
      return toolResult(fail, true);
    }
    const dirParams: Args = {
      relative_path: args.relative_path,
      create_parents: args.create_dirs ?? true,
    };
    if (typeof args.reason === "string") dirParams.reason = args.reason;
    const { response: dirResponse } = await executeCached("create_directory", dirParams);
    recordMetric("create", performance.now() - started, true);
    return toolResult(buildEnvelope("create", dirResponse, { requestId, elapsedMs: performance.now() - started }));
  }
  if (kind !== "file") {
    recordMetric("create", performance.now() - started, false);
    return toolResult(errorEnvelope("create", new Error(`[invalid_request] \`kind\` must be "file" or "directory". Received: ${JSON.stringify(kind)}.`), { requestId, elapsedMs: performance.now() - started }), true);
  }
  if (typeof args.content !== "string") {
    recordMetric("create", performance.now() - started, false);
    return toolResult(errorEnvelope("create", new Error("[invalid_request] kind=file requires `content` (a UTF-8 string; use an empty string \"\" for an empty file)."), { requestId, elapsedMs: performance.now() - started }), true);
  }
  const fileParams: Args = { relative_path: args.relative_path, content: args.content, create_dirs: args.create_dirs ?? true };
  if (args.mode !== undefined) fileParams.mode = args.mode;
  if (args.expected_sha256 !== undefined) fileParams.expected_sha256 = args.expected_sha256;
  if (typeof args.reason === "string") fileParams.reason = args.reason;
  const result = (await executeCached("write_file", fileParams)).response;
  recordMetric("create", performance.now() - started, true);
  return toolResult(buildEnvelope("create", result, { requestId, elapsedMs: performance.now() - started }));
}

// ---------------------------------------------------------------------------
// project_health lives in ./project-health.ts. The providers below expose the state
// this module owns (caches, queue, capability, shell runs) as read-only snapshots.
// ---------------------------------------------------------------------------
const healthDeps: HealthDeps = {
  hostSnapshot: () => host.snapshot(),
  refreshCapability: capabilityReady,
  capability: () =>
    capability
      ? {
          state: capabilityState(capability),
          project_id: capability.projectId,
          opened_ago_ms: Date.now() - capability.openedAt,
        }
      : { state: opening ? "opening" : "closed" },
  queue: () => ({ depth: queueDepth, in_flight: inFlight, peak_depth: peakQueueDepth }),
  caches: cache.report,
  shells: () => ({
    active: [...shellRuns.entries()]
      .filter(([, state]) => state.running)
      .map(([runId, state]) => ({ run_id: runId, exit_code: state.exit_code })),
    tracked: shellRuns.size,
  }),
  startedAt: STARTED_AT,
  permissionMode: PERMISSION_MODE,
  shellElicit: SHELL_ELICIT,
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------
type ToolMode = "default" | "expert";

/**
 * Per-mode tool exclusions layered on top of `VENIRA_DISABLE_TOOLS` and the
 * `VENIRA_PROFILE=core` preset. `expert` keeps the full set (everything the
 * server can do: shell, JS eval, CI/CD shipping, secrets, intel); `default` is
 * the **full sandbox coding toolset** — all specialized tools for reading,
 * writing, editing, searching, code intelligence, diagnostics, snapshots,
 * config, **shell execution, JS execution**; only excludes CI/CD shipping
 * (PR/CI tools). `project_delete_path` is available in both modes — shell
 * `rm -rf` / `rd /s` / `Remove-Item -Recurse -Force` are hard-denied by shell
 * policy in every mode, so `project_delete_path` is the controlled, auditable
 * deletion path.
 */
const TOOL_MODE_EXCLUDES: Record<ToolMode, string[]> = {
  expert: [],
  default: [
    "project_ci_status",
    "project_ci_trigger",
    "project_ci_logs",
    "project_ci_wait",
    "project_ci_control",
    "project_pr_create",
    "project_pr_comment",
    "project_pr_merge",
    "project_pr_list",
    "project_pr_close",
    "project_pr_reopen",
  ],
};

function resolveToolMode(): ToolMode {
  const raw = (process.env.VENIRA_TOOL_MODE ?? "").trim().toLowerCase();
  if (raw === "expert" || raw === "default") return raw;
  try {
    const file = path.join(WORKSPACE, "venira.config.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { toolMode?: unknown };
    const candidate = String(parsed?.toolMode ?? "").trim().toLowerCase();
    if (candidate === "expert" || candidate === "default") return candidate;
  } catch {
    /* no config -> default */
  }
  return "default";
}

/**
 * Tool modes (default/expert) + `VENIRA_DISABLE_TOOLS` (deployment-level)
 * keep tools out of `tools/list` entirely, so a client can never call them.
 * Mode exclusions layer on top of the disable list; `expert` keeps the full set.
 */
function applyDisabledTools(server: McpServer): void {
  const profile = (process.env.VENIRA_PROFILE ?? "full").toLowerCase();
  const disabled = (process.env.VENIRA_DISABLE_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const mode = resolveToolMode();
  const modeExcludes = TOOL_MODE_EXCLUDES[mode];
  if (profile === "core") {
    disabled.push(
      "project_execute_js",
      "project_outline_symbol",
      "project_diff_files",
      "project_symbol_references",
      "project_selective_search",
      "project_recent_files",
      "project_dependency_graph",
      "project_change_impact",
    );
  }
  const blocked = new Set<string>([...disabled, ...modeExcludes]);
  if (blocked.size === 0) return;
  const original = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
  server.registerTool = ((name: string, ...rest: unknown[]) =>
    blocked.has(name) ? undefined : original(name, ...rest)) as unknown as typeof server.registerTool;
  console.error(`[venira-coding] disabled tools (${mode}): ${[...blocked].join(", ")}`);
}

/** Path of the audit DB (lives in the corehost data dir). */
const auditDbPath = (): string => path.join(dataDirFor(host.snapshot().exe), "venira.db");

async function runSnapshot(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const action = typeof args.action === "string" ? args.action : "create";
  const operation =
    action === "list"
      ? "snapshot_list"
      : action === "restore"
        ? "snapshot_restore"
        : action === "delete"
          ? "snapshot_delete"
          : action === "create"
            ? "snapshot_create"
            : null;
  if (!operation) {
    const requestId = newRequestId();
    const elapsedMs = performance.now() - started;
    recordMetric("snapshot", elapsedMs, false);
    return toolResult(
      errorEnvelope(
        "snapshot",
        new Error(
          `[invalid_request] action must be create|list|restore|delete. Received: ${JSON.stringify(action)}.`,
        ),
        { requestId, elapsedMs },
      ),
      true,
    );
  }
  // `action` is transport-level sugar; the host operation is explicit so each
  // one gets its own audit row (snapshot_create / ... / snapshot_delete).
  const payload: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== "action" && value !== undefined) payload[key] = value;
  }
  return runOne(operation, payload);
}

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

async function runSymbolReferences(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const symbolName = String(args.symbol_name ?? "");
  if (!symbolName) {
    return toolResult(errorEnvelope("symbol_references", new Error("[invalid_request] symbol_name is required."), { requestId, elapsedMs: 0 }), true);
  }
  const scope = args.scope === "file" ? "file" : "workspace";
  // For "file" scope, search only the file that the symbol lives in (approximation:
  // the caller should pair this with project_outline_symbol first). For "workspace",
  // do a bounded content search for the identifier.
  let references: Array<{ relative_path: string; line_number: number; context: string }> = [];
  let searchCacheHit = false;
  if (scope === "file") {
    const rel = String(args.relative_path ?? "");
    if (isProtectedPath(toHostPath(rel))) {
      return toolResult(
        errorEnvelope("symbol_references", new Error(`[sensitive_result] Path is protected by policy: ${rel}.`), { requestId, elapsedMs: performance.now() - started }),
        true,
      );
    }
    const text = await readTextFile(rel);
    if (text === null) {
      return toolResult(errorEnvelope("symbol_references", new Error(`[not_found] No such file: ${rel}.`), { requestId, elapsedMs: performance.now() - started }), true);
    }
    const lines = text.split("\n");
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        references.push({ relative_path: toHostPath(rel), line_number: i + 1, context: lines[i].trim().slice(0, 160) });
      }
    }
  } else {
    // workspace scope: bounded search via the existing search op, kind=literal_content.
    // Dedicated cache: the host reports complete=false when it stops at the hit
    // cap, and searchCache only stores complete results — a plain limit=10 query
    // would never be cached and every call would re-walk the repo.
    const limit = Number(args.limit ?? 50);
    const innerArgs = {
      query: symbolName,
      kind: "literal_content",
      whole_word: true,
      limit,
      relative_path: args.relative_path,
    };
    const refKey = stableKey(innerArgs);
    const cachedSearch = cache.references.lookup(refKey);
    searchCacheHit = cachedSearch !== null;
    const searchRes = cachedSearch ?? (await executeCached("search", innerArgs)).response;
    if (!cachedSearch) cache.references.store(refKey, searchRes);
    const hits = (searchRes.result?.data as { hits?: unknown[] } | undefined)?.hits ?? [];
    references = (hits as Array<{ relative_path?: unknown; line_number?: unknown; snippet?: unknown; text?: unknown; line?: unknown; context?: unknown }>).map((h) => ({
      relative_path: String(h.relative_path ?? ""),
      line_number: Number(h.line_number ?? 0),
      context: String(h.snippet ?? h.text ?? h.line ?? h.context ?? "").slice(0, 160),
    }));
  }
  const max = Number(args.max_references ?? 100);
  const response: RustResponse = {
    status: "completed",
    result: {
      kind: "symbol_references",
      data: {
        symbol_name: symbolName,
        scope,
        count: references.length,
        references: references.slice(0, max),
      },
    },
    truncated: references.length > max,
  };
  const elapsedMs = performance.now() - started;
  recordMetric("symbol_references", elapsedMs, true);
  return toolResult(buildEnvelope("symbol_references", response, { requestId, elapsedMs, cached: searchCacheHit }));
}

async function runSelectiveSearch(args: Args): Promise<ToolResult> {  const started = performance.now();
  const requestId = newRequestId();
  const queries = args.queries as Array<{ pattern: string; must?: boolean; weight?: number }> | undefined;
  if (!Array.isArray(queries) || queries.length === 0) {
    return toolResult(errorEnvelope("selective_search", new Error("[invalid_request] queries[] is required."), { requestId, elapsedMs: 0 }), true);
  }
  // Bounded file set: prefer the caller's files_hint, otherwise scan a subset of
  // the workspace via list_files + read.
  const files = new Map<string, string>();
  const hint = Array.isArray(args.files_hint) ? (args.files_hint as string[]) : [];
  if (hint.length > 0) {
    let usable = 0;
    let blocked = 0;
    for (const rel of hint.slice(0, 20)) {
      let protectedPath = false;
      try {
        protectedPath = isProtectedPath(toHostPath(rel));
      } catch {
        protectedPath = false;
      }
      if (protectedPath) {
        blocked += 1;
        continue;
      }
      usable += 1;
      const text = await readTextFile(rel);
      if (text !== null) files.set(toHostPath(rel), text);
    }
    if (usable === 0 && blocked > 0) {
      return toolResult(
        errorEnvelope("selective_search", new Error("[sensitive_result] Every files_hint path is protected by policy."), { requestId, elapsedMs: performance.now() - started }),
        true,
      );
    }
  } else {
    // Fallback: a shallow directory listing + read of the first N text files.
    const relPath = args.relative_path ? String(args.relative_path) : undefined;
    const listRes = (await execute("list_files", { relative_path: relPath, depth: 2, limit: 40 })) as RustResponse;
    const entries = (listRes.result?.data as { entries?: unknown[] } | undefined)?.entries ?? [];
    const list = entries.filter((e) => typeof e === "object" && (e as { kind?: unknown }).kind === "file").slice(0, 40) as Array<{ relative_path?: unknown }>;
    for (const e of list) {
      const rel = String(e.relative_path ?? "");
      if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|cs|rb|php|sql|json|md|sh|yml|yaml|toml)$/.test(rel)) {
        const text = await readTextFile(rel);
        if (text !== null) files.set(toHostPath(rel), text);
      }
    }
  }
  const result = selectiveSearch(files, queries, Number(args.limit ?? 100));
  const response: RustResponse = {
    status: "completed",
    result: {
      kind: "selective_search",
      data: {
        hits: result.hits,
        total_files: result.total_files,
        total_hits: result.total_hits,
        truncated: result.truncated,
      },
    },
    truncated: result.truncated,
  };
  const elapsedMs = performance.now() - started;
  recordMetric("selective_search", elapsedMs, true);
  return toolResult(buildEnvelope("selective_search", response, { requestId, elapsedMs, cached: false }));
}

// ---------------------------------------------------------------------------
// Diagnostics + read planning (deterministic, no model call)
// ---------------------------------------------------------------------------

/** Map a familiar failure to its cause and the next tool call (rules, not a model). */
async function runExplainError(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const errorText = typeof args.error_text === "string" ? args.error_text : "";
  const logTail = typeof args.log_tail === "string" ? args.log_tail : "";
  if (!errorText.trim() && !logTail.trim()) {
    const elapsedMs = performance.now() - started;
    return toolResult(
      errorEnvelope(
        "explain_error",
        new Error(
          "[invalid_request] Pass error_text (the error block) or log_tail (the last lines of output). " +
            "Hint: project_ci_logs and project_shell_status already return a tail.",
        ),
        { requestId, elapsedMs },
      ),
      true,
    );
  }
  const result = explainErrorText({ error_text: errorText, log_tail: logTail });
  const language =
    result.language ?? (typeof args.language === "string" && args.language.trim() ? args.language.trim() : null);
  const response: RustResponse = {
    status: "completed",
    result: { kind: "explain_error", data: { ...result, language } },
    ...(result.matched
      ? {}
      : {
          hint:
            "No known signature matched. Hint: read the failing file:line with project_read_file, then narrow the loop " +
            "(one test / one command) before changing code.",
        }),
  };
  const elapsedMs = performance.now() - started;
  recordMetric("explain_error", elapsedMs, true);
  return toolResult(buildEnvelope("explain_error", response, { requestId, elapsedMs, cached: false }));
}

/**
 * Turn a task sentence into a real read plan: keywords → bounded searches →
 * ranked candidates → one ready `project_read_batch` call (+ outline/search
 * follow-ups). Deterministic and read-only.
 */
async function runPlanReadBatch(args: Args): Promise<ToolResult> {  const started = performance.now();
  const requestId = newRequestId();
  const task = typeof args.task_description === "string" ? args.task_description.trim() : "";
  if (!task) {
    const elapsedMs = performance.now() - started;
    return toolResult(
      errorEnvelope(
        "plan_read_batch",
        new Error(
          "[invalid_request] `task_description` is required. Hint: describe the change in one line, e.g. " +
            '"add retry handling to the GitHub client".',
        ),
        { requestId, elapsedMs },
      ),
      true,
    );
  }
  const maxFiles = Math.max(1, Math.min(8, Number(args.max_files ?? 6) || 6));
  const keywords = extractKeywords(task, Math.max(1, Math.min(5, Number(args.max_keywords ?? 5) || 5)));
  const includeSearch = args.include_search !== false;
  const hints = Array.isArray(args.files_hint)
    ? (args.files_hint as unknown[]).map((value) => String(value).trim()).filter(Boolean).slice(0, 16)
    : [];

  const candidates = new Map<string, PlanCandidate>();
  for (const rel of hints) candidates.set(rel, { relative_path: rel, reason: "files_hint", hits: 3 });

  let searched = false;
  const addCandidate = (rel: string, reason: string, points: number) => {
    if (!rel || !isPlannablePath(rel)) return;
    const existing = candidates.get(rel);
    if (existing) existing.hits = (existing.hits ?? 0) + points;
    else candidates.set(rel, { relative_path: rel, reason, hits: points });
  };

  /**
   * File-name search. One retry with the other word separator covers the common
   * snake_case <-> kebab-case mismatch (`user_profile` vs `user-profile.ts`).
   */
  const searchNames = async (keyword: string): Promise<Array<{ relative_path?: unknown }>> => {
    const run = async (query: string) => {
      const res = (await execute("search", { query, kind: "file_name", limit: 8 })) as RustResponse;
      return ((res.result?.data as { hits?: unknown[] } | undefined)?.hits ?? []) as Array<{ relative_path?: unknown }>;
    };
    const swapped = keyword.includes("_") ? keyword.replace(/_/g, "-") : keyword.replace(/-/g, "_");
    // Filename search is case-sensitive on some hosts: task keywords such as
    // GitHub must also find the repository's lowercase git-github.ts.
    const queries = [...new Set([keyword, keyword.toLowerCase(), swapped, swapped.toLowerCase()])];
    for (const query of queries) {
      try {
        const hits = await run(query);
        if (hits.length > 0) return hits;
      } catch {
        /* try the next bounded spelling variant */
      }
    }
    return [];
  };

  for (const keyword of includeSearch ? keywords.slice(0, 3) : []) {
    try {
      const searchRes = (await execute("search", {
        query: keyword,
        kind: "literal_content",
        limit: 25,
      })) as RustResponse;
      searched = true;
      const hits = (searchRes.result?.data as { hits?: unknown[] } | undefined)?.hits ?? [];
      for (const hit of hits as Array<{ relative_path?: unknown }>) {
        // The audit DB / build output match keyword searches but are never
        // useful read targets, so they must not rank in the plan.
        addCandidate(String(hit.relative_path ?? ""), `search:${keyword}`, 1);
      }
    } catch {
      /* a single search failure (policy/glob) must not fail the plan */
    }
    // Content search cannot find a file *named* after the task: the string
    // "git-provider" never occurs inside lib/git-provider.ts. A bounded
    // file-name search covers exactly that case.
    try {
      const nameHits = await searchNames(keyword);
      searched = true;
      for (const hit of nameHits) {
        addCandidate(String(hit.relative_path ?? ""), `name:${keyword}`, NAME_HIT_POINTS);
      }
    } catch {
      /* name search is a bonus signal: content hits still stand */
    }
  }

  // Fallback: the SQLite recent-files index keeps the plan useful on a cold
  // keyword match (a bare task description has no identifiers to search for).
  if (candidates.size < 2) {
    try {
      for (const recent of queryRecentFiles(12, false, WORKSPACE)) {
        if (!isPlannablePath(recent.relative_path)) continue;
        if (!candidates.has(recent.relative_path)) {
          candidates.set(recent.relative_path, {
            relative_path: recent.relative_path,
            reason: "recent_edit",
            size_bytes: recent.size,
          });
        }
      }
    } catch {
      /* index unavailable: plan works from hints/keywords only */
    }
  }

  const ranked = rankCandidates([...candidates.values()], keywords, task, maxFiles);

  const plan = buildReadPlan({ task, keywords, candidates: ranked, maxFiles, includeSearch, searched });
  const response: RustResponse = {
    status: "completed",
    result: {
      kind: "plan_read_batch",
      data: {
        task,
        keywords: plan.keywords,
        searched,
        candidates: plan.candidates,
        steps: plan.steps,
        estimated_ms: plan.estimated_ms,
        notes: plan.notes,
      },
    },
  };
  const elapsedMs = performance.now() - started;
  recordMetric("plan_read_batch", elapsedMs, true);
  return toolResult(buildEnvelope("plan_read_batch", response, { requestId, elapsedMs, cached: false }));
}

// ---------------------------------------------------------------------------
// P2.5: self-install — detect harnesses + install venira MCP config
// ---------------------------------------------------------------------------

async function runDetectHarnesses(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const detections = detectAllHarnesses();
  const response: RustResponse = {
    status: "completed",
    result: {
      kind: "harness_detect",
      data: {
        detected: detections.filter((d) => d.detected).map((d) => d.harness),
        harnesses: detections,
      },
    },
    truncated: false,
  };
  const elapsedMs = performance.now() - started;
  recordMetric("detect_harnesses", elapsedMs, true);
  return toolResult(buildEnvelope("detect_harnesses", response, { requestId, elapsedMs, cached: false }));
}

async function runInstallSelf(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();

  if (!envFlag("VENIRA_ALLOW_SELF_INSTALL", false)) {
    return toolResult(
      errorEnvelope(
        "install_self",
        new Error(
          "[feature_disabled] Self-install is disabled on this host (operator flag, not a per-call approval: no approval_id will be issued). Ask the user to run it manually, or the operator to set VENIRA_ALLOW_SELF_INSTALL=1. " +
            "Hint: this writes to another client's config file outside the workspace.",
        ),
        { requestId, elapsedMs: 0 },
      ),
      true,
    );
  }
  const harness = String(args.harness ?? "") as HarnessName;
  const valid: HarnessName[] = [
    "opencode",
    "claude_desktop",
    "cursor",
    "codex",
    "kimi",
    "deepseek",
    "antigravity",
  ];
  if (!valid.includes(harness)) {
    return toolResult(
      errorEnvelope(
        "install_self",
        new Error(
          `[invalid_request] harness must be one of: ${valid.join(", ")}. Got: ${harness || "(empty)"}`,
        ),
        { requestId, elapsedMs: 0 },
      ),
      true,
    );
  }
  const result: InstallResult = await installSelf({
    harness,
    workspace: typeof args.workspace === "string" ? args.workspace : undefined,
    dataDir: typeof args.data_dir === "string" ? args.data_dir : undefined,
    dryRun: args.dry_run !== false,
  });
  const response: RustResponse = {
    status: "completed",
    result: {
      kind: "install_self",
      data: result,
    },
    truncated: false,
  };
  const elapsedMs = performance.now() - started;
  recordMetric("install_self", elapsedMs, result.status !== "error");
  return toolResult(buildEnvelope("install_self", response, { requestId, elapsedMs, cached: false }));
}

export function registerProjectTools(server: McpServer): void {
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

  server.registerTool(
    "project_outline_symbol",
    {
      ...config(
        "Parse a source file and return its symbol outline (functions, classes, types, interfaces) with line numbers.",
        "Outline symbols",
        {
          use_when: "you need to see the structure / top-level symbols of a file before reading or refactoring it.",
          avoid_when: "you need every usage of a symbol (project_symbol_references) or a text-only diff (project_diff_files).",
          speed_profile: "fast; single-file regex scan, no external indexer.",
          output_kind: "outline_symbol: total_symbols, symbols[] {name, kind, line, signature}.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        language: z.string().optional(),
        include_functions: flag01.optional(),
        include_classes: flag01.optional(),
        max_symbols: z.number().int().min(1).max(500).optional(),
      },
    },
    (args) => runOutlineSymbol(args as Args),
  );

  server.registerTool(
    "project_diff_files",
    {
      ...config(
        "Unified (git-style) diff between two workspace files. Reports lines_added/lines_removed and the full hunk text.",
        "Diff files",
        {
          use_when: "comparing two versions of a file, or reviewing changes before/after an edit.",
          avoid_when: "the two files are in different languages or one is binary; large binaries are not supported.",
          speed_profile: "medium; LCS-based diff over the two full texts, bounded by max_lines.",
          output_kind: "diff_files: lines_added, lines_removed, unified_diff, truncated.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path_a: path_,
        relative_path_b: path_,
        context_lines: z.number().int().min(0).max(50).optional(),
        max_lines: z.number().int().min(10).max(10000).optional(),
      },
    },
    (args) => runDiffFiles(args as Args),
  );

  server.registerTool(
    "project_symbol_references",
    {
      ...config(
        "Find every occurrence of a named symbol. scope=file (fast, single file) or scope=workspace (uses content search).",
        "Symbol references",
        {
          use_when: "you need to know where a symbol is used before renaming/refactoring it.",
          avoid_when: "you only need its declaration (project_outline_symbol) or an arbitrary string (project_search).",
          speed_profile: "fast for scope=file; medium for scope=workspace (single search call).",
          output_kind: "symbol_references: count, references[] {relative_path, line_number, context}.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        symbol_name: z.string(),
        scope: z.enum(["file", "workspace"]).optional(),
        relative_path: path_.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        max_references: z.number().int().min(1).max(500).optional(),
      },
    },
    (args) => runSymbolReferences(args as Args),
  );

  server.registerTool(
    "project_selective_search",
    {
      ...config(
        "Smart multi-query search: combine several patterns with AND/OR/NOT + fuzzy scoring. Bounded to a file set you pass in.",
        "Selective search",
        {
          use_when: "you need to rank many files by how well they match several keywords at once (e.g. locating the right module among candidates).",
          avoid_when: "you need a single exact literal (project_search) or to inspect one file's content (project_read_file).",
          speed_profile: "medium; reads a bounded set of files (files_hint or a shallow listing) and scores each line.",
          output_kind: "selective_search: hits[] {relative_path, line_number, text, score, matched}, total_files, total_hits, truncated.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        queries: z.array(z.object({
          pattern: z.string(),
          must: flag01.optional(),
          weight: z.number().int().optional(),
        })).min(1),
        files_hint: z.array(z.string()).optional(),
        relative_path: path_.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    (args) => runSelectiveSearch(args as Args),
  );

  server.registerTool(
    "project_dependency_graph",
    {
      ...config(
        "Build a deterministic file/symbol dependency graph for TypeScript/JavaScript, Python, Rust, Go, Java and Kotlin (module declarations, pub mod, use crate::/super::, extern crate, go.mod module resolution, import (...) blocks, relative imports, require(), dynamic import(), extends/implements, cross-file symbol references). Renders as JSON, DOT or Mermaid.",
        "Dependency graph",
        {
          use_when:
            "you need the import graph, a module map to render, or the files/symbols a change can reach before refactoring.",
          avoid_when:
            "you only need usages of one symbol in one file (project_symbol_references) or a text search (project_search).",
          speed_profile:
            "medium; bounded walk (<=5000 files / 64 MB), parser-lite line scan, 5 s index cache invalidated on writes. No network.",
          output_kind:
            "dependency_graph: nodes[] {id, type, language, loc}, edges[] {from, to, type (import|extends|implements|references), confidence, line, via}, external[] {id, used_by}, unresolved[], stats, truncated; format=dot|mermaid returns data.graph.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        kind: z.enum(["files", "symbols", "both"]).optional().describe("files (imports), symbols (references/extends), or both (default files)."),
        format: z.enum(["json", "dot", "mermaid"]).optional().describe("Output format (default json). dot/mermaid return data.graph."),
        relative_path: path_.optional().describe("Limit the walk to this subtree (default: the workspace root)."),
        depth: z.number().int().min(1).max(10).optional().describe("Directory recursion cap (default 3, max 10)."),
        include_external: flag01.optional().describe("1 aggregates npm/pip/node package nodes in external[]. Default 0."),
        include_tests: flag01.optional().describe("1 includes test files/edges (default); 0 hides them."),
        languages: z.array(z.string().max(20)).max(6).optional().describe('Language filter, e.g. ["ts","py","rs","go","java","kotlin"] (default: all supported).'),
        max_nodes: z.number().int().min(1).max(2000).optional().describe("Max file nodes (default 500)."),
        max_edges: z.number().int().min(1).max(5000).optional().describe("Max edges (default 2000)."),
      },
    },
    (args) => runOne("dependency_graph", args as Args),
  );

  server.registerTool(
    "project_change_impact",
    {
      ...config(
        "Answer \"if I change these files/symbols, what depends on them?\" with a bounded reverse (or forward) closure: affected files, distance, path, reason and confidence, plus affected symbols and a separate test count.",
        "Change impact",
        {
          use_when:
            "before renaming/changing a function or file, to list the dependents you should read/test (direction=dependents), or the dependencies a module relies on.",
          avoid_when:
            "you need the whole graph (project_dependency_graph) or exact textual usages in one file (project_symbol_references).",
          speed_profile:
            "medium; reuses the dependency index (5 s cache, invalidated on writes), BFS bounded by depth. No network.",
          output_kind:
            "change_impact: seed {files, symbols}, affected[] {id, distance, path, reason, confidence, symbols?}, unresolved[], summary {affected_files, affected_symbols, max_distance, tests_affected}, truncated; format=mermaid returns data.graph.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        files: z.array(z.string().max(500)).max(32).optional().describe("Workspace paths you plan to edit."),
        symbols: z
          .array(
            z.union([
              z.string().max(200),
              z.object({
                name: z.string().max(200),
                file: z.string().max(500).optional(),
                relative_path: z.string().max(500).optional(),
              }),
            ]),
          )
          .max(32)
          .optional()
          .describe('Symbols you plan to rename/change; pass a name, or {name, file} when the name is ambiguous.'),
        direction: z.enum(["dependents", "dependencies", "both"]).optional().describe("Traversal direction (default dependents)."),
        depth: z.number().int().min(1).max(10).optional().describe("BFS hop cap (default 5)."),
        include_tests: flag01.optional().describe("1 includes test files (default) and counts them in tests_affected."),
        max_nodes: z.number().int().min(1).max(2000).optional().describe("Max affected files (default 300)."),
        format: z.enum(["json", "mermaid"]).optional().describe("Output format (default json)."),
      },
    },
    (args) => runOne("change_impact", args as Args),
  );

  // -------------------------------------------------------------------------
  // P2.5: Self-install (detect harnesses + install venira MCP config)
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_detect_harnesses",
    {
      ...config(
        "Detect which MCP-client harnesses (OpenCode/Claude/Cursor/Codex/Kimi/DeepSeek/Antigravity) have a config on this machine.",
        "Detect MCP harnesses",
        {
          use_when: "before installing venira, to know which client configs exist and can be updated.",
          avoid_when: "you already know the config path (skip straight to project_install_self).",
          speed_profile: "fast; filesystem checks, no writes.",
          output_kind: "harness_detect: detected[] (found harnesses), harnesses[] {harness, detected, config_path, format, note}.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {},
    },
    (args) => runDetectHarnesses(args as Args),
  );

  server.registerTool(
    "project_install_self",
    {
      ...config(
        "Add the venira MCP entry to a target client's config (OpenCode/Claude/Cursor/Codex/Kimi/DeepSeek/Antigravity). Atomic + backup.",
        "Self-install venira MCP",
        {
          use_when: "a user asks to 'install venira into <client>' — add the MCP server block to that client's config file.",
          avoid_when: "the config path is unknown (run project_detect_harnesses first), or the user wants a dry-run (set dry_run=1).",
          speed_profile: "fast; one atomic write per config. Always backs up the original to <file>.venira-bak.",
          output_kind: "install_self: {harness, config_path, status (installed|already_present|config_missing|error), needs_restart, error?}.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        harness: z.enum([
          "opencode",
          "claude_desktop",
          "cursor",
          "codex",
          "kimi",
          "deepseek",
          "antigravity",
        ]),
        workspace: z.string().optional().describe("VENIRA_WORKSPACE value to write (default: process.cwd())."),
        data_dir: z.string().optional().describe("VENIRA_DATA_DIR value to write (default: the per-user Venira data directory)."),
        dry_run: flag01.optional().describe("1 reports what would happen without writing; 0 performs the action."),
      },
    },
    (args) => runInstallSelf(args as Args),
  );

  // -------------------------------------------------------------------------
  // Diagnostics + read planning (deterministic, no model call)
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_explain_error",
    {
      ...config(
        "Diagnose a failure from its error text / log tail: known signatures (errno, TypeScript, Python, git, npm, GitHub, venira codes) → likely cause + ready-to-send next tool calls. Rule-based, offline, instant.",
        "Explain an error",
        {
          use_when:
            "a command, test, build or provider call failed and you want the fastest route to the fix (feed it the stderr tail or the CI log tail).",
          avoid_when:
            "you already know the cause and only need the file contents (use project_read_file, which also accepts ranges).",
          speed_profile: "pure local rules, < 1 ms; no network and no model call.",
          output_kind:
            "explain_error: matched, summary, error_line, language, diagnoses[] {rule_id, title, likely_cause, suggested_fix[], retry_hint?, next_actions[]}, next_actions[].",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        error_text: z
          .string()
          .max(32 * 1024)
          .optional()
          .describe("The error block (stderr, exception, compiler output). One of error_text/log_tail is required."),
        log_tail: z
          .string()
          .max(32 * 1024)
          .optional()
          .describe("Tail of the failing output (e.g. project_ci_logs / project_shell_status text)."),
        language: z
          .string()
          .max(40)
          .optional()
          .describe("Optional language hint (typescript|python|rust|go|...) when the text does not show a file extension."),
      },
    },
    (args) => runExplainError(args as Args),
  );

  server.registerTool(
    "project_plan_read_batch",
    {
      ...config(
        "Plan a read: extract keywords from the task, run bounded content + file-name searches (+recent files), rank candidate source files by hits, path/name match and prose weight (build output, DB/log artifacts excluded), and return a ready project_read_batch call with a calibrated estimate. Deterministic planner, no model call.",
        "Plan reads from a task",
        {
          use_when:
            "starting a task in an unfamiliar area and you do not know which files matter yet (one call instead of guess-read-repeat).",
          avoid_when:
            "you already know the exact files (call project_read_batch directly), or the task is a one-line lookup (project_search).",
          speed_profile: "1-3 bounded content searches (~20 ms each) + local ranking; no file contents are returned.",
          output_kind:
            "plan_read_batch: task, keywords[], searched, candidates[] {relative_path, reason, hits}, steps[] {tool, arguments, why}, estimated_ms, notes.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        task_description: z
          .string()
          .min(1)
          .max(2_000)
          .describe('What you are about to do, in one line, e.g. "add retry handling to the GitHub client".'),
        files_hint: z
          .array(z.string().max(300))
          .max(16)
          .optional()
          .describe("Files you already suspect (ranked first, no search needed for them)."),
        max_files: z.number().int().min(1).max(8).optional().describe("Max candidates to plan (default 6; batch accepts 8)."),
        include_search: flag01
          .optional()
          .describe("1 runs keyword searches (default); 0 plans only from files_hint/recent files."),
      },
    },
    (args) => runPlanReadBatch(args as Args),
  );

  // -------------------------------------------------------------------------
  // Checkpoints: snapshot + rollback without git
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_snapshot",
    {
      ...config(
        "Checkpoint/rollback for the workspace: create a labeled, scoped snapshot before multi-file or hard-to-reverse edits; keep its returned id. For rollback, preview with restore dry_run=1 (size-based preview only; it cannot detect same-size content changes), inspect newer user edits, then restore that exact id with verify=1 and delete_extra=0. Content-addressed and deduplicated.",
        "Workspace checkpoint",
        {
          use_when:
            "before multi-file, cross-file, refactor/rename or hard-to-reverse edits: create with a descriptive label, scope paths to the affected area, retain the exact returned id, and confirm required files were captured. For rollback, run restore dry_run=1 to preview path/size changes (same-size content differences are not detected); inspect files with newer user edits, then restore the exact id with verify=1 and delete_extra=0. Example: checkpoint → edit 3 files → tests fail → inspect scope → restore.",
          avoid_when: "a tiny, easily recreated single-file edit, generated build output, or a commit already provides the needed recovery point; do not restore over newer user changes without inspecting them.",
          speed_profile:
            "create walks/hashes the captured files (skips .git/node_modules/dist, symlinks, huge files); repeats only store new blobs. restore is atomic per file, concurrency 4, SHA-256 verified by default; dry_run previews path/size only, not same-size content changes.",
          output_kind:
            "snapshot_create: id, label, file_count, total_bytes, new_blob_bytes, skipped[], truncated; " +
            "snapshot_list: checkpoints[]; snapshot_restore: restored_count/restored[], deleted_count, skipped[]; snapshot_delete: deleted, bytes_freed.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        action: z.enum(["create", "list", "restore", "delete"]).default("create"),
        id: z.string().optional().describe("Checkpoint id (required for restore/delete; returned by create/list)."),
        label: z
          .string()
          .max(400)
          .optional()
          .describe("Human label for the checkpoint, e.g. \"before refactor auth\"."),
        paths: z
          .array(z.string())
          .max(64)
          .optional()
          .describe("Capture affected paths (default ['.'] only when scope is unclear); restore accepts a subset to filter files."),
        exclude: z.array(z.string()).max(64).optional().describe("Extra directory/file names to skip."),
        respect_default_excludes: flag01
          .optional()
          .describe("1 skips standard generated/cache directories (default); 0 disables those exclusions."),
        max_files: z.number().int().min(1).max(20000).optional(),
        max_total_bytes: z.number().int().min(1).max(512 * 1024 * 1024).optional(),
        dry_run: flag01.optional().describe("restore only: 1 previews path/size changes without writing (same-size content changes are not detected); inspect current user edits before applying."),
        verify: flag01.optional().describe("restore only: 1 verifies each blob before writing (default); 0 disables verification."),
        delete_extra: flag01
          .optional()
          .describe("restore only: 1 also deletes files inside captured dirs not in the checkpoint (capped at 500); default/0 keeps them. Use 1 only when deletion is explicitly intended."),
        limit: z.number().int().min(1).max(100).optional().describe("list only: max checkpoints to return (default 20)."),
        reason: reason_,
      },
    },
    (args) => runSnapshot(args as Args),
  );

  registerVcsTools(server, { runOne, runSecret });
}
