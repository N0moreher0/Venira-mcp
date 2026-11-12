import path from "node:path";
import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { selectiveSearch, type SelectiveQuery } from "../lib/symbol-diff.js";
import { WORKSPACE } from "../lib/workspace.js";
import type { Args } from "./project-cache.js";

type ReferenceCache = {
  lookup: (key: string) => RustResponse | null;
  store: (key: string, response: RustResponse) => void;
};

export type CodeIntelRunnerDeps = {
  execute: (operation: string, args: Args) => Promise<RustResponse>;
  executeCached: (operation: string, args: Args) => Promise<{ response: RustResponse; cached: boolean }>;
  readTextFile: (relativePath: string) => Promise<string | null>;
  toHostPath: (relativePath: string | undefined) => string;
  isProtectedPath: (absolutePath: string) => boolean;
  referenceCache: ReferenceCache;
  stableKey: (value: Args) => string;
};

export function createCodeIntelRunners(deps: CodeIntelRunnerDeps) {
  const { execute, executeCached, readTextFile, toHostPath, isProtectedPath, referenceCache, stableKey } = deps;

  async function runSymbolReferences(args: Args): Promise<ToolResult> {
    const started = performance.now();
    const requestId = newRequestId();
    const symbolName = String(args.symbol_name ?? "");
    if (!symbolName) {
      return toolResult(errorEnvelope("symbol_references", new Error("[invalid_request] symbol_name is required."), { requestId, elapsedMs: 0 }), true);
    }
    const scope = args.scope === "file" ? "file" : "workspace";
    let references: Array<{ relative_path: string; line_number: number; context: string }> = [];
    let found = 0;
    let searchCacheHit = false;
    let sourceTruncated = false;
    // Roadmap item 15 (P2): `limit` and `max_references` overlapped and the
    // schema did not say which was which. The two roles are now explicit:
    //   max_references - how many references come back (the token bill)
    //   limit         - how many workspace hits are scanned (the work)
    // The scan is never the bottleneck by default: it follows max_references.
    const max = Number(args.max_references ?? 100);
    const requestedScan = Number(args.limit ?? max);
    const scanLimit = Math.max(1, Math.min(200, requestedScan));
    if (scope === "file") {
      const rel = String(args.relative_path ?? "");
      // Roadmap item 15 (P2): scope=file needs a file. Without one it used to
      // answer `not_found "No such file: ."`, which looks like a missing file
      // instead of a missing argument.
      if (!rel.trim() || rel === ".") {
        return toolResult(
          errorEnvelope(
            "symbol_references",
            new Error(
              "[invalid_request] scope=file needs relative_path. " +
                "Hint: pass the file to search, or use scope=workspace (the default).",
            ),
            { requestId, elapsedMs: performance.now() - started },
          ),
          true,
        );
      }
      if (isProtectedPath(toHostPath(rel))) {
        return toolResult(
          errorEnvelope("symbol_references", new Error(`[sensitive_result] Path is protected by policy: ${rel}.`), { requestId, elapsedMs: performance.now() - started }),
          true,
        );
      }
      const content = await readTextFile(rel);
      if (content === null) {
        return toolResult(errorEnvelope("symbol_references", new Error(`[not_found] No such file: ${rel}.`), { requestId, elapsedMs: performance.now() - started }), true);
      }
      const lines = content.split("\n");
      const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`);
      const relName = path.relative(WORKSPACE, toHostPath(rel)).replace(/\\/g, "/");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          found += 1;
          // Only the returned slice is kept in memory: the count stays exact,
          // the payload stays bounded by max_references.
          if (references.length < max) {
            references.push({
              // Roadmap item 15 (P2): a workspace-relative path, like every
              // other tool reports.
              relative_path: relName,
              line_number: i + 1,
              context: lines[i].trim().slice(0, 160),
            });
          }
        }
      }
    } else {
      const innerArgs = {
        query: symbolName,
        kind: "literal_content",
        whole_word: true,
        limit: scanLimit,
        relative_path: args.relative_path,
      };
      const refKey = stableKey(innerArgs);
      const cachedSearch = referenceCache.lookup(refKey);
      searchCacheHit = cachedSearch !== null;
      const searchRes = cachedSearch ?? (await executeCached("search", innerArgs)).response;
      const searchData = searchRes.result?.data as { complete?: boolean } | undefined;
      sourceTruncated = searchData?.complete === false;
      if (!cachedSearch && searchData?.complete !== false) referenceCache.store(refKey, searchRes);
      const hits = (searchRes.result?.data as { hits?: unknown[] } | undefined)?.hits ?? [];
      found = hits.length;
      references = (hits as Array<{ relative_path?: unknown; line_number?: unknown; snippet?: unknown; text?: unknown; line?: unknown; context?: unknown }>).map((hit) => ({
        relative_path: String(hit.relative_path ?? ""),
        line_number: Number(hit.line_number ?? 0),
        context: String(hit.snippet ?? hit.text ?? hit.line ?? hit.context ?? "").slice(0, 160),
      }));
    }
    const returned = references.slice(0, max);
    // `count` is the number of matches, `returned` what came back: the agent
    // sees at once that a cap cut the list instead of guessing.
    const limited = found > returned.length || sourceTruncated;
    const response: RustResponse = {
      status: "completed",
      result: {
        kind: "symbol_references",
        data: {
          symbol_name: symbolName,
          scope,
          count: found,
          returned: returned.length,
          ...(found > returned.length ? { omitted: found - returned.length } : {}),
          ...(scope === "workspace" ? { scan_limit: scanLimit } : {}),
          ...(limited ? { limited: true } : {}),
          references: returned,
        },
      },
      truncated: limited,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("symbol_references", elapsedMs, true);
    return toolResult(buildEnvelope("symbol_references", response, { requestId, elapsedMs, cached: searchCacheHit }));
  }

  async function runSelectiveSearch(args: Args): Promise<ToolResult> {
    const started = performance.now();
    const requestId = newRequestId();
    const queries = args.queries as SelectiveQuery[] | undefined;
    if (!Array.isArray(queries) || queries.length === 0) {
      return toolResult(errorEnvelope("selective_search", new Error("[invalid_request] queries[] is required."), { requestId, elapsedMs: 0 }), true);
    }
    const files = new Map<string, string>();
    const hint = Array.isArray(args.files_hint) ? (args.files_hint as string[]) : [];
    if (hint.length > 0) {
      let usable = 0;
      let blocked = 0;
      for (const rel of hint.slice(0, 20)) {
        let protectedPath = false;
        try {
          protectedPath = isProtectedPath(toHostPath(rel));
        } catch {
          protectedPath = false;
        }
        if (protectedPath) {
          blocked += 1;
          continue;
        }
        usable += 1;
        const content = await readTextFile(rel);
        if (content !== null) files.set(toHostPath(rel), content);
      }
      if (usable === 0 && blocked > 0) {
        return toolResult(
          errorEnvelope("selective_search", new Error("[sensitive_result] Every files_hint path is protected by policy."), { requestId, elapsedMs: performance.now() - started }),
          true,
        );
      }
    } else {
      const relPath = args.relative_path ? String(args.relative_path) : undefined;
      const listRes = await execute("list_files", { relative_path: relPath, depth: 2, limit: 40 });
      const entries = (listRes.result?.data as { entries?: unknown[] } | undefined)?.entries ?? [];
      const list = entries.filter((entry) => typeof entry === "object" && (entry as { kind?: unknown }).kind === "file").slice(0, 40) as Array<{ relative_path?: unknown }>;
      for (const entry of list) {
        const rel = String(entry.relative_path ?? "");
        if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|cs|rb|php|sql|json|md|sh|yml|yaml|toml)$/.test(rel)) {
          const content = await readTextFile(rel);
          if (content !== null) files.set(toHostPath(rel), content);
        }
      }
    }
    const result = selectiveSearch(files, queries, Number(args.limit ?? 100));
    // Roadmap item 15 (P2): the hits carried the absolute path of the file.
    const hits = result.hits.map((hit) => ({
      ...hit,
      relative_path: path.relative(WORKSPACE, hit.relative_path).replace(/\\/g, "/"),
    }));
    const response: RustResponse = {
      status: "completed",
      result: {
        kind: "selective_search",
        data: { hits, total_files: result.total_files, total_hits: result.total_hits, truncated: result.truncated },
      },
      truncated: result.truncated,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("selective_search", elapsedMs, true);
    return toolResult(buildEnvelope("selective_search", response, { requestId, elapsedMs, cached: false }));
  }

  return { runSymbolReferences, runSelectiveSearch };
}
