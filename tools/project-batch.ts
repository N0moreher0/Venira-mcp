import { checkReadItemKeys, validateEditBatchItems } from "../lib/arg-hints.js";
import { recordMetric } from "../lib/metrics.js";
import {
  batchEnvelope,
  buildEnvelope,
  errorEnvelope,
  newRequestId,
  parseToolError,
  stringify,
  toolResult,
  VeniraError,
} from "../lib/output.js";
import type { Failure, RustResponse, ToolResult } from "../lib/output.js";
import type { HybridDeps } from "./project-hybrid.js";

// Multi-item edit / multi-item read runners.
//
// read_file executes several files in ONE call (`requests[]`); edit_file executes several replacements,
// possibly across files (`edits[]` with per-item `relative_path`, all-or-nothing). Both used to be
// separate tools (read_batch / edit_batch); they are the same logic with the same cached executor, just
// registered under the one tool name. The standalone shapes of the operations are unchanged:
// one item of requests[] OR edits[] is exactly what the standalone tool accepts.

type Args = Record<string, unknown>;

const serializedSize = (value: unknown): number => Buffer.byteLength(stringify(value), "utf8");

/** Numeric 0/1 flags accepted inside requests[]/edits[], coerced to booleans before the backend sees them. */
const BATCH_FLAG_KEYS = new Set([
  "regex",
  "case_sensitive",
  "whole_word",
  "include_hidden",
  "count_only",
  "hybrid",
  "include_ignored",
  "line_numbers",
  "missing_ok",
  "invert",
  "files_only",
]);

const BATCH_FLAG_VALUE_KEYS = ["max_bytes"] as const;

function normalizeBatchArgs(operation: string, args: Args): Args {
  const out: Args = { ...args };
  for (const key of BATCH_FLAG_KEYS) {
    const value = out[key];
    if (typeof value === "number") out[key] = value === 1;
    else if (typeof value === "boolean") out[key] = value;
    else if (value === "1" || value === "true") out[key] = true;
    else if (value === "0" || value === "false") out[key] = false;
  }
  for (const key of BATCH_FLAG_VALUE_KEYS) {
    const value = out[key];
    if (typeof value === "string" && /^\d+$/.test(value)) out[key] = Number(value);
  }
  // Search clients commonly call the text field `pattern`; the standalone
  // search contract calls it `query`. Accept the alias in batches so
  // a valid search is not forwarded with query=undefined to the backend.
  if (operation === "search" && typeof out.query !== "string" && typeof out.pattern === "string") {
    out.query = out.pattern;
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function failureItem(operation: string, failure: Failure): Record<string, unknown> {
  const envelope = errorEnvelope(
    operation,
    new VeniraError(failure.code, failure.message, {
      retryable: failure.retryable,
      data: failure.data,
      next_actions: failure.next_actions,
    }),
    { hint: failure.hint },
  );
  return {
    ok: false,
    error: envelope.error,
    ...(envelope.hint ? { hint: envelope.hint } : {}),
    ...(envelope.data !== undefined ? { data: envelope.data } : {}),
    ...(envelope.next_actions !== undefined ? { next_actions: envelope.next_actions } : {}),
    ...(envelope.summary !== undefined ? { summary: envelope.summary } : {}),
    ...(envelope.trimmed ? { trimmed: true, truncated: true } : {}),
  };
}

/**
 * `max_response_bytes_per_item` is accepted by the multi-read form of read_file and by edit_file's
 * multi-file form but no longer advertised (ROADMAP_TOOL_SCHEMA.md, phase 7). Both tools are registered
 * as loose objects so the SDK does not strip it, which also means zod no longer range-checks it, so the
 * range is checked here. Returns an error result for a bad value, undefined when it is absent or fine.
 */
export function checkItemBytes(operation: string, value: unknown, min: number, max: number): ToolResult | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return undefined;
  return toolResult(
    errorEnvelope(
      operation,
      new VeniraError(
        "invalid_request",
        `max_response_bytes_per_item must be an integer between ${min} and ${max} (got ${String(value)}).`,
      ),
      { hint: "Omit it to use the default." },
    ),
  );
}

export const EDIT_ITEM_BYTES_MIN = 256;
export const EDIT_ITEM_BYTES_MAX = 1_048_576;
export const READ_ITEM_BYTES_MIN = 1024;
export const READ_ITEM_BYTES_MAX = 2 * 1024 * 1024;

/**
 * Same `execute` as HybridDeps (project.ts `executeCached`), plus the total response budget that
 * project.ts also applies to its own caches.
 */
export type BatchDeps = HybridDeps & {
  /** Upper bound on the serialized size of one whole multi-item response. */
  maxBatchResponseBytes: number;
};

/** The multi-read form of read_file: one call, several files, sequential + cached. */
export async function runReadFileBatch(
  requests: Args[],
  maxItemBytes: number,
  deps: BatchDeps,
): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const items = Array.isArray(requests) ? requests : [];
  const responses: unknown[] = [];
  let totalBytes = 0;
  let budgetExhausted = false;

  for (const request of items) {
    if (budgetExhausted) {
      responses.push({
        ok: false,
        error: {
          code: "resource_limit",
          message: "Item not executed: batch response budget exhausted.",
          retryable: false,
        },
        hint: "Split into smaller calls.",
      });
      continue;
    }

    const itemStarted = performance.now();
    try {
      const keyError = checkReadItemKeys("read_file", request as Args);
      if (keyError) throw new VeniraError("invalid_request", keyError);
      const itemArgs = normalizeBatchArgs("read_file", request as Args);
      const { response, cached } = await deps.execute("read_file", itemArgs);
      const itemRequestId = newRequestId();
      const itemElapsedMs = performance.now() - itemStarted;
      const envelope = buildEnvelope("read_file", response, { requestId: itemRequestId, elapsedMs: itemElapsedMs, cached });
      const size = serializedSize(envelope);
      if (size > maxItemBytes) {
        recordMetric("read_file", performance.now() - itemStarted, false);
        responses.push({
          ok: false,
          error: {
            code: "resource_limit",
            message: `Item response exceeds max_response_bytes_per_item (${size} > ${maxItemBytes} bytes).`,
            retryable: false,
          },
          hint: "Request this file alone with a smaller max_bytes or a line range.",
        });
        continue;
      }
      if (totalBytes + size > deps.maxBatchResponseBytes) {
        budgetExhausted = true;
        recordMetric("read_file", performance.now() - itemStarted, false);
        responses.push({
          ok: false,
          error: {
            code: "resource_limit",
            message: "Batch response size limit reached; this item was not included.",
            retryable: false,
          },
          hint: "Split into smaller calls.",
        });
        continue;
      }
      totalBytes += size;
      recordMetric("read_file", performance.now() - itemStarted, true);
      responses.push({ ok: true, response: envelope });
    } catch (error) {
      recordMetric("read_file", performance.now() - itemStarted, false);
      const failure = parseToolError(error);
      responses.push(failureItem("read_file", failure));
    }
  }

  const elapsedMs = performance.now() - started;
  const failed = responses.some((response) => isRecord(response) && "ok" in response && response.ok === false);
  recordMetric("read_file", elapsedMs, !failed);
  const envelope = batchEnvelope(requestId, responses, elapsedMs, {
    total_bytes_returned: totalBytes,
    max_response_bytes_per_item: maxItemBytes,
  }, { kind: "read_file" });
  const allFailed = responses.length > 0 && responses.every((response) => isRecord(response) && response.ok === false);
  return toolResult(envelope, allFailed);
}

/** The multi-file form of edit_file: one call, all-or-nothing, automatic rollback. */
export async function runEditBatch(args: Args, deps: BatchDeps, kind = "edit_file"): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const items = Array.isArray(args.edits) ? (args.edits as Args[]) : [];
  const badBytes = checkItemBytes("edit_file", args.max_response_bytes_per_item, EDIT_ITEM_BYTES_MIN, EDIT_ITEM_BYTES_MAX);
  if (badBytes) return badBytes;
  const maxItemBytes = Number(args.max_response_bytes_per_item ?? EDIT_ITEM_BYTES_MAX);
  const responses: unknown[] = [];
  let totalBytes = 0;
  // Fail fast: validate every item's field names BEFORE the snapshot or any edit runs, so a
  // misspelled key (e.g. `path` for `relative_path`) rejects the whole batch with nothing applied.
  const argErrors = validateEditBatchItems(items);
  if (argErrors.length > 0) {
    const rejectedMs = performance.now() - started;
    recordMetric(kind, rejectedMs, false);
    return toolResult(
      batchEnvelope(
        requestId,
        [],
        rejectedMs,
        {
          total_bytes_returned: 0,
          atomic: true,
          applied: false,
          failed: true,
          failed_index: -1,
          executed: [],
          skipped: items.map((_, index) => index),
          rollback_attempted: false,
          rollback_succeeded: false,
          validation_errors: argErrors,
        },
        {
          kind,
          failure: {
            code: "invalid_request",
            message: `Batch rejected before running; nothing was applied. ${argErrors.join("; ")}`,
            hint: "Use the exact edit_file field names (relative_path, old_text, new_text, ...) and resend the whole batch.",
          },
        },
      ),
      true,
    );
  }
  // Capture affected files before edits; atomicity depends on a complete checkpoint.
  const distinctPaths = [...new Set(items.map((i) => String(i?.relative_path ?? "")).filter(Boolean))];
  let snapshotId: string | undefined;
  let snapshotFileCount: number | undefined;
  let snapshotComplete = false;
  let snapshotError: string | undefined;
  let rollbackError: string | undefined;
  if (distinctPaths.length > 0) {
    try {
      const batchLabel = `edit_file: ${distinctPaths.slice(0, 3).join(", ")}${distinctPaths.length > 3 ? ` +${distinctPaths.length - 3} more` : ""}`;
      const snap = await deps.execute("snapshot_create", { action: "create", paths: distinctPaths, label: batchLabel, reason: "edit_file" });
      const snapshotData = snap.response?.result?.data as
        | { id?: unknown; file_count?: unknown; truncated?: unknown; skipped?: unknown }
        | undefined;
      snapshotId = typeof snapshotData?.id === "string" && snapshotData.id ? snapshotData.id : undefined;
      snapshotFileCount =
        typeof snapshotData?.file_count === "number" &&
        Number.isInteger(snapshotData.file_count) &&
        snapshotData.file_count >= 0
          ? snapshotData.file_count
          : undefined;
      const skippedCount = Array.isArray(snapshotData?.skipped) ? snapshotData.skipped.length : 0;
      const snapshotTruncated = snapshotData?.truncated === true || snap.response?.truncated === true;
      snapshotComplete = Boolean(snapshotId) && !snapshotTruncated && skippedCount === 0;
      if (!snapshotId) snapshotError = "Snapshot creation returned no checkpoint id.";
      else if (!snapshotComplete) {
        snapshotError = `Checkpoint ${snapshotId} is incomplete (truncated=${snapshotTruncated}, skipped=${skippedCount}).`;
      }
    } catch (error) {
      snapshotError = error instanceof Error ? error.message : String(error);
    }
  }
  let failed = false;
  const executed: number[] = [];
  const skipped: number[] = [];
  let rollbackAttempted = false;
  let rollbackSucceeded = false;
  let failedIndex = -1;
  const abortBatch = async (index: number, failure: Failure): Promise<void> => {
    failed = true;
    failedIndex = index;
    responses.push(failureItem("edit_file", failure));
    if (snapshotId) {
      rollbackAttempted = true;
      try {
        const restore = await deps.execute("snapshot_restore", { action: "restore", id: snapshotId });
        const restoreData = restore.response?.result?.data as
          | { restored_count?: unknown; skipped?: unknown }
          | undefined;
        const skippedCount = Array.isArray(restoreData?.skipped) ? restoreData.skipped.length : 0;
        const restoredEnough =
          snapshotFileCount === undefined ||
          (typeof restoreData?.restored_count === "number" && restoreData.restored_count >= snapshotFileCount);
        rollbackSucceeded = snapshotComplete && skippedCount === 0 && restoredEnough;
        if (!rollbackSucceeded) {
          rollbackError = `Restore was incomplete (checkpoint_complete=${snapshotComplete}, skipped=${skippedCount}, restored_count=${String(restoreData?.restored_count ?? "unknown")}, expected_count=${String(snapshotFileCount ?? "unknown")}).`;
          console.error(`[venira-coding] edit_file rollback incomplete: ${rollbackError}`);
        }
      } catch (restoreError) {
        rollbackError = restoreError instanceof Error ? restoreError.message : String(restoreError);
        console.error(`[venira-coding] edit_file rollback failed: ${rollbackError}`);
      }
    }
    for (let skippedIndex = index + 1; skippedIndex < items.length; skippedIndex += 1) {
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
  };
  for (const [itemIndex, item] of items.entries()) {
    const itemStarted = performance.now();
    try {
      const { response, cached } = await deps.execute("edit_file", item);
      executed.push(itemIndex);
      const envelope = buildEnvelope("edit_file", response, { requestId: newRequestId(), elapsedMs: performance.now() - itemStarted, cached });
      const size = serializedSize(envelope);
      if (size > maxItemBytes) {
        recordMetric(kind, performance.now() - itemStarted, false);
        await abortBatch(itemIndex, {
          code: "resource_limit",
          message: `Edit ran, but its response (${size} bytes) exceeds the per-item limit (${maxItemBytes} bytes).`,
          hint: "The batch stopped and attempted rollback; inspect data.rollback_succeeded before retrying.",
          retryable: false,
        });
        break;
      }
      if (totalBytes + size > deps.maxBatchResponseBytes) {
        recordMetric(kind, performance.now() - itemStarted, false);
        await abortBatch(itemIndex, {
          code: "resource_limit",
          message: `Edit ran, but the batch response budget would be exceeded (${totalBytes + size} > ${deps.maxBatchResponseBytes} bytes).`,
          hint: "The batch stopped and attempted rollback; inspect data.rollback_succeeded before retrying.",
          retryable: false,
        });
        break;
      }
      totalBytes += size;
      recordMetric(kind, performance.now() - itemStarted, true);
      responses.push({ ok: true, response: envelope });
    } catch (error) {
      recordMetric(kind, performance.now() - itemStarted, false);
      const failure = parseToolError(error);
      await abortBatch(itemIndex, failure);
      break;
    }
  }
  const elapsedMs = performance.now() - started;
  recordMetric(kind, elapsedMs, !failed);
  // A failed batch that rolled back cleanly left its internal checkpoint behind, eating one
  // VENIRA_SNAPSHOT_KEEP slot per failed attempt. Nothing was changed, so the checkpoint has served
  // its purpose: drop it. A FAILED rollback keeps it - it is the recovery path.
  let checkpointDeleted = false;
  let checkpointDeleteError: string | undefined;
  if (failed && rollbackSucceeded && snapshotId) {
    try {
      await deps.execute("snapshot_delete", { action: "delete", id: snapshotId, reason: "edit_file rollback done" });
      checkpointDeleted = true;
    } catch (error) {
      checkpointDeleteError = error instanceof Error ? error.message : String(error);
    }
  }
  const batchExtra = {
    total_bytes_returned: totalBytes,
    atomic: snapshotComplete,
    failed_index: failedIndex,
    failed,
    executed,
    skipped,
    rollback_attempted: rollbackAttempted,
    rollback_succeeded: rollbackSucceeded,
    ...(snapshotError ? { snapshot_error: snapshotError } : {}),
    ...(rollbackError ? { rollback_error: rollbackError } : {}),
    ...(snapshotId && !checkpointDeleted ? { snapshot_id: snapshotId } : {}),
    ...(checkpointDeleted ? { checkpoint_deleted: true } : {}),
    ...(checkpointDeleteError ? { checkpoint_delete_error: checkpointDeleteError } : {}),
  };
  const base = { code: "batch_failed" };
  const failure = !failed
    ? undefined
    : rollbackSucceeded
      ? { ...base, message: `edits[${failedIndex}] failed; every file was restored from snapshot ${snapshotId}. Nothing changed.`, hint: `Fix edits[${failedIndex}] (see data.responses) and resend the whole batch.` }
      : rollbackAttempted
        ? { ...base, message: `edits[${failedIndex}] failed and the rollback FAILED; files may be partly edited.`, hint: `Run snapshot action=restore id=${snapshotId} verify=true now, then re-read the files.` }
        : { ...base, message: `edits[${failedIndex}] failed and rollback was not verified; files may still contain edits from data.executed or the failing item.`, hint: snapshotId ? "Inspect data.rollback_error and data.snapshot_error, then restore the checkpoint or re-read and repair the touched files." : "Re-read the touched files; finish or undo the applied edits by hand." };
  return toolResult(
    batchEnvelope(requestId, responses, elapsedMs, batchExtra, failure ? { kind, failure } : { kind }),
    failed,
  );
}
