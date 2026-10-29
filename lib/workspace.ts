/**
 * Restrict all paths to WORKSPACE (default = the current working directory).
 * Standalone: no Rust host, no @grant paths — just plain workspace locking.
 */
import path from "node:path";

export const PLATFORM = process.platform;

export const WORKSPACE = path.resolve(process.env.VENIRA_WORKSPACE ?? process.cwd());

/** VENIRA_UNRESTRICTED=1: disable workspace lock, allow any absolute path (relative paths still resolve from WORKSPACE). */
export const UNRESTRICTED = ["1", "true", "on", "yes"].includes(
  (process.env.VENIRA_UNRESTRICTED ?? "").toLowerCase(),
);

export function toHostPath(input: string | undefined): string {
  const raw = (input ?? "").trim();
  const abs = path.resolve(WORKSPACE, raw === "" ? "." : raw);
  if (UNRESTRICTED) return abs;
  const rel = path.relative(WORKSPACE, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(
      `[path_escape] Path is outside the workspace (${WORKSPACE}): ${raw}. Hint: use a workspace-relative path or set VENIRA_UNRESTRICTED=1.`,
    );
  }
  return abs;
}

/**
 * Resolve `input` under an explicit `root` (used by the corehost operations,
 * which receive the workspace root per call). Same guarantee as
 * `toHostPath`: relative stays inside, absolute must stay inside unless
 * VENIRA_UNRESTRICTED=1.
 */
export function resolveWithin(root: string, input: string | undefined): string {
  const raw = (input ?? "").trim();
  const abs = path.resolve(root, raw === "" ? "." : raw);
  if (UNRESTRICTED) return abs;
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(
      `[scope_denied] Path escapes workspace (${root}): ${raw}. Hint: use a workspace-relative path or set VENIRA_UNRESTRICTED=1.`,
    );
  }
  return abs;
}

// ---------------------------------------------------------------------------
// P1: cache control (VENIRA_CACHE_ALL / VENIRA_CACHE_LIST_ONLY / VENIRA_CACHE_SEARCH_ONLY)
// ---------------------------------------------------------------------------
const envFlag = (name: string): boolean =>
  !["0", "false", "off", "no"].includes((process.env[name] ?? "").toLowerCase());

/** VENIRA_CACHE_ALL=0 disables every read/list/search/recent cache (strict "always fresh" mode). */
export const CACHE_ALL_ENABLED = envFlag("VENIRA_CACHE_ALL");
/** VENIRA_CACHE_LIST_ONLY=0 disables only the list_files TTL cache. */
export const CACHE_LIST_ONLY_ENABLED = envFlag("VENIRA_CACHE_LIST_ONLY");
/** VENIRA_CACHE_SEARCH_ONLY=0 disables only the search TTL cache. */
export const CACHE_SEARCH_ONLY_ENABLED = envFlag("VENIRA_CACHE_SEARCH_ONLY");
