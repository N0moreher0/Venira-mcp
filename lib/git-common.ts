/**
 * Argument helpers, response shaping and log trimming shared by every dialect.
 * Keeping them here means GitHub/GitLab/Bitbucket return the same envelope.
 */
import zlib from "node:zlib";
import { prNumberFromUrl } from "./git-repo.js";

export type Resp = {
  status?: string;
  truncated?: boolean;
  hint?: string;
  result?: { kind?: string; data?: unknown };
};

export function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

export function requireText(args: Record<string, unknown>, key: string, hint: string): string {
  const value = text(args, key);
  if (!value) throw new Error(`[invalid_request] \`${key}\` is required. Hint: ${hint}`);
  return value;
}

/**
 * Number of CI selectors set among run_id / ref / pr / branch (blank values do
 * not count). Shared by `project_ci_status` (0..1 allowed) and
 * `project_ci_wait` (exactly 1) so both tools define "a selector" identically.
 * `workflow` is not a selector: it only narrows `branch` or the recent-runs list.
 */
export function selectorCount(args: Record<string, unknown>): number {
  let count = 0;
  if (args.run_id !== undefined && args.run_id !== null && String(args.run_id).trim() !== "") count += 1;
  if (typeof args.ref === "string" && args.ref.trim() !== "") count += 1;
  if (args.pr !== undefined && args.pr !== null && String(args.pr).trim() !== "") count += 1;
  if (typeof args.branch === "string" && args.branch.trim() !== "") count += 1;
  return count;
}

export function prNumberFrom(args: Record<string, unknown>, key = "pr"): number {
  const raw = args[key];
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1 && Number.isSafeInteger(Math.floor(raw))) return Math.floor(raw);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d{1,15}$/.test(trimmed)) {
      const direct = Number(trimmed);
      if (direct > 0) return direct;
    }
    const fromUrl = prNumberFromUrl(raw);
    if (fromUrl !== null) return fromUrl;
  }
  throw new Error(
    `[invalid_request] \`${key}\` must be a PR number or a pull/merge-request URL. ` +
      `Hint: e.g. pr=12 or pr="https://github.com/owner/name/pull/12".`,
  );
}

export function ok(kind: string, data: unknown, extra: { hint?: string; truncated?: boolean } = {}): Resp {
  return {
    status: "completed",
    result: { kind, data },
    ...(extra.hint ? { hint: extra.hint } : {}),
    ...(extra.truncated ? { truncated: true } : {}),
  };
}

export type CiControlAction = "cancel" | "retry_failed";

export function ciControlRequest(args: Record<string, unknown>): { action: CiControlAction; runId: string } {
  const action = text(args, "action");
  if (action !== "cancel" && action !== "retry_failed") {
    throw new Error('[invalid_request] `action` must be "cancel" or "retry_failed".');
  }
  requireText(args, "reason", 'pass a short reason for the audited CI action.');
  const raw = args.run_id;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new Error("[invalid_request] `run_id` must be a positive safe integer or provider run ID.");
    }
    return { action, runId: String(raw) };
  }
  const runId = typeof raw === "string" ? raw.trim() : "";
  if (!runId || runId.length > 80) {
    throw new Error("[invalid_request] `run_id` is required and must be at most 80 characters.");
  }
  return { action, runId };
}

export function numericCiRunId(runId: string): string {
  if (!/^\d{1,16}$/.test(runId)) {
    throw new Error("[invalid_request] This provider requires a numeric CI `run_id`.");
  }
  const numeric = Number(runId);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error("[invalid_request] `run_id` must be a positive safe integer.");
  }
  return String(numeric);
}

export function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

export function tailLines(content: string, lines: number): { text: string; dropped: number } {
  // A trailing newline would otherwise make the "last line" empty.
  const body = content.replace(/\r?\n$/, "");
  const parts = body.split(/\r?\n/);
  if (parts.length <= lines) return { text: body, dropped: 0 };
  return { text: parts.slice(-lines).join("\n"), dropped: parts.length - lines };
}

export function tailBytes(content: string, maxBytes: number): { text: string; dropped: number } {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= maxBytes) return { text: content, dropped: 0 };
  // Cut on a UTF-8 boundary: drop partial leading bytes.
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return { text: buf.subarray(start).toString("utf8"), dropped: start };
}

export function overallFrom(runs: Array<Record<string, unknown>>): string {
  if (runs.length === 0) return "no_runs";
  const active = runs.some(
    (r) => r.status === "in_progress" || r.status === "queued" || r.status === "requested" || r.status === "waiting" || r.status === "pending" || r.status === "running",
  );
  if (active) return "in_progress";
  const failed = runs.some((r) =>
    ["failure", "failed", "timed_out", "cancelled", "canceled", "startup_failure", "action_required", "error"].includes(String(r.conclusion)),
  );
  return failed ? "failure" : "success";
}

export function overallFromChecks(checks: Array<Record<string, unknown>>): string {
  if (checks.length === 0) return "no_checks";
  const active = checks.some((c) => ["queued", "in_progress", "requested", "waiting", "pending"].includes(String(c.status)));
  if (active) return "in_progress";
  const failed = checks.some((c) =>
    ["failure", "timed_out", "cancelled", "startup_failure", "action_required", "neutral"].includes(String(c.conclusion)),
  );
  return failed ? "failure" : "success";
}

// ---------------------------------------------------------------------------
// Bounded listings
// ---------------------------------------------------------------------------

const NOT_GREEN = new Set([
  "failure",
  "failed",
  "timed_out",
  "cancelled",
  "canceled",
  "startup_failure",
  "action_required",
  "error",
  "neutral",
]);

function ciRank(item: Record<string, unknown>): number {
  if (NOT_GREEN.has(String(item.conclusion))) return 0;
  if (item.status !== "completed") return 1;
  return 2;
}

/**
 * Keep provider order while everything fits in `limit`. Only when the list has
 * to be cut do failing and still-running items move to the front, so the cut
 * can never hide the item the verdict (`overall`) was derived from.
 */
export function listWithPriority<T extends Record<string, unknown>>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return items
    .map((item, index) => ({ item, index, rank: ciRank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// ZIP (GitHub run logs, Bitbucket step logs may be plain text)
// ---------------------------------------------------------------------------

export type ZipEntry = { name: string; data: Buffer; method: number; skipped?: string };

function findZipEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * Minimal ZIP reader: central directory → local header → raw/deflate payload.
 * Only what provider log archives use; unsupported (zip64/encrypted) entries
 * are skipped rather than guessed. `totalMaxBytes` bounds the *cumulative*
 * inflated size so an archive of many individually-small entries cannot burn
 * CPU/memory (decompression-bomb guard); later entries are skipped, not guessed.
 */
export function readZipEntries(buf: Buffer, entryMaxBytes: number, totalMaxBytes = Number.POSITIVE_INFINITY): ZipEntry[] {
  const eocd = findZipEocd(buf);
  if (eocd < 0) throw new Error("[provider_error] Log archive is not a valid ZIP (no end-of-central-directory record).");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error("[provider_error] ZIP64 log archives are not supported.");
  }
  if (cdOffset > buf.length) throw new Error("[provider_error] Log archive central directory is out of range.");

  const entries: ZipEntry[] = [];
  let inflated = 0;
  let cursor = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;

    const entry: ZipEntry = { name, data: Buffer.alloc(0), method };
    if (flags & 0x1) {
      entry.skipped = "encrypted";
      entries.push(entry);
      continue;
    }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      entry.skipped = "zip64";
      entries.push(entry);
      continue;
    }
    if (uncompSize > entryMaxBytes) {
      entry.skipped = `entry too large (${uncompSize} bytes)`;
      entries.push(entry);
      continue;
    }
    if (inflated + uncompSize > totalMaxBytes) {
      entry.skipped = `inflate budget exhausted (${totalMaxBytes} bytes)`;
      entries.push(entry);
      continue;
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      entry.skipped = "bad local header";
      entries.push(entry);
      continue;
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + compSize > buf.length) {
      entry.skipped = "truncated payload";
      entries.push(entry);
      continue;
    }
    const raw = buf.subarray(start, start + compSize);
    try {
      if (method === 0) entry.data = Buffer.from(raw);
      else if (method === 8) entry.data = zlib.inflateRawSync(raw, { maxOutputLength: entryMaxBytes });
      else entry.skipped = `unsupported compression (${method})`;
    } catch (error) {
      entry.skipped = `inflate failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    inflated += entry.data.length;
    entries.push(entry);
  }
  return entries;
}

/** Turn a raw log buffer (ZIP or plain text) into `{ text, entries }`. */
export function logBufferToText(
  buffer: Buffer,
  label: string,
  entryMaxBytes: number,
  textMaxBytes: number,
): { text: string; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  if (buffer.subarray(0, 2).toString("latin1") !== "PK") {
    return { text: buffer.toString("utf8"), entries: [{ name: `${label}.log`, bytes: buffer.length }] };
  }
  const parsed = readZipEntries(buffer, entryMaxBytes, Math.max(textMaxBytes, entryMaxBytes));
  const parts: string[] = [];
  let used = 0;
  for (const entry of parsed) {
    if (entry.skipped || entry.data.length === 0) {
      entries.push({ name: entry.name, bytes: entry.data.length, ...(entry.skipped ? { skipped: entry.skipped } : {}) });
      continue;
    }
    const chunk = `##### ${entry.name} #####\n${entry.data.toString("utf8")}`;
    const chunkBytes = Buffer.byteLength(chunk, "utf8") + (parts.length > 0 ? 2 : 0);
    if (used + chunkBytes > textMaxBytes) {
      entries.push({ name: entry.name, bytes: entry.data.length, skipped: "output cap" });
      continue;
    }
    parts.push(chunk);
    used += chunkBytes;
    entries.push({ name: entry.name, bytes: entry.data.length });
  }
  return { text: parts.join("\n\n"), entries };
}

/**
 * Entries that were left out of a log (too large, over the output cap, inflate
 * budget, unsupported, or steps never downloaded). A failing step can be the
 * one that got skipped, so callers must surface this instead of returning an
 * innocent-looking empty/short text.
 */
export function skippedLogEntries(entries: Array<Record<string, unknown>>): { count: number; names: string[]; hint: string | null } {
  const skipped = entries.filter((entry) => typeof entry.skipped === "string" && entry.skipped.length > 0);
  if (skipped.length === 0) return { count: 0, names: [], hint: null };
  const names = skipped.slice(0, 5).map((entry) => String(entry.name ?? "?"));
  const reasons = [...new Set(skipped.map((entry) => String(entry.skipped).replace(/\s*\(.*\)$/, "")))].join(", ");
  return {
    count: skipped.length,
    names,
    hint:
      `${skipped.length} log entr${skipped.length === 1 ? "y was" : "ies were"} skipped (${reasons}): ${names.join(", ")}${skipped.length > names.length ? ", ..." : ""}. ` +
      `Hint: fetch the failing job/step on its own, or raise VENIRA_GIT_LOG_ENTRY_BYTES / VENIRA_GIT_LOG_TEXT_BYTES.`,
  };
}
