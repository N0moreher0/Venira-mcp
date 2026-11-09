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
import {
  computeHybridSearch,
  fitHybridToBudget,
  type HybridDeps,
  type HybridSymbolCache,
} from "./project-hybrid.js";

// project_read_batch and project_edit_batch handlers. Extracted from tools/project.ts
// (P1 #6, step 5f); behavior is unchanged. The cached backend executor and the batch
// response budget are owned by project.ts and reach this module through BatchDeps, so
// it never imports project.ts.

type Args = Record<string, unknown>;

const serializedSize = (value: unknown): number => Buffer.byteLength(stringify(value), "utf8");

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
 * Same `execute` as HybridDeps (project.ts `executeCached`), plus the total response budget that
 * project.ts also applies to its own caches.
 */
export type BatchDeps = HybridDeps & {
  /** Upper bound on the serialized size of one whole batch response. */
  maxBatchResponseBytes: number;
};

/**
 * Numeric 0/1 flags accepted by the batchable read ops. The standalone tools coerce these
 * through the `flag01` zod transform (1 -> true), but `project_read_batch` takes
 * `arguments` as an untyped record, so without this step the host receives the raw number
 * and silently ignores it (e.g. `regex: 1` searched for the pattern as plain text and
 * `"A|B"` returned no matches).
 */
const BATCH_FLAG_KEYS = new Set([
  "regex",
  "case_sensitive",
  "whole_word",
  "include_hidden",
  "count_only",
  "hybrid",
  "include_ignored",
  "line_numbers",
]);

function normalizeBatchArgs(operation: string, args: Args): Args {
  const out: Args = { ...args };
  for (const key of BATCH_FLAG_KEYS) {
    const value = out[key];
    if (typeof value === "number") out[key] = value === 1;
    else if (value === "1" || value === "true") out[key] = true;
    else if (value === "0" || value === "false") out[key] = false;
  }
  // Search clients commonly call the text field `pattern`; the standalone
  // project_search contract calls it `query`. Accept the alias in batches so
  // a valid search is not forwarded with query=undefined to the backend.
  if (operation === "search" && typeof out.query !== "string" && typeof out.pattern === "string") {
    out.query = out.pattern;
  }
  return out;
}

export async function runReadBatch(
  requests: { operation: string; arguments: Args }[],
  maxItemBytes: number,
  deps: BatchDeps,
): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const responses: unknown[] = [];
  let totalBytes = 0;
  let budgetExhausted = false;
  // One symbol cache per batch call: hybrid items that hit the same files parse each file once.
  const symbolCache: HybridSymbolCache = new Map();

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
      const keyError = checkReadItemKeys(request.operation, request.arguments as Args);
      if (keyError) throw new VeniraError("invalid_request", keyError);
      const itemArgs = normalizeBatchArgs(request.operation, request.arguments as Args);
      // Same routing rule as the standalone project_search tool: hybrid only applies to literal_content.
      const useHybrid = request.operation === "search" && itemArgs.hybrid === true && itemArgs.kind === "literal_content";
      const execution = useHybrid
        ? await computeHybridSearch(itemArgs, deps, symbolCache)
        : await deps.execute(request.operation, itemArgs);
      const { cached } = execution;
      let response = execution.response;
      const itemRequestId = newRequestId();
      const itemElapsedMs = performance.now() - itemStarted;
      const render = (candidate: RustResponse) =>
        buildEnvelope(request.operation, candidate, { requestId: itemRequestId, elapsedMs: itemElapsedMs, cached });
      let envelope = render(response);
      let size = serializedSize(envelope);
      if (size > maxItemBytes && useHybrid) {
        // Hybrid over-fetches up to 200 hits: keep the largest prefix that fits instead of failing the item.
        const fitted = fitHybridToBudget(response, maxItemBytes, (candidate) => serializedSize(render(candidate)));
        if (fitted) {
          response = fitted;
          envelope = render(response);
          size = serializedSize(envelope);
        }
      }
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
      if (totalBytes + size > deps.maxBatchResponseBytes) {
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
      responses.push(failureItem(request.operation, failure));
    }
  }

  const elapsedMs = performance.now() - started;
  const failed = responses.some((response) => typeof response === "object" && response !== null && "ok" in response && response.ok === false);
  recordMetric("read_batch", elapsedMs, !failed);
  const envelope = batchEnvelope(requestId, responses, elapsedMs, {
    total_bytes_returned: totalBytes,
    max_response_bytes_per_item: maxItemBytes,
  });
  return toolResult(
    envelope,
    envelope.ok === false,
  );
}

export async function runEditBatch(args: Args, deps: BatchDeps): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const items = Array.isArray(args.edits) ? (args.edits as Args[]) : [];
  const maxItemBytes = Number(args.max_response_bytes_per_item ?? 1_048_576);
  const responses: unknown[] = [];
  let totalBytes = 0;
  // Fail fast: validate every item's field names BEFORE the snapshot or any edit runs, so a
  // misspelled key (e.g. `path` for `relative_path`) rejects the whole batch with nothing applied.
  const argErrors = validateEditBatchItems(items);
  if (argErrors.length > 0) {
    const rejectedMs = performance.now() - started;
    recordMetric("edit_batch", rejectedMs, false);
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
          kind: "edit_batch",
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
      const snap = await deps.execute("snapshot_create", { action: "create", paths: distinctPaths, label: "edit_batch", reason: "edit_batch" });
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
          console.error(`[venira-coding] edit_batch rollback incomplete: ${rollbackError}`);
        }
      } catch (restoreError) {
        rollbackError = restoreError instanceof Error ? restoreError.message : String(restoreError);
        console.error(`[venira-coding] edit_batch rollback failed: ${rollbackError}`);
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
        recordMetric("edit_file", performance.now() - itemStarted, false);
        await abortBatch(itemIndex, {
          code: "resource_limit",
          message: `Edit ran, but its response (${size} bytes) exceeds the per-item limit (${maxItemBytes} bytes).`,
          hint: "The batch stopped and attempted rollback; inspect data.rollback_succeeded before retrying.",
          retryable: false,
        });
        break;
      }
      if (totalBytes + size > deps.maxBatchResponseBytes) {
        recordMetric("edit_file", performance.now() - itemStarted, false);
        await abortBatch(itemIndex, {
          code: "resource_limit",
          message: `Edit ran, but the batch response budget would be exceeded (${totalBytes + size} > ${deps.maxBatchResponseBytes} bytes).`,
          hint: "The batch stopped and attempted rollback; inspect data.rollback_succeeded before retrying.",
          retryable: false,
        });
        break;
      }
      totalBytes += size;
      recordMetric("edit_file", performance.now() - itemStarted, true);
      responses.push({ ok: true, response: envelope });
    } catch (error) {
      recordMetric("edit_file", performance.now() - itemStarted, false);
      const failure = parseToolError(error);
      await abortBatch(itemIndex, failure);
      break;
    }
  }
  const elapsedMs = performance.now() - started;
  recordMetric("edit_batch", elapsedMs, !failed);
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
    ...(snapshotId ? { snapshot_id: snapshotId } : {}),
  };
  const base = { code: "batch_failed" };
  const failure = !failed
    ? undefined
    : rollbackSucceeded
      ? { ...base, message: `edits[${failedIndex}] failed; every file was restored from snapshot ${snapshotId}. Nothing changed.`, hint: `Fix edits[${failedIndex}] (see data.responses) and resend the whole batch.` }
      : rollbackAttempted
        ? { ...base, message: `edits[${failedIndex}] failed and the rollback FAILED; files may be partly edited.`, hint: `Run project_snapshot action=restore id=${snapshotId} verify=1 now, then re-read the files.` }
        : { ...base, message: `edits[${failedIndex}] failed and rollback was not verified; files may still contain edits from data.executed or the failing item.`, hint: snapshotId ? "Inspect data.rollback_error and data.snapshot_error, then restore the checkpoint or re-read and repair the touched files." : "Re-read the touched files; finish or undo the applied edits by hand." };
  return toolResult(
    batchEnvelope(requestId, responses, elapsedMs, batchExtra, failure ? { kind: "edit_batch", failure } : { kind: "edit_batch" }),
    failed,
  );
}
