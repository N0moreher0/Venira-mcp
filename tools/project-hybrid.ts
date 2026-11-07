import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { extractSymbols } from "../lib/symbol-diff.js";
import { readTextFile } from "./project-codeintel.js";

// project_search hybrid mode. Extracted from tools/project.ts (P1 #6, step 5e); behavior is
// unchanged. The backend search (with its cache) is owned by project.ts and reached through
// HybridDeps, so this module never imports project.ts.

type Args = Record<string, unknown>;

/** Same shape as the response cache's Execution record in project.ts. */
export type HybridExecution = { response: RustResponse; cached: boolean };

export type HybridDeps = {
  /** Run one backend operation through the shared cache (project.ts `executeCached`). */
  execute: (operation: string, args: Args) => Promise<HybridExecution>;
};

// ---------------------------------------------------------------------------
// project_search hybrid mode (opt-in, `hybrid: 1`). One backend walk feeds the
// enrichment — a second ripgrep pass would share the same backend and double
// the work for no extra information. Every hit is tagged with `source`
// (symbol_index definition > symbol_reference whole-word > plain content) and
// `confidence`. A scoped, identifier-like query that returns nothing widens
// once to the workspace and flags `scope_widened: true` so the agent knows the
// scope changed underneath it.
// ---------------------------------------------------------------------------
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Per-batch cache of parsed symbols (path -> symbols, or null when the file is unreadable). */
export type HybridSymbolCache = Map<string, ReturnType<typeof extractSymbols> | null>;

/**
 * Largest prefix of a hybrid search response's hits that fits `maxItemBytes`, or null when not even one
 * hit fits. `measure` returns the serialized size of a candidate response exactly as it would be sent.
 */
export function fitHybridToBudget(
  response: RustResponse,
  maxItemBytes: number,
  measure: (candidate: RustResponse) => number,
): RustResponse | null {
  const data = (response.result?.data ?? {}) as { hits?: unknown[] };
  const hits = Array.isArray(data.hits) ? data.hits : [];
  const build = (keep: number): RustResponse => ({
    ...response,
    truncated: true,
    result: {
      kind: "search",
      data: { ...data, hits: hits.slice(0, keep), complete: false, trimmed_to_item_budget: true },
    },
  });
  let lo = 1;
  let hi = hits.length - 1;
  let best: RustResponse | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = build(mid);
    if (measure(candidate) <= maxItemBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

type HybridHit = Record<string, unknown> & {
  relative_path?: unknown;
  line_number?: unknown;
  snippet?: unknown;
  source: string;
  confidence: "exact_match" | "text_match";
};

/**
 * Core of the hybrid search, shared by `project_search` (hybrid: 1) and by `search` items inside
 * `project_read_batch`. Returns the merged response so each caller builds its own envelope.
 */
export async function computeHybridSearch(
  args: Args,
  deps: HybridDeps,
  symbolCache?: HybridSymbolCache,
): Promise<HybridExecution> {
  const query = String(args.query ?? "");
  const queryTrimmed = query.trim();
  const identifier = IDENTIFIER_RE.test(queryTrimmed) ? queryTrimmed : null;
  const scoped = typeof args.relative_path === "string" && args.relative_path.trim() !== "";
  const requestedLimit = Number.isFinite(Number(args.limit))
    ? Math.max(1, Math.min(200, Math.floor(Number(args.limit))))
    : 200;

  const searchArgs = { ...args, hybrid: undefined, limit: 200 } as Args;
  let execution = await deps.execute("search", searchArgs);
  let response = execution.response;
  let data = (response.result?.data ?? {}) as { hits?: unknown[]; complete?: boolean };
  let hits = Array.isArray(data.hits) ? (data.hits as Record<string, unknown>[]) : [];

  // Retry-scope fallback: zero hits on a scoped, identifier-like query.
  let scopeWidened = false;
  if (hits.length === 0 && scoped && identifier !== null) {
    const widened = { ...args, hybrid: undefined, relative_path: undefined, limit: 200 } as Args;
    const widenedExecution = await deps.execute("search", widened);
    const widenedData = (widenedExecution.response.result?.data ?? {}) as { hits?: unknown[] };
    const widenedHits = Array.isArray(widenedData.hits) ? (widenedData.hits as Record<string, unknown>[]) : [];
    if (widenedHits.length > 0) {
      scopeWidened = true;
      execution = widenedExecution;
      response = widenedExecution.response;
      data = (response.result?.data ?? {}) as typeof data;
      hits = widenedHits;
    }
  }

  // Tag hits. Definition sites are detected per file with the same parser-lite
  // used by project_outline_symbol, bounded to files that
  // actually produced hits.
  const definitionLines = new Map<string, Set<number>>();
  if (identifier !== null && hits.length > 0) {
    const files = [...new Set(hits.map((hit) => String(hit.relative_path ?? "")).filter(Boolean))].slice(0, 32);
    await Promise.allSettled(
      files.map(async (rel) => {
        try {
          let symbols = symbolCache?.get(rel);
          if (symbols === undefined) {
            const text = await readTextFile(rel);
            symbols = text === null ? null : extractSymbols(text);
            symbolCache?.set(rel, symbols);
          }
          if (symbols === null) return;
          const lines = new Set<number>();
          for (const sym of symbols) {
            if (sym.name === identifier) lines.add(sym.line);
          }
          if (lines.size > 0) definitionLines.set(rel, lines);
        } catch {
          /* best effort — the hit keeps its weaker tag */
        }
      }),
    );
  }

  const wordRe = identifier !== null ? new RegExp(`\\b${escapeRegExp(identifier)}\\b`) : null;
  // Tag every raw hit (already bounded by the 200-hit over-fetch), rank, and only then apply
  // `limit`. Slicing first would make the tag priority irrelevant for which hits are returned.
  const taggedAll: HybridHit[] = hits.map((hit) => {
    const rel = String(hit.relative_path ?? "");
    const line = Number(hit.line_number ?? 0);
    const snippet = String(hit.snippet ?? "");
    let source = "content";
    let confidence: "exact_match" | "text_match" = "text_match";
    if (definitionLines.get(rel)?.has(line)) {
      source = "symbol_index";
      confidence = "exact_match";
    } else if (wordRe?.test(snippet)) {
      source = "symbol_reference";
      confidence = "exact_match";
    }
    return { ...hit, source, confidence };
  });

  // symbol_index > symbol_reference > content; ties keep file-walk order (explicit index tie-break,
  // so the result does not depend on the engine's sort stability).
  const sourceRank = (source: string): number =>
    source === "symbol_index" ? 0 : source === "symbol_reference" ? 1 : 2;
  const tagged: HybridHit[] = taggedAll
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => sourceRank(a.hit.source) - sourceRank(b.hit.source) || a.index - b.index)
    .slice(0, requestedLimit)
    .map((entry) => entry.hit);

  const truncated = tagged.length < hits.length || response.truncated === true || data.complete === false;
  const mergedData = {
    ...data,
    hits: tagged,
    // The over-fetch returns up to 200 hits; when we slice below the request,
    // the agent did NOT get everything — report `complete: false` (matching
    // the plain path's cap semantics) instead of a stale `true`.
    complete: !truncated,
    hybrid: true,
    ...(scopeWidened ? { scope_widened: true } : {}),
  };
  const merged: RustResponse = {
    status: "completed",
    truncated,
    result: { kind: "search", data: mergedData },
  };
  return { response: merged, cached: execution.cached };
}

export async function runHybridSearch(args: Args, deps: HybridDeps): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const { response, cached } = await computeHybridSearch(args, deps);
  const elapsedMs = performance.now() - started;
  recordMetric("search", elapsedMs, true);
  return toolResult(buildEnvelope("search", response, { requestId, elapsedMs, cached }));
}
