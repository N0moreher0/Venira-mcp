/**
 * Audit detail: what a job was asked to do and what it returned, kept next to the audit row.
 *
 * The audit row itself (lib/audit-store.ts) is a hash-chained, tamper-evident log of *that* a call
 * happened. It deliberately carries only an `args_hash`, so it could never say *what* a call did or
 * *what came back*. This module builds the readable part and stores it in a separate table keyed by
 * `request_id`; the hash chain is untouched.
 *
 * VENIRA_AUDIT_DETAIL controls how much is kept:
 *   off      nothing
 *   summary  (default) one-line args and result per job (a few hundred bytes)
 *   full     summary plus the redacted, size-capped args and result JSON
 *
 * Everything is redacted before it is stored. Bulk text (file contents, edit bodies, secret values)
 * is never stored: it is replaced by its length.
 */
import { envChoice } from "./env.js";
import { redactSecretValues } from "./secrets.js";
import { redactSecrets } from "./shell-policy.js";

export const AUDIT_DETAIL_MODES = ["off", "summary", "full"] as const;
export type AuditDetailMode = (typeof AUDIT_DETAIL_MODES)[number];

export type AuditDetail = {
  args_summary: string;
  result_summary: string;
  args_json: string | null;
  result_json: string | null;
  result_bytes: number;
  stored_truncated: boolean;
};

export function auditDetailMode(): AuditDetailMode {
  return envChoice("VENIRA_AUDIT_DETAIL", "summary", AUDIT_DETAIL_MODES);
}

/** Keys whose string values are bulk or sensitive: only their length is kept. */
const BULK_KEYS = new Set([
  "content",
  "new_text",
  "old_text",
  "new_str",
  "old_str",
  "text",
  "preview",
  "value",
  "body",
  "diff",
  "unified_diff",
  "snippet",
  "context",
  "commit_message",
]);
const SECRET_KEY = /token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key/i;
/** Result fields that identify the run but say nothing about the outcome. */
const NOISE_KEYS = new Set([
  "kill_key",
  "run_id",
  "shell_id",
  "request_id",
  "sha256",
  "text_sha256",
  "sha256_after",
  "sha256_before",
  "sha256_scope",
  "mtime_ms",
  "elapsed_ms",
  "shell_path",
  "shell_kind",
  "dropped_bytes",
]);

const FULL_JSON_CAP = 16 * 1024;
const FULL_STRING_CAP = 2000;
const FULL_ARRAY_CAP = 20;
const MAX_DEPTH = 6;

function scrub(text: string): string {
  return redactSecretValues(redactSecrets(text));
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
}

function shape(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return clip(scrub(value), FULL_STRING_CAP);
  if (value === undefined || typeof value === "function") return null;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, FULL_ARRAY_CAP).map((item) => shape(item, depth + 1));
    if (value.length > FULL_ARRAY_CAP) items.push(`[+${value.length - FULL_ARRAY_CAP} more]`);
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "string" && SECRET_KEY.test(key)) out[key] = "[redacted]";
      else if (typeof item === "string" && BULK_KEYS.has(key)) out[key] = `[${item.length} chars]`;
      else out[key] = shape(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function describeScalar(key: string, value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") return `${key}=${value}`;
  if (typeof value !== "string") return null;
  if (SECRET_KEY.test(key)) return `${key}=[redacted]`;
  if (BULK_KEYS.has(key)) return `${key}=[${value.length} chars]`;
  return `${key}=${clip(scrub(value), 80)}`;
}

export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (Array.isArray(value)) parts.push(`${key}=[${value.length} items]`);
    else if (value && typeof value === "object") parts.push(`${key}={…}`);
    else {
      const scalar = describeScalar(key, value);
      if (scalar) parts.push(scalar);
    }
  }
  return clip(parts.join(", "), 240);
}

function lastLine(text: unknown, max: number): string | null {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? clip(scrub(lines[lines.length - 1]), max) : null;
}

export function summarizeResult(response: unknown): string {
  const r = (response ?? {}) as { status?: unknown; result?: { kind?: unknown; data?: unknown }; truncated?: unknown };
  const parts: string[] = [];
  if (typeof r.status === "string") parts.push(r.status);
  if (typeof r.result?.kind === "string") parts.push(r.result.kind);
  const data = r.result?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    let scalars = 0;
    for (const [key, value] of Object.entries(record)) {
      if (scalars >= 6) break;
      if (NOISE_KEYS.has(key)) continue;
      if (typeof value === "string" && value.length > 60) continue;
      const scalar = describeScalar(key, value);
      if (scalar) {
        parts.push(scalar);
        scalars += 1;
      }
    }
    // A shell job's outcome lives in its output: keep the last meaningful line.
    const errLine = lastLine(record.stderr ?? record.stderr_tail, 120);
    const outLine = lastLine(record.stdout ?? record.stdout_tail, 120);
    if (errLine) parts.push(`stderr: ${errLine}`);
    else if (outLine) parts.push(`stdout: ${outLine}`);
  }
  if (r.truncated === true) parts.push("truncated");
  return clip(parts.join(" · "), 360);
}

export function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return clip(`error: ${scrub(message)}`, 360);
}

function jsonCapped(value: unknown): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(shape(value, 0)) ?? "null";
  } catch {
    text = JSON.stringify("[unserializable]");
  }
  if (text.length <= FULL_JSON_CAP) return { text, truncated: false };
  return { text: text.slice(0, FULL_JSON_CAP), truncated: true };
}

export type AuditOutcome = { ok: true; response: unknown } | { ok: false; error: unknown };

/** Build what is stored next to the audit row; null when VENIRA_AUDIT_DETAIL=off (or is invalid). */
export function buildAuditDetail(args: unknown, outcome: AuditOutcome): AuditDetail | null {
  let mode: AuditDetailMode;
  try {
    mode = auditDetailMode();
  } catch {
    return null; // a bad value is reported once at startup; never fail a tool call over it
  }
  if (mode === "off") return null;
  const result = outcome.ok ? outcome.response : { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) };
  let resultBytes = 0;
  try {
    resultBytes = JSON.stringify(result)?.length ?? 0;
  } catch {
    resultBytes = 0;
  }
  const detail: AuditDetail = {
    args_summary: summarizeArgs(args),
    result_summary: outcome.ok ? summarizeResult(outcome.response) : summarizeError(outcome.error),
    args_json: null,
    result_json: null,
    result_bytes: resultBytes,
    stored_truncated: false,
  };
  if (mode === "full") {
    const a = jsonCapped(args);
    const r = jsonCapped(result);
    detail.args_json = a.text;
    detail.result_json = r.text;
    detail.stored_truncated = a.truncated || r.truncated;
  }
  return detail;
}
