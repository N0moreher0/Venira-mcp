/**
 * Standardizes the envelope returned by every venira tool:
 *   { ok, status, request_id, kind, data, truncated, summary, hint, cached, elapsed_ms }
 * and on failure:
 *   { ok:false, status:"failed", request_id, kind, error:{code, message, retryable}, hint, elapsed_ms }
 */
import { randomBytes } from "node:crypto";

export type OutputMode = "full" | "compact" | "summary";

function outputModeFromEnv(): OutputMode {
  const raw = (process.env.VENIRA_OUTPUT_MODE ?? "full").trim().toLowerCase();
  return raw === "compact" || raw === "summary" ? raw : "full";
}

export const OUTPUT_MODE: OutputMode = outputModeFromEnv();
export const PRETTY = process.env.VENIRA_PRETTY === "1";

export const stringify = (value: unknown): string =>
  PRETTY ? JSON.stringify(value, null, 2) : JSON.stringify(value);
export const newRequestId = (): string => randomBytes(12).toString("hex");

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function toolResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

export type RustResponse = {
  status?: string;
  request_id?: string;
  truncated?: boolean;
  hint?: string;
  result?: { kind?: string; data?: unknown };
};

export type Envelope = {
  ok: boolean;
  status: string;
  request_id: string;
  kind: string;
  data?: unknown;
  summary?: unknown;
  hint?: string;
  truncated?: boolean;
  cached?: boolean;
  trimmed?: boolean;
  elapsed_ms?: number;
};

const PREVIEW_BYTES = 8 * 1024;
const SUMMARY_THRESHOLD_BYTES = 8 * 1024;

type Loose = Record<string, any>;

const round = (ms: number) => Math.round(ms * 100) / 100;
const isObject = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function inferHint(kind: string, data: unknown): string | undefined {
  if (!isObject(data)) return undefined;
  if (kind === "file_read") {
    if (data.truncated === true && data.next_start_line !== undefined) {
      return `Next chunk: project_read_file({ relative_path: "${data.relative_path}", start_line: ${data.next_start_line} }).`;
    }
    return undefined;
  }
  if (kind === "file_list") {
    if (typeof data.hint === "string" && data.hint) return data.hint;
    if (data.truncated === true) return "Result truncated: raise limit (max 200) or narrow relative_path/depth.";
    return undefined;
  }
  if (kind === "search") {
    if (typeof data.hint === "string" && data.hint) return data.hint;
    const hits = Array.isArray(data.hits) ? data.hits : [];
    if (hits.length === 0) {
      return "No matches. Broaden the search: drop glob/relative_path, set regex=false, or use kind=file_name.";
    }
    if (data.complete === false) {
      return "Search incomplete (see diagnostics). Narrow with relative_path/glob or raise limit (max 200).";
    }
    return undefined;
  }
  if (kind === "shell_run" && data.running === true) {
    return `Poll project_shell_status({ run_id: "${data.run_id}", wait_seconds: 5 }).`;
  }
  if (kind === "file_read_ranges" && data.truncated === true) {
    return "Some ranges were truncated; continue with next_start_line.";
  }
  return undefined;
}

export function summarize(kind: string, data: unknown): unknown {
  if (!isObject(data)) return undefined;
  if (kind === "file_read") {
    const text = typeof data.text === "string" ? data.text : "";
    const first = Number(data.first_line ?? 0);
    const last = Number(data.last_line ?? 0);
    return {
      relative_path: data.relative_path,
      first_line: first,
      last_line: last,
      lines_returned: last >= first ? last - first + 1 : 0,
      text_bytes: Buffer.byteLength(text, "utf8"),
      total_bytes: data.total_bytes,
      truncated: data.truncated === true,
      ...(data.next_start_line !== undefined ? { next_start_line: data.next_start_line } : {}),
    };
  }
  if (kind === "file_list") {
    const entries = Array.isArray(data.entries) ? (data.entries as Loose[]) : [];
    const files = entries.filter((entry) => entry.kind === "file").length;
    return {
      entry_count: entries.length,
      files,
      directories: entries.length - files,
      truncated: data.truncated === true,
      paths_preview: entries.slice(0, 5).map((entry) => entry.relative_path),
    };
  }
  if (kind === "search") {
    const hits = Array.isArray(data.hits) ? (data.hits as Loose[]) : [];
    const files = new Set(hits.map((hit) => hit.relative_path));
    const summary: Loose = {
      match_count: hits.length,
      files_matched: files.size,
      complete: data.complete !== false,
      diagnostics: data.diagnostics ?? [],
      matches_preview: hits.slice(0, 8).map((hit) => ({
        relative_path: hit.relative_path,
        line_number: hit.line_number ?? null,
        snippet: typeof hit.snippet === "string" ? hit.snippet.slice(0, 120) : null,
      })),
    };
    if (data.total_match_lines !== undefined) summary.total_match_lines = data.total_match_lines;
    if (data.files_matched !== undefined) summary.files_matched_total = data.files_matched;
    if (typeof data.hint === "string" && data.hint) summary.suggested_narrowing = data.hint;
    return summary;
  }
  if (kind === "file_info") {
    return {
      relative_path: data.relative_path,
      kind: data.kind,
      size_bytes: data.size_bytes,
      modified_unix_seconds: data.modified_unix_seconds,
    };
  }
  if (kind === "file_written") {
    return {
      relative_path: data.relative_path,
      action: data.action,
      bytes_written: data.bytes_written,
      replacements: data.replacements,
      sha256_after: data.sha256_after,
    };
  }
  if (kind === "path_deleted") {
    return {
      relative_path: data.relative_path,
      kind: data.kind,
      entries_deleted: data.entries_deleted,
      bytes_deleted: data.bytes_deleted,
    };
  }
  if (kind === "shell_run") {
    const stdout = typeof data.stdout_tail === "string" ? data.stdout_tail : "";
    const stderr = typeof data.stderr_tail === "string" ? data.stderr_tail : "";
    return {
      run_id: data.run_id,
      shell: data.shell,
      running: data.running === true,
      exit_code: data.exit_code ?? null,
      cancelled: data.cancelled === true,
      stdout_bytes: Buffer.byteLength(stdout, "utf8"),
      stderr_bytes: Buffer.byteLength(stderr, "utf8"),
      truncated: data.truncated === true,
    };
  }
  if (kind === "file_read_ranges") {
    const ranges = Array.isArray(data.ranges) ? (data.ranges as Loose[]) : [];
    return {
      relative_path: data.relative_path,
      range_count: ranges.length,
      failed: ranges.filter((range) => range.ok === false).length,
      truncated: data.truncated === true,
      next_start_lines: ranges
        .filter((range) => range.ok !== false && range.next_start_line !== undefined)
        .map((range) => range.next_start_line),
    };
  }
  return undefined;
}

export function previewData(kind: string, data: unknown): unknown {
  if (!isObject(data)) return data;
  if (kind === "file_read") {
    const text = typeof data.text === "string" ? data.text : "";
    const preview = text.slice(0, PREVIEW_BYTES);
    return {
      relative_path: data.relative_path,
      first_line: data.first_line,
      last_line: data.last_line,
      total_bytes: data.total_bytes,
      truncated: data.truncated === true,
      ...(data.next_start_line !== undefined ? { next_start_line: data.next_start_line } : {}),
      preview,
      preview_truncated: text.length > preview.length,
    };
  }
  if (kind === "file_list") {
    const entries = Array.isArray(data.entries) ? (data.entries as unknown[]) : [];
    return {
      entries_preview: entries.slice(0, 20),
      entry_count: entries.length,
      truncated: data.truncated === true,
      ...(typeof data.hint === "string" ? { hint: data.hint } : {}),
    };
  }
  if (kind === "search") {
    const hits = Array.isArray(data.hits) ? (data.hits as unknown[]) : [];
    const out: Loose = {
      matches_preview: hits.slice(0, 20),
      match_count: hits.length,
      complete: data.complete !== false,
      diagnostics: data.diagnostics ?? [],
    };
    if (data.total_match_lines !== undefined) out.total_match_lines = data.total_match_lines;
    if (data.files_matched !== undefined) out.files_matched = data.files_matched;
    if (data.files !== undefined) out.files = data.files;
    if (typeof data.hint === "string") out.hint = data.hint;
    return out;
  }
  if (kind === "shell_run") {
    return {
      ...data,
      stdout_tail: typeof data.stdout_tail === "string" ? data.stdout_tail.slice(-2000) : data.stdout_tail,
      stderr_tail: typeof data.stderr_tail === "string" ? data.stderr_tail.slice(-2000) : data.stderr_tail,
    };
  }
  return data;
}

export type EnvelopeOptions = {
  requestId?: string;
  elapsedMs?: number;
  cached?: boolean;
  hint?: string;
};

export function buildEnvelope(
  operation: string,
  response: RustResponse | undefined,
  options: EnvelopeOptions = {},
): Envelope {
  const data = response?.result?.data;
  const kind = response?.result?.kind ?? operation;
  const truncated = response?.truncated === true;
  const hint = options.hint ?? inferHint(kind, data);

  const envelope: Envelope = {
    ok: true,
    status: response?.status ?? "completed",
    request_id: options.requestId ?? newRequestId(),
    kind,
    elapsed_ms: round(options.elapsedMs ?? 0),
  };
  if (truncated) envelope.truncated = true;
  if (options.cached) envelope.cached = true;
  if (hint) envelope.hint = hint;

  if (OUTPUT_MODE === "summary") {
    envelope.data = previewData(kind, data);
    const summary = summarize(kind, data);
    if (summary !== undefined) envelope.summary = summary;
    envelope.trimmed = true;
    const trimHint = "Output mode summary: payload trimmed; set VENIRA_OUTPUT_MODE=full for complete data.";
    envelope.hint = envelope.hint ? `${envelope.hint} ${trimHint}` : trimHint;
    return envelope;
  }

  envelope.data = data;
  const summary = summarize(kind, data);
  if (summary !== undefined) {
    const tooBig =
      OUTPUT_MODE === "compact" || stringify(data ?? null).length > SUMMARY_THRESHOLD_BYTES;
    if (tooBig) envelope.summary = summary;
  }
  return envelope;
}

export type Failure = {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
};

const RETRYABLE = new Set(["io_error", "capability_expired", "host_timeout", "host_unavailable"]);

const DEFAULT_HINTS: Record<string, string> = {
  invalid_request: "Check argument names/types; unknown fields are rejected.",
  not_found: "Check the path with project_list_files or project_search first; do not retry the same path.",
  conflict: "The file changed or the edit is ambiguous; re-read it and retry.",
  scope_denied: "Use a path inside the workspace (workspace-relative is safest).",
  path_escape: "Paths must stay inside the workspace. Use a relative path under it, or enable VENIRA_UNRESTRICTED=1.",
  resource_limit: "Narrow the request: smaller limit/max_bytes, line ranges, or project_read_batch.",
  audit_unavailable:
    "The host refused the operation because its audit row could not be written. Tell the user; do not retry in a loop.",
  capability_expired: "The scope is reopened automatically on the next call; retry once.",
  sensitive_result: "Content withheld for safety; do not retry or work around it.",
  unsupported: "The operation is unavailable in the current permission mode or for this file type.",
  io_error: "The file may be locked or the disk busy; retry once.",
  host_timeout: "The backend did not answer in time; check project_health, then retry once.",
  host_unavailable: "The backend is unavailable; it restarts on the next call. Retry once.",
  internal: "Unexpected error; check project_health and the server stderr log.",
};

function classify(raw: string): string {
  if (/outside (the )?workspace/i.test(raw)) return "path_escape";
  if (/timed out|timeout/i.test(raw)) return "host_timeout";
  if (/corehost exited|EPIPE/i.test(raw)) return "host_unavailable";
  if (/ENOENT|not found|does not exist/i.test(raw)) return "not_found";
  if (/EACCES|EPERM|access is denied|permission denied/i.test(raw)) return "io_error";
  return "internal";
}

export function parseToolError(error: unknown): Failure {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  const match = /^\[([a-z0-9_]+)\]\s*([\s\S]*)$/i.exec(raw);
  let code = match ? match[1].toLowerCase() : "";
  let body = match ? match[2].trim() : raw;
  if (!code) code = classify(raw);

  let hint: string | undefined;
  const hintAt = body.indexOf(" Hint: ");
  if (hintAt >= 0) {
    hint = body.slice(hintAt + " Hint: ".length).trim();
    body = body.slice(0, hintAt).trim();
  }
  if (!hint) hint = DEFAULT_HINTS[code];

  return {
    code,
    message: body || raw,
    hint,
    retryable: RETRYABLE.has(code),
  };
}

export function errorEnvelope(
  operation: string,
  error: unknown,
  options: EnvelopeOptions = {},
): Envelope & { error: { code: string; message: string; retryable: boolean } } {
  const failure = parseToolError(error);
  return {
    ok: false,
    status: "failed",
    request_id: options.requestId ?? newRequestId(),
    kind: operation,
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    },
    ...(failure.hint ? { hint: failure.hint } : {}),
    elapsed_ms: round(options.elapsedMs ?? 0),
  };
}

export function batchEnvelope(
  requestId: string,
  responses: unknown[],
  elapsedMs: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    status: "completed",
    request_id: requestId,
    kind: "read_batch",
    data: { responses, count: responses.length, ...extra },
    elapsed_ms: round(elapsedMs),
  };
}
