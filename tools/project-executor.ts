import { evaluateToolPolicy } from "../lib/tool-policy.js";
import { addTrace } from "../lib/tracer.js";
import { invalidateDependencyGraphCache } from "../lib/dependency-graph.js";
import { clearShellCache } from "../lib/shell-cache.js";
import {
  CACHE_ALL_ENABLED,
  CACHE_LIST_ONLY_ENABLED,
  CACHE_SEARCH_ONLY_ENABLED,
  toHostPath,
} from "../lib/workspace.js";
import type { RustResponse } from "../lib/output.js";
import type { Args, Execution, CacheLayer } from "./project-cache.js";

export type CachedExecutorDeps = {
  cache: CacheLayer;
  execute: (operation: string, args: Args) => Promise<RustResponse>;
  rememberEdit: (absolutePath: string) => void;
  clearRecentEdits: () => void;
  trackShell: (operation: string, data: unknown) => void;
};

const MUTATING = new Set(["write_file", "edit_file", "delete_path"]);

/** Central policy/cache/invalidation wrapper for tool backend operations. */
export function createCachedExecutor({
  cache,
  execute,
  rememberEdit,
  clearRecentEdits,
  trackShell,
}: CachedExecutorDeps): (operation: string, args: Args) => Promise<Execution> {
  return async function executeCached(operation: string, args: Args): Promise<Execution> {
    const started = Date.now();
    let cached = false;
    let ok = true;
    try {
      // Tool-level policy is centralized here; the shell policy still runs in corehost.
      const decision = evaluateToolPolicy(operation, args);
      if (decision) {
        if (decision.tier === "deny") throw new Error(`[command_denied] ${decision.reason} (rule: ${decision.tool})`);
        if (decision.tier === "ask") throw new Error(`[approval_required] ${decision.reason}`);
      }

      if (operation === "cache_clear") {
        const type = (args.type as string | undefined) ?? "all";
        const cleared: Record<string, number> = {};
        const clearType = (name: string, fn: () => number | void) => {
          try {
            const count = fn();
            cleared[name] = typeof count === "number" ? count : 0;
          } catch {
            cleared[name] = 0;
          }
        };
        if (type === "all" || type === "shell") {
          clearShellCache();
          cleared.shell = -1;
        }
        for (const name of ["read", "info", "list", "search", "recent", "negative"] as const) {
          if (type === "all" || type === name) clearType(name, () => cache.clear(name));
        }
        if (type === "all" || type === "graph") {
          invalidateDependencyGraphCache();
          cleared.graph = -1;
        }
        return {
          response: { status: "completed", result: { kind: "cache_clear", data: { type, cleared } } },
          cached: false,
        };
      }

      if (operation === "safe_edit") {
        throw new Error("[invalid_request] safe_edit tool removed. Use project_edit_file with expected_sha256 instead.");
      }

      const bypassAll = !CACHE_ALL_ENABLED && ["read_file", "get_file_info", "list_files", "search"].includes(operation);
      let execution: Execution;
      if (operation === "read_file") {
        execution = bypassAll
          ? { response: await execute(operation, args), cached: false }
          : await cache.readFileCached(args);
      } else if (operation === "get_file_info") {
        execution = bypassAll
          ? { response: await execute(operation, args), cached: false }
          : await cache.fileInfoCached(args);
      } else if (operation === "list_files") {
        execution = bypassAll || !CACHE_LIST_ONLY_ENABLED
          ? { response: await execute(operation, args), cached: false }
          : await cache.listCached(args);
      } else if (operation === "search") {
        execution = bypassAll || !CACHE_SEARCH_ONLY_ENABLED
          ? { response: await execute(operation, args), cached: false }
          : await cache.searchCached(args);
      } else {
        const response = await execute(operation, args);
        if (MUTATING.has(operation)) {
          try {
            const absolutePath = toHostPath(args.relative_path as string | undefined);
            cache.invalidatePath(absolutePath);
            rememberEdit(absolutePath);
          } catch {
            /* invalid paths already return an error; there is no cache entry to clean */
          }
          cache.invalidateListCaches();
          invalidateDependencyGraphCache();
        }
        if (operation === "snapshot_restore" || operation === "snapshot_delete") {
          cache.invalidateAllCaches();
          clearRecentEdits();
          invalidateDependencyGraphCache();
        }
        if (operation.startsWith("shell_") || operation === "cancel") {
          trackShell(operation, response.result?.data);
        }
        execution = { response, cached: false };
      }

      cached = execution.cached;
      return execution;
    } catch (error) {
      ok = false;
      throw error;
    } finally {
      addTrace({ operation, duration_ms: Date.now() - started, ok, cached });
    }
  };
}
