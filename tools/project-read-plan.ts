import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import {
  NAME_HIT_POINTS,
  buildReadPlan,
  extractKeywords,
  isPlannablePath,
  rankCandidates,
  type PlanCandidate,
} from "../lib/read-plan.js";
import type { Args } from "./project-cache.js";

type RecentFile = { relative_path: string; size: number };

export type ReadPlanRunnerDeps = {
  execute: (operation: string, args: Args) => Promise<RustResponse>;
  queryRecentFiles: (limit: number, includeDirs: boolean, workspaceRoot: string) => RecentFile[];
  workspaceRoot: string;
};

export function createReadPlanRunner({ execute, queryRecentFiles, workspaceRoot }: ReadPlanRunnerDeps) {
  return async function runPlanReadBatch(args: Args): Promise<ToolResult> {
    const started = performance.now();
    const requestId = newRequestId();
    const task = typeof args.task_description === "string" ? args.task_description.trim() : "";
    if (!task) {
      const elapsedMs = performance.now() - started;
      return toolResult(
        errorEnvelope(
          "plan_read_batch",
          new Error(
            "[invalid_request] `task_description` is required. Hint: describe the change in one line, e.g. " +
              '"add retry handling to the GitHub client".',
          ),
          { requestId, elapsedMs },
        ),
        true,
      );
    }
    const maxFiles = Math.max(1, Math.min(8, Number(args.max_files ?? 6) || 6));
    const keywords = extractKeywords(task, Math.max(1, Math.min(5, Number(args.max_keywords ?? 5) || 5)));
    const includeSearch = args.include_search !== false;
    const hints = Array.isArray(args.files_hint)
      ? (args.files_hint as unknown[]).map((value) => String(value).trim()).filter(Boolean).slice(0, 16)
      : [];

    const candidates = new Map<string, PlanCandidate>();
    for (const rel of hints) candidates.set(rel, { relative_path: rel, reason: "files_hint", hits: 3 });
    let searched = false;
    const addCandidate = (rel: string, reason: string, points: number) => {
      if (!rel || !isPlannablePath(rel)) return;
      const existing = candidates.get(rel);
      if (existing) existing.hits = (existing.hits ?? 0) + points;
      else candidates.set(rel, { relative_path: rel, reason, hits: points });
    };

    const searchNames = async (keyword: string): Promise<Array<{ relative_path?: unknown }>> => {
      const run = async (query: string) => {
        const res = await execute("search", { query, kind: "file_name", limit: 8 });
        return ((res.result?.data as { hits?: unknown[] } | undefined)?.hits ?? []) as Array<{ relative_path?: unknown }>;
      };
      const swapped = keyword.includes("_") ? keyword.replace(/_/g, "-") : keyword.replace(/-/g, "_");
      const queries = [...new Set([keyword, keyword.toLowerCase(), swapped, swapped.toLowerCase()])];
      for (const query of queries) {
        try {
          const hits = await run(query);
          if (hits.length > 0) return hits;
        } catch {
          /* try the next bounded spelling variant */
        }
      }
      return [];
    };

    for (const keyword of includeSearch ? keywords.slice(0, 3) : []) {
      try {
        const searchRes = await execute("search", { query: keyword, kind: "literal_content", limit: 25 });
        searched = true;
        const hits = (searchRes.result?.data as { hits?: unknown[] } | undefined)?.hits ?? [];
        for (const hit of hits as Array<{ relative_path?: unknown }>) {
          addCandidate(String(hit.relative_path ?? ""), `search:${keyword}`, 1);
        }
      } catch {
        /* a single search failure (policy/glob) must not fail the plan */
      }
      try {
        const nameHits = await searchNames(keyword);
        searched = true;
        for (const hit of nameHits) addCandidate(String(hit.relative_path ?? ""), `name:${keyword}`, NAME_HIT_POINTS);
      } catch {
        /* filename search is a bonus signal: content hits still stand */
      }
    }

    if (candidates.size < 2) {
      try {
        for (const recent of queryRecentFiles(12, false, workspaceRoot)) {
          if (!isPlannablePath(recent.relative_path)) continue;
          if (!candidates.has(recent.relative_path)) {
            candidates.set(recent.relative_path, {
              relative_path: recent.relative_path,
              reason: "recent_edit",
              size_bytes: recent.size,
            });
          }
        }
      } catch {
        /* index unavailable: plan works from hints/keywords only */
      }
    }

    const ranked = rankCandidates([...candidates.values()], keywords, task, maxFiles);
    const plan = buildReadPlan({ task, keywords, candidates: ranked, maxFiles, includeSearch, searched });
    const response: RustResponse = {
      status: "completed",
      result: {
        kind: "plan_read_batch",
        data: {
          task,
          keywords: plan.keywords,
          searched,
          candidates: plan.candidates,
          steps: plan.steps,
          estimated_ms: plan.estimated_ms,
          notes: plan.notes,
        },
      },
    };
    const elapsedMs = performance.now() - started;
    recordMetric("plan_read_batch", elapsedMs, true);
    return toolResult(buildEnvelope("plan_read_batch", response, { requestId, elapsedMs, cached: false }));
  };
}
