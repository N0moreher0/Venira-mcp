import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { envChoice, envFlag, parseBackgroundFlag } from "../lib/env.js";
import { CoreHost, SHELL_MAX_TIMEOUT_MS, shellPolicySnapshot, SCOPE_TTL_MS } from "../lib/corehost.js";
import * as approvals from "../lib/approvals.js";
import {
  APPROVAL_PENDING_TTL_MS,
  APPROVAL_WAIT_MAX_MS,
  awaitApprovalGrant,
  buildApprovalPayload,
  parseApprovalWaitMs,
  redeemApproval,
  requestApproval,
} from "../lib/approval-gate.js";
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
import { redactSecrets } from "../lib/shell-policy.js";
import { queryRecentFiles } from "../lib/corehost.js";
import { snapshotHealth } from "../lib/snapshots.js";
import { githubHealth } from "../lib/git-provider.js";
import { secretsHealth } from "../lib/secrets.js";
import {
  toHostPath,
  UNRESTRICTED,
  WORKSPACE,
  CACHE_ALL_ENABLED,
  CACHE_LIST_ONLY_ENABLED,
  CACHE_SEARCH_ONLY_ENABLED,
  isProtectedPath,
  ALLOW_JS_EXEC,
  JS_EXEC_APPROVAL,
  activeDataDir,
} from "../lib/workspace.js";
import { addTrace, recentTraces, traceSnapshot } from "../lib/tracer.js";
import { invalidateDependencyGraphCache } from "../lib/dependency-graph.js";
import { clearShellCache, getShellCacheStats } from "../lib/shell-cache.js";
import { auditKeyPath, verifyAuditRows } from "../lib/audit-hash.js";
import { readHexKey } from "../lib/keyfile.js";
import {
  buildOutline,
  diffUnified,
  extractSymbols,
  selectiveSearch,
} from "../lib/symbol-diff.js";
import {
  detectAllHarnesses,
  installSelf,
  type HarnessName,
  type InstallResult,
} from "../lib/self-install.js";
import { explainErrorText } from "../lib/diagnostics.js";
import { resolveSecurityProfile, securityProfileIsExplicit } from "../lib/security-profile.js";
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
const NEGATIVE_CACHE_TTL_MS = envInt("VENIRA_NEGATIVE_CACHE_MS", 500);

/** Age of the oldest entry in the negative-read cache (ms), 0 when empty. */
function oldestNegativeAge(): number {
  const now = Date.now();
  let oldest = 0;
  for (const ts of negativeReadCache.values()) {
    const age = now - ts;
    if (age > oldest) oldest = age;
  }
  return oldest;
}
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
    // warm cache. Failures (missing files) are expected and swallowed.
    const candidates = ["README.md", "AGENTS.md", "CLAUDE.md", "package.json", ".env.example"];
    // Fire-and-forget: do not block server start on I/O warmup.
    void Promise.allSettled(
      candidates.map(async (name) => {
        try {
          await readFileCached({ relative_path: name } as Args);
        } catch {
          /* not_found expected; negative cache stores it */
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
type Args = Record<string, unknown>;

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
const referencesCache = new Map<string, CachedTtl>();
const recentCache = new Map<string, CachedTtl>();
const negativeReadCache = new Map<string, number>(); // Absolute path -> timestamp of not_found

let readBytes = 0;
let infoBytes = 0;

const cacheStats = {
  read: { hits: 0, misses: 0 },
  info: { hits: 0, misses: 0 },
  list: { hits: 0, misses: 0 },
  search: { hits: 0, misses: 0 },
  // symbol_references (workspace) uses a dedicated cache (keyed on the inner
  // search args) because the host reports complete=false when it stops at the
  // hit cap, and searchCache only stores complete results.
  references: { hits: 0, misses: 0 },
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
  // Negative cache: short-TTL suppress repeated backend calls for not_found paths.
  const negTs = negativeReadCache.get(key);
  if (negTs !== undefined) {
    const stat = await statSignature(absolutePath);
    if (!stat) {
      if (Date.now() - negTs <= NEGATIVE_CACHE_TTL_MS) {
        // MRU: refresh recency without displacing unrelated cache entries.
        negativeReadCache.delete(key);
        negativeReadCache.set(key, negTs);
        throw new Error(
          '[not_found] Path does not exist: ' + args.relative_path + '. Hint: Check it with project_list_files; do not retry the same path.',
        );
      }
      negativeReadCache.delete(key);
    } else {
      negativeReadCache.delete(key);
    }
  }
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
      while (negativeReadCache.size >= 256) {
       const oldest = negativeReadCache.keys().next().value;
       if (oldest === undefined) break;
       negativeReadCache.delete(oldest);
     }
     negativeReadCache.set(key, Date.now());
      throw new Error(
        '[not_found] Path does not exist: ' + args.relative_path + '. Hint: Check it with project_list_files; do not retry the same path.',
      );
    }
    if (!signature.isFile) {
      throw new Error(
        '[invalid_request] Not a file: ' + args.relative_path + '. Hint: Use project_list_files for folders or project_get_file_info for metadata.',
      );
    }
    throw error;
  }  const signature = await statSignature(absolutePath);
  const readData = response.result && typeof response.result === 'object' ? (response.result.data as Record<string, unknown> | null) : null;
  const readText = typeof readData?.text === 'string' ? (readData.text as string) : null;
  if (signature && signature.isFile && readText !== null) {
    // Surface content integrity + freshness metadata for Agents (TOCTOU guard). Hash computed once on first read, reused from cache.
    const sha256 = createHash('sha256').update(readText, 'utf8').digest('hex');
    if (readData) {
      readData.sha256 = sha256;
      readData.mtime_ms = signature.mtimeMs;
      readData.size_bytes = signature.size;
    }
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

// In-flight de-duplication protects concurrent callers (MCP batching) from
// triggering duplicate full-tree walks for the same query while one is running.
const inflightSearches = new Map<string, Promise<Execution>>();
async function searchCached(args: Args): Promise<Execution> {
  const prepared = prepare("search", args);
  const key = stableKey(prepared);
  const cached = ttlLookup(searchCache, key, SEARCH_CACHE_MS, cacheStats.search);
  if (cached) return { response: cached, cached: true };

  const inFlight = inflightSearches.get(key);
  if (inFlight) return await inFlight;

  const promise = (async () => {
    const response = (await execute("search", args)) as RustResponse;
    // Cache any COMPLETE result (including zero-hit).
    const data = response.result?.data as { complete?: boolean; hits?: unknown[] } | undefined;
    if (data?.complete !== false) {
      ttlStore(searchCache, key, response);
    }
    return { response, cached: false };
  })();
  inflightSearches.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightSearches.delete(key);
  }
}

function invalidatePath(absolutePath: string): void {
  const prefix = `${absolutePath}\u0000`;
  for (const [key, entry] of readCache) {
    if (key.startsWith(prefix)) {
      readCache.delete(key);
      readBytes -= entry.bytes;
    }
  }
  // Clear negative-cache entries keyed by the same path prefix.
  for (const key of negativeReadCache.keys()) {
    if (key.startsWith(prefix)) {
      negativeReadCache.delete(key);
    }
  }
  const info = infoCache.get(absolutePath);
  if (info) {
    infoCache.delete(absolutePath);
    infoBytes -= info.bytes;
  }
}

/** A restore can rewrite any file under the workspace: drop every cache. */
function invalidateAllCaches(): void {
  readCache.clear();
  infoCache.clear();
  negativeReadCache.clear();
  readBytes = 0;
  infoBytes = 0;
  invalidateListCaches();
}

function invalidateListCaches(): void {
  listCache.clear();
  searchCache.clear();
  referencesCache.clear();
  recentCache.clear();
}

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
      if (type === "all" || type === "read") {
        clearType("read", () => { const n = readCache.size; readCache.clear(); readBytes = 0; return n; });
      }
      if (type === "all" || type === "info") {
        clearType("info", () => { const n = infoCache.size; infoCache.clear(); infoBytes = 0; return n; });
      }
      if (type === "all" || type === "list") {
        clearType("list", () => { const n = listCache.size; listCache.clear(); return n; });
      }
      if (type === "all" || type === "search") {
        clearType("search", () => { const n = searchCache.size; searchCache.clear(); return n; });
      }
      if (type === "all" || type === "recent") {
        clearType("recent", () => { const n = recentCache.size; recentCache.clear(); return n; });
      }
      if (type === "all" || type === "negative") {
        clearType("negative", () => { const n = negativeReadCache.size; negativeReadCache.clear(); return n; });
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
// Shell approval flow
// ---------------------------------------------------------------------------

const SHELL_ELICIT = envFlag("VENIRA_SHELL_ELICIT", false);
const ELICIT_TIMEOUT_MS = 5 * 60 * 1000;

type ShellApprovalData = {
  approval_id?: unknown;
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
  const approvalId = typeof data.approval_id === "string" ? data.approval_id : "";
  const reason = typeof data.reason === "string" ? data.reason : "This command requires approval.";
  const rule = typeof data.rule === "string" ? data.rule : "policy";
  const hint = approvalId
    ? `Stop and tell the user: run \`npx venira-mcp --approve ${approvalId}\` in an interactive terminal. Do not loop. After they confirm, retry project_shell_run once with approval_id="${approvalId}".`
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
 * the `approval_required` envelope with an `approval_id` for the CLI flow.
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
        // The person accepted in their own client UI: record the grant on their
        // behalf, with the scope they chose (session only where it is allowed).
        const pendingId = typeof data?.approval_id === "string" ? data.approval_id : "";
        if (pendingId) {
          try {
            approvals.writeApprovalGrant(pendingId, "elicitation", verdict.remember ? "session" : "once");
          } catch {
            try {
              approvals.writeApprovalGrant(pendingId, "elicitation", "once");
            } catch (error) {
              console.error(`[venira-coding] could not record approval: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        const retry: Args = { ...args, approval_id: data?.approval_id };
        delete (retry as Record<string, unknown>).approval_token;
        delete (retry as Record<string, unknown>).approval_scope;
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

async function runEditBatch(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const items = Array.isArray(args.edits) ? (args.edits as Args[]) : [];
  const maxItemBytes = Number(args.max_response_bytes_per_item ?? 1_048_576);
  const responses: unknown[] = [];
  let totalBytes = 0;
  // Transactional: capture affected files before applying edits.
  const distinctPaths = [...new Set(items.map((i) => String(i?.relative_path ?? "")).filter(Boolean))];
  let snapshotId: string | undefined;
  if (distinctPaths.length > 0) {
    try {
      const snap = await executeCached("snapshot_create", { action: "create", paths: distinctPaths, label: "edit_batch", reason: "edit_batch" });
      snapshotId = String((snap.response?.result?.data as { id?: unknown } | undefined)?.id ?? "");
      if (!snapshotId) snapshotId = undefined;
    } catch {
      snapshotId = undefined;
    }
  }
  let failed = false;
  const executed: number[] = [];
  const skipped: number[] = [];
  let rollbackAttempted = false;
  let rollbackSucceeded = false;
  for (const item of items) {
    const itemStarted = performance.now();
    try {
      const { response, cached } = await executeCached("edit_file", item);
      const envelope = buildEnvelope("edit_file", response, { requestId: newRequestId(), elapsedMs: performance.now() - itemStarted, cached });
      const size = stringify(envelope).length;
      if (size > maxItemBytes) {
        recordMetric("edit_file", performance.now() - itemStarted, false);
        responses.push({ ok: false, error: { code: "resource_limit", message: "Item response exceeds item limit.", retryable: false } });
        continue;
      }
      if (totalBytes + size > MAX_BATCH_RESPONSE_BYTES) {
        recordMetric("edit_file", performance.now() - itemStarted, false);
        responses.push({ ok: false, error: { code: "resource_limit", message: "Batch budget exhausted.", retryable: false } });
        continue;
      }
      totalBytes += size;
      recordMetric("edit_file", performance.now() - itemStarted, true);
      responses.push({ ok: true, response: envelope });
      executed.push(responses.length - 1);
    } catch (error) {
      failed = true;
      recordMetric("edit_file", performance.now() - itemStarted, false);
      const failure = parseToolError(error);
      responses.push({ ok: false, error: { code: failure.code, message: failure.message, retryable: failure.retryable } });
      if (snapshotId) {
        rollbackAttempted = true;
        try {
          await executeCached("snapshot_restore", { action: "restore", id: snapshotId });
          rollbackSucceeded = true;
        } catch (restoreError) {
          console.error(`[venira-coding] edit_batch rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
      }
      for (let skippedIndex = responses.length; skippedIndex < items.length; skippedIndex += 1) {
        skipped.push(skippedIndex);
        responses.push({
          ok: false,
          error: {
            code: "batch_aborted",
            message: "Not executed because an earlier edit failed; the batch was rolled back when possible.",
            retryable: true,
          },
        });
      }
      break;
    }
  }
  const elapsedMs = performance.now() - started;
  recordMetric("edit_batch", elapsedMs, !failed || rollbackSucceeded);
  return toolResult(batchEnvelope(requestId, responses, elapsedMs, {
    total_bytes_returned: totalBytes,
    atomic: true,
    failed,
    executed,
    skipped,
    rollback_attempted: rollbackAttempted,
    rollback_succeeded: rollbackSucceeded,
    ...(snapshotId ? { snapshot_id: snapshotId } : {}),
  }));
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

    // P2: Try the SQLite index first (no bounded scan needed when the index is populated).
    const maxFiles = Math.max(1, Math.min(100, Number(args.limit ?? 20)));
    const indexHits = queryRecentFiles(maxFiles, args.include_ignored === true, root);
    if (indexHits.length > 0) {
      const data = {
        relative_path: root,
        source: "index" as const,
        entries: indexHits.map((hit) => ({
          relative_path: hit.relative_path,
          size_bytes: hit.size,
          modified_unix_seconds: Math.floor((hit.mtime_ms || hit.updated_at) / 1000),
          modified_ago_seconds: Math.max(0, Math.floor((Date.now() - (hit.mtime_ms || hit.updated_at)) / 1000)),
        })),
        scanned_files: indexHits.length,
        scanned_dirs: 0,
        truncated: false,
      };
      const response: RustResponse = { status: "completed", result: { kind: "recent_files", data } };
      ttlStore(recentCache, key, response);
      const elapsedMs = performance.now() - started;
      recordMetric("recent_files", elapsedMs, true);
      return toolResult(buildEnvelope("recent_files", response, { requestId, elapsedMs, cached: false }));
    }

    // Node-side fallback: bounded filesystem scan (no external backend).
    const scan = await scanRecent(args);
    const editedRecently = [...new Set([...recentEdits].filter((abs) => abs.startsWith(root)))].slice(0, 20);
    const data = {
      relative_path: root,
      source: "fallback_scan" as const,
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
// project_health
// ---------------------------------------------------------------------------
/** Approval config as the agent should see it, plus operator-facing warnings. */
function approvalsHealth(): { approvals: Record<string, unknown>; warnings: string[] } {
  const policy = shellPolicySnapshot().policy;
  const warnings: string[] = [];
  const securityProfile = resolveSecurityProfile();
  if (securityProfile === "off") {
    warnings.push("security_profile=off: shell checks and per-call JS approval are disabled. Use only in a trusted environment.");
  }
  if (policy.mode === "off") {
    warnings.push("shell_mode=off: ALL shell policy checks are bypassed, hard-deny included (secret_env still asks).");
  } else if (policy.mode === "permissive") {
    warnings.push("shell_mode=permissive: hard-deny commands ask instead of being refused; ask-rule commands run without approval.");
  }
  if (ALLOW_JS_EXEC && !JS_EXEC_APPROVAL) {
    warnings.push("project_execute_js is enabled without per-call approval (VENIRA_JS_EXEC_APPROVAL=0).");
  }
  if (/^(1|true|yes|on)$/i.test((process.env.VENIRA_SHELL_AUTO_APPROVE_TOKEN ?? "").trim())) {
    warnings.push("VENIRA_SHELL_AUTO_APPROVE_TOKEN is set but was removed in v1.15; it is ignored.");
  }
  return {
    approvals: {
      security_profile: securityProfile,
      security_profile_explicit: securityProfileIsExplicit(),
      shell_mode: policy.mode,
      policy_source: policy.source,
      js_exec_enabled: ALLOW_JS_EXEC,
      js_exec_approval: JS_EXEC_APPROVAL,
      elicitation: SHELL_ELICIT,
      session_grant_rules: approvals.sessionGrantRules(),
      pending_ttl_ms: APPROVAL_PENDING_TTL_MS,
      max_wait_ms: APPROVAL_WAIT_MAX_MS,
    },
    warnings,
  };
}

function dataDirFor(exe: string | null): string {
  // `exe` is always null in the standalone (pure-Node, no Rust binary) build — kept as a
  // parameter for call-site compatibility. Must match corehost.ts's ensureAuditDb(), which
  // resolves VENIRA_DATA_DIR else the per-user default (lib/workspace.ts#defaultDataDir);
  // falling back to WORKSPACE/data here would silently point at a DB nothing ever writes to.
  void exe;
  return activeDataDir();
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
      let loopFailures: Array<{ operation: string; reason_code: string; count: number }> = [];
      let adoptionRuns: Array<{ operation: string; count: number; duration_ms: number }> = [];
      try {
        const loopRows = db
          .prepare(
            `SELECT operation, COALESCE(reason_code, 'operation_failed') AS reason_code, COUNT(*) AS n
             FROM project_tool_audit
             WHERE outcome = 'failed'
               AND started_at >= ?
               AND args_hash IS NOT NULL
             GROUP BY operation, reason_code, args_hash
             HAVING COUNT(*) >= 2
             ORDER BY n DESC
             LIMIT 20`,
          )
          .all(Date.now() - 10 * 60 * 1000) as Array<{ operation?: string; reason_code?: string; n?: number }>;
        loopFailures = loopRows.map((row) => ({
            operation: row.operation ?? "unknown",
            reason_code: row.reason_code ?? "operation_failed",
            count: Number(row.n ?? 0),
          }));
      } catch {
        // Legacy databases without args_hash remain healthy; the migration may
        // not have completed yet in a concurrently opened health reader.
      }
      try {
        const adoptionRows = db
          .prepare(
            `SELECT id, session_id, operation, outcome, started_at, completed_at
             FROM project_tool_audit
             WHERE started_at >= ?
             ORDER BY id ASC`,
          )
          .all(Date.now() - 10 * 60 * 1000) as Array<{
          id: number;
          session_id: string;
          operation: string;
          outcome: string;
          started_at: number;
          completed_at?: number | null;
        }>;
        const eligible = new Set(["read_file", "edit_file"]);
        let current: { operation: string; session_id: string; count: number; started_at: number; ended_at: number } | null = null;
        const flush = () => {
          if (current && current.count >= 3) {
            adoptionRuns.push({
              operation: current.operation,
              count: current.count,
              duration_ms: Math.max(0, current.ended_at - current.started_at),
            });
          }
          current = null;
        };
        for (const row of adoptionRows) {
          const canJoin =
            row.outcome === "succeeded" &&
            eligible.has(row.operation) &&
            current !== null &&
            current.operation === row.operation &&
            current.session_id === row.session_id &&
            row.started_at - current.ended_at <= 60_000;
          if (canJoin && current) {
            current.count += 1;
            current.ended_at = row.completed_at ?? row.started_at;
          } else {
            flush();
            if (row.outcome === "succeeded" && eligible.has(row.operation)) {
              current = {
                operation: row.operation,
                session_id: row.session_id,
                count: 1,
                started_at: row.started_at,
                ended_at: row.completed_at ?? row.started_at,
              };
            }
          }
        }
        flush();
        adoptionRuns = adoptionRuns.sort((a, b) => b.count - a.count).slice(0, 20);
      } catch {
        // Legacy or concurrently migrated audit databases remain usable.
      }
      return {
        path: dbPath,
        exists: true,
        bytes,
        reachable: true,
        total_rows: Number(total?.n ?? 0),
        orphan_running: Number(orphan?.n ?? 0),
        session: Object.fromEntries(mine.map((row) => [row.outcome ?? "unknown", Number(row.n ?? 0)])),
        loop_failures: loopFailures,
        adoption_runs: adoptionRuns,
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
    negative: {
      entries: negativeReadCache.size,
      ttl_ms: NEGATIVE_CACHE_TTL_MS,
      oldest_age_ms: oldestNegativeAge(),
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
    references: {
      entries: referencesCache.size,
      ttl_ms: SEARCH_CACHE_MS,
      ...cacheStats.references,
      hit_rate: rate(cacheStats.references),
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
  // Refresh transparently so a long-lived process never reports an expired/stale scope.
  try {
    await capabilityReady();
  } catch {
    /* health still reports what it can (state "closed" below) */
  }
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
        pretty: envFlag("VENIRA_PRETTY", false),
        node: process.version,
      },
      corehost: {
        ...hostInfo,
        exe: hostInfo.exe,
        data_dir: dataDir,
        audit_fast: envFlag("VENIRA_AUDIT_FAST", true),
      },
      capability: capability
        ? {
            state: capabilityState(capability),
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
      ...approvalsHealth(),
      // Checkpoints: manifest-level only (no blob walk, so health stays fast).
      snapshots: await snapshotHealth().catch(() => ({ store: "", checkpoints: 0, logical_bytes: 0 })),
      // Secrets: counts + encryption only; the store path is reported, never values.
      secrets: secretsHealth(),
      // GitHub/CI: repo detection, api base, auth presence (never the token).
      network: {
        enabled: envFlag("VENIRA_NETWORK", true),
        github: githubHealth(),
      },
      metrics: metricsSnapshot(),
      // P1: config + observability surfaces
      cache: {
        all_enabled: CACHE_ALL_ENABLED,
        list_enabled: CACHE_LIST_ONLY_ENABLED,
        search_enabled: CACHE_SEARCH_ONLY_ENABLED,
      },
      trace: traceSnapshot(),
      shell: {
        tail_max: Number(process.env.VENIRA_SHELL_TAIL_MAX ?? 4096),
        exit_early: envFlag("VENIRA_SHELL_EXIT_EARLY", false),
        timeout_policy: envChoice("VENIRA_SHELL_TIMEOUT_POLICY", "soft", ["soft", "hard"]),
      },
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
const flag01 = z.number().int().min(0).max(1).transform((value) => value === 1).describe("Numeric flag: 1=enabled, 0=disabled.");
/** `background` accepts 0/1, booleans and strings so `false`/`"False"` works. */
const backgroundFlag = z
  .union([z.number().int().min(0).max(1), z.boolean(), z.string().max(20)])
  .transform((value) => parseBackgroundFlag(value))
  .describe(
    "1/true = background (default): return immediately with run_id. " +
      "0/false = foreground: block until the command exits, then return the final stdout/stderr in this call.",
  );
const reason_ = z
  .string()
  .max(400)
  .optional()
  .describe(
    "Why this change is made (e.g. \"sua loi null pointer o dong 45\"). Recorded in the audit trail so later sessions know the intent. Single line, max 400 chars, secrets are redacted.",
  );
const editOp = z.object({
  old_text: z.string().min(1),
  new_text: z.string(),
  replace_all: flag01.optional(),
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

const JS_EXEC_RULE = "ask.js_exec";

/**
 * The whole call is the approval scope: the script plus its argv. Hashing both
 * (instead of trusting a stored copy) means a grant cannot be replayed for a
 * different snippet or different `process.argv` values.
 */
function jsExecBinding(code: string, argv: string[] | undefined): string {
  return approvals.bindingHash({
    command: `${code}\u0000${JSON.stringify(argv ?? [])}`,
    shell: "node",
    cwd: WORKSPACE,
    secret_env: [],
    rule: JS_EXEC_RULE,
  });
}

async function runExecuteJs(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  if (!ALLOW_JS_EXEC) {
    const elapsedMs = performance.now() - started;
    return toolResult(
      errorEnvelope("execute_js", new Error("[unsupported] project_execute_js is disabled. Set VENIRA_ALLOW_JS_EXEC=1 to enable."), { requestId, elapsedMs }),
      true,
    );
  }
  const code = typeof args.code === "string" ? args.code : "";
  const timeoutMs = typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
    ? Math.min(Math.floor(args.timeout_ms), 600_000)
    : 30_000;
  const cliArgs = Array.isArray(args.argv) ? (args.argv as string[]).map(String) : undefined;

  // Per-call human approval. Enabling the tool only says the operator accepts
  // the risk in general; it does not say they have read this snippet, which can
  // still read protected files and (best-effort) reach the network.
  if (JS_EXEC_APPROVAL) {
    const binding = jsExecBinding(code, cliArgs);
    const approvalId = typeof args.approval_id === "string" ? args.approval_id.trim() : "";
    if (!approvalId) {
      const reason =
        "project_execute_js runs arbitrary JavaScript outside shell policy and the protected-path guard.";
      const pending = requestApproval("js", SESSION_ID, {
        tool: "project_execute_js",
        // The approver must see exactly what they are approving, so the code is
        // stored as written (the data dir is per-user, 0700). Redaction belongs
        // in the tool response/transcript, not in the human's review copy.
        command: code.slice(0, 8000),
        shell: "node",
        cwd: WORKSPACE,
        secretEnv: [],
        rule: JS_EXEC_RULE,
        reason,
        binding,
      });
      const pendingId = pending.approval_id;
      const waitMs = parseApprovalWaitMs(args.approval_wait_ms);
      if (waitMs > 0 && (await awaitApprovalGrant(SESSION_ID, pendingId, binding, waitMs))) {
        // Granted by a human while waiting: redeem through the normal path (single use).
        return runExecuteJs({ ...args, approval_id: pendingId, approval_wait_ms: 0 });
      }
      const expiresAt = pending.expires_at;
      const elapsedMs = performance.now() - started;
      return toolResult(
        errorEnvelope("execute_js", new Error(`[approval_required] ${reason} (rule: ${JS_EXEC_RULE})`), {
          requestId,
          elapsedMs,
          data: {
            approval_required: true,
            approval_id: pendingId,
            rule: JS_EXEC_RULE,
            reason,
            cwd: WORKSPACE,
            code_preview: redactSecrets(code).slice(0, 2000),
            ...(cliArgs ? { argv: cliArgs } : {}),
            approval: buildApprovalPayload(
              "js",
              pending,
              { tool: "project_execute_js", rule: JS_EXEC_RULE, reason },
              redactSecrets(code),
              {
                code,
                ...(cliArgs ? { argv: cliArgs } : {}),
                ...(typeof args.timeout_ms === "number" ? { timeout_ms: args.timeout_ms } : {}),
              },
            ),
            expires_at: expiresAt,
            retry_with: {
              tool: "project_execute_js",
              arguments: {
                code,
                ...(cliArgs ? { argv: cliArgs } : {}),
                ...(typeof args.timeout_ms === "number" ? { timeout_ms: args.timeout_ms } : {}),
                approval_id: pendingId,
              },
            },
            note: `A human must run: npx venira-mcp --approve ${pendingId} (then retry with approval_id).`,
          },
          hint: `Ask the user to run \`npx venira-mcp --approve ${pendingId}\` in an interactive terminal, then retry project_execute_js with approval_id="${pendingId}".`,
        }),
        true,
      );
    }
    const verdict = redeemApproval("js", SESSION_ID, approvalId, binding, "project_execute_js");
    if (!verdict.ok) {
      const elapsedMs = performance.now() - started;
      return toolResult(
        errorEnvelope("execute_js", new Error(`[approval_invalid] Approval ${approvalId} ${verdict.reason}. Hint: ${verdict.hint}`), {
          requestId,
          elapsedMs,
        }),
        true,
      );
    }
  }

  try {
    const r = executeJs(code, { cwd: WORKSPACE, timeout: timeoutMs, args: cliArgs });
    const response: RustResponse = {
      status: "completed",
      result: {
        kind: "js_execute",
        data: {
          ok: r.ok,
          // execute_js is not covered by the protected-path guard, so at least
          // keep obvious secret assignments out of the transcript.
          stdout_tail: redactSecrets(r.stdout_tail),
          stderr_tail: redactSecrets(r.stderr_tail),
          exit_code: r.exit_code,
          timed_out: r.timed_out,
          ...(r.error ? { error: redactSecrets(r.error) } : {}),
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

async function runReadAudit(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const limit = Math.max(1, Math.min(200, Number(args.limit ?? 50)));
  const dbPath = path.join(dataDirFor(host.snapshot().exe), "venira.db");
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const where: string[] = [];
    const values: unknown[] = [];
    if (typeof args.session_id === "string") { where.push("session_id = ?"); values.push(args.session_id); }
    if (typeof args.operation === "string") { where.push("operation = ?"); values.push(args.operation); }
    if (typeof args.outcome === "string") { where.push("outcome = ?"); values.push(args.outcome); }
    if (typeof args.since_unix === "number") { where.push("started_at >= ?"); values.push(Math.floor(args.since_unix * 1000)); }
    // `reason` is a newer additive column: probe first so an older DB file
    // (written before the migration) still returns rows instead of erroring.
    const columns = new Set(
      (db.prepare("PRAGMA table_info(project_tool_audit)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const reasonColumn = columns.has("reason") ? ", reason" : "";
    const sql =
      `SELECT session_id, operation, outcome, reason_code, request_id, started_at, completed_at, elapsed_ms${reasonColumn} ` +
      `FROM project_tool_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY started_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...values, limit + 1) as unknown[];
    const truncated = rows.length > limit;
    let verified: boolean | null = null;
    let verifyDetail: Record<string, unknown> | undefined;
    if (args.verify === true && columns.has("row_hash")) {
      try {
        // Recompute the digest, not just the links: a link-only check passes
        // even when a row's operation/reason was edited in place.
        const fields = ["session_id", "project_id", "operation", "request_id", "started_at", "prev_hash", "row_hash"];
        if (columns.has("reason")) fields.push("reason");
        if (columns.has("args_hash")) fields.push("args_hash");
        const all = db
          .prepare(`SELECT ${fields.join(", ")} FROM project_tool_audit ORDER BY id ASC`)
          .all() as Array<Record<string, unknown>>;
        let key: Buffer | null = null;
        try {
          key = readHexKey(auditKeyPath(path.dirname(dbPath)), "audit");
        } catch {
          key = null; // keyed rows cannot be verified without the key; reported below
        }
        const window = all.length > 50_000 ? all.slice(-50_000) : all;
        const result = verifyAuditRows(
          window.map((r) => ({
            session_id: String(r.session_id ?? ""),
            project_id: String(r.project_id ?? ""),
            operation: String(r.operation ?? ""),
            request_id: (r.request_id as string | null | undefined) ?? null,
            started_at: Number(r.started_at ?? 0),
            reason: (r.reason as string | null | undefined) ?? null,
            args_hash: (r.args_hash as string | null | undefined) ?? null,
            prev_hash: (r.prev_hash as string | null | undefined) ?? null,
            row_hash: (r.row_hash as string | null | undefined) ?? null,
          })),
          key,
        );
        verified = result.ok;
        verifyDetail = { ...result, total_rows: all.length, checked_rows: window.length, keyed: Boolean(key) };
      } catch (error) {
        verified = false;
        verifyDetail = { ok: false, reason: "verify_failed", error: error instanceof Error ? error.message : String(error) };
      }
    }
    db.close();
    const data = {
      db_path: dbPath,
      count: truncated ? limit : rows.length,
      truncated,
      ...(verified !== null ? { verified } : {}),
      ...(verifyDetail ? { verify_detail: verifyDetail } : {}),
      rows: rows.slice(0, limit).map((r) => {
        const row = r as Record<string, unknown>;
        return {
          session_id: row.session_id,
          operation: row.operation,
          outcome: row.outcome,
          ...(row.reason_code ? { reason_code: row.reason_code } : {}),
          ...(typeof row.reason === "string" && row.reason ? { reason: row.reason } : {}),
          request_id: row.request_id,
          started_at: typeof row.started_at === "number" ? Math.floor(row.started_at / 1000) : row.started_at,
          ...(row.completed_at != null ? { completed_at: Math.floor((row.completed_at as number) / 1000) } : {}),
          ...(row.elapsed_ms != null ? { elapsed_ms: row.elapsed_ms } : {}),
        };
      }),
    };
    const response: RustResponse = {
      status: "completed",
      result: { kind: "audit_read", data },
      truncated,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("read_audit", elapsedMs, true);
    return toolResult(buildEnvelope("read_audit", response, { requestId, elapsedMs, cached: false }));
  } catch (error) {
    // WAL locked or DB missing: report audit_unavailable (non-retryable), do not crash.
    const msg = error instanceof Error ? error.message : String(error);
    const elapsedMs = performance.now() - started;
    recordMetric("read_audit", elapsedMs, false);
    return toolResult(
      errorEnvelope("read_audit", new Error(`[audit_unavailable] ${msg}`), { requestId, elapsedMs }),
      true,
    );
  }
}

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

async function runCancelShellSession(): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  try {
    // Reuse the session-level cancel exposed by the corehost.
    const result = (await host.call(
      "project_tool.shell.cancel_session",
      { session_id: SESSION_ID },
      5_000,
    )) as { cancelled?: unknown } | undefined;
    const response: RustResponse = {
      status: "completed",
      result: {
        kind: "shell_cancel_session",
        data: {
          cancelled: result?.cancelled === true,
          session_id: SESSION_ID,
        },
      },
      truncated: false,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("shell_cancel_session", elapsedMs, true);
    return toolResult(buildEnvelope("shell_cancel_session", response, { requestId, elapsedMs, cached: false }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("shell_cancel_session", elapsedMs, false);
    return toolResult(errorEnvelope("shell_cancel_session", error, { requestId, elapsedMs }), true);
  }
}

// ---------------------------------------------------------------------------
// P2/P3: code intelligence + workflow tools
// ---------------------------------------------------------------------------

/** Read a workspace file's text, respecting max bytes; null when missing or protected. */
async function readTextFile(relPath: string): Promise<string | null> {
  try {
    const abs = toHostPath(relPath);
    // Every code-intelligence reader funnels through here, so this is the one
    // place that must refuse secret stores (callers used to forget the check).
    if (isProtectedPath(abs)) return null;
    const text = await fs.readFile(abs, "utf8");
    return text;
  } catch {
    return null;
  }
}

async function runOutlineSymbol(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const rel = String(args.relative_path ?? "");
  if (isProtectedPath(toHostPath(rel))) {
    const elapsedMs = performance.now() - started;
    return toolResult(errorEnvelope("outline_symbol", new Error(`[sensitive_result] Path is protected by policy: ${rel}.`), { requestId, elapsedMs }), true);
  }
  const text = await readTextFile(rel);
  if (text === null) {
    const elapsedMs = performance.now() - started;
    return toolResult(
      errorEnvelope("outline_symbol", new Error(`[not_found] No such file: ${rel}. Hint: use project_list_files to locate it.`), { requestId, elapsedMs }),
      true,
    );
  }
  const includeFunctions = args.include_functions !== false;
  const includeClasses = args.include_classes !== false;
  const symbols = extractSymbols(text, typeof args.language === "string" ? args.language : undefined, includeFunctions, includeClasses);
  const outline = buildOutline(text);
  const response: RustResponse = {
    status: "completed",
    result: {
      kind: "outline_symbol",
      data: {
        relative_path: toHostPath(rel),
        total_symbols: outline.total_symbols,
        symbols: symbols.slice(0, Number(args.max_symbols ?? 200)),
      },
    },
    truncated: false,
  };
  const elapsedMs = performance.now() - started;
  recordMetric("outline_symbol", elapsedMs, true);
  return toolResult(buildEnvelope("outline_symbol", response, { requestId, elapsedMs, cached: false }));
}

async function runFileSymbols(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const rel = String(args.relative_path ?? "");
  if (isProtectedPath(toHostPath(rel))) {
    const elapsedMs = performance.now() - started;
    return toolResult(errorEnvelope("file_symbols", new Error(`[sensitive_result] Path is protected by policy: ${rel}.`), { requestId, elapsedMs }), true);
  }
  const text = await readTextFile(rel);
  if (text === null) {
    const elapsedMs = performance.now() - started;
    return toolResult(
      errorEnvelope("file_symbols", new Error(`[not_found] No such file: ${rel}. Hint: use project_list_files to locate it.`), { requestId, elapsedMs }),
      true,
    );
  }
  const includeFunctions = args.include_functions !== false;
  const includeClasses = args.include_classes !== false;
  const symbols = extractSymbols(text, typeof args.language === "string" ? args.language : undefined, includeFunctions, includeClasses);
  const response: RustResponse = {
    status: "completed",
    result: {
      kind: "file_symbols",
      data: {
        relative_path: toHostPath(rel),
        language: typeof args.language === "string" ? args.language : null,
        count: symbols.length,
        symbols,
      },
    },
    truncated: false,
  };
  const elapsedMs = performance.now() - started;
  recordMetric("file_symbols", elapsedMs, true);
  return toolResult(buildEnvelope("file_symbols", response, { requestId, elapsedMs, cached: false }));
}

async function runDiffFiles(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const relA = String(args.relative_path_a ?? "");
  const relB = String(args.relative_path_b ?? "");
  if (isProtectedPath(toHostPath(relA)) || isProtectedPath(toHostPath(relB))) {
    const elapsedMs = performance.now() - started;
    return toolResult(errorEnvelope("diff_files", new Error(`[sensitive_result] Path is protected by policy.`), { requestId, elapsedMs }), true);
  }
  const [a, b] = await Promise.all([readTextFile(relA), readTextFile(relB)]);
  if (a === null || b === null) {
    const missing = a === null ? relA : relB;
    const elapsedMs = performance.now() - started;
    return toolResult(
      errorEnvelope("diff_files", new Error(`[not_found] Cannot diff: missing ${missing}.`), { requestId, elapsedMs }),
      true,
    );
  }
  const contextLines = Number(args.context_lines ?? 3);
  const maxLines = Number(args.max_lines ?? 500);
  const diff = diffUnified(a, b, contextLines, maxLines);
  const response: RustResponse = {
    status: "completed",
    result: {
      kind: "diff_files",
      data: {
        relative_path_a: toHostPath(relA),
        relative_path_b: toHostPath(relB),
        lines_added: diff.lines_added,
        lines_removed: diff.lines_removed,
        unified_diff: diff.unified_diff,
        truncated: diff.truncated,
      },
    },
    truncated: diff.truncated,
  };
  const elapsedMs = performance.now() - started;
  recordMetric("diff_files", elapsedMs, true);
  return toolResult(buildEnvelope("diff_files", response, { requestId, elapsedMs, cached: false }));
}

// ---------------------------------------------------------------------------
// project_search hybrid mode (opt-in, `hybrid: 1`). One backend walk feeds the
// enrichment — a second ripgrep pass would share the same backend and double
// the work for no extra information. Every hit is tagged with `source`
// (symbol_index definition > symbol_reference whole-word > plain content) and
// `confidence`. A scoped, identifier-like query that returns nothing widens
// once to the workspace and flags `scope_widened: true` so the agent knows the
// scope changed underneath it.
// ---------------------------------------------------------------------------
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type HybridHit = Record<string, unknown> & {
  relative_path?: unknown;
  line_number?: unknown;
  snippet?: unknown;
  source: string;
  confidence: "exact_match" | "text_match";
};

async function runHybridSearch(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const query = String(args.query ?? "");
  const queryTrimmed = query.trim();
  const identifier = IDENTIFIER_RE.test(queryTrimmed) ? queryTrimmed : null;
  const scoped = typeof args.relative_path === "string" && args.relative_path.trim() !== "";
  const requestedLimit = Number.isFinite(Number(args.limit))
    ? Math.max(1, Math.min(200, Math.floor(Number(args.limit))))
    : 200;

  const searchArgs = { ...args, hybrid: undefined, limit: 200 } as Args;
  let execution = await executeCached("search", searchArgs);
  let response = execution.response;
  let data = (response.result?.data ?? {}) as { hits?: unknown[]; complete?: boolean };
  let hits = Array.isArray(data.hits) ? (data.hits as Record<string, unknown>[]) : [];

  // Retry-scope fallback: zero hits on a scoped, identifier-like query.
  let scopeWidened = false;
  if (hits.length === 0 && scoped && identifier !== null) {
    const widened = { ...args, hybrid: undefined, relative_path: undefined, limit: 200 } as Args;
    const widenedExecution = await executeCached("search", widened);
    const widenedData = (widenedExecution.response.result?.data ?? {}) as { hits?: unknown[] };
    const widenedHits = Array.isArray(widenedData.hits) ? (widenedData.hits as Record<string, unknown>[]) : [];
    if (widenedHits.length > 0) {
      scopeWidened = true;
      execution = widenedExecution;
      response = widenedExecution.response;
      data = (response.result?.data ?? {}) as typeof data;
      hits = widenedHits;
    }
  }

  // Tag hits. Definition sites are detected per file with the same parser-lite
  // used by project_outline_symbol / project_file_symbols, bounded to files that
  // actually produced hits.
  const definitionLines = new Map<string, Set<number>>();
  if (identifier !== null && hits.length > 0) {
    const files = [...new Set(hits.map((hit) => String(hit.relative_path ?? "")).filter(Boolean))].slice(0, 32);
    await Promise.allSettled(
      files.map(async (rel) => {
        try {
          const text = await readTextFile(rel);
          if (text === null) return;
          const symbols = extractSymbols(text);
          const lines = new Set<number>();
          for (const sym of symbols) {
            if (sym.name === identifier) lines.add(sym.line);
          }
          if (lines.size > 0) definitionLines.set(rel, lines);
        } catch {
          /* best effort — the hit keeps its weaker tag */
        }
      }),
    );
  }

  const wordRe = identifier !== null ? new RegExp(`\\b${escapeRegExp(identifier)}\\b`) : null;
  const tagged: HybridHit[] = hits.slice(0, requestedLimit).map((hit) => {
    const rel = String(hit.relative_path ?? "");
    const line = Number(hit.line_number ?? 0);
    const snippet = String(hit.snippet ?? "");
    let source = "content";
    let confidence: "exact_match" | "text_match" = "text_match";
    if (definitionLines.get(rel)?.has(line)) {
      source = "symbol_index";
      confidence = "exact_match";
    } else if (wordRe?.test(snippet)) {
      source = "symbol_reference";
      confidence = "exact_match";
    }
    return { ...hit, source, confidence };
  });

  const truncated = tagged.length < hits.length || response.truncated === true || data.complete === false;
  const mergedData = {
    ...data,
    hits: tagged,
    // The over-fetch returns up to 200 hits; when we slice below the request,
    // the agent did NOT get everything — report `complete: false` (matching
    // the plain path's cap semantics) instead of a stale `true`.
    complete: !truncated,
    hybrid: true,
    ...(scopeWidened ? { scope_widened: true } : {}),
  };
  const merged: RustResponse = {
    status: "completed",
    truncated,
    result: { kind: "search", data: mergedData },
  };
  const elapsedMs = performance.now() - started;
  recordMetric("search", elapsedMs, true);
  return toolResult(buildEnvelope("search", merged, { requestId, elapsedMs, cached: execution.cached }));
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
  // the caller should pair this with project_file_symbols first). For "workspace",
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
    const cachedSearch = ttlLookup(referencesCache, refKey, SEARCH_CACHE_MS, cacheStats.references);
    searchCacheHit = cachedSearch !== null;
    const searchRes = cachedSearch ?? (await executeCached("search", innerArgs)).response;
    if (!cachedSearch) ttlStore(referencesCache, refKey, searchRes);
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
            "No known signature matched. Hint: read the failing file:line with project_read_ranges, then narrow the loop " +
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
        include_ignored: flag01.optional(),
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
        line_numbers: flag01.optional(),
        max_bytes: z.number().int().min(1).max(1048576).optional(),
        ranges: z
          .array(
            z.object({
              start_line: z.number().int().min(1),
              end_line: z.number().int().min(1).optional(),
              max_bytes: z.number().int().min(1).optional(),
            })
          )
          .min(1)
          .max(16)
          .optional()
          .describe("Multiple disjoint ranges of the SAME file (max 16). Use instead of multiple read_file calls."),
      },
    },
    (args) => {
      const wantNumbers = Boolean((args as Args).line_numbers);
      return runOne("read_file", args, wantNumbers ? { line_numbers: true } : undefined);
    },
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
        "Search by file name, directory name, content (literal or regex=1), or symbol declaration lines (definition).",
        "Search workspace",
        {
          use_when: "you need to find code/strings/symbols before reading; use kind=literal_content or definition.",
          avoid_when: "you already know the exact path to read.",
          speed_profile: "medium (file scan); TTL cache 3s for the same query.",
          output_kind:
            "search: hits (source+confidence when hybrid:1), complete, diagnostics, hint.",
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
        regex: flag01.optional(),
        case_sensitive: flag01.optional(),
        whole_word: flag01.optional().describe("1 = whole-word match only (rg -w / JS word boundaries) for literal_content and definition."),
        include_hidden: flag01.optional().describe("1 = include hidden files (default); 0 = skip dotfiles (rg-style). Secrets (.env*, credentials, keys) are always excluded either way."),
        context_lines: z.number().int().min(0).max(20).optional(),
        count_only: flag01.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        hybrid: flag01.optional().describe("1 = tag each hit with source (symbol_index|symbol_reference|content) and confidence (exact_match|text_match); a scoped identifier query with 0 hits widens once to the workspace (scope_widened:true). literal_content only."),
      },
    },
    (args) =>
      args.hybrid === true && args.kind === "literal_content"
        ? runHybridSearch(args as Args)
        : runOne("search", args),
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
        include_ignored: flag01.optional(),
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
        create_dirs: flag01.optional(),
        expected_sha256: z.string().optional(),
        reason: reason_,
      },
    },
    (args) => runOne("write_file", args),
  );

  server.registerTool(
    "project_edit_file",
    {
      ...config(
        "Edit a file by exact text replacement: one old_text/new_text pair, or edits[] for multiple sections. Supports TOCTOU guard mode (guard=sha256) for atomic read-edit-verify cycle.",
        "Edit file",
        {
          use_when: "change one or a few text sections whose exact content you know; pair with expected_sha256 to guard against blind overwrites. Use guard=sha256 for atomic read-edit-verify cycle (replaces safe_edit). If editing 2+ files or 2+ sections, create a project_snapshot first so you can rollback in one call.",
          avoid_when: "the whole file must change (project_write_file), or you have not read the file to know old_text.",
          speed_profile: "fast; clears the read/list/search cache for the affected path.",
          output_kind: "file_written: replacements, sha256_before/after, verified (with guard=sha256).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        old_text: z.string().min(1).optional(),
        new_text: z.string().optional(),
        replace_all: flag01.optional(),
        edits: z.array(editOp).max(64).optional(),
        expected_sha256: z.string().optional(),
        // P2: Fuzzy edit args
        old_text_fuzzy: z.string().optional().describe("P2: Fuzzy-match fallback for old_text (used when exact match fails and VENIRA_EDIT_FUZZY=1)."),
        fuzzy_distance: z.number().int().min(0).max(10).optional().describe("P2: Max Levenshtein distance for fuzzy matching (default 3)."),
        ignore_indentation: flag01.optional().describe("P2: Ignore leading whitespace differences in fuzzy matching; 1=on, 0=off."),
        case_insensitive: flag01.optional().describe("P2: Case-insensitive fuzzy matching; 1=on, 0=off."),
        // TOCTOU guard: "sha256" = read fresh, verify content unchanged vs expected_sha256, apply edits, write, re-read and verify
        guard: z.enum(["sha256"]).optional().describe("TOCTOU guard: 'sha256' reads fresh content, verifies expected_sha256, applies edits, writes, then re-reads to verify content+sha256 match. Provides atomic read-edit-verify cycle."),
        reason: reason_,
      },
    },
    (args) => runOne("edit_file", args),
  );
  server.registerTool(
    "project_edit_batch",
    {
      ...config(
        "Apply multiple edit_file operations atomically in one call; aborts after the first failure and restores the pre-batch snapshot when possible.",
        "Edit batch",
        {
          use_when: "you have 2+ independent edits across one or more files. Consider project_snapshot action=create first so you can rollback the whole batch in one call if something goes wrong.",
          avoid_when: "a single edit (project_edit_file) or a whole-file rewrite (project_write_file).",
          speed_profile: "depends on item count; each runs edit_file and clears caches.",
          output_kind: "batch: responses[] {ok, response|error}, atomic metadata with executed/skipped indexes and rollback status.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        edits: z.array(z.record(z.string(), z.any())).min(1).max(64).describe("Array of edit_file argument objects. The batch aborts on the first failure and rolls back earlier writes when possible."),
        max_response_bytes_per_item: z.number().int().min(256).max(1048576).optional(),
      },
    },
    (args) => runEditBatch(args as Args),
  );

  server.registerTool(
    "project_delete_path",
    {
      ...config("Delete a file or directory (directories require recursive=1). Create and verify a scoped snapshot before using this irreversible tool; do not delete if the checkpoint is incomplete.", "Delete path", {
        use_when: "only after creating a scoped project_snapshot for the exact target, confirming file_count/truncated/skipped cover the intended files, and keeping its id for recovery.",
        avoid_when: "the target is ambiguous or a pre-delete snapshot is missing, truncated, or skipped the target. This op is not undoable; capture and verify a checkpoint first.",
        speed_profile: "fast; clears the read/list/search cache.",
        output_kind: "path_deleted: entries_deleted, bytes_deleted.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      inputSchema: {
        relative_path: path_.describe("Exact workspace path to delete. Create a scoped project_snapshot first and confirm this target is captured; do not delete if it is skipped or the checkpoint is truncated."),
        recursive: flag01.optional().describe("For recursive directory deletion, set 1 only after confirming the target and creating a scoped project_snapshot; required for directory deletion."),
        reason: reason_,
      },
    },
    (args) => runOne("delete_path", args),
  );

  server.registerTool(
    "project_shell_run",
    {
      ...config(
        `Run a shell command (cwd defaults to ${WORKSPACE}). ` +
          "Asynchronous by default: returns run_id immediately, so poll project_shell_status for the output. " +
          "Pass background=0 (or false) for a foreground run: the call blocks until the command exits and returns the final stdout/stderr. " +
          "Commands pass a policy gate: risky ones return an approval_required error with a pending approval_id; " +
          "catastrophic ones are denied outright. Named overrides require operator allowlisting and a per-call reason.",
        "Shell run",
        {
          use_when:
            "build/test/lint/long-running commands. Default (background=1) returns run_id immediately so it never blocks other tools; " +
            "set background=0 when you need the final output in this call — it blocks until the command exits, and you must not start other work while waiting. " +
            "After approval_required, ask the user to approve the approval_id in an interactive terminal, then retry.",
          avoid_when: "a command that may never finish: use the async default plus project_shell_status/project_shell_cancel.",
          speed_profile:
            "background=1 returns in ~5 ms, run time is up to the command; " +
            "background=0 blocks for the whole run (bounded by timeout_ms, default 10 min).",
          output_kind:
            "shell_run: run_id/shell_id, running, exit_code, background/foreground, stdout_tail/stderr_tail, timed_out, policy; " +
            "background=0 also returns bounded stdout/stderr. " +
            "approval_required: rule, reason, approval_id, retry_with.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        shell: z.enum(["powershell", "cmd", "bash"]).optional(),
        command: z.string().describe("Command line to execute."),
        relative_cwd: z.string().optional().describe("Working directory inside the workspace (default: workspace root)."),
        background: backgroundFlag.optional(),
        secret_env: z
          .array(z.string())
          .max(16)
          .optional()
          .describe(
            "Names of stored secrets (project_secret) to inject as environment variables for this command, " +
              "e.g. [\"GITHUB_TOKEN\"]. The value never appears in the command, the audit log or the output.",
          ),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Kill the whole process tree after this many milliseconds. Unset or 0 uses the default 10-minute timeout; capped by VENIRA_SHELL_MAX_TIMEOUT_MS."),
        approval_token: z
          .string()
          .optional()
          .describe("REMOVED in v1.15: passing it returns an error. Use approval_id instead."),
        approval_id: z
          .string()
          .optional()
          .describe("Approval ID from the approval_required envelope, granted by a human via `npx venira-mcp --approve <id>` or client elicitation. Retry once after they confirm."),
        approval_wait_ms: z
          .number()
          .int()
          .min(0)
          .max(APPROVAL_WAIT_MAX_MS)
          .optional()
          .describe("If the command needs approval, wait up to this many ms (max 45000) for the human to grant it and run in the same call. On timeout you get the normal approval_required response."),
        dry_run: z
          .number()
          .int()
          .min(0)
          .max(1)
          .optional()
          .describe("1 = evaluate policy only: returns tier, rule and whether approval would be needed. Nothing runs and no approval is created."),
        override: z
          .enum(["ALLOW_GIT_PUSH", "ALLOW_ENV_READ"])
          .optional()
          .describe("Named exception; only works when the operator enabled this exact name in VENIRA_SHELL_OVERRIDES."),
        reason: z
          .string()
          .min(1)
          .max(400)
          .optional()
          .describe("Required with override; explain the specific intent in one line. Redacted and recorded in the SQLite audit trail."),
        approval_scope: z
          .enum(["once", "session"])
          .optional()
          .describe("Ignored: scope (once/session) is chosen by the human at approval time (`--approve <id> --session`), never by the model."),
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
      inputSchema: { run_id: z.string(), kill_key: z.string() },
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
        create_dirs: flag01.optional(),
        expected_sha256: z.string().optional(),
        reason: reason_,
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
          speed_profile: "fast (~a few ms + 1 audit DB query); set include_audit=0 to skip the DB query.",
          output_kind: "health: server, corehost, capability, queue, caches, shells, metrics, audit.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: { include_audit: flag01.optional() },
    },
    (args) => runHealth(args as Args),

  );

  server.registerTool(
    "project_cache_clear",
    {
      ...config(
        "Clear in-process read/search/list/recent/search/shell/graph caches. Use after a toolchain generates files outside normal write flow, or to force fresh reads.",
        "Clear caches",
        {
          use_when: "force-fresh reads after external tooling mutated files, or the cache stats show high hit/miss pressure.",
          avoid_when: "normal flow (cache invalidates on write/edit/delete).",
          speed_profile: "instant; clears LRU/TTL maps only (no backend call).",
          output_kind: "cache_clear: type, cleared per-cache entry counts.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        type: z.enum(["all", "shell", "read", "info", "list", "search", "recent", "negative", "graph"]).default("all").describe("Which cache to clear."),
      },
    },
    (args) => runOne("cache_clear", args as Args),
  );

  if (ALLOW_JS_EXEC) {
    server.registerTool(
      "project_execute_js",
      {
        ...config(
          "Evaluate JavaScript code. Runs `node` in the workspace, capturing stdout/stderr; supports top-level await and `require`. Each call needs human approval by default (`VENIRA_JS_EXEC_APPROVAL=1`): call without `approval_id` to receive one, then retry after the user grants it.",
          "Execute JS",
          {
            use_when: "you need to run a small JS snippet for computation, file I/O via fs, or prototyping.",
            avoid_when: "you need a full shell pipeline (project_shell_run) or a persistent process.",
            speed_profile: "synchronous node exec with timeout (default 30s, cap 10min); output capped at 1 MiB.",
            output_kind: "execute_js: stdout_tail, stderr_tail, exit_code, timed_out, ok. Without approval_id: approval_required + approval_id.",
            batch_safe: false,
          },
          { destructiveHint: true, openWorldHint: false },
        ),
        inputSchema: {
          code: z.string().min(1),
          timeout_ms: z.number().int().min(1).max(600_000).optional(),
          argv: z.array(z.string()).optional(),
          approval_id: z
            .string()
            .optional()
            .describe("Approval id from a previous project_execute_js approval_required response, granted with `npx venira-mcp --approve <id>`."),
          approval_wait_ms: z
            .number()
            .int()
            .min(0)
            .max(APPROVAL_WAIT_MAX_MS)
            .optional()
            .describe("Wait up to this many ms (max 45000) for the human to grant the approval and run in the same call."),
        },
      },
      (args) => runExecuteJs(args as Args),
    );
  }

  // -------------------------------------------------------------------------
  // P1: observability + audit + shell session tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_trace_status",
    {
      ...config(
        "Show the most recent traced tool calls from the in-memory buffer (last N) plus the trace configuration.",
        "Trace status",
        {
          use_when: "VENIRA_TRACE=1 and you want to see what ran recently without reading the log file.",
          avoid_when: "tracing is disabled (returns an empty buffer) or you need the full on-disk log (read VENIRA_TRACE_FILE instead).",
          speed_profile: "instant; in-memory buffer only, no I/O.",
          output_kind: "trace_status: enabled, file, buffered, recent[] (newest last).",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("How many recent traces to return (default 20, max 100)."),
      },
    },
    (args) => {
      const started = performance.now();
      const requestId = newRequestId();
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const recent = recentTraces(limit);
      const response: RustResponse = {
        status: "completed",
        result: {
          kind: "trace_status",
          data: {
            ...traceSnapshot(),
            recent,
          },
        },
        truncated: false,
      };
      const elapsedMs = performance.now() - started;
      recordMetric("trace_status", elapsedMs, true);
      return toolResult(buildEnvelope("trace_status", response, { requestId, elapsedMs, cached: false }));
    },
  );

  server.registerTool(
    "project_read_audit",
    {
      ...config(
        "Read recent rows from the SQLite audit log (WAL). Filter by session/operation/outcome; bounded by limit.",
        "Read audit log",
        {
          use_when: "you need to inspect what operations were recorded (audit trail) — e.g. compliance or debugging a prior action.",
          avoid_when: "you only need the live cache/metric report (project_health include_audit=1) — that one is faster.",
          speed_profile: "fast; one bounded SQLite read (readonly, WAL-safe).",
          output_kind: "audit_read: rows[] (newest first), count, truncated, db_path.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        session_id: z.string().optional(),
        operation: z.string().optional(),
        outcome: z.enum(["success", "failure", "running"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        since_unix: z.number().int().min(0).optional(),
        verify: flag01.optional().describe("1 verifies the audit hash chain and returns chain_ok; 0 disables verification."),
      },
    },
    (args) => runReadAudit(args as Args),
  );

  server.registerTool(
    "project_shell_cancel_session",
    {
      ...config(
        "Cancel ALL shell runs tracked in this session (kills every process tree). Use to cleanly tear down a session.",
        "Shell cancel session",
        {
          use_when: "a session is ending or a stuck session has many running commands and they must all be stopped.",
          avoid_when: "only one run needs cancelling (project_shell_cancel by run_id). Destructive: running commands are killed.",
          speed_profile: "fast; iterates the in-process shell run table and kills each tree.",
          output_kind: "shell_cancel_session: cancelled_run_ids[], count.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {},
    },
    () => runCancelShellSession(),
  );

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
          avoid_when: "you only need its declaration (project_file_symbols) or an arbitrary string (project_search).",
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
            "you already know the cause and only need the file contents (use project_read_file / project_read_ranges).",
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

  // -------------------------------------------------------------------------
  // Git provider: pull requests / CI. Dialect + endpoint + token are resolved
  // per call (see lib/git-config.ts), so the same tools drive GitHub, GitLab
  // and Bitbucket.
  // -------------------------------------------------------------------------

  const repoArg = z
    .string()
    .max(200)
    .optional()
    .describe(
      'Repository as "owner/name" or a PR URL (default: VENIRA_GIT_REPO, git.repo in venira.config.json, else the workspace .git origin remote).',
    );

  const providerArg = z
    .enum(["github", "gitlab", "bitbucket"])
    .optional()
    .describe(
      "Provider override for this call (default: VENIRA_GIT_PROVIDER, then venira.config.json, then inferred from the origin remote).",
    );

  server.registerTool(
    "project_pr_create",
    {
      ...config(
        "Open a pull request for the current branch (or an explicit head/base). Works with GitHub, GitLab and Bitbucket; repo/token/provider are resolved per call.",
        "Create pull request",
        {
          use_when:
            "the change is committed and pushed, and the user asks to open a PR/MR. Default base is the repo's default branch.",
          avoid_when: "the branch is not pushed yet (push first), or a PR for this branch already exists (use project_pr_comment).",
          speed_profile: "one provider API call (~1 network round trip, 2 if the default branch is not cached).",
          output_kind: "pr_create: repo, provider, number, url, title, state, draft, head, base, created.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        title: z.string().min(1).max(256).describe("PR title (imperative, one line)."),
        head: z.string().max(200).optional().describe("Source branch (default: the current branch)."),
        base: z.string().max(200).optional().describe("Target branch (default: the repository default branch)."),
        body: z.string().max(65_536).optional().describe("PR description (markdown); usually a summary + test plan."),
        draft: flag01.optional().describe("1 opens as a draft PR; 0 opens as ready for review."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_create", args as Args),
  );

  server.registerTool(
    "project_pr_comment",
    {
      ...config(
        "Post a comment on a pull request: a general thread comment, or an inline review note pinned to a file/line (pass path + line). Accepts a PR number or a full PR URL.",
        "Comment on PR",
        {
          use_when:
            "reporting status into the PR thread, answering a review comment, or leaving a file/line review note (path + line).",
          avoid_when: "the PR is not open yet (create it first), or you want to change code (use project_edit_file).",
          speed_profile: "one provider API call (issue-comments, or review-comments for inline notes).",
          output_kind:
            "pr_comment: repo, provider, pr, inline, comment_id, url, created_at, body_chars (+ path/line/side for inline notes).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        pr: z.union([z.number().int().positive(), z.string().max(300)]).describe("PR number or PR URL."),
        body: z.string().min(1).max(65_536).describe("Comment body (markdown)."),
        path: z
          .string()
          .max(300)
          .optional()
          .describe("Workspace/repo file path for an inline review comment (requires `line`); omit for a general comment."),
        line: z.number().int().positive().optional().describe("Line number to anchor the inline note (new side by default)."),
        start_line: z.number().int().positive().optional().describe("First line of a multi-line inline note (must be <= line; GitHub/GitLab)."),
        side: z.enum(["RIGHT", "LEFT"]).optional().describe("RIGHT = new code (default), LEFT = deleted code."),
        commit_id: z.string().max(64).optional().describe("Commit sha the note is anchored to (default: the PR head)."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_comment", args as Args),
  );

  server.registerTool(
    "project_pr_merge",
    {
      ...config(
        "Merge a pull request (merge/squash/rebase) and optionally delete the head branch. Refuses cleanly when the PR is closed or conflicting.",
        "Merge pull request",
        {
          use_when: "CI is green and the user asked to land the PR. Use method=squash for a single commit.",
          avoid_when: "checks are still running (project_ci_status first), or the user only wants a review comment.",
          speed_profile: "2-3 API calls (state check, merge, optional branch delete).",
          output_kind: "pr_merge: repo, provider, pr, merged, method, sha, head, base, branch_deleted, note?.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        pr: z.union([z.number().int().positive(), z.string().max(300)]).describe("PR number or PR URL."),
        method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge strategy (default: merge)."),
        commit_title: z.string().max(256).optional().describe("Title for the merge commit (squash/merge)."),
        commit_message: z.string().max(65_536).optional().describe("Body for the merge commit."),
        delete_branch: flag01.optional().describe("1 deletes the head branch after a successful merge (same-repo only); 0 keeps it."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_merge", args as Args),
  );

  server.registerTool(
    "project_pr_list",
    {
      ...config(
        "List pull/merge requests for a repo, optionally filtered by state, head or base branch.",
        "List pull requests",
        {
          use_when: "you need the PR number for a branch (before commenting/merging) or a quick open/closed overview.",
          avoid_when: "you already know the PR number (use project_pr_comment / project_pr_merge directly).",
          speed_profile: "one API call; read-only and batch-safe.",
          output_kind: "pr_list: repo, provider, state, total, prs[] {number, title, state, draft, head, base, author, url}.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        state: z.enum(["open", "closed", "all"]).optional().describe("Filter by state (default: open)."),
        head: z.string().max(200).optional().describe("Filter by source/head branch."),
        base: z.string().max(200).optional().describe("Filter by target/base branch."),
        limit: z.number().int().min(1).max(100).optional().describe("Max PRs to return (default 20, cap 100)."),
        repo: repoArg,
        provider: providerArg,
      },
    },
    (args) => runOne("pr_list", args as Args),
  );

  server.registerTool(
    "project_pr_close",
    {
      ...config(
        "Close (decline) an open pull/merge request without merging it.",
        "Close pull request",
        {
          use_when: "a PR is superseded, opened by mistake, or the user asked to abandon it.",
          avoid_when: "the change should land (use project_pr_merge instead).",
          speed_profile: "one API call; idempotent (closing a closed PR is a no-op).",
          output_kind: "pr_close: repo, provider, pr, state, closed, url.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        pr: z.union([z.number().int().positive(), z.string().max(300)]).describe("PR number or PR URL."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_close", args as Args),
  );

  server.registerTool(
    "project_pr_reopen",
    {
      ...config(
        "Reopen a closed pull/merge request (GitHub, GitLab). Bitbucket returns `unsupported`.",
        "Reopen pull request",
        {
          use_when: "a PR was closed by mistake and the same branch should be reviewed again.",
          avoid_when: "the branch was deleted or force-pushed away (open a new PR with project_pr_create).",
          speed_profile: "one API call; idempotent.",
          output_kind: "pr_reopen: repo, provider, pr, state, reopened, url.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        pr: z.union([z.number().int().positive(), z.string().max(300)]).describe("PR number or PR URL."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_reopen", args as Args),
  );

  // -------------------------------------------------------------------------
  // CI provider: GitHub Actions status / control / trigger / logs
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_ci_status",
    {
      ...config(
        "Read CI status: recent runs for a branch/workflow, one run with its jobs, or branch-protection check-runs for a ref/PR (GitHub). GitHub Actions, GitLab pipelines and Bitbucket Pipelines are supported.",
        "CI status",
        {
          use_when:
            "after pushing or triggering a pipeline, to see whether checks passed before merging; pass pr=<number> (or ref=<sha>) for branch-protection check-runs (GitHub).",
          avoid_when: "you need the failure detail (use project_ci_logs with the run_id/job_id).",
          speed_profile: "1-2 API calls; newest runs first. pr= adds one call to resolve the head sha.",
          output_kind:
            "ci_status: overall (success|failure|in_progress|no_runs|no_checks) + runs[] {id, name, status, conclusion, branch, sha, url}; " +
            "run_id → run + jobs[]; ref/pr → check_runs[] (GitHub) or the newest pipeline (GitLab/Bitbucket).",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        run_id: z
          .union([z.number().int().positive(), z.string().max(80)])
          .optional()
          .describe("Inspect one run: GitHub/GitLab numeric id, or a Bitbucket pipeline UUID."),
        ref: z
          .string()
          .max(200)
          .optional()
          .describe("Commit sha or branch: read check-runs (GitHub) or the newest pipeline for that ref."),
        pr: z
          .union([z.number().int().positive(), z.string().max(300)])
          .optional()
          .describe("PR number or PR URL: read check-runs for the PR head commit."),
        branch: z.string().max(200).optional().describe("Filter runs by branch."),
        workflow: z.string().max(200).optional().describe("Workflow file name (ci.yml) or numeric id."),
        limit: z.number().int().min(1).max(50).optional().describe("Max runs (or check-runs) to list (default 10 / 20)."),
        repo: repoArg,
        provider: providerArg,
      },
    },
    (args) => runOne("ci_status", args as Args),
  );

  server.registerTool(
    "project_ci_control",
    {
      ...config(
        "Cancel one CI run, or retry failed jobs when the provider supports it. Requires an explicit run_id and audit reason; Bitbucket Cloud supports cancel but not retry.",
        "Control CI run",
        {
          use_when: "you explicitly want to stop a run or retry only its failed jobs; read project_ci_status first to confirm the target run.",
          avoid_when: "the run id is ambiguous, the user has not requested a remote CI write, or you need a new run on a different ref (use project_ci_trigger).",
          speed_profile: "one provider API call; POST is never automatically retried.",
          output_kind: "ci_control: repo, provider, action, run_id, request_submitted; check project_ci_status to confirm the asynchronous result.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        action: z.enum(["cancel", "retry_failed"]).describe("Cancel the selected run, or retry only failed/canceled jobs if supported."),
        run_id: z
          .union([z.number().int().positive(), z.string().trim().min(1).max(80)])
          .describe("Exact provider run ID from project_ci_status; Bitbucket uses a pipeline UUID."),
        repo: repoArg,
        provider: providerArg,
        reason: z.string().trim().min(1).max(400).describe("Why this CI action is needed; recorded in the audit trail, secrets redacted."),
      },
    },
    (args) => runOne("ci_control", args as Args),
  );

  server.registerTool(
    "project_ci_trigger",
    {
      ...config(
        "Trigger a pipeline: GitHub Actions workflow_dispatch, a GitLab pipeline, or a Bitbucket custom pipeline. Ref defaults to the current branch.",
        "Trigger CI workflow",
        {
          use_when: "re-running a pipeline for a branch without a new commit, or dispatching a workflow with inputs/variables.",
          avoid_when: "the workflow has no workflow_dispatch trigger (GitHub rejects it), or a push would do it anyway.",
          speed_profile: "one API call; the new run appears in project_ci_status within ~10s.",
          output_kind: "ci_trigger: repo, provider, workflow, ref, inputs, triggered, dispatched_at.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        workflow: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("GitHub: workflow file name (ci.yml) or id (required). GitLab: optional label. Bitbucket: custom pipeline pattern (default: default)."),
        ref: z.string().max(200).optional().describe("Branch/tag to run on (default: current branch, else default branch)."),
        inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("ci_trigger", args as Args),
  );

  server.registerTool(
    "project_ci_logs",
    {
      ...config(
        "Read CI logs: a whole run (GitHub ZIP or up to 3 failing GitLab/Bitbucket jobs) or a single job/step. Returns the tail, not the whole log.",
        "CI logs",
        {
          use_when: "a run failed and you need the error. Pass job_id to isolate the failing job; tail_lines/max_bytes keep it small.",
          avoid_when: "you only need pass/fail (use project_ci_status).",
          speed_profile: "1 download; run archives are parsed in memory with per-entry caps.",
          output_kind:
            "ci_logs: repo, provider, run_id|job_id, source, entries[] {name, bytes, skipped?}, lines, text (tail), truncated, dropped_lines, dropped_bytes.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        run_id: z
          .union([z.number().int().positive(), z.string().max(80)])
          .optional()
          .describe("Whole run: GitHub/GitLab id, or a Bitbucket pipeline UUID."),
        job_id: z
          .union([z.number().int().positive(), z.string().max(161)])
          .optional()
          .describe('Single job: GitHub/GitLab job id, or a Bitbucket step UUID (or "pipelineUuid:stepUuid").'),
        tail_lines: z.number().int().min(1).max(5000).optional().describe("Keep only the last N lines (default 500)."),
        max_bytes: z.number().int().min(1).max(4 * 1024 * 1024).optional().describe("Max text bytes returned (default 512KB, cap 4MB)."),
        repo: repoArg,
        provider: providerArg,
      },
    },
    (args) => runOne("ci_logs", args as Args),
  );

  server.registerTool(
    "project_ci_wait",
    {
      ...config(
        "Long-poll one CI run/ref/PR/branch until it reaches a terminal state (success|failure|cancelled|skipped), changes (until=any_change), or timeout_ms elapses. On failure it includes the same bounded log tail as project_ci_logs. This does not wake the model: it is one bounded call, not a push notification.",
        "Wait for CI",
        {
          use_when:
            "after project_ci_trigger or a push you want the result plus the failure tail in one call instead of a polling loop.",
          avoid_when:
            "you want a snapshot right now (project_ci_status) or the full log of a specific job (project_ci_logs with job_id).",
          speed_profile:
            "blocks up to timeout_ms (default 45 s, max 110 s) with 2–15 s backoff polling; unqueued, so other tools keep working. Respects VENIRA_NETWORK=0.",
          output_kind:
            "ci_wait: overall, previous, changed, terminal, waited_ms, polls, run, selector, ci_status, failure_tail? {text, lines, truncated}; terminal=false means chain another call.",
          batch_safe: false,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        run_id: z
          .union([z.number().int().positive(), z.string().max(80)])
          .optional()
          .describe("Wait on one run: GitHub/GitLab numeric id, or a Bitbucket pipeline UUID."),
        ref: z.string().max(200).optional().describe("Commit sha or branch: wait on check-runs (GitHub) or the newest pipeline."),
        pr: z.union([z.number().int().positive(), z.string().max(300)]).optional().describe("PR number or URL: wait on its head-sha check-runs."),
        branch: z.string().max(200).optional().describe("Wait on the newest run/pipeline for this branch (optionally narrow with workflow)."),
        workflow: z.string().max(200).optional().describe("Workflow file name (ci.yml) or numeric id; narrows a branch selector."),
        until: z.enum(["terminal", "any_change"]).optional().describe("Stop at a terminal state (default) or on the first state change."),
        timeout_ms: z.number().int().min(1000).max(110_000).optional().describe("Max wait in ms (default 45_000, max 110_000). Values > ~55 s need a client request timeout > 60 s."),
        interval_ms: z.number().int().min(2000).max(15_000).optional().describe("Poll interval in ms (default 5000; min 2000, max 15000)."),
        include_failure_tail: flag01.optional().describe("1 fetches the failing job/run log tail on failure (default); 0 skips it."),
        tail_lines: z.number().int().min(1).max(1000).optional().describe("Failure tail lines (default 80)."),
        repo: repoArg,
        provider: providerArg,
      },
    },
    (args) => runOne("ci_wait", args as Args),
  );

  // -------------------------------------------------------------------------
  // Secrets: safe env-var storage for tokens and other credentials
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_github_connect",
    {
      ...config(
        "Connect GitHub through its Device Flow. The user authorizes at github.com; access and refresh tokens are saved in the encrypted local vault and are never returned.",
        "Connect GitHub",
        {
          use_when:
            "the user wants to connect or replace the local GitHub credential without pasting a token into chat.",
          avoid_when:
            "the user only needs GitHub public read access or has already configured a token.",
          speed_profile:
            "start returns a short-lived verification code; poll only at the interval GitHub specifies.",
          output_kind:
            "github_connect: start returns verification_uri, user_code, pending_id and expiry; poll returns pending, denied, expired or connected (never a token).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        action: z.enum(["start", "poll"]),
        replace_existing: flag01
          .optional()
          .describe("action=start: 1 explicitly authorizes replacing an existing GitHub credential; 0 does not."),
        pending_id: z
          .string()
          .max(64)
          .optional()
          .describe("action=poll: opaque id returned by action=start; it does not contain the device code or token."),
      },
    },
    (args) => runOne("github_connect", args as Args),
  );

  server.registerTool(
    "project_secret",
    {
      ...config(
        "Manage API tokens/credentials without leaking them: values are encrypted at rest and never returned by default. " +
          "Inject them into commands with project_shell_run secret_env=[\"NAME\"] instead of pasting them into a command line. " +
          "Rotation metadata (expiry, last use, use count) is tracked by default and expired secrets are refused.",
        "Manage secrets",
        {
          use_when:
            "storing a non-GitHub token (action=set), checking whether one exists or is due for rotation (action=get / action=list), " +
            "removing one (action=delete). Then use secret_env on project_shell_run or the built-in GitHub tools.",
          avoid_when:
            "the value is a normal, non-secret config (put it in .env or the config file); or you need the plaintext " +
            "printed (only with reveal=1 + VENIRA_SECRET_ALLOW_REVEAL=1).",
          speed_profile:
            "fast; encrypted AES-256-GCM store, atomic writes, values decrypted only when injected. Expiry/use fields are metadata only.",
          output_kind:
            "secret_set: name, length, sha256_12, updated_at, expires_at, days_left, created, rotated; " +
            "secret_get/list: metadata only (expires_at, expired, days_left, last_used_at, use_count, rotated_at); " +
            "secret_delete: deleted.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        action: z.enum(["get", "set", "list", "delete"]).default("list"),
        name: z
          .string()
          .max(64)
          .optional()
          .describe("Env-var style name, e.g. GITHUB_TOKEN (required for get/set/delete)."),
        value: z
          .string()
          .max(16 * 1024)
          .optional()
          .describe("Secret value for action=set. Prefer value_env so it never appears in the transcript."),
        value_env: z
          .string()
          .max(64)
          .optional()
          .describe("Read the value from this host environment variable instead of `value` (never logged)."),
        expires_in_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe("action=set: expiry in days (e.g. 90 for quarterly rotation). Expired secrets are not injected."),
        expires_at: z
          .union([z.number().int(), z.string().max(60)])
          .optional()
          .describe("action=set: absolute expiry (epoch ms or ISO-8601), instead of expires_in_days."),
        reveal: flag01
          .optional()
          .describe("action=get: 1 returns the plaintext value and requires VENIRA_SECRET_ALLOW_REVEAL=1 on the host; prefer secret_env injection."),
        reason: reason_,
      },
    },
    (args) => runSecret(args as Args),
  );
}
