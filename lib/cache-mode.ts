/**
 * `VENIRA_CACHE=all|list|search|off`: one variable decides every cache
 * (ROADMAP_ENV_SLIM.md phase 2b).
 *
 *   all    every read/list/search cache on (the default)
 *   list   only the directory-listing cache
 *   search only the search cache
 *   off    always fresh, no TTL caches
 *
 * `VENIRA_CACHE_ALL` was removed (no alias). `VENIRA_CACHE_LIST_ONLY` and
 * `VENIRA_CACHE_SEARCH_ONLY` remain aliases: an explicitly set legacy flag
 * ALWAYS wins over `VENIRA_CACHE`, per variable; an unknown mode fails closed
 * with `[config_invalid]`, the same as an invalid boolean.
 *
 * Keep this file dependency-free apart from `env.ts`.
 */
import { envFlag } from "./env.js";

export const CACHE_MODES = ["all", "list", "search", "off"] as const;
export type CacheMode = (typeof CACHE_MODES)[number];
export type CachePart = "all" | "list" | "search";

const LEGACY_FLAG: Partial<Readonly<Record<CachePart, string>>> = {
  list: "VENIRA_CACHE_LIST_ONLY",
  search: "VENIRA_CACHE_SEARCH_ONLY",
};

/** Parse `VENIRA_CACHE`. Unset or empty means `all`. */
export function cacheModeFromEnv(env: NodeJS.ProcessEnv = process.env): CacheMode {
  const raw = env.VENIRA_CACHE;
  if (raw === undefined) return "all";
  const value = raw.trim().toLowerCase();
  if (value === "") return "all";
  if ((CACHE_MODES as readonly string[]).includes(value)) return value as CacheMode;
  throw new Error(`[config_invalid] VENIRA_CACHE must be one of: ${CACHE_MODES.join(", ")}.`);
}

/** What the mode alone says about one cache part (ignoring the legacy flags). */
export function cachePartFromMode(mode: CacheMode, part: CachePart): boolean {
  switch (mode) {
    case "all":
      return true;
    case "off":
      return false;
    case "list":
      return part !== "search";
    case "search":
      return part !== "list";
  }
}

/** Effective on/off for one cache part: explicit legacy flag first, then `VENIRA_CACHE`. */
export function cacheEnabled(part: CachePart, env: NodeJS.ProcessEnv = process.env): boolean {
  const legacy = LEGACY_FLAG[part];
  const explicit = legacy === undefined ? undefined : env[legacy];
  if (explicit !== undefined) return envFlag(legacy as string, true, explicit);
  return cachePartFromMode(cacheModeFromEnv(env), part);
}
