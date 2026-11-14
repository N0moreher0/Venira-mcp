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

const MUTATING = new Set(["write_file", "edit_file", "delete_path", "apply_patch"]);
/** Two-path mutations: both `from` and `to` must be invalidated. */
const PAIR_MUTATING = new Set(["move_path", "copy_path"]);
/** Worktree-wide mutations with no single path in args. */
const isGitWorktreeMutation = (operation: string, args: Args): boolean => {
  if (operation === "git_commit") return true;
  const rawAction = typeof args.action === "string" ? args.action.trim().toLowerCase() : undefined;
  if (operation === "git_branch") return !["list", "current"].includes(rawAction ?? "list");
  if (operation === "git_stash") return !["list", "show"].includes(rawAction ?? "list");
  return false;
};

/** 0|1 integer or boolean dry_run shapes (apply_patch). */
function isDryRunFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** Same 0|1 coercion for get_file_info's `missing_ok`. */
function isMissingOkFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** The backend labels missing paths as `[not_found] ...`; other codes (sensitive_result, path_escape, ...) stay errors. */
function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("[not_found]");
}

/** Copy of `response` with `exists` set on its data payload (used when `missing_ok=1`). */
function withExists(response: RustResponse, exists: boolean): RustResponse {
  const result = response.result;
  const data = result && typeof result === "object" ? result.data : undefined;
  if (!result || typeof result !== "object" || !data || typeof data !== "object") return response;
  return { ...response, result: { ...result, data: { ...(data as Record<string, unknown>), exists } } };
}

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
        throw new Error("[invalid_request] safe_edit tool removed. Use edit_file with expected_sha256 instead.");
      }

      const bypassAll = !CACHE_ALL_ENABLED && ["read_file", "get_file_info", "list_files", "search"].includes(operation);
      let execution: Execution;
      if (operation === "read_file") {
        execution = bypassAll
          ? { response: await execute(operation, args), cached: false }
          : await cache.readFileCached(args);
      } else if (operation === "get_file_info") {
        // `missing_ok` is answered here, not in the backend: it is stripped before the
        // cache/backend call so the cache key does not change, and only `[not_found]` is
        // swallowed. Other errors (outside workspace, protected path, ...) stay errors.
        const missingOk = isMissingOkFlag(args.missing_ok);
        let backendArgs = args;
        if (missingOk && "missing_ok" in args) {
          backendArgs = { ...args };
          delete backendArgs.missing_ok;
        }
        try {
          execution = bypassAll
            ? { response: await execute(operation, backendArgs), cached: false }
            : await cache.fileInfoCached(backendArgs);
          if (missingOk) execution = { ...execution, response: withExists(execution.response, true) };
        } catch (error) {
          if (!missingOk || !isNotFoundError(error)) throw error;
          execution = {
            response: {
              status: "completed",
              result: {
                kind: "file_info",
                data: {
                  relative_path: typeof backendArgs.relative_path === "string" ? backendArgs.relative_path : "",
                  exists: false,
                },
              },
              hint: "Path does not exist. Create it with write_file if that is intended; do not retry the same path.",
            },
            cached: false,
          };
        }
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
        const skipInvalidation = operation === "apply_patch" && isDryRunFlag(args.dry_run);
        if (operation === "apply_patch" && !skipInvalidation) {
          // Paths live inside the patch, not in args: collect them from the result.
          const data = response.result?.data as
            | { files?: Array<{ relative_path?: string; old_path?: string; new_path?: string }> }
            | undefined;
          const paths = new Set<string>();
          for (const file of data?.files ?? []) {
            if (file.relative_path) paths.add(file.relative_path);
            if (file.old_path) paths.add(file.old_path);
            if (file.new_path) paths.add(file.new_path);
          }
          for (const rel of paths) {
            try {
              const absolutePath = toHostPath(rel);
              cache.invalidatePath(absolutePath);
              rememberEdit(absolutePath);
            } catch {
              /* invalid paths already return an error; there is no cache entry to clean */
            }
          }
          cache.invalidateListCaches();
          invalidateDependencyGraphCache();
        } else if (isGitWorktreeMutation(operation, args)) {
          cache.invalidateAllCaches();
          clearRecentEdits();
          invalidateDependencyGraphCache();
        } else if (MUTATING.has(operation) && !skipInvalidation) {
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
        if (PAIR_MUTATING.has(operation)) {
          for (const key of ["from", "to"] as const) {
            try {
              const absolutePath = toHostPath(args[key] as string | undefined);
              cache.invalidatePath(absolutePath);
              rememberEdit(absolutePath);
            } catch {
              /* invalid paths already return an error; there is no cache entry to clean */
            }
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
