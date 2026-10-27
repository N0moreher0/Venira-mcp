import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CoreHost } from "../lib/corehost.js";
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
import { toHostPath, UNRESTRICTED, WORKSPACE } from "../lib/workspace.js";

const PERMISSION_MODE = process.env.VENIRA_PERMISSION_MODE ?? "allow_all";
// Rust cấp scope "chat-terminal" cho allow_all khi không có Project (giống app Venira).
// Đặt VENIRA_SESSION_ID để test/verify truy vết được audit rows của riêng phiên này.
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
const MAX_READ_BYTES = 1048576; // 1 MiB, an toàn hơn native
const STARTED_AT = Date.now();

const host = new CoreHost();
export const closeHost = () => host.close();

// ---------------------------------------------------------------------------
// Hàng đợi tuần tự: Rust spawn mỗi request lên một blocking thread, mỗi thread
// lại mở connection SQLite riêng cho audit; gọi song song nhiều request làm
// audit tranh khóa (chậm gấp 3-4 lần và có thể lỗi audit_unavailable).
// Gọi tuần tự giữ thread pool ấm, nhanh hơn và ổn định hơn hẳn.
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
// Capability sống: mở scope 1 lần rồi dùng lại cho mọi request (TTL 2 giờ).
// Trước đây mỗi call đều open_scope -> canonicalize + mở handle cho home và
// từng ổ đĩa, rồi close_scope ngay sau đó.
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
    message.includes("corehost_rs thoát")
  );
}

export async function warmUp(): Promise<void> {
  try {
    await capabilityReady();
  } catch (error) {
    console.error(
      "[venira-coding] warmup thất bại:",
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
    /* host đã chết hoặc scope đã hết hạn */
  }
}

export async function cancelAllShellRuns(): Promise<void> {
  try {
    await host.call("project_tool.shell.cancel_session", { session_id: SESSION_ID }, 5_000);
  } catch {
    /* host chưa chạy hoặc đã chết: không có gì để huỷ */
  }
}

// ---------------------------------------------------------------------------
// Request/response
// ---------------------------------------------------------------------------
type Args = Record<string, unknown>;

/** Đổi các trường đường dẫn sang tuyệt đối trong workspace; bỏ undefined. */
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

/** shell_status/cancel không xếp hàng: một lần poll dài không được chặn tool khác. */
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
    // Scope có thể đã hết hạn / host vừa restart: mở lại đúng 1 lần rồi thử lại.
    capability = null;
    return (await executeOnce(operation, args)) as RustResponse;
  }
}

// ---------------------------------------------------------------------------
// Cache đọc: xác thực bằng stat (mtime + size) nên file bị sửa/xoá là tự trượt.
// list/search/recent dùng TTL ngắn và bị xoá toàn bộ khi có thao tác ghi.
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
    // Rust gộp "không tồn tại" và "bị khoá" vào io_error; stat lại để trả code đúng.
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
  // Chỉ cache kết quả COMPLETE và có hits. Kết quả 0-hit không cache để tránh
  // trả "không có match" từ cache khi file mới vừa được ghi (stale).
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

// File đã ghi/sửa trong phiên (project_recent_files trả thêm session_edits).
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
      /* path không hợp lệ thì Rust đã trả lỗi, không cần dọn cache */
    }
    invalidateListCaches();
  }
  if (operation.startsWith("shell_") || operation === "cancel") {
    trackShell(operation, response.result?.data);
  }
  return { response, cached: false };
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
// project_recent_files: quét filesystem có giới hạn (không có backend Rust).
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

// Theo dõi file đã ghi/sửa trong phiên để project_recent_files trả thêm context.

// ---------------------------------------------------------------------------
// project_create (gộp file + directory, đồng bộ với tool `project_create` của app native).
// Không đổi IPC Rust (backend có sẵn `write_file` + `create_directory`).
// ---------------------------------------------------------------------------
async function runCreate(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const kind = args.kind;
  if (kind === "directory") {
    if (args.content) {
      const fail = errorEnvelope("create", new Error("[invalid_request] kind=directory không nhận `content`. Bỏ content hoặc dùng kind=file. Hint: Dùng write_file cho file, create_directory cho thư mục."), { requestId, elapsedMs: performance.now() - started });
      recordMetric("create", performance.now() - started, false);
      return toolResult(fail, true);
    }
    const result = (await execute("create_directory", { relative_path: args.relative_path, create_parents: args.create_dirs ?? true })) as RustResponse;
    recordMetric("create", performance.now() - started, true);
    return toolResult(buildEnvelope("create", result, { requestId, elapsedMs: performance.now() - started }));
  }
  if (kind !== "file") {
    recordMetric("create", performance.now() - started, false);
    return toolResult(errorEnvelope("create", new Error(`[invalid_request] \`kind\` phải là "file" hoặc "directory". Nhận: ${JSON.stringify(kind)}.`), { requestId, elapsedMs: performance.now() - started }), true);
  }
  if (typeof args.content !== "string") {
    recordMetric("create", performance.now() - started, false);
    return toolResult(errorEnvelope("create", new Error("[invalid_request] kind=file cần `content` (chuỗi UTF-8; file rỗng dùng \"\")."), { requestId, elapsedMs: performance.now() - started }), true);
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
// Đăng ký tool
// ---------------------------------------------------------------------------
const path_ = z.string().describe("Đường dẫn trong workspace (tương đối hoặc tuyệt đối trong workspace)");
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

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "project_list_files",
    {
      ...config(
        "Liệt kê file/thư mục trong workspace. depth 1..3 để xem cây trong một lần gọi.",
        "List files",
        {
          use_when: "cần xem cây thư mục, kiểm tra path, hoặc lấy danh sách file trước khi đọc.",
          avoid_when: "chỉ cần metadata 1 file (project_get_file_info) hoặc nội dung 1 file (project_read_file).",
          speed_profile: "nhanh; cache TTL 1.5s, tự xoá khi ghi/sửa/xoá.",
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
        "Đọc file text, tuỳ chọn theo khoảng dòng (1-based). Kết quả có next_start_line nếu bị cắt.",
        "Read file",
        {
          use_when: "cần nội dung 1 file, hoặc 1 khoảng dòng của file lớn.",
          avoid_when: "cần đọc từ 2 file trở lên (project_read_batch) hoặc chỉ cần metadata (project_get_file_info).",
          speed_profile: "rất nhanh khi lặp lại; cache xác thực bằng mtime+size.",
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
        "Đọc nhiều khoảng dòng của CÙNG một file trong 1 lần gọi (tối đa 16 range).",
        "Read file ranges",
        {
          use_when: "cần nhiều đoạn rời của một file (ví dụ quanh các search hit) mà không muốn nhiều round-trip.",
          avoid_when: "cần cả file (project_read_file) hoặc nhiều file khác nhau (project_read_batch).",
          speed_profile: "nhanh; tận dụng cache read_file theo từng range.",
          output_kind: "file_read_ranges: ranges[] với text/truncated/next_start_line.",
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
        "Metadata của file/thư mục (kind, kích thước, thời gian sửa).",
        "Get file info",
        {
          use_when: "chỉ cần size/mtime/kind, hoặc kiểm tra path tồn tại.",
          avoid_when: "cần nội dung file (project_read_file).",
          speed_profile: "rất nhanh; cache xác thực bằng mtime+size.",
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
        "Tìm theo tên file, tên thư mục, nội dung (literal hoặc regex=true) hoặc dòng khai báo symbol (definition).",
        "Search workspace",
        {
          use_when: "cần tìm code/chuỗi/symbol trước khi đọc; dùng kind=literal_content hoặc definition.",
          avoid_when: "đã biết chính xác path cần đọc.",
          speed_profile: "trung bình (quét file); cache TTL 3s cho cùng query.",
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
        "Liệt kê file sửa gần đây nhất trong workspace (quét filesystem có giới hạn, bỏ qua node_modules/target/.git).",
        "Recent files",
        {
          use_when: "cần biết file nào vừa thay đổi, hoặc chọn file để đọc tiếp trong phiên làm việc.",
          avoid_when: "cần danh sách đầy đủ/theo tên (project_list_files) hoặc tìm nội dung (project_search).",
          speed_profile: "trung bình (đi filesystem); cache TTL 2s, giới hạn 4000 file/300 thư mục.",
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
        "Chạy tối đa 8 thao tác CHỈ-ĐỌC (list_files, read_file, get_file_info, search) trong một lần gọi; read/info dùng cache nên lặp lại rất nhanh.",
        "Batch read",
        {
          use_when: "cần đọc từ 2 file/thao tác trở lên trong cùng một bước (đọc context, quét nhiều file).",
          avoid_when: "chỉ có 1 thao tác đơn lẻ; hoặc cần thao tác ghi (dùng tool tương ứng).",
          speed_profile: "nhanh nhất cho read-heavy; chạy tuần tự + cache, có ngân sách response.",
          output_kind: "read_batch: responses[] (mỗi item là envelope ok/error).",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        requests: z
          .array(
            z.object({
              operation: z.enum(["list_files", "read_file", "get_file_info", "search"]),
              arguments: z.record(z.unknown()),
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
        "Ghi file. mode=create báo lỗi nếu đã tồn tại; overwrite thay thế; append nối vào cuối.",
        "Write file",
        {
          use_when: "tạo file mới hoặc thay toàn bộ/nối nội dung file.",
          avoid_when: "chỉ sửa một đoạn nhỏ (project_edit_file) để giữ nguyên phần còn lại.",
          speed_profile: "nhanh; xoá cache read/list/search của path bị ảnh hưởng.",
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
        "Sửa file bằng thay thế văn bản chính xác: một cặp old_text/new_text, hoặc edits[] cho nhiều đoạn.",
        "Edit file",
        {
          use_when: "sửa một hoặc vài đoạn text đã biết chính xác; có thể kèm expected_sha256 để chống ghi đè.",
          avoid_when: "cần đổi toàn bộ file (project_write_file) hoặc chưa đọc file để biết old_text.",
          speed_profile: "nhanh; xoá cache read/list/search của path bị ảnh hưởng.",
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
      ...config("Tạo thư mục (create_parents mặc định true).", "Create directory", {
        use_when: "cần tạo thư mục trước khi ghi file vào path mới.",
        avoid_when: "thư mục đã tồn tại hoặc chỉ cần ghi file với create_dirs=true.",
        speed_profile: "nhanh.",
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
      ...config("Xoá file hoặc thư mục (thư mục cần recursive=true).", "Delete path", {
        use_when: "cần xoá hẳn file/thư mục; đã xác định đúng path.",
        avoid_when: "chỉ cần thay nội dung (write/edit). Đây là thao tác không hoàn tác.",
        speed_profile: "nhanh; xoá cache read/list/search.",
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
        `Chạy lệnh shell (cwd mặc định ${WORKSPACE}). Trả run_id ngay; dùng project_shell_status để lấy output.`,
        "Shell run (async)",
        {
          use_when: "build/test/lint/lệnh chạy lâu; trả run_id ngay nên không chặn tool khác.",
          avoid_when: "lệnh cực ngắn mà bạn cần output ngay (vẫn có thể chạy rồi poll 0s).",
          speed_profile: "trả về trong ~5ms; thời gian chạy do lệnh quyết định.",
          output_kind: "shell_run: run_id, running, exit_code, stdout_tail/stderr_tail.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        shell: z.enum(["powershell", "cmd", "bash"]).optional(),
        command: z.string(),
        relative_cwd: z.string().optional(),
      },
    },
    (args) => runOne("shell_run", args),
  );

  server.registerTool(
    "project_shell_status",
    {
      ...config(
        "Xem trạng thái + output của lệnh đang chạy. wait_seconds (0..30) chỉ là thời gian chờ quan sát, không phải timeout.",
        "Shell status",
        {
          use_when: "sau project_shell_run; poll cho tới khi running=false.",
          avoid_when: "chưa có run_id.",
          speed_profile: "nhanh; không xếp hàng nên không chặn tool khác.",
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
      ...config("Dừng một lệnh shell đang chạy theo run_id.", "Shell cancel", {
        use_when: "lệnh chạy quá lâu hoặc không còn cần kết quả.",
        avoid_when: "lệnh đã kết thúc (kiểm tra bằng project_shell_status).",
        speed_profile: "nhanh.",
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
        "Tạo thư mục HOẶC file trong MỘT lần gọi (gộp project_create_directory + project_write_file cho trường hợp mới).",
        "Create file or directory",
        {
          use_when: "tạo thư mục (kind=directory) hoặc file mới (kind=file, content+mode); đồng bộ với tool native của app Venira.",
          avoid_when: "sửa file có sẵn (project_edit_file); ghi đè file đã có mà cần giữ nguyên (project_write_file mode=overwrite vẫn được).",
          speed_profile: "nhanh; tạo cache invalidation khi ghi/thư mục mới.",
          output_kind: "directory_created hoặc file_written (kind data theo thao tác).",
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
        "Chẩn đoán server: corehost/data dir/audit DB, capability, queue depth, cache hit-rate, shell đang chạy, metrics p50/p95.",
        "Health & metrics",
        {
          use_when: "debug chậm/lỗi, kiểm tra corehost/DB/audit trước khi báo lỗi, hoặc xem cache/metrics của phiên.",
          avoid_when: "đang cần đọc/ghi file bình thường.",
          speed_profile: "nhanh (~vài ms + 1 query DB audit); include_audit=false để bỏ query DB.",
          output_kind: "health: server, corehost, capability, queue, caches, shells, metrics, audit.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: { include_audit: z.boolean().optional() },
    },
    (args) => runHealth(args as Args),
  );
}
