import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CoreHost, shellPolicySnapshot } from "../lib/corehost.js";
import { evaluateToolPolicy } from "../lib/tool-policy.js";
import { recordMetric, metricsSnapshot } from "../lib/metrics.js";
import {
  OUTPUT_MODE,
  batchEnvelope,
  buildEnvelope,
  errorEnvelope,
  newRequestId,
  parseToolError,
  stringify,
  toolResult,
} from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { VERSION } from "../lib/version.js";
import { executeJs } from "../lib/js-executor.js";
import { toHostPath, UNRESTRICTED, WORKSPACE } from "../lib/workspace.js";

const PERMISSION_MODE = process.env.VENIRA_PERMISSION_MODE ?? "allow_all";
// allow_all grants the "chat-terminal" scope when there is no Project (same as the native app).
// Set VENIRA_SESSION_ID so test/verify runs can trace their own audit rows.
export const SESSION_ID =
  process.env.VENIRA_SESSION_ID ?? `opencode-${process.pid}-${randomBytes(3).toString("hex")}`;

const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const MAX_CACHE_BYTES = envInt("VENIRA_READ_CACHE_BYTES", 64 * 1024 * 1024);
const MAX_CACHE_ENTRIES = 1024;
const LIST_CACHE_MS = envInt("VENIRA_LIST_CACHE_MS", 1500);
const SEARCH_CACHE_MS = envInt("VENIRA_SEARCH_CACHE_MS", 3000);
const RECENT_CACHE_MS = envInt("VENIRA_RECENT_CACHE_MS", 2000);
const MAX_BATCH_RESPONSE_BYTES = 2 * 1024 * 1024;
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
  if (capability) return Promise.resolve(capability);
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
type Args = Record<string, unknown>;

/** Convert path fields to absolute workspace paths; drop undefined values. */
function prepare(operation: string, args: Args): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value;
  }
  if (operation === "shell_run") {
    out.relative_cwd = toHostPath(out.relative_cwd as string | undefined);
  } else if (operation !== "shell_status" && operation !== "cancel") {
    out.relative_path = toHostPath(out.relative_path as string | undefined);
  }
  return out;
}

function timeoutFor(operation: string, args: Args): number {
  if (operation === "shell_status") {
    const wait = Number(args.wait_seconds ?? 0);
    return Math.min(30, Math.max(0, Number.isFinite(wait) ? wait : 0)) * 1000 + 15_000;
  }
  return 30_000;
}

/** shell_status/cancel are not queued: a long poll must never block other tools. */
const UNQUEUED = new Set(["shell_status", "cancel"]);

async function executeOnce(operation: string, args: Args): Promise<unknown> {
  const cap = await capabilityReady();
  const envelope = {
    contract_version: 1,
    request_id: newRequestId(),
    session_id: SESSION_ID,
    project_id: cap.projectId,
    capability_id: cap.id,
    operation: { name: operation, arguments: prepare(operation, args) },
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
// Read cache: validated by stat (mtime + size) so edited/deleted files drop out.
// list/search/recent use short TTLs and are wiped on any mutating op.
// ---------------------------------------------------------------------------
type CachedRead = {
  status: string;
  truncated: boolean;
  result: RustResponse["result"];
  hint?: string;
  mtimeMs: number;
  size: number;
  bytes: number;
};

type CachedTtl = { at: number; response: RustResponse; bytes: number };

type Execution = { response: RustResponse; cached: boolean };

const readCache = new Map<string, CachedRead>();
const infoCache = new Map<string, CachedRead>();
const listCache = new Map<string, CachedTtl>();
const searchCache = new Map<string, CachedTtl>();
const recentCache = new Map<string, CachedTtl>();

let readBytes = 0;
let infoBytes = 0;

const cacheStats = {
  read: { hits: 0, misses: 0 },
  info: { hits: 0, misses: 0 },
  list: { hits: 0, misses: 0 },
  search: { hits: 0, misses: 0 },
  recent: { hits: 0, misses: 0 },
};

function enforceLimits(): void {
  while (readBytes + infoBytes > MAX_CACHE_BYTES || readCache.size + infoCache.size > MAX_CACHE_ENTRIES) {
    const useRead = readCache.size >= infoCache.size;
    const map = useRead ? readCache : infoCache;
    const key = map.keys().next().value;
    if (key === undefined) break;
    const entry = map.get(key)!;
    map.delete(key);
    if (useRead) readBytes -= entry.bytes;
    else infoBytes -= entry.bytes;
  }
}

function touch(map: Map<string, CachedRead>, key: string, entry: CachedRead): void {
  map.delete(key);
  map.set(key, entry);
  enforceLimits();
}

async function statSignature(
  absolutePath: string,
): Promise<{ mtimeMs: number; size: number; isFile: boolean } | null> {
  try {
    const stat = await fs.stat(absolutePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
  } catch {
    return null;
  }
}

function cacheKey(absolutePath: string, args: Args): string {
  return `${absolutePath}\u0000${args.start_line ?? ""}\u0000${args.end_line ?? ""}\u0000${args.max_bytes ?? ""}`;
}

function fromReadEntry(entry: CachedRead): RustResponse {
  return {
    status: entry.status,
    truncated: entry.truncated,
    result: entry.result,
    ...(entry.hint ? { hint: entry.hint } : {}),
  };
}

async function readFileCached(args: Args): Promise<Execution> {
  const absolutePath = toHostPath(args.relative_path as string | undefined);
  const key = cacheKey(absolutePath, args);
  const entry = readCache.get(key);
  if (entry) {
    const signature = await statSignature(absolutePath);
    if (signature && signature.isFile && signature.mtimeMs === entry.mtimeMs && signature.size === entry.size) {
      touch(readCache, key, entry);
      cacheStats.read.hits += 1;
      return { response: fromReadEntry(entry), cached: true };
    }
    readCache.delete(key);
    readBytes -= entry.bytes;
  }

  cacheStats.read.misses += 1;
  let response: RustResponse;
  try {
    response = (await execute("read_file", args)) as RustResponse;
  } catch (error) {
    // The backend lumps "does not exist" and "locked" into io_error; stat again to return the right code.
    const signature = await statSignature(absolutePath);
    if (!signature) {
      throw new Error(
        `[not_found] Path does not exist: ${args.relative_path}. Hint: Check it with project_list_files; do not retry the same path.`,
      );
    }
    if (!signature.isFile) {
      throw new Error(
        `[invalid_request] Not a file: ${args.relative_path}. Hint: Use project_list_files for folders or project_get_file_info for metadata.`,
      );
    }
    throw error;
  }  const signature = await statSignature(absolutePath);
  if (signature && signature.isFile && typeof (response.result?.data as { text?: unknown })?.text === "string") {
    const bytes = stringify(response).length;
    if (bytes <= MAX_BATCH_RESPONSE_BYTES) {
      const cached: CachedRead = {
        status: response.status ?? "completed",
        truncated: response.truncated === true,
        result: response.result,
        hint: response.hint,
        mtimeMs: signature.mtimeMs,
        size: signature.size,
        bytes,
      };
      readCache.set(key, cached);
      readBytes += bytes;
      touch(readCache, key, cached);
    }
  }
  return { response, cached: false };
}

async function fileInfoCached(args: Args): Promise<Execution> {
  const absolutePath = toHostPath(args.relative_path as string | undefined);
  const key = absolutePath;
  const entry = infoCache.get(key);
  if (entry) {
    const signature = await statSignature(absolutePath);
    if (signature && signature.mtimeMs === entry.mtimeMs && signature.size === entry.size) {
      touch(infoCache, key, entry);
      cacheStats.info.hits += 1;
      return { response: fromReadEntry(entry), cached: true };
    }
    infoCache.delete(key);
    infoBytes -= entry.bytes;
  }

  const response = (await execute("get_file_info", args)) as RustResponse;
  cacheStats.info.misses += 1;
  const signature = await statSignature(absolutePath);
  if (signature && response.result) {
    const bytes = stringify(response).length;
    if (bytes <= MAX_BATCH_RESPONSE_BYTES) {
      const cached: CachedRead = {
        status: response.status ?? "completed",
        truncated: response.truncated === true,
        result: response.result,
        hint: response.hint,
        mtimeMs: signature.mtimeMs,
        size: signature.size,
        bytes,
      };
      infoCache.set(key, cached);
      infoBytes += bytes;
      touch(infoCache, key, cached);
    }
  }
  return { response, cached: false };
}

function stableKey(args: Args): string {
  return JSON.stringify(
    Object.keys(args)
      .sort()
      .map((key) => [key, args[key]]),
  );
}

function ttlLookup(
  map: Map<string, CachedTtl>,
  key: string,
  ttlMs: number,
  counter: { hits: number; misses: number },
): RustResponse | null {
  if (ttlMs <= 0) return null;
  const entry = map.get(key);
  if (!entry) {
    counter.misses += 1;
    return null;
  }
  if (Date.now() - entry.at > ttlMs) {
    map.delete(key);
    counter.misses += 1;
    return null;
  }
  map.delete(key);
  map.set(key, entry);
  counter.hits += 1;
  return entry.response;
}

function ttlStore(map: Map<string, CachedTtl>, key: string, response: RustResponse): void {
  const bytes = stringify(response).length;
  if (bytes > 1024 * 1024) return;
  map.set(key, { at: Date.now(), response, bytes });
  while (map.size > 64) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

async function listCached(args: Args): Promise<Execution> {
  const absolutePath = toHostPath(args.relative_path as string | undefined);
  const key = `${absolutePath}\u0000${args.depth ?? ""}\u0000${args.limit ?? ""}\u0000${args.include_ignored === true ? 1 : 0}`;
  const cached = ttlLookup(listCache, key, LIST_CACHE_MS, cacheStats.list);
  if (cached) return { response: cached, cached: true };
  const response = (await execute("list_files", args)) as RustResponse;
  ttlStore(listCache, key, response);
  return { response, cached: false };
}

async function searchCached(args: Args): Promise<Execution> {
  const prepared = prepare("search", args);
  const key = stableKey(prepared);
  const cached = ttlLookup(searchCache, key, SEARCH_CACHE_MS, cacheStats.search);
  if (cached) return { response: cached, cached: true };
  const response = (await execute("search", args)) as RustResponse;
  // Only cache COMPLETE results that have hits. 0-hit results are not cached,
  // to avoid returning a stale "no match" right after a file was written.
  const data = response.result?.data as { complete?: boolean; hits?: unknown[] } | undefined;
  if (data?.complete !== false && (data?.hits?.length ?? 0) > 0) {
    ttlStore(searchCache, key, response);
  }
  return { response, cached: false };
}

function invalidatePath(absolutePath: string): void {
  const prefix = `${absolutePath}\u0000`;
  for (const [key, entry] of readCache) {
    if (key.startsWith(prefix)) {
      readCache.delete(key);
      readBytes -= entry.bytes;
    }
  }
  const info = infoCache.get(absolutePath);
  if (info) {
    infoCache.delete(absolutePath);
    infoBytes -= info.bytes;
  }
}

function invalidateListCaches(): void {
  listCache.clear();
  searchCache.clear();
  recentCache.clear();
}

const MUTATING = new Set(["write_file", "edit_file", "delete_path", "create_directory"]);

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
  const _decision = evaluateToolPolicy(operation, args);
  if (_decision?.tier === "deny") throw new Error(`[command_denied] ${_decision.reason} (rule: ${_decision.tool})`);
  if (_decision?.tier === "ask") throw new Error(`[approval_required] ${_decision.reason}`);
  // Tool-level policy: deny → throw (non-retryable), ask → throw an
  // approval_required envelope.  When VENIRA_TOOL_POLICY_FILE is unset this
  // is a no-op and the shell policy in lib/corehost.ts still applies.
  const decision = evaluateToolPolicy(operation, args);
  if (decision) {
    if (decision.tier === "deny") {
      throw new Error(`[command_denied] ${decision.reason} (rule: ${decision.tool})`);
    }
    if (decision.tier === "ask") {
      // Registry of pending tool-level approvals stored in-process.  The
      // same token machinery reuses shell's approval flow when possible.
      throw new Error(`[approval_required] ${decision.reason}`);
    }
  }
  if (operation === "read_file") return readFileCached(args);
  if (operation === "get_file_info") return fileInfoCached(args);
  if (operation === "list_files") return listCached(args);
  if (operation === "search") return searchCached(args);

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
  }
  if (operation.startsWith("shell_") || operation === "cancel") {
    trackShell(operation, response.result?.data);
  }
  return { response, cached: false };
}

// ---------------------------------------------------------------------------
// Shell approval flow
// ---------------------------------------------------------------------------

const SHELL_ELICIT = ["1", "true", "on", "yes"].includes(
  (process.env.VENIRA_SHELL_ELICIT ?? "").toLowerCase(),
);
const ELICIT_TIMEOUT_MS = 5 * 60 * 1000;

type ShellApprovalData = {
  approval_token?: unknown;
  command?: unknown;
  rule?: unknown;
  reason?: unknown;
  mode?: unknown;
  expires_at?: unknown;
};

function approvalFailure(
  operation: string,
  data: ShellApprovalData,
  requestId: string,
  elapsedMs: number,
): ToolResult {
  const token = typeof data.approval_token === "string" ? data.approval_token : "";
  const reason = typeof data.reason === "string" ? data.reason : "This command requires approval.";
  const rule = typeof data.rule === "string" ? data.rule : "policy";
  const hint = token
    ? `Ask the user to confirm "${String(data.command ?? "").slice(0, 200)}". If they approve, retry project_shell_run with approval_token="${token}"; add approval_scope="session" to approve this command group until the token TTL ends.`
    : undefined;
  return toolResult(
    errorEnvelope(operation, new Error(`[approval_required] ${reason} (rule: ${rule})`), {
      requestId,
      elapsedMs,
      data,
      hint,
    }),
    true,
  );
}

/**
 * Optional MCP elicitation (`VENIRA_SHELL_ELICIT=1`). Clients that do not
 * advertise the `elicitation` capability are skipped, so the caller still gets
 * the `approval_required` envelope and a usable token.
 */
async function elicitShellApproval(
  server: McpServer,
  data: ShellApprovalData,
): Promise<{ approved: boolean; remember: boolean }> {
  const capabilities = server.server.getClientCapabilities() as
    | { elicitation?: unknown }
    | undefined;
  if (!capabilities?.elicitation) return { approved: false, remember: false };
  try {
    const result = await server.server.elicitInput(
      {
        message: `Run this shell command?\n\n${String(data.command ?? "").slice(0, 2000)}\n\nWhy approval is needed: ${String(data.reason ?? "policy")}`,
        requestedSchema: {
          type: "object" as const,
          properties: {
            approve: {
              type: "boolean" as const,
              title: "Run the command",
              description: "Approve this exact command once.",
              default: false,
            },
            remember: {
              type: "boolean" as const,
              title: "Remember for this session",
              description: "Approve the same command group (e.g. `git push`) until the approval TTL ends.",
              default: false,
            },
          },
          required: ["approve"],
        },
      },
      { timeout: ELICIT_TIMEOUT_MS },
    );
    if (result.action !== "accept") return { approved: false, remember: false };
    const content = (result.content ?? {}) as { approve?: unknown; remember?: unknown };
    return { approved: content.approve === true, remember: content.remember === true };
  } catch (error) {
    console.error(
      `[venira-coding] elicitation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { approved: false, remember: false };
  }
}

async function runShell(args: Args, server: McpServer): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  try {
    let { response, cached } = await executeCached("shell_run", args);
    let data = response.result?.data as ShellApprovalData | undefined;

    if (response.result?.kind === "shell_approval" && SHELL_ELICIT) {
      const verdict = await elicitShellApproval(server, data ?? {});
      if (verdict.approved) {
        const retry: Args = { ...args, approval_token: data?.approval_token };
        if (verdict.remember) retry.approval_scope = "session";
        ({ response } = await executeCached("shell_run", retry));
        data = response.result?.data as ShellApprovalData | undefined;
        cached = false;
      }
    }

    const elapsedMs = performance.now() - started;
    if (response.result?.kind === "shell_approval") {
      recordMetric("shell_run", elapsedMs, false);
      return approvalFailure("shell_run", data ?? {}, requestId, elapsedMs);
    }
    recordMetric("shell_run", elapsedMs, true);
    return toolResult(buildEnvelope("shell_run", response, { requestId, elapsedMs, cached }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("shell_run", elapsedMs, false);
    return toolResult(errorEnvelope("shell_run", error, { requestId, elapsedMs }), true);
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
    return toolResult(buildEnvelope(operation, result, { requestId, elapsedMs, cached }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric(operation, elapsedMs, false);
    return toolResult(errorEnvelope(operation, error, { requestId, elapsedMs }), true);
  }
}

async function runReadBatch(
  requests: { operation: string; arguments: Args }[],
  maxItemBytes: number,
): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const responses: unknown[] = [];
  let totalBytes = 0;
  let budgetExhausted = false;

  for (const request of requests) {
    if (budgetExhausted) {
      responses.push({
        ok: false,
        error: {
          code: "resource_limit",
          message: "Item not executed: batch response budget exhausted.",
          retryable: false,
        },
        hint: "Split the batch into smaller calls.",
      });
      continue;
    }

    const itemStarted = performance.now();
    try {
      const { response, cached } = await executeCached(request.operation, request.arguments as Args);
      const envelope = buildEnvelope(request.operation, response, {
        requestId: newRequestId(),
        elapsedMs: performance.now() - itemStarted,
        cached,
      });
      const size = stringify(envelope).length;
      if (size > maxItemBytes) {
        recordMetric(request.operation, performance.now() - itemStarted, false);
        responses.push({
          ok: false,
          error: {
            code: "resource_limit",
            message: `Item response exceeds max_response_bytes_per_item (${size} > ${maxItemBytes} bytes).`,
            retryable: false,
          },
          hint: "Request this item alone with a smaller max_bytes/limit or a narrower line range.",
        });
        continue;
      }
      if (totalBytes + size > MAX_BATCH_RESPONSE_BYTES) {
        budgetExhausted = true;
        recordMetric(request.operation, performance.now() - itemStarted, false);
        responses.push({
          ok: false,
          error: {
            code: "resource_limit",
            message: "Batch response size limit reached; this item was not included.",
            retryable: false,
          },
          hint: "Split the batch or request items individually.",
        });
        continue;
      }
      totalBytes += size;
      recordMetric(request.operation, performance.now() - itemStarted, true);
      responses.push({ ok: true, response: envelope });
    } catch (error) {
      recordMetric(request.operation, performance.now() - itemStarted, false);
      const failure = parseToolError(error);
      responses.push({
        ok: false,
        error: { code: failure.code, message: failure.message, retryable: failure.retryable },
        ...(failure.hint ? { hint: failure.hint } : {}),
      });
    }
  }

  const elapsedMs = performance.now() - started;
  recordMetric("read_batch", elapsedMs, true);
  return toolResult(
    batchEnvelope(requestId, responses, elapsedMs, {
      total_bytes_returned: totalBytes,
      max_response_bytes_per_item: maxItemBytes,
    }),
  );
}

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
// project_recent_files: bounded filesystem scan (no external backend).
// ---------------------------------------------------------------------------
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".venv",
  "__pycache__",
  ".cache",
  ".turbo",
  "coverage",
]);
const RECENT_MAX_DIRS = 300;
const RECENT_MAX_FILES = 4000;

type RecentEntry = { abs: string; rel: string; size: number; mtimeMs: number };

async function scanRecent(args: Args): Promise<{
  entries: RecentEntry[];
  scannedFiles: number;
  scannedDirs: number;
  truncated: boolean;
}> {
  const root = toHostPath(args.relative_path as string | undefined);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`[invalid_request] Not a directory: ${root}. Hint: Pass a folder path or omit relative_path.`);
  }
  const maxDepth = Math.max(1, Math.min(6, Number(args.depth ?? 2)));
  const maxFiles = Math.max(1, Math.min(100, Number(args.limit ?? 20)));
  const includeIgnored = args.include_ignored === true;

  const queue: { abs: string; depth: number }[] = [{ abs: root, depth: 0 }];
  const files: { abs: string; rel: string }[] = [];
  let scannedDirs = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (scannedDirs >= RECENT_MAX_DIRS || files.length >= RECENT_MAX_FILES) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    scannedDirs += 1;
    let entries;
    try {
      entries = await fs.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir.abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        if (!includeIgnored && IGNORED_DIRS.has(entry.name)) continue;
        if (dir.depth < maxDepth) queue.push({ abs, depth: dir.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(WORKSPACE, abs);
      files.push({
        abs,
        rel: rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : abs,
      });
      if (files.length >= RECENT_MAX_FILES) {
        truncated = true;
        break;
      }
    }
  }
  const found: RecentEntry[] = [];
  const chunkSize = 64;
  for (let index = 0; index < files.length; index += chunkSize) {
    const chunk = files.slice(index, index + chunkSize);
    const stats = await Promise.all(
      chunk.map(async (file) => {
        try {
          const stat = await fs.stat(file.abs);
          return { ...file, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    for (const item of stats) if (item) found.push(item);
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    entries: found.slice(0, maxFiles),
    scannedFiles: found.length,
    scannedDirs,
    truncated: truncated || found.length > maxFiles,
  };
}

async function runRecentFiles(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const root = toHostPath(args.relative_path as string | undefined);
  const key = `${root}\u0000${args.depth ?? 2}\u0000${args.limit ?? 20}\u0000${args.include_ignored === true ? 1 : 0}`;
  try {
    const cached = ttlLookup(recentCache, key, RECENT_CACHE_MS, cacheStats.recent);
    if (cached) {
      const elapsedMs = performance.now() - started;
      recordMetric("recent_files", elapsedMs, true);
      return toolResult(buildEnvelope("recent_files", cached, { requestId, elapsedMs, cached: true }));
    }

    const scan = await scanRecent(args);
    const editedRecently = [...new Set([...recentEdits].filter((abs) => abs.startsWith(root)))].slice(0, 20);
    const data = {
      relative_path: root,
      entries: scan.entries.map((entry) => ({
        relative_path: entry.rel,
        size_bytes: entry.size,
        modified_unix_seconds: Math.floor(entry.mtimeMs / 1000),
        modified_ago_seconds: Math.max(0, Math.floor((Date.now() - entry.mtimeMs) / 1000)),
      })),
      scanned_files: scan.scannedFiles,
      scanned_dirs: scan.scannedDirs,
      truncated: scan.truncated,
      ...(scan.truncated
        ? { hint: "Scan hit its limit; lower depth, raise limit, or pass a narrower relative_path." }
        : {}),
      ...(editedRecently.length > 0
        ? {
            session_edits: editedRecently.map((abs) => {
              const rel = path.relative(WORKSPACE, abs);
              return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : abs;
            }),
          }
        : {}),
    };
    const response: RustResponse = {
      status: "completed",
      result: { kind: "recent_files", data },
    };
    ttlStore(recentCache, key, response);
    const elapsedMs = performance.now() - started;
    recordMetric("recent_files", elapsedMs, true);
    return toolResult(buildEnvelope("recent_files", response, { requestId, elapsedMs }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("recent_files", elapsedMs, false);
    return toolResult(errorEnvelope("recent_files", error, { requestId, elapsedMs }), true);
  }
}

// Track files written/edited in this session so project_recent_files can add context.

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
    const result = (await execute("create_directory", { relative_path: args.relative_path, create_parents: args.create_dirs ?? true })) as RustResponse;
    recordMetric("create", performance.now() - started, true);
    return toolResult(buildEnvelope("create", result, { requestId, elapsedMs: performance.now() - started }));
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
  const result = (await execute("write_file", fileParams)) as RustResponse;
  recordMetric("create", performance.now() - started, true);
  return toolResult(buildEnvelope("create", result, { requestId, elapsedMs: performance.now() - started }));
}

// ---------------------------------------------------------------------------
// project_health
// ---------------------------------------------------------------------------
function dataDirFor(exe: string | null): string {
  if (process.env.VENIRA_DATA_DIR) return path.resolve(process.env.VENIRA_DATA_DIR);
  if (exe) return path.join(path.dirname(exe), "data");
  return path.join(WORKSPACE, "data");
}

async function auditHealth(dbPath: string): Promise<Record<string, unknown>> {
  let exists = false;
  let bytes = 0;
  try {
    const stat = await fs.stat(dbPath);
    exists = stat.isFile();
    bytes = stat.size;
  } catch {
    return { path: dbPath, exists: false, reachable: false };
  }
  if (!exists) return { path: dbPath, exists: false, reachable: false };

  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const total = db.prepare("SELECT count(*) AS n FROM project_tool_audit").get() as { n?: unknown };
      const orphan = db
        .prepare(
          "SELECT count(*) AS n FROM project_tool_audit WHERE outcome = 'running' AND completed_at IS NULL",
        )
        .get() as { n?: unknown };
      const mine = db
        .prepare("SELECT outcome, count(*) AS n FROM project_tool_audit WHERE session_id = ? GROUP BY outcome")
        .all(SESSION_ID) as { outcome?: string; n?: unknown }[];
      return {
        path: dbPath,
        exists: true,
        bytes,
        reachable: true,
        total_rows: Number(total?.n ?? 0),
        orphan_running: Number(orphan?.n ?? 0),
        session: Object.fromEntries(mine.map((row) => [row.outcome ?? "unknown", Number(row.n ?? 0)])),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      path: dbPath,
      exists: true,
      bytes,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function cacheReport() {
  const rate = (counter: { hits: number; misses: number }) => {
    const total = counter.hits + counter.misses;
    return total === 0 ? null : Math.round((counter.hits / total) * 1000) / 1000;
  };
  return {
    read: {
      entries: readCache.size,
      bytes: readBytes,
      ...cacheStats.read,
      hit_rate: rate(cacheStats.read),
    },
    info: {
      entries: infoCache.size,
      bytes: infoBytes,
      ...cacheStats.info,
      hit_rate: rate(cacheStats.info),
    },
    list: {
      entries: listCache.size,
      ttl_ms: LIST_CACHE_MS,
      ...cacheStats.list,
      hit_rate: rate(cacheStats.list),
    },
    search: {
      entries: searchCache.size,
      ttl_ms: SEARCH_CACHE_MS,
      ...cacheStats.search,
      hit_rate: rate(cacheStats.search),
    },
    recent: {
      entries: recentCache.size,
      ttl_ms: RECENT_CACHE_MS,
      ...cacheStats.recent,
      hit_rate: rate(cacheStats.recent),
    },
  };
}

async function runHealth(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const hostInfo = host.snapshot();
  const dataDir = dataDirFor(hostInfo.exe);
  const includeAudit = args.include_audit !== false;
  try {
    const dbPath = path.join(dataDir, "venira.db");
    const data = {
      server: {
        name: "venira-coding",
        version: VERSION,
        pid: process.pid,
        session_id: SESSION_ID,
        uptime_ms: Date.now() - STARTED_AT,
        workspace: WORKSPACE,
        unrestricted: UNRESTRICTED,
        permission_mode: PERMISSION_MODE,
        output_mode: OUTPUT_MODE,
        pretty: process.env.VENIRA_PRETTY === "1",
        node: process.version,
      },
      corehost: {
        ...hostInfo,
        exe: hostInfo.exe,
        data_dir: dataDir,
        audit_fast: (process.env.VENIRA_AUDIT_FAST ?? "1") !== "0",
      },
      capability: capability
        ? {
            state: "open",
            project_id: capability.projectId,
            opened_ago_ms: Date.now() - capability.openedAt,
          }
        : { state: opening ? "opening" : "closed" },
      queue: {
        depth: queueDepth,
        in_flight: inFlight,
        peak_depth: peakQueueDepth,
      },
      caches: cacheReport(),
      shells: {
        active: [...shellRuns.entries()]
          .filter(([, state]) => state.running)
          .map(([runId, state]) => ({ run_id: runId, exit_code: state.exit_code })),
        tracked: shellRuns.size,
        policy: shellPolicySnapshot(),
      },
      metrics: metricsSnapshot(),
      audit: includeAudit ? await auditHealth(dbPath) : { skipped: true },
    };
    const elapsedMs = performance.now() - started;
    recordMetric("health", elapsedMs, true);
    return toolResult(buildEnvelope("health", { status: "completed", result: { kind: "health", data } }, {
      requestId,
      elapsedMs,
    }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("health", elapsedMs, false);
    return toolResult(errorEnvelope("health", error, { requestId, elapsedMs }), true);
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------
const path_ = z.string().describe("Path inside the workspace (relative, or absolute inside the workspace)");
const editOp = z.object({
  old_text: z.string(),
  new_text: z.string(),
  replace_all: z.boolean().optional(),
});

type ToolMeta = {
  use_when: string;
  avoid_when: string;
  speed_profile: string;
  output_kind: string;
  batch_safe: boolean;
};

function config(
  base: string,
  title: string,
  meta: ToolMeta,
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  },
) {
  return {
    title,
    description:
      `${base}\nUse when: ${meta.use_when}\nAvoid when: ${meta.avoid_when}\n` +
      `Speed: ${meta.speed_profile}\nOutput: ${meta.output_kind}\n` +
      `Batch-safe: ${meta.batch_safe ? "yes" : "no"}`,
    annotations,
    _meta: { venira: meta },
  };
}

/**
 * `VENIRA_DISABLE_TOOLS="project_shell_run,project_delete_path"` keeps tools
 * out of `tools/list` entirely, so a client can never call them. This is a
 * deployment-level switch (env only), not something an agent can change.
 */
function applyDisabledTools(server: McpServer): void {
  const disabled = (process.env.VENIRA_DISABLE_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (disabled.length === 0) return;
  const blocked = new Set(disabled);
  const original = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
  server.registerTool = ((name: string, ...rest: unknown[]) =>
    blocked.has(name) ? undefined : original(name, ...rest)) as unknown as typeof server.registerTool;
  console.error(`[venira-coding] disabled tools: ${[...blocked].join(", ")}`);
}

async function runExecuteJs(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const code = typeof args.code === "string" ? args.code : "";
  const timeoutMs = typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
    ? Math.min(Math.floor(args.timeout_ms), 600_000)
    : 30_000;
  try {
    const cliArgs = Array.isArray(args.argv) ? (args.argv as string[]).map(String) : undefined;
    const r = executeJs(code, { timeout: timeoutMs, args: cliArgs });
    const response: RustResponse = {
      status: "completed",
      result: {
        kind: "js_execute",
        data: {
          ok: r.ok,
          stdout_tail: r.stdout_tail,
          stderr_tail: r.stderr_tail,
          exit_code: r.exit_code,
          timed_out: r.timed_out,
          ...(r.error ? { error: r.error } : {}),
        },
      },
      truncated: false,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("execute_js", elapsedMs, r.ok);
    return toolResult(buildEnvelope("execute_js", response, { requestId, elapsedMs, cached: false }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("execute_js", elapsedMs, false);
    return toolResult(errorEnvelope("execute_js", error, { requestId, elapsedMs }), true);
  }
}

export function registerProjectTools(server: McpServer): void {
  applyDisabledTools(server);
  server.registerTool(
    "project_list_files",
    {
      ...config(
        "List files/directories in the workspace. depth 1..3 shows the tree in a single call.",
        "List files",
        {
          use_when: "you need to see the directory tree, check a path, or list files before reading.",
          avoid_when: "you only need one file's metadata (project_get_file_info) or one file's contents (project_read_file).",
          speed_profile: "fast; TTL cache 1.5s, auto-wiped on write/edit/delete.",
          output_kind: "file_list: entries, truncated, hint.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_.optional(),
        include_ignored: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        depth: z.number().int().min(1).max(3).optional(),
      },
    },
    (args) => runOne("list_files", args),
  );

  server.registerTool(
    "project_read_file",
    {
      ...config(
        "Read a text file, optionally by line range (1-based). The result carries next_start_line when truncated.",
        "Read file",
        {
          use_when: "you need the contents of one file, or one line range of a large file.",
          avoid_when: "you need to read 2+ files (project_read_batch) or only need metadata (project_get_file_info).",
          speed_profile: "very fast on repeat; cache validated by mtime+size.",
          output_kind: "file_read: text, first_line, last_line, total_bytes, next_start_line.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        start_line: z.number().int().min(0).optional(),
        end_line: z.number().int().min(0).optional(),
        line_numbers: z.boolean().optional(),
        max_bytes: z.number().int().min(1).max(1048576).optional(),
      },
    },
    (args) => {
      const wantNumbers = Boolean((args as Args).line_numbers);
      return runOne("read_file", args, wantNumbers ? { line_numbers: true } : undefined);
    },
  );

  server.registerTool(
    "project_read_ranges",
    {
      ...config(
        "Read multiple disjoint line ranges of the SAME file in a single call (max 16 ranges).",
        "Read file ranges",
        {
          use_when: "you need several disjoint segments of one file (e.g. around search hits) without multiple round-trips.",
          avoid_when: "you need the whole file (project_read_file) or different files (project_read_batch).",
          speed_profile: "fast; reuses the per-range read_file cache.",
          output_kind: "file_read_ranges: ranges[] with text/truncated/next_start_line.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        ranges: z
          .array(
            z.object({
              start_line: z.number().int().min(1),
              end_line: z.number().int().min(1).optional(),
              max_bytes: z.number().int().min(1).optional(),
            }),
          )
          .min(1)
          .max(16),
      },
    },
    (args) => runReadRanges(args as Args),
  );

  server.registerTool(
    "project_get_file_info",
    {
      ...config(
        "File/directory metadata (kind, size, modification time).",
        "Get file info",
        {
          use_when: "you only need size/mtime/kind, or want to check that a path exists.",
          avoid_when: "you need the file's contents (project_read_file).",
          speed_profile: "very fast; cache validated by mtime+size.",
          output_kind: "file_info: relative_path, kind, size_bytes, modified_unix_seconds.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: { relative_path: path_ },
    },
    (args) => runOne("get_file_info", args),
  );

  server.registerTool(
    "project_search",
    {
      ...config(
        "Search by file name, directory name, content (literal or regex=true), or symbol declaration lines (definition).",
        "Search workspace",
        {
          use_when: "you need to find code/strings/symbols before reading; use kind=literal_content or definition.",
          avoid_when: "you already know the exact path to read.",
          speed_profile: "medium (file scan); TTL cache 3s for the same query.",
          output_kind: "search: hits, complete, diagnostics, hint.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        query: z.string(),
        kind: z.enum(["file_name", "directory_name", "literal_content", "definition"]),
        relative_path: path_.optional(),
        glob: z.string().optional(),
        exclude_glob: z.string().optional(),
        regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        whole_word: z.boolean().optional(),
        include_hidden: z.boolean().optional(),
        context_lines: z.number().int().min(0).max(20).optional(),
        count_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    (args) => runOne("search", args),
  );

  server.registerTool(
    "project_recent_files",
    {
      ...config(
        "List files modified most recently in the workspace (bounded filesystem scan, skips node_modules/target/.git).",
        "Recent files",
        {
          use_when: "you need to know which files just changed, or to pick the next file to read in this session.",
          avoid_when: "you need the full list / by name (project_list_files) or content search (project_search).",
          speed_profile: "medium (filesystem walk); TTL cache 2s, bounded to 4000 files / 300 directories.",
          output_kind: "recent_files: entries[] sorted by mtime desc, scanned_files, truncated.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        depth: z.number().int().min(1).max(6).optional(),
        include_ignored: z.boolean().optional(),
      },
    },
    (args) => runRecentFiles(args as Args),
  );

  server.registerTool(
    "project_read_batch",
    {
      ...config(
        "Run up to 8 READ-ONLY ops (list_files, read_file, get_file_info, search) in one call; read/info use the cache so repeats are very fast.",
        "Batch read",
        {
          use_when: "you need to read 2+ files/ops in the same step (reading context, scanning several files).",
          avoid_when: "there is only a single op; or you need a mutating op (use the corresponding tool).",
          speed_profile: "fastest for read-heavy work; sequential + cached, with a response budget.",
          output_kind: "read_batch: responses[] (each item is an ok/error envelope).",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        requests: z
          .array(
            z.object({
              operation: z.enum(["list_files", "read_file", "get_file_info", "search"]),
              arguments: z.record(z.string(), z.unknown()),
            }),
          )
          .min(1)
          .max(8),
        max_response_bytes_per_item: z.number().int().min(1024).max(2 * 1024 * 1024).optional(),
      },
    },
    ({ requests, max_response_bytes_per_item }) =>
      runReadBatch(requests, max_response_bytes_per_item ?? MAX_BATCH_ITEM_BYTES),
  );

  server.registerTool(
    "project_write_file",
    {
      ...config(
        "Write a file. mode=create errors if it exists; overwrite replaces; append concatenates to the end.",
        "Write file",
        {
          use_when: "create a new file or replace/append a file's contents.",
          avoid_when: "only a small section needs to change (project_edit_file) to leave the rest intact.",
          speed_profile: "fast; clears the read/list/search cache for the affected path.",
          output_kind: "file_written: action, bytes_written, sha256_after.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        content: z.string(),
        mode: z.enum(["create", "overwrite", "append"]).optional(),
        create_dirs: z.boolean().optional(),
        expected_sha256: z.string().optional(),
      },
    },
    (args) => runOne("write_file", args),
  );

  server.registerTool(
    "project_edit_file",
    {
      ...config(
        "Edit a file by exact text replacement: one old_text/new_text pair, or edits[] for multiple sections.",
        "Edit file",
        {
          use_when: "change one or a few text sections whose exact content you know; pair with expected_sha256 to guard against blind overwrites.",
          avoid_when: "the whole file must change (project_write_file), or you have not read the file to know old_text.",
          speed_profile: "fast; clears the read/list/search cache for the affected path.",
          output_kind: "file_written: replacements, sha256_before/after.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        old_text: z.string().optional(),
        new_text: z.string().optional(),
        replace_all: z.boolean().optional(),
        edits: z.array(editOp).max(64).optional(),
        expected_sha256: z.string().optional(),
      },
    },
    (args) => runOne("edit_file", args),
  );

  server.registerTool(
    "project_create_directory",
    {
      ...config("Create a directory (create_parents defaults to true).", "Create directory", {
        use_when: "a directory must exist before writing a file into a new path.",
        avoid_when: "the directory already exists, or you only need to write a file with create_dirs=true.",
        speed_profile: "fast; create_parents avoids a second call.",
        output_kind: "directory_created: relative_path.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
      inputSchema: {
        relative_path: path_,
        create_parents: z.boolean().optional(),
      },
    },
    (args) => runOne("create_directory", args),
  );

  server.registerTool(
    "project_delete_path",
    {
      ...config("Delete a file or directory (directories require recursive=true).", "Delete path", {
        use_when: "a file/directory must be deleted entirely; the path is confirmed.",
        avoid_when: "you only need to change the content (write/edit). This op is not undoable.",
        speed_profile: "fast; clears the read/list/search cache.",
        output_kind: "path_deleted: entries_deleted, bytes_deleted.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      inputSchema: {
        relative_path: path_,
        recursive: z.boolean().optional(),
      },
    },
    (args) => runOne("delete_path", args),
  );

  server.registerTool(
    "project_shell_run",
    {
      ...config(
        `Run a shell command (cwd defaults to ${WORKSPACE}). Returns run_id immediately; use project_shell_status to get the output. ` +
          "Commands pass a policy gate: risky ones return an approval_required error with a single-use approval_token; " +
          "catastrophic ones are denied outright.",
        "Shell run (async)",
        {
          use_when:
            "build/test/lint/long-running commands; returns run_id immediately so it never blocks other tools. " +
            "After approval_required, ask the user and retry with the approval_token from data.",
          avoid_when: "a very short command whose output you need right now (you can still run it and poll 0s).",
          speed_profile: "returns in ~5 ms; run time is up to the command (bounded by timeout_ms).",
          output_kind:
            "shell_run: run_id, running, exit_code, stdout_tail/stderr_tail, timed_out, policy; " +
            "approval_required: rule, reason, approval_token, retry_with.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        shell: z.enum(["powershell", "cmd", "bash"]).optional(),
        command: z.string().describe("Command line to execute."),
        relative_cwd: z.string().optional().describe("Working directory inside the workspace (default: workspace root)."),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Kill the whole process tree after this many milliseconds (0 = no timeout; capped by VENIRA_SHELL_MAX_TIMEOUT_MS)."),
        approval_token: z
          .string()
          .optional()
          .describe("Single-use token from a previous approval_required envelope. Never invent or reuse one."),
        approval_scope: z
          .enum(["once", "session"])
          .optional()
          .describe("With approval_token: `once` (default) runs this command only; `session` also approves the same command group for the token TTL."),
      },
    },
    (args) => runShell(args, server),
  );

  server.registerTool(
    "project_shell_status",
    {
      ...config(
        "Check status + output of a running command. wait_seconds (0..30) is an observation window, not a timeout.",
        "Shell status",
        {
          use_when: "after project_shell_run; poll until running=false.",
          avoid_when: "no run_id available yet.",
          speed_profile: "fast; not queued so it never blocks other tools.",
          output_kind: "shell_run: running, exit_code, stdout_tail/stderr_tail.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        run_id: z.string(),
        wait_seconds: z.number().int().min(0).max(30).optional(),
      },
    },
    (args) => runOne("shell_status", args),
  );

  server.registerTool(
    "project_shell_cancel",
    {
      ...config("Cancel a running shell command by run_id.", "Shell cancel", {
        use_when: "the command is running too long or its result is no longer needed.",
        avoid_when: "the command already finished (check with project_shell_status).",
        speed_profile: "fast; kills the whole process tree so grandchildren do not keep running.",
        output_kind: "cancellation: accepted, cleanup_complete.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      inputSchema: { run_id: z.string() },
    },
    (args) => runOne("cancel", args),
  );

  server.registerTool(
    "project_create",
    {
      ...config(
        "Create a directory OR a file in ONE call (merges project_create_directory + project_write_file for the new-file case).",
        "Create file or directory",
        {
          use_when: "create a directory (kind=directory) or a new file (kind=file, content+mode); kept in sync with the Venira native app tool.",
          avoid_when: "modifying an existing file (project_edit_file); overwriting a file whose contents must be preserved (project_write_file mode=overwrite still works).",
          speed_profile: "fast; triggers cache invalidation on write / new directory.",
          output_kind: "directory_created or file_written (data kind depends on the op).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        kind: z.enum(["file", "directory"]),
        content: z.string().optional(),
        mode: z.enum(["create", "overwrite", "append"]).optional(),
        create_dirs: z.boolean().optional(),
        expected_sha256: z.string().optional(),
      },
    },
    (args) => runCreate(args as Args),
  );

  server.registerTool(
    "project_health",
    {
      ...config(
        "Server diagnostics: corehost/data dir/audit DB, capability, queue depth, cache hit-rate, running shells, p50/p95 metrics.",
        "Health & metrics",
        {
          use_when: "debugging slowness/errors, checking the backend/DB/audit before reporting, or inspecting this session's cache/metrics.",
          avoid_when: "you just need to read/write files normally.",
          speed_profile: "fast (~a few ms + 1 audit DB query); set include_audit=false to skip the DB query.",
          output_kind: "health: server, corehost, capability, queue, caches, shells, metrics, audit.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: { include_audit: z.boolean().optional() },
    },
    (args) => runHealth(args as Args),

  );

  server.registerTool(
    "project_execute_js",
    {
      ...config(
        "Evaluate JavaScript code. Runs `node` in the workspace, capturing stdout/stderr; supports top-level await and `require`.",
        "Execute JS",
        {
          use_when: "you need to run a small JS snippet for computation, file I/O via fs, or prototyping.",
          avoid_when: "you need a full shell pipeline (project_shell_run) or a persistent process.",
          speed_profile: "synchronous node exec with timeout (default 30s, cap 10min); output capped at 1 MiB.",
          output_kind: "execute_js: stdout_tail, stderr_tail, exit_code, timed_out, ok.",
          batch_safe: false,
        },
        { destructiveHint: true, openWorldHint: false },
      ),
      inputSchema: {
        code: z.string().min(1),
        timeout_ms: z.number().int().min(1).max(600_000).optional(),
        argv: z.array(z.string()).optional(),
      },
    },
    (args) => runExecuteJs(args as Args),
  );
}

