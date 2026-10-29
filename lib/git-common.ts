/**
 * Argument helpers, response shaping and log trimming shared by every dialect.
 * Keeping them here means GitHub/GitLab/Bitbucket return the same envelope.
 */
import zlib from "node:zlib";

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

export function prNumberFrom(args: Record<string, unknown>, key = "pr"): number {
  const raw = args[key];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const direct = Number(raw.trim());
    if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
    const match = /\/(?:pull|pulls|issues|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(raw);
    if (match) return Number(match[1]);
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
 * are skipped rather than guessed.
 */
export function readZipEntries(buf: Buffer, entryMaxBytes: number): ZipEntry[] {
  const eocd = findZipEocd(buf);
  if (eocd < 0) throw new Error("[provider_error] Log archive is not a valid ZIP (no end-of-central-directory record).");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error("[provider_error] ZIP64 log archives are not supported.");
  }
  if (cdOffset > buf.length) throw new Error("[provider_error] Log archive central directory is out of range.");

  const entries: ZipEntry[] = [];
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
  const parsed = readZipEntries(buffer, entryMaxBytes);
  const parts: string[] = [];
  for (const entry of parsed) {
    if (entry.skipped || entry.data.length === 0) {
      entries.push({ name: entry.name, bytes: entry.data.length, ...(entry.skipped ? { skipped: entry.skipped } : {}) });
      continue;
    }
    const chunk = `##### ${entry.name} #####\n${entry.data.toString("utf8")}`;
    if (Buffer.byteLength(parts.join("\n\n"), "utf8") + Buffer.byteLength(chunk, "utf8") > textMaxBytes) {
      entries.push({ name: entry.name, bytes: entry.data.length, skipped: "output cap" });
      continue;
    }
    parts.push(chunk);
    entries.push({ name: entry.name, bytes: entry.data.length });
  }
  return { text: parts.join("\n\n"), entries };
}
