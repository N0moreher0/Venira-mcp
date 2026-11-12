/**
 * Standardizes the envelope returned by every venira tool:
 *   { ok, status, request_id, kind, data, truncated, summary, hint, cached, command_status, elapsed_ms }
 * and on failure:
 *   { ok:false, status:"failed", request_id, kind, error:{code, message, retryable}, hint, elapsed_ms }
 */
import { randomBytes } from "node:crypto";
import { envChoice, envFlag } from "./env.js";

export type OutputMode = "full" | "compact";

export const OUTPUT_MODE: OutputMode = envChoice("VENIRA_OUTPUT_MODE", "full", ["full", "compact"]);
export const PRETTY = envFlag("VENIRA_PRETTY", false);

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
  next_actions?: unknown[];
  truncated?: boolean;
  /** A limit cut the result (a list, a search). */
  limited?: boolean;
  /** The content was not fully returned (a file read, a range). */
  incomplete?: boolean;
  cached?: boolean;
  trimmed?: boolean;
  /** Some items of a batch succeeded while others failed (roadmap item 15, P1). */
  partial?: boolean;
  command_status?: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  elapsed_ms?: number;
};

const PREVIEW_BYTES = 8 * 1024;
// A file read is the content the caller asked for, so compact mode keeps far more of it than of a list or search.
const FILE_PREVIEW_BYTES = 32 * 1024;
const SUMMARY_THRESHOLD_BYTES = 8 * 1024;
const GENERIC_PREVIEW_BYTES = PREVIEW_BYTES / 2;

type Loose = Record<string, any>;

const round = (ms: number) => Math.round(ms * 100) / 100;
const isObject = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(stringify(value) ?? "null", "utf8");
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  let end = 0;
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) return { text: value.slice(0, end), truncated: true };
    bytes += characterBytes;
    end += character.length;
  }
  return { text: value, truncated: false };
}

function commandStatus(data: Loose): NonNullable<Envelope["command_status"]> {
  if (data.running === true) return "running";
  if (data.cancelled === true) return "cancelled";
  if (data.timed_out === true) return "failed";
  if (typeof data.exit_code !== "number") return "unknown";
  return data.exit_code === 0 ? "succeeded" : "failed";
}

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
      return "No matches. Broaden the search: drop glob/relative_path, set regex=0, or use kind=file_name.";
    }
    if (data.complete === false) {
      return "Search incomplete (see diagnostics). Narrow with relative_path/glob or raise limit (max 200).";
    }
    return undefined;
  }
  if (kind === "shell_run" && data.running === true) {
    const timeoutNote = data.timed_out === true ? " It exceeded its time budget but is still running." : "";
    return `Command is still running.${timeoutNote} Poll project_shell_status({ run_id: "${data.run_id}", wait_seconds: 5 }).`;
  }
  if (kind === "shell_run" && data.cancelled === true) {
    return "Command was cancelled. Check its partial stdout/stderr before deciding whether to rerun.";
  }
  if (kind === "shell_run" && data.timed_out === true) {
    return `Command timed out${typeof data.exit_code === "number" ? ` (exit_code ${data.exit_code})` : ""}. Read stderr, adjust the timeout or command, then rerun.`;
  }
  if (kind === "shell_run" && typeof data.exit_code === "number" && data.exit_code !== 0) {
    return `Command failed (exit_code ${data.exit_code}). Read stderr, fix, rerun; project_explain_error can diagnose it.`;
  }
  if (kind === "shell_run" && data.running === false && data.exit_code == null) {
    return "Command stopped without an exit code. Check project_health and the run's stderr before retrying.";
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
      ...(typeof data.sha256 === "string" ? { sha256: data.sha256 } : {}),
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
    const stdoutRaw = data.stdout_tail ?? data.stdout;
    const stderrRaw = data.stderr_tail ?? data.stderr;
    const stdout = typeof stdoutRaw === "string" ? stdoutRaw : "";
    const stderr = typeof stderrRaw === "string" ? stderrRaw : "";
    return {
      run_id: data.run_id,
      shell: data.shell,
      running: data.running === true,
      command_status: commandStatus(data),
      exit_code: data.exit_code ?? null,
      cancelled: data.cancelled === true,
      timed_out: data.timed_out === true,
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
  if (kind === "health") {
    // Roadmap item 15 (P1): the health payload does not fit in a compact
    // response, and slicing it into `preview_text` cut the JSON mid-word and
    // made every section unreachable. Drop whole sections instead and say
    // which ones were dropped, so the agent can ask for them by name.
    const keep = ["notice", "server", "capability", "queue", "shell", "environment"];
    const dropped: string[] = [];
    const out: Loose = {};
    for (const [key, value] of Object.entries(data)) {
      if (keep.includes(key)) out[key] = value;
      else dropped.push(key);
    }
    out.sections_dropped = dropped;
    // Every section the tool can produce, so the agent can ask for the ones
    // that did not fit.
    out.sections_available = Object.keys(data);
    return out;
  }
  if (kind === "file_read") {
    const text = typeof data.text === "string" ? data.text : "";
    const { text: prefix, truncated: cut } = truncateUtf8(text, FILE_PREVIEW_BYTES);
    let preview = prefix;
    let nextStart = data.next_start_line;
    let lastLine = data.last_line;
    if (cut) {
      const lastNewline = preview.lastIndexOf("\n");
      const hasCompleteLine = lastNewline >= 0;
      if (hasCompleteLine) {
        preview = preview.slice(0, lastNewline + 1);
      } else {
        nextStart = undefined;
      }
      const firstLine = typeof data.first_line === "number" ? data.first_line : 1;
      if (!hasCompleteLine) {
        lastLine = firstLine;
      } else {
        const whole = preview.match(/\n/g)?.length ?? 0;
        nextStart = firstLine + whole;
        lastLine = nextStart - 1;
      }
    }
    return {
      relative_path: data.relative_path,
      first_line: data.first_line,
      last_line: lastLine,
      total_bytes: data.total_bytes,
      truncated: data.truncated === true || cut,
      // The whole-file hash must survive the compact preview: it is what the
      // agent hands to project_edit_file as expected_sha256 (roadmap item 17).
      ...(typeof data.sha256 === "string" ? { sha256: data.sha256, sha256_scope: "file" } : {}),
      ...(typeof data.text_sha256 === "string" ? { text_sha256: data.text_sha256 } : {}),
      ...(typeof data.mtime_ms === "number" ? { mtime_ms: data.mtime_ms } : {}),
      ...(typeof data.size_bytes === "number" ? { size_bytes: data.size_bytes } : {}),
      ...(nextStart !== undefined ? { next_start_line: nextStart } : {}),
      preview,
      preview_truncated: cut,
    };
  }
  if (kind === "file_list") {
    const entries = Array.isArray(data.entries) ? (data.entries as unknown[]) : [];
    return {
      entries_preview: entries.slice(0, 20),
      entry_count: entries.length,
      entries_omitted: Math.max(0, entries.length - 20),
      truncated: data.truncated === true || entries.length > 20,
      ...(typeof data.hint === "string" ? { hint: data.hint } : {}),
    };
  }
  if (kind === "search") {
    const hits = Array.isArray(data.hits) ? (data.hits as unknown[]) : [];
    const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
    const out: Loose = {
      matches_preview: hits.slice(0, 20),
      match_count: hits.length,
      matches_omitted: Math.max(0, hits.length - 20),
      complete: data.complete !== false,
      diagnostics: diagnostics.slice(0, 10),
      diagnostics_omitted: Math.max(0, diagnostics.length - 10),
    };
    if (data.total_match_lines !== undefined) out.total_match_lines = data.total_match_lines;
    if (data.files_matched !== undefined) out.files_matched = data.files_matched;
    if (data.files !== undefined) out.files = data.files;
    if (typeof data.hint === "string") out.hint = data.hint;
    return out;
  }
  if (kind === "shell_run") {
    const tail = (value: unknown) =>
      typeof value === "string" ? truncateUtf8(value.slice(-2000), PREVIEW_BYTES).text : value;
    return {
      ...data,
      ...(data.stdout_tail !== undefined ? { stdout_tail: tail(data.stdout_tail), stderr_tail: tail(data.stderr_tail) } : {}),
      ...(data.stdout !== undefined ? { stdout: tail(data.stdout), stderr: tail(data.stderr) } : {}),
    };
  }
  return data;
}

function genericSummary(data: unknown, originalBytes = serializedBytes(data)): Loose {
  if (Array.isArray(data)) {
    return { data_type: "array", item_count: data.length, serialized_bytes: originalBytes };
  }
  if (isObject(data)) {
    const keys = Object.keys(data);
    return {
      data_type: "object",
      key_count: keys.length,
      keys_preview: keys.slice(0, 20),
      serialized_bytes: originalBytes,
    };
  }
  return { data_type: data === null ? "null" : typeof data, serialized_bytes: originalBytes };
}

function genericPreview(data: unknown, originalBytes: number): Loose {
  const serialized = stringify(data) ?? "null";
  const preview = truncateUtf8(serialized, GENERIC_PREVIEW_BYTES);
  return {
    preview_text: preview.text,
    preview_truncated: preview.truncated,
    original_bytes: originalBytes,
  };
}

function trimHint(hint: string | undefined): string {
  const trimNotice = "Output mode compact: payload trimmed; set VENIRA_OUTPUT_MODE=full for complete data.";
  return hint ? `${hint} ${trimNotice}` : trimNotice;
}

export type EnvelopeOptions = {
  requestId?: string;
  elapsedMs?: number;
  cached?: boolean;
  hint?: string;
  /** Extra machine-readable payload for error envelopes (e.g. approval tokens). */
  data?: unknown;
  /** Suggested next tool calls to recover from this failure. */
  next_actions?: unknown[];
};

export function buildEnvelope(
  operation: string,
  response: RustResponse | undefined,
  options: EnvelopeOptions = {},
): Envelope {
  const data = response?.result?.data;
  const kind = response?.result?.kind ?? operation;
  const dd = (data ?? {}) as { complete?: unknown; truncated?: unknown; hits?: unknown; limited?: unknown; incomplete?: unknown };
  const dataTruncated =
    dd.complete === false ||
    dd.truncated === true ||
    (Array.isArray(dd.hits) && dd.truncated === true);
  const truncated = response?.truncated === true || dataTruncated;
  // Roadmap item 15 (P2): `truncated` meant three different things. The
  // producers now say which one happened: `limited` (a limit cut the
  // result), `incomplete` (the content was not fully returned) and
  // `trimmed` (compact mode cut the payload).
  const limited = dd.limited === true;
  const incomplete = dd.incomplete === true;
  const hint = options.hint ?? inferHint(kind, data);

  const envelope: Envelope = {
    ok: true,
    status: response?.status ?? "completed",
    request_id: options.requestId ?? newRequestId(),
    kind,
    elapsed_ms: round(options.elapsedMs ?? 0),
  };
  if (truncated) envelope.truncated = true;
  if (limited) envelope.limited = true;
  if (incomplete) envelope.incomplete = true;
  if (options.cached) envelope.cached = true;
  if (hint) envelope.hint = hint;
  if (kind === "shell_run" && isObject(data)) envelope.command_status = commandStatus(data);

  const originalBytes = serializedBytes(data ?? null);
  if (OUTPUT_MODE === "compact" && originalBytes > SUMMARY_THRESHOLD_BYTES) {
    const candidate = previewData(kind, data);
    const previewed = serializedBytes(candidate) < originalBytes ? candidate : genericPreview(data, originalBytes);
    envelope.data = previewed;
    const summary = summarize(kind, data) ?? genericSummary(data, originalBytes);
    envelope.summary = serializedBytes(summary) > PREVIEW_BYTES ? genericSummary(summary) : summary;
    envelope.truncated = true;
    if (kind === "file_read" && isObject(previewed) && previewed.preview_truncated === true) {
      if (isObject(envelope.summary)) {
        envelope.summary.truncated = true;
        if (typeof previewed.last_line === "number") envelope.summary.last_line = previewed.last_line;
        if (typeof previewed.first_line === "number" && typeof previewed.last_line === "number") {
          envelope.summary.lines_returned = Math.max(0, previewed.last_line - previewed.first_line + 1);
        }
        if (typeof previewed.next_start_line === "number") {
          envelope.summary.next_start_line = previewed.next_start_line;
        } else {
          delete envelope.summary.next_start_line;
        }
      }
      envelope.hint =
        typeof previewed.next_start_line === "number"
          ? `Cut by compact mode. Next chunk: project_read_file({ relative_path: "${previewed.relative_path}", start_line: ${previewed.next_start_line} }).`
          : `A line exceeds the compact preview. Re-read with VENIRA_OUTPUT_MODE=full or a larger max_bytes to get that line completely.`;
    }
    envelope.trimmed = true;
    envelope.hint = trimHint(envelope.hint);
    return envelope;
  }

  envelope.data = data;
  const summary = summarize(kind, data);
  if (summary !== undefined && originalBytes > SUMMARY_THRESHOLD_BYTES) envelope.summary = summary;
  return envelope;
}

export class VeniraError extends Error {
  code: string;
  retryable: boolean;
  data?: unknown;
  next_actions?: unknown[];
  constructor(code: string, message: string, options: { retryable?: boolean; data?: unknown; next_actions?: unknown[] } = {}) {
    super(message);
    this.name = "VeniraError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.data = options.data;
    this.next_actions = options.next_actions;
  }
}

export type Failure = {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
  data?: unknown;
  next_actions?: unknown[];
};

const RETRYABLE = new Set(["io_error", "capability_expired", "host_timeout", "host_unavailable"]);

const GENERIC_HINT =
  "Unknown error code. Read error.message, fix what it names, retry once; else project_explain_error.";

const DEFAULT_HINTS: Record<string, string> = {
  invalid_request: "Check argument names, types and values against the tool schema; unknown fields are rejected.",
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
  feature_disabled:
    "Switched off by the operator; no approval will enable it. Do not retry; tell the user the hint (VENIRA_* flag) or ask them to do it manually.",
  approval_required:
    "NOT run: a human must approve. Stop; tell the user the approval_id and data.approval.approve_command. After they confirm, retry the same call once with approval_id. Never invent or reuse an id.",
  approval_invalid:
    "approval_id is single-use, bound to the exact command/shell/cwd/secret_env, and expires. Call again without it for a fresh approval_required; a human must grant the new id.",
  command_denied:
    "Policy refuses this command in every mode. Do not retry or rephrase; ask the user to run it manually if needed.",
  old_text_not_found:
    "The text to replace is not in the file. Copy nearest_match.text into old_text (it is the file content without line numbers); it also reports the indentation and the line endings. The file was not changed.",
  old_text_ambiguous:
    "old_text matches more than one place. Extend it with surrounding context, or set replace_all=1. The file was not changed.",
  stale_content:
    "The file changed since you read it. Read it again with project_read_file, rebuild the patch against the current content and send the new sha256 as expected_sha256. Never replay the same edit unchanged.",
  repeated_failure:
    "This exact invocation already failed in this session. Read data.previous.stderr_tail, fix the cause, then change the command or its inputs. Pass retry_failed=1 only for a deliberate rerun of the identical command.",
  batch_failed: "Check data.atomic for rollback state, fix the failed item, resubmit the rest.",
  batch_partial_failure: "Fix or drop the failed items in data.responses, retry only those.",
  config_invalid: "Fix the named VENIRA_* setting or config value and restart; do not retry unchanged.",
  workspace_switch_denied: "Workspace switching is disabled; stay in the current workspace.",
  override_not_enabled: "Override not enabled by the operator; do not retry, ask the user to run it manually.",
  override_scope_mismatch: "Override does not cover this command; ask the user to run it manually.",
  checkpoint_failed: "Pre-command snapshot failed, command not run. Create a scoped project_snapshot, then retry.",
  shell_unavailable:
    "The shell binary is not installed or not on PATH; nothing ran. Follow error.message to install it or pick another shell; do not retry unchanged.",
  snapshot_corrupt: "Snapshot is damaged; pick another id from project_snapshot action=list.",
  snapshot_version_unsupported: "Snapshot format not supported by this version; use a newer snapshot or upgrade.",
  mirror_conflict: "Snapshot mirror differs from primary; change nothing and check project_health.",
  secret_missing: "No such secret; see project_secret action=list or create it with action=set.",
  secret_expired: "Secret expired; ask the user for a new one (project_secret action=set).",
  secret_store_locked: "Secret store locked by another process; retry once.",
  secret_store_corrupt: "Secret store unreadable; do not delete it, tell the user.",
  lock_timeout: "Lock held by another process; retry once, do not loop.",
  secret_detected: "Content looks like a credential and was blocked; remove it and retry.",
  secret_output_blocked: "Output contained a secret and was withheld; tell the user.",
  secret_scan_failed: "Secret scan failed, nothing sent; retry once with a smaller body.",
  secret_scan_limit: "Content too large to scan; send a smaller body.",
  auth_missing: "No credential; run project_github_connect or store a token with project_secret.",
  auth_failed: "Provider rejected the credential; ask the user to reconnect or replace it.",
  forbidden: "Credential lacks permission for this repo/action; check token scopes with the user.",
  rate_limited: "Rate limited; wait until the reset time before retrying, do not loop.",
  network_blocked: "Network access is blocked by policy; tell the user, do not retry.",
  network_error: "Network failed; check connectivity, retry once.",
  timeout: "Timed out; retry once with a smaller scope.",
  provider_error: "Provider error; retry once, then check its status page.",
  repo_unresolved: 'Pass repo as "owner/name" or set VENIRA_GIT_REPO.',
  detached_head: "No current branch (detached HEAD); pass an explicit ref/head.",
  already_exists: "Already exists; update the existing one instead.",
  already_configured: "Credential already set; use replace_existing=1 only if the user wants to replace it.",
};

function classify(raw: string): string {
  if (/outside (the )?workspace/i.test(raw)) return "path_escape";
  if (/timed out|timeout/i.test(raw)) return "host_timeout";
  if (/corehost exited|EPIPE/i.test(raw)) return "host_unavailable";
  if (/ENOENT|not found|does not exist/i.test(raw)) return "not_found";
  if (/EACCES|EPERM|access is denied|permission denied/i.test(raw)) return "io_error";
  return "internal";
}

const DEFAULT_NEXT_ACTIONS: Record<string, unknown[]> = {
  not_found: [{ tool: "project_list_files", arguments: { relative_path: "." }, why: "locate the correct path" }],
  path_escape: [{ tool: "project_list_files", arguments: { relative_path: "." }, why: "stay inside the workspace" }],
  snapshot_corrupt: [{ tool: "project_snapshot", arguments: { action: "list" }, why: "pick another checkpoint" }],
  secret_missing: [{ tool: "project_secret", arguments: { action: "list" }, why: "see stored names" }],
};

/**
 * Tool-specific recovery (roadmap item 15, P1).
 *
 * One generic `not_found` hint pointed every tool at project_list_files: a
 * missing secret name or a pending GitHub device flow has nothing to do with
 * the filesystem, so the agent wasted a round trip on a directory listing.
 * Each entry names the call that can actually recover.
 */
const TOOL_RECOVERY: Record<string, Record<string, { hint?: string; next_actions?: unknown[] }>> = {
  secret: {
    not_found: {
      hint: "No such secret. List the stored names with project_secret action=list, or store it with action=set.",
      next_actions: [{ tool: "project_secret", arguments: { action: "list" }, why: "see the stored names" }],
    },
  },
  github_connect: {
    not_found: {
      hint: "No such pending device flow. Start one with project_github_connect action=start, then poll it with its pending_id.",
      next_actions: [{ tool: "project_github_connect", arguments: { action: "start" }, why: "start the device flow" }],
    },
  },
  snapshot: {
    not_found: {
      hint: "No such checkpoint. List the checkpoints with project_snapshot action=list and pick another id.",
      next_actions: [{ tool: "project_snapshot", arguments: { action: "list" }, why: "pick another checkpoint" }],
    },
  },
  shell_status: {
    not_found: {
      hint: "Unknown run id. Run ids live only in the session that started them; start a new run with project_shell_run.",
    },
  },
  shell_cancel: {
    not_found: {
      hint: "Unknown run id. Run ids live only in the session that started them.",
    },
  },
  read_audit: {
    not_found: {
      hint: "The audit database was not found at that path. Check project_health for the audit store location.",
    },
  },
  ci_status: {
    not_found: {
      hint: "No run, job or check-run matched the selector. List the recent runs with project_ci_status without a selector, or use project_ci_logs with a run_id from it.",
    },
  },
  ci_logs: {
    not_found: {
      hint: "No log archive for that run or job. Take run_id/job_id from project_ci_status.",
    },
  },
  read_file: {
    not_found: {
      hint: "No such file. Check the path with project_list_files or project_search; do not retry the same path.",
    },
  },
  write_file: {
    not_found: {
      hint: "No such file. Check the path with project_list_files, or pass create_dirs=1 to create the parent directory.",
    },
  },
  edit_file: {
    not_found: {
      hint: "No such file. Check the path with project_list_files, or create it with project_write_file.",
    },
  },
  delete_path: {
    not_found: {
      hint: "No such path. Check it with project_list_files before deleting.",
    },
  },
  get_file_info: {
    not_found: {
      hint: "No such path. Check it with project_list_files.",
    },
  },
  list_files: {
    not_found: {
      hint: "No such directory. Check the path with project_list_files on its parent.",
    },
  },
};

/** A not_found about a shell run id is not a path problem: listing files would not help. */
function defaultNextActions(failure: Failure, operation?: string): unknown[] | undefined {
  const recovery = operation ? TOOL_RECOVERY[operation]?.[failure.code] : undefined;
  if (recovery?.next_actions) return recovery.next_actions;
  if (failure.code === "not_found" && /^(Unknown run_id|Checkpoint )/i.test(failure.message)) return undefined;
  if (failure.code === "old_text_not_found" || failure.code === "old_text_ambiguous") {
    const file = /^old_text (?:not found|matches \d+ locations) in (.+?)\.(?: |$)/.exec(failure.message)?.[1];
    return file
      ? [{ tool: "project_read_file", arguments: { relative_path: file }, why: "copy the exact current text, then retry the edit" }]
      : undefined;
  }
  return DEFAULT_NEXT_ACTIONS[failure.code];
}

/** The tool-specific hint, when the tool knows a better way out than the generic one. */
function toolSpecificHint(failure: Failure, operation?: string): string | undefined {
  if (!operation) return undefined;
  return TOOL_RECOVERY[operation]?.[failure.code]?.hint;
}

const INVALID_REQUEST_HINTS: Array<[RegExp, string]> = [
  [/symbol_name is required/i, "Pass symbol_name (identifier); scope=file with relative_path, or scope=workspace."],
  [/queries\[\] is required/i, "Pass queries: [{ pattern, must?, weight? }]."],
  [/action must be create\|list\|restore/i, "Use project_snapshot action=create|list|restore|delete|mirror; restore/delete need id."],
  [/Invalid checkpoint id/i, "Use an id from project_snapshot action=list."],
  [/paths\[\] is limited/i, "Max 64 paths; pass a directory instead."],
  [/harness must be one of/i, "See project_detect_harnesses for valid names."],
  [/No edits provided/i, "Pass old_text+new_text, or edits[] of { old_text, new_text }."],
  [/old_text must be a non-empty/i, "old_text is the exact text to replace; to replace a whole file use project_write_file."],
  [/Directory requires recursive=1/i, "Set recursive=1 only after a scoped project_snapshot of it."],
  [/`command` must be a non-empty/i, "Pass command as the shell command line."],
  [/override must be/i, "override: ALLOW_GIT_PUSH or ALLOW_ENV_READ (operator-enabled), plus reason."],
  [/reason of at most 400/i, "Add reason (one line, max 400 chars)."],
  [/kill_key/i, "Use the kill_key from the project_shell_run response."],
  [/secret_env/i, "secret_env: array of up to 16 names from project_secret action=list."],
  [/Pass exactly one/i, "Pass only one selector: run_id, ref, pr or branch."],
  [/Pass either expires_in_days or expires_at|expires_at` must be/i, "Use expires_in_days or expires_at (epoch ms/ISO-8601), not both."],
  [/`until` must be/i, 'Set until to "terminal" or "any_change".'],
  [/pending_id|action must be "start" or "poll"/i, "Call project_github_connect action=start first, then poll with its pending_id."],
  [/`value` must be a non-empty|NUL bytes/i, "value must be a non-empty string without NUL; or use value_env."],
  [/`side` must be/i, "side: RIGHT (new code) or LEFT (deleted)."],
  [/start_line|`line`|line\/`start_line`/i, "Inline comments need path + positive line; start_line <= line. Omit both for a general comment."],
  [/`method` must be/i, "method: merge, squash or rebase."],
  [/`state` must be/i, "state: open, closed or all."],
  [/`action` must be "cancel"/i, 'action: "cancel" or "retry_failed".'],
  [/run_id|job_id|pipeline\/step UUID/i, "Take run_id/job_id from project_ci_status."],
  [/`inputs`|Variable|Workflow input|Too many/i, "inputs: object of string/number/boolean values with valid names, within the limit."],
  [/`kind` must be "files"|`format` must be|`direction` must be/i, "Use a value listed in the message; see the tool schema."],
  [/Seed path is not a file|not a regular file or directory/i, "Pass an existing file path (check with project_list_files)."],
  [/git\.repos|has no host/i, 'Fix git.repos / remote URL (expected "owner/name").'],
  [/root\/relative_path required/i, "Pass relative_path (workspace-relative)."],
  [/Unknown method/i, "Server/backend mismatch; restart and check project_health."],
  [/Refusing to delete the workspace root/i, "Delete a path inside the workspace; the root is protected."],
  [/value_env .* is not set/i, "Export that variable in the server environment, or pass value."],
  [/must be a PR number or/i, "Pass pr as a number or a PR/MR URL."],
  [/is not valid JSON/i, "Fix the JSON syntax in that config file."],
  [/must be https|is not in the allowed list/i, "Provider host must be https and on the allowed host list in git config."],
  [/must be an integer between/i, "Use an integer within the stated range."],
  [/`ref` must be a branch/i, "ref: branch name or commit sha."],
  [/safe_edit tool removed/i, "Use project_edit_file with expected_sha256."],
  [/Pass error_text/i, "Pass error_text or log_tail."],
  [/Provider path must start/i, 'Internal: provider paths start with "/"; report a bug.'],
];

function invalidRequestHint(body: string): string | undefined {
  for (const [re, text] of INVALID_REQUEST_HINTS) if (re.test(body)) return text;
  return undefined;
}

export function parseToolError(error: unknown): Failure & { data?: unknown } {
  const raw = (error instanceof Error ? error.message : String(error)).trim() || "Unknown error (no message provided).";
  const match = /^\[([a-z0-9_]+)\]\s*([\s\S]*)$/i.exec(raw);
  let code =
    error instanceof VeniraError && error.code.trim()
      ? error.code.trim().toLowerCase()
      : match
        ? match[1].toLowerCase()
        : "";
  let body = match ? match[2].trim() : raw;
  if (!code) code = classify(raw);

  let hint: string | undefined;
  const hintAt = body.indexOf(" Hint: ");
  if (hintAt >= 0) {
    hint = body.slice(hintAt + " Hint: ".length).trim();
    body = body.slice(0, hintAt).trim();
  }
  if (!hint && code === "not_found" && /^Unknown run_id/i.test(body)) hint = "Run ids only live for this session; start the command again with project_shell_run.";
  if (!hint && code === "invalid_request" && /^Invalid regex/i.test(body)) hint = "Fix the pattern, or set regex=0 to search it as literal text.";
  if (!hint && code === "invalid_request") hint = invalidRequestHint(body);
  if (!hint) hint = DEFAULT_HINTS[code] ?? GENERIC_HINT;
  const message = body || raw;
  const retryable = error instanceof VeniraError ? error.retryable : RETRYABLE.has(code);
  const nextActions =
    error instanceof VeniraError
      ? error.next_actions
      : defaultNextActions({ code, message, hint, retryable });

  return {
    code,
    message,
    hint,
    retryable,
    ...(error && typeof error === "object" && (error as { data?: unknown }).data !== undefined
      ? { data: (error as { data?: unknown }).data }
      : {}),
    ...(nextActions !== undefined ? { next_actions: nextActions } : {}),
  };
}

export function errorEnvelope(
  operation: string,
  error: unknown,
  options: EnvelopeOptions = {},
): Envelope & { error: { code: string; message: string; retryable: boolean } } {
  const failure = parseToolError(error);
  // The tool knows better than the generic hint whether *its* failure can be
  // recovered from (roadmap item 15, P1).
  const recovery = TOOL_RECOVERY[operation]?.[failure.code];
  const hint = options.hint ?? recovery?.hint ?? failure.hint;
  const messageBytes = Buffer.byteLength(failure.message, "utf8");
  const messagePreview =
    OUTPUT_MODE === "compact" && messageBytes > SUMMARY_THRESHOLD_BYTES
      ? truncateUtf8(failure.message, PREVIEW_BYTES)
      : undefined;
  const failureData = options.data !== undefined ? options.data : failure.data;
  const failureDataBytes = failureData === undefined ? 0 : serializedBytes(failureData);
  const compactFailureData =
    OUTPUT_MODE === "compact" && failureData !== undefined && failureDataBytes > SUMMARY_THRESHOLD_BYTES
      ? genericPreview(failureData, failureDataBytes)
      : undefined;
  const compacted = messagePreview?.truncated === true || compactFailureData !== undefined;
  const compactHint = compacted ? trimHint(hint) : hint;
  const nextActions =
    options.next_actions ?? recovery?.next_actions ?? failure.next_actions ?? defaultNextActions(failure, operation);
  const summary = {
    ...(messagePreview?.truncated ? { error_message_bytes: messageBytes } : {}),
    ...(compactFailureData ? { error_data: genericSummary(failureData, failureDataBytes) } : {}),
  };
  return {
    ok: false,
    status: "failed",
    request_id: options.requestId ?? newRequestId(),
    kind: operation,
    error: {
      code: failure.code,
      message: messagePreview?.truncated ? `${messagePreview.text}… [message trimmed]` : failure.message,
      retryable: failure.retryable,
    },
    ...(compactHint ? { hint: compactHint } : {}),
    ...(failureData !== undefined ? { data: compactFailureData ?? failureData } : {}),
    ...(Object.keys(summary).length > 0 ? { summary } : {}),
    ...(nextActions !== undefined ? { next_actions: nextActions } : {}),
    ...(compacted ? { trimmed: true, truncated: true } : {}),
    elapsed_ms: round(options.elapsedMs ?? 0),
  };
}

export function batchEnvelope(
  requestId: string,
  responses: unknown[],
  elapsedMs: number,
  extra: Record<string, unknown> = {},
  options: { kind?: string; failure?: { code: string; message: string; hint?: string } } = {},
): Record<string, unknown> {
  const failedResponses = responses.filter((response) => isObject(response) && response.ok === false);
  const failure = options.failure ?? (failedResponses.length > 0
    ? {
        code: "batch_partial_failure",
        message: `${failedResponses.length} of ${responses.length} batch item(s) failed; inspect data.responses.`,
        hint: "Fix or remove the failed item(s), then retry only those requests.",
      }
    : undefined);
  const base = {
    request_id: requestId,
    kind: options.kind ?? "read_batch",
    data: {
      responses,
      count: responses.length,
      ...(failedResponses.length > 0
        ? {
            failed_count: failedResponses.length,
            succeeded_count: responses.length - failedResponses.length,
          }
        : {}),
      ...extra,
    },
    elapsed_ms: round(elapsedMs),
  };
  if (failure) {
    const { code, message, hint } = failure;
    return {
      ok: false,
      status: options.failure ? "failed" : "partial",
      // Some items succeeded. A client that maps `ok:false` to isError must
      // still be able to see that the successful reads are in data.responses
      // (roadmap item 15, P1).
      ...(options.failure ? {} : { partial: true }),
      ...base,
      error: { code, message, retryable: false },
      ...(hint ? { hint } : {}),
    };
  }
  return { ok: true, status: "completed", ...base };
}
