import { recordMetric } from "../lib/metrics.js";
import {
  batchEnvelope,
  buildEnvelope,
  newRequestId,
  parseToolError,
  stringify,
  toolResult,
} from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
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
      let size = stringify(envelope).length;
      if (size > maxItemBytes && useHybrid) {
        // Hybrid over-fetches up to 200 hits: keep the largest prefix that fits instead of failing the item.
        const fitted = fitHybridToBudget(response, maxItemBytes, (candidate) => stringify(render(candidate)).length);
        if (fitted) {
          response = fitted;
          envelope = render(response);
          size = stringify(envelope).length;
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

export async function runEditBatch(args: Args, deps: BatchDeps): Promise<ToolResult> {
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
      const snap = await deps.execute("snapshot_create", { action: "create", paths: distinctPaths, label: "edit_batch", reason: "edit_batch" });
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
      const { response, cached } = await deps.execute("edit_file", item);
      const envelope = buildEnvelope("edit_file", response, { requestId: newRequestId(), elapsedMs: performance.now() - itemStarted, cached });
      const size = stringify(envelope).length;
      if (size > maxItemBytes) {
        recordMetric("edit_file", performance.now() - itemStarted, false);
        responses.push({ ok: false, error: { code: "resource_limit", message: "Item response exceeds item limit.", retryable: false } });
        continue;
      }
      if (totalBytes + size > deps.maxBatchResponseBytes) {
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
          await deps.execute("snapshot_restore", { action: "restore", id: snapshotId });
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
