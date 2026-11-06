/**
 * Bounded pagination shared by the GitHub and Bitbucket dialects.
 *
 * Rules (the same ones GitLab's `gitlabPages` follows):
 * - at most `CI_MAX_PAGES` requests and `CI_MAX_ITEMS` items per logical read;
 * - the next page is only ever followed on the configured API origin, and the
 *   request goes back through `gitFetch`, so the token, redirect handling,
 *   response cap and secret scanning stay in one place;
 * - a page URL is never fetched twice (a misbehaving server cannot loop us);
 * - hitting a cap is reported (`truncated`), never hidden: callers that derive
 *   a verdict (e.g. "success") from the items must say when it is partial.
 */
import { gitFetch, type RawHeaders, type RawResult } from "./git-http.js";
import type { GitContext } from "./git-config.js";

export const CI_MAX_PAGES = 5;
export const CI_MAX_ITEMS = 200;

/** Absolute provider URL -> path relative to `api_base`; cross-origin / out-of-base URLs are refused. */
export function relativeApiPath(target: URL, apiBase: string): string | null {
  const base = new URL(apiBase);
  if (target.origin !== base.origin) return null;
  const prefix = base.pathname.replace(/\/+$/, "");
  if (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) return null;
  return `${target.pathname.slice(prefix.length) || "/"}${target.search}`;
}

/** `Link: <url>; rel="next"` (GitHub, GitLab) -> relative API path, or null. */
export function linkNextPath(headers: RawHeaders, currentUrl: URL, apiBase: string): string | null {
  const raw = headers.link;
  const links = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  for (const part of links.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!match) continue;
    return relativeApiPath(new URL(match[1], currentUrl), apiBase);
  }
  return null;
}

export type Paged<T> = {
  items: T[];
  /** Provider-reported total (GitHub `total_count`), when the first page carried one. */
  total: number | null;
  pages: number;
  /** True when the provider has more than `items` (a cap stopped the walk, or the total says so). */
  truncated: boolean;
};

export type PagedOptions<T> = {
  /** Items of one decoded page (must tolerate `null`: an empty or non-JSON body). */
  pick: (json: any) => T[];
  /** Next page as a path relative to `api_base`; default follows `Link rel=next`. */
  next?: (json: any, res: RawResult, current: URL) => string | null;
  /** Provider total from the first page, when it reports one. */
  total?: (json: any) => unknown;
  maxItems?: number;
  maxPages?: number;
  allowAnonymous?: boolean;
};

function clampInt(value: number | undefined, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

export async function fetchPaged<T = any>(ctx: GitContext, initialPath: string, opts: PagedOptions<T>): Promise<Paged<T>> {
  const itemCap = clampInt(opts.maxItems, CI_MAX_ITEMS, CI_MAX_ITEMS);
  const pageCap = clampInt(opts.maxPages, CI_MAX_PAGES, CI_MAX_PAGES);
  const items: T[] = [];
  const seen = new Set<string>();
  let path = initialPath;
  let total: number | null = null;
  let pages = 0;
  let truncated = false;

  while (true) {
    if (seen.has(path)) break;
    seen.add(path);
    const res = await gitFetch(ctx, path, { allowAnonymous: opts.allowAnonymous });
    pages += 1;
    let json: any = null;
    try {
      json = res.buffer.length ? JSON.parse(res.buffer.toString("utf8")) : null;
    } catch {
      json = null;
    }
    if (pages === 1 && opts.total) {
      const reported = Number(opts.total(json));
      total = Number.isFinite(reported) && reported >= 0 ? Math.floor(reported) : null;
    }
    items.push(...opts.pick(json));

    const current = new URL(res.url);
    const nextPath = opts.next ? opts.next(json, res, current) : linkNextPath(res.headers, current, ctx.api_base);
    if (!nextPath) break;
    if (items.length >= itemCap || pages >= pageCap) {
      truncated = true;
      break;
    }
    path = nextPath;
  }

  if (items.length > itemCap) {
    items.length = itemCap;
    truncated = true;
  }
  if (total !== null && items.length < total) truncated = true;
  return { items, total, pages, truncated };
}
