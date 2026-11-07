import { promises as fs } from "node:fs";
import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { buildOutline, diffUnified, extractSymbols } from "../lib/symbol-diff.js";
import { isProtectedPath, toHostPath } from "../lib/workspace.js";

// Code-intelligence tool handlers (outline_symbol, file_symbols, diff_files) and the
// shared protected-path-aware text reader. Extracted verbatim from tools/project.ts
// (P1 #6, step 5a); behavior is unchanged.

type Args = Record<string, unknown>;

/** Read a workspace file's text, respecting max bytes; null when missing or protected. */
export async function readTextFile(relPath: string): Promise<string | null> {
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

export async function runOutlineSymbol(args: Args): Promise<ToolResult> {
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

export async function runFileSymbols(args: Args): Promise<ToolResult> {
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

export async function runDiffFiles(args: Args): Promise<ToolResult> {
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
