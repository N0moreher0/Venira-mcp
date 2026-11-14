import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { stringify } from "../lib/output.js";
import type { RustResponse } from "../lib/output.js";

// ---------------------------------------------------------------------------
// Read cache: validated by stat (mtime + size) so edited/deleted files drop out.
// list/search/recent use short TTLs and are wiped on any mutating op.
//
// Extracted from tools/project.ts (roadmap item 6, step 5h). The module never imports
// tools/project.ts: everything it needs from there arrives through CacheDeps.
// ---------------------------------------------------------------------------

export type Args = Record<string, unknown>;
export type Execution = { response: RustResponse; cached: boolean };

export type CacheDeps = {
  /** Uncached backend call. */
  execute: (operation: string, args: Args) => Promise<RustResponse>;
  /** Normalizes args the same way the backend call will see them (used for search cache keys). */
  prepare: (operation: string, args: Args) => Args;
  /** Workspace-relative path -> absolute host path. */
  toHostPath: (relativePath: string | undefined) => string;
};

export const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const MAX_CACHE_BYTES = envInt("VENIRA_READ_CACHE_BYTES", 64 * 1024 * 1024);
const MAX_CACHE_ENTRIES = 1024;
const LIST_CACHE_MS = envInt("VENIRA_LIST_CACHE_MS", 1500);
const SEARCH_CACHE_MS = envInt("VENIRA_SEARCH_CACHE_MS", 3000);
const RECENT_CACHE_MS = envInt("VENIRA_RECENT_CACHE_MS", 2000);
const NEGATIVE_CACHE_TTL_MS = envInt("VENIRA_NEGATIVE_CACHE_MS", 500);
// list/search/recent/references: each map is also capped by bytes (the 64-entry cap alone allows ~64 MB per map).
const TTL_CACHE_BYTES = envInt("VENIRA_TTL_CACHE_BYTES", 8 * 1024 * 1024);
const TTL_CACHE_ENTRIES = 64;
// File timestamps tick coarsely (up to ~16 ms on Windows, a few ms on Linux). A file whose mtime is this close to
// "now" can be rewritten in the same tick with the same size, which stat() cannot see. Such entries are not trusted.
const RACY_WINDOW_MS = envInt("VENIRA_CACHE_RACY_MS", 30);
export const MAX_BATCH_RESPONSE_BYTES = 2 * 1024 * 1024;

type CachedRead = {
  status: string;
  truncated: boolean;
  result: RustResponse["result"];
  hint?: string;
  mtimeMs: number;
  /** mtime was within RACY_WINDOW_MS of caching: stat cannot prove freshness, so the next lookup re-reads. */
  racy: boolean;
  size: number;
  bytes: number;
};

type CachedTtl = { at: number; response: RustResponse; bytes: number };

type Counter = { hits: number; misses: number };

/** Cache types that `cache_clear` can clear in this module. */
export type ClearableCache = "read" | "info" | "list" | "search" | "recent" | "negative";

export function stableKey(args: Args): string {
  return JSON.stringify(
    Object.keys(args)
      .sort()
      .map((key) => [key, args[key]]),
  );
}

export function createCacheLayer(deps: CacheDeps) {
  const { execute, prepare, toHostPath } = deps;

  const readCache = new Map<string, CachedRead>();
  const infoCache = new Map<string, CachedRead>();
  const listCache = new Map<string, CachedTtl>();
  const searchCache = new Map<string, CachedTtl>();
  const referencesCache = new Map<string, CachedTtl>();
  const recentCache = new Map<string, CachedTtl>();
  const negativeReadCache = new Map<string, number>(); // Absolute path -> timestamp of not_found

  let readBytes = 0;
  let infoBytes = 0;

  const cacheStats = {
    read: { hits: 0, misses: 0 },
    info: { hits: 0, misses: 0 },
    list: { hits: 0, misses: 0 },
    search: { hits: 0, misses: 0 },
    // symbol_references (workspace) uses a dedicated cache (keyed on the inner
    // search args) because the host reports complete=false when it stops at the
    // hit cap, and searchCache only stores complete results.
    references: { hits: 0, misses: 0 },
    recent: { hits: 0, misses: 0 },
  };

  /** Age of the oldest entry in the negative-read cache (ms), 0 when empty. */
  function oldestNegativeAge(): number {
    const now = Date.now();
    let oldest = 0;
    for (const ts of negativeReadCache.values()) {
      const age = now - ts;
      if (age > oldest) oldest = age;
    }
    return oldest;
  }

  function enforceLimits(): void {
    while (readBytes + infoBytes > MAX_CACHE_BYTES || readCache.size + infoCache.size > MAX_CACHE_ENTRIES) {
      // Evict from the cache holding more of whatever is over its limit: bytes first, entry count otherwise.
      const overBytes = readBytes + infoBytes > MAX_CACHE_BYTES;
      let useRead = overBytes ? readBytes >= infoBytes : readCache.size >= infoCache.size;
      if ((useRead ? readCache : infoCache).size === 0) useRead = !useRead;
      const map = useRead ? readCache : infoCache;
      const key = map.keys().next().value;
      if (key === undefined) break;
      const entry = map.get(key)!;
      map.delete(key);
      if (useRead) readBytes -= entry.bytes;
      else infoBytes -= entry.bytes;
    }
  }

  function touch(map: Map<string, CachedRead>, key: string, entry: CachedRead): void {
    map.delete(key);
    map.set(key, entry);
    enforceLimits();
  }

  async function statSignature(
    absolutePath: string,
  ): Promise<{ mtimeMs: number; size: number; isFile: boolean } | null> {
    try {
      const stat = await fs.stat(absolutePath);
      return { mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
    } catch {
      return null;
    }
  }

  function isRacy(mtimeMs: number): boolean {
    return RACY_WINDOW_MS > 0 && Date.now() - mtimeMs < RACY_WINDOW_MS;
  }

  function cacheKey(absolutePath: string, args: Args): string {
    // Roadmap item 15 (P2): the key must cover EVERY argument that changes the
    // shape of the answer. `ranges` and `line_numbers` do exactly that, and
    // omitting them made a ranged read return a plain read (and vice versa) -
    // the same file, the same cache entry, a different answer.
    const ranges = Array.isArray(args.ranges) ? JSON.stringify(args.ranges) : "";
    return `${absolutePath}\u0000${args.start_line ?? ""}\u0000${args.end_line ?? ""}\u0000${args.max_bytes ?? ""}\u0000${ranges}\u0000${args.line_numbers ? 1 : 0}`;
  }

  function fromReadEntry(entry: CachedRead): RustResponse {
    return {
      status: entry.status,
      truncated: entry.truncated,
      result: entry.result,
      ...(entry.hint ? { hint: entry.hint } : {}),
    };
  }

  async function readFileCached(args: Args): Promise<Execution> {
    const absolutePath = toHostPath(args.relative_path as string | undefined);
    const key = cacheKey(absolutePath, args);
    // Negative cache: short-TTL suppress repeated backend calls for not_found paths.
    const negTs = negativeReadCache.get(key);
    if (negTs !== undefined) {
      const stat = await statSignature(absolutePath);
      if (!stat) {
        if (Date.now() - negTs <= NEGATIVE_CACHE_TTL_MS) {
          // MRU: refresh recency without displacing unrelated cache entries.
          negativeReadCache.delete(key);
          negativeReadCache.set(key, negTs);
          throw new Error(
            '[not_found] Path does not exist: ' + args.relative_path + '. Hint: Check it with list_files; do not retry the same path.',
          );
        }
        negativeReadCache.delete(key);
      } else {
        negativeReadCache.delete(key);
      }
    }
    const entry = readCache.get(key);
    if (entry) {
      const signature = await statSignature(absolutePath);
      if (
        signature &&
        signature.isFile &&
        !entry.racy &&
        signature.mtimeMs === entry.mtimeMs &&
        signature.size === entry.size
      ) {
        touch(readCache, key, entry);
        cacheStats.read.hits += 1;
        return { response: fromReadEntry(entry), cached: true };
      }
      readCache.delete(key);
      readBytes -= entry.bytes;
    }

    cacheStats.read.misses += 1;
    // Stat before AND after the read: a file rewritten while it was being read must not be cached under the new mtime.
    const before = await statSignature(absolutePath);
    let response: RustResponse;
    try {
      response = await execute("read_file", args);
    } catch (error) {
      // The backend lumps "does not exist" and "locked" into io_error; stat again to return the right code.
      const signature = await statSignature(absolutePath);
      if (!signature) {
        while (negativeReadCache.size >= 256) {
          const oldest = negativeReadCache.keys().next().value;
          if (oldest === undefined) break;
          negativeReadCache.delete(oldest);
        }
        negativeReadCache.set(key, Date.now());
        throw new Error(
          '[not_found] Path does not exist: ' + args.relative_path + '. Hint: Check it with list_files; do not retry the same path.',
        );
      }
      if (!signature.isFile) {
        throw new Error(
          '[invalid_request] Not a file: ' + args.relative_path + '. Hint: Use list_files for folders or get_file_info for metadata.',
        );
      }
      throw error;
    }
    const signature = await statSignature(absolutePath);
    const readData = response.result && typeof response.result === 'object' ? (response.result.data as Record<string, unknown> | null) : null;
    const readText = typeof readData?.text === 'string' ? (readData.text as string) : null;
    if (
      signature &&
      signature.isFile &&
      readText !== null &&
      before &&
      before.mtimeMs === signature.mtimeMs &&
      before.size === signature.size
    ) {
      // Freshness metadata for agents (TOCTOU guard). The whole-file hash comes
      // from the backend (`sha256`, scope "file"); the cache must not replace it
      // with a hash of the returned slice - that hash is not the file and
      // feeding it back as expected_sha256 causes a stale_content loop
      // (roadmap item 17). `text_sha256` covers the text that was returned.
      const textSha256 = createHash('sha256').update(readText, 'utf8').digest('hex');
      if (readData) {
        readData.text_sha256 ??= textSha256;
        readData.mtime_ms = signature.mtimeMs;
        readData.size_bytes = signature.size;
      }
      const bytes = stringify(response).length;
      if (bytes <= MAX_BATCH_RESPONSE_BYTES) {
        const cached: CachedRead = {
          status: response.status ?? "completed",
          truncated: response.truncated === true,
          result: response.result,
          hint: response.hint,
          mtimeMs: signature.mtimeMs,
          size: signature.size,
          racy: isRacy(signature.mtimeMs),
          bytes,
        };
        readCache.set(key, cached);
        readBytes += bytes;
        touch(readCache, key, cached);
      }
    }
    return { response, cached: false };
  }

  async function fileInfoCached(args: Args): Promise<Execution> {
    const absolutePath = toHostPath(args.relative_path as string | undefined);
    const key = absolutePath;
    const entry = infoCache.get(key);
    if (entry) {
      const signature = await statSignature(absolutePath);
      if (signature && !entry.racy && signature.mtimeMs === entry.mtimeMs && signature.size === entry.size) {
        touch(infoCache, key, entry);
        cacheStats.info.hits += 1;
        return { response: fromReadEntry(entry), cached: true };
      }
      infoCache.delete(key);
      infoBytes -= entry.bytes;
    }

    const before = await statSignature(absolutePath);
    const response = await execute("get_file_info", args);
    cacheStats.info.misses += 1;
    const signature = await statSignature(absolutePath);
    if (
      signature &&
      response.result &&
      before &&
      before.mtimeMs === signature.mtimeMs &&
      before.size === signature.size
    ) {
      const bytes = stringify(response).length;
      if (bytes <= MAX_BATCH_RESPONSE_BYTES) {
        const cached: CachedRead = {
          status: response.status ?? "completed",
          truncated: response.truncated === true,
          result: response.result,
          hint: response.hint,
          mtimeMs: signature.mtimeMs,
          size: signature.size,
          racy: isRacy(signature.mtimeMs),
          bytes,
        };
        infoCache.set(key, cached);
        infoBytes += bytes;
        touch(infoCache, key, cached);
      }
    }
    return { response, cached: false };
  }

  function ttlLookup(
    map: Map<string, CachedTtl>,
    key: string,
    ttlMs: number,
    counter: Counter,
  ): RustResponse | null {
    if (ttlMs <= 0) return null;
    const entry = map.get(key);
    if (!entry) {
      counter.misses += 1;
      return null;
    }
    if (Date.now() - entry.at > ttlMs) {
      map.delete(key);
      counter.misses += 1;
      return null;
    }
    map.delete(key);
    map.set(key, entry);
    counter.hits += 1;
    return entry.response;
  }

  function ttlStore(map: Map<string, CachedTtl>, key: string, response: RustResponse): void {
    const bytes = stringify(response).length;
    if (bytes > 1024 * 1024) return;
    map.set(key, { at: Date.now(), response, bytes });
    let total = 0;
    for (const e of map.values()) total += e.bytes;
    while (map.size > TTL_CACHE_ENTRIES || total > TTL_CACHE_BYTES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      total -= map.get(oldest)?.bytes ?? 0;
      map.delete(oldest);
    }
  }

  async function listCached(args: Args): Promise<Execution> {
    const absolutePath = toHostPath(args.relative_path as string | undefined);
    const key = `${absolutePath}\u0000${args.depth ?? ""}\u0000${args.limit ?? ""}\u0000${args.include_ignored === true ? 1 : 0}`;
    const cached = ttlLookup(listCache, key, LIST_CACHE_MS, cacheStats.list);
    if (cached) return { response: cached, cached: true };
    const response = await execute("list_files", args);
    ttlStore(listCache, key, response);
    return { response, cached: false };
  }

  // In-flight de-duplication protects concurrent callers (MCP batching) from
  // triggering duplicate full-tree walks for the same query while one is running.
  const inflightSearches = new Map<string, Promise<Execution>>();
  async function searchCached(args: Args): Promise<Execution> {
    const prepared = prepare("search", args);
    const key = stableKey(prepared);
    const cached = ttlLookup(searchCache, key, SEARCH_CACHE_MS, cacheStats.search);
    if (cached) return { response: cached, cached: true };

    const inFlight = inflightSearches.get(key);
    if (inFlight) return await inFlight;

    const promise = (async () => {
      const response = await execute("search", args);
      // Cache any COMPLETE result (including zero-hit).
      const data = response.result?.data as { complete?: boolean; hits?: unknown[] } | undefined;
      if (data?.complete !== false) {
        ttlStore(searchCache, key, response);
      }
      return { response, cached: false };
    })();
    inflightSearches.set(key, promise);
    try {
      return await promise;
    } finally {
      inflightSearches.delete(key);
    }
  }

  function invalidatePath(absolutePath: string): void {
    const prefix = `${absolutePath}\u0000`;
    for (const [key, entry] of readCache) {
      if (key.startsWith(prefix)) {
        readCache.delete(key);
        readBytes -= entry.bytes;
      }
    }
    // Clear negative-cache entries keyed by the same path prefix.
    for (const key of negativeReadCache.keys()) {
      if (key.startsWith(prefix)) {
        negativeReadCache.delete(key);
      }
    }
    const info = infoCache.get(absolutePath);
    if (info) {
      infoCache.delete(absolutePath);
      infoBytes -= info.bytes;
    }
  }

  function invalidateListCaches(): void {
    listCache.clear();
    searchCache.clear();
    referencesCache.clear();
    recentCache.clear();
  }

  /** A restore can rewrite any file under the workspace: drop every cache. */
  function invalidateAllCaches(): void {
    readCache.clear();
    infoCache.clear();
    negativeReadCache.clear();
    readBytes = 0;
    infoBytes = 0;
    invalidateListCaches();
  }

  /** Clears one cache for `cache_clear`; returns how many entries were dropped. */
  function clear(type: ClearableCache): number {
    switch (type) {
      case "read": {
        const n = readCache.size;
        readCache.clear();
        readBytes = 0;
        return n;
      }
      case "info": {
        const n = infoCache.size;
        infoCache.clear();
        infoBytes = 0;
        return n;
      }
      case "list": {
        const n = listCache.size;
        listCache.clear();
        return n;
      }
      case "search": {
        const n = searchCache.size;
        searchCache.clear();
        return n;
      }
      case "recent": {
        const n = recentCache.size;
        recentCache.clear();
        return n;
      }
      case "negative": {
        const n = negativeReadCache.size;
        negativeReadCache.clear();
        return n;
      }
    }
  }

  function report() {
    const rate = (counter: Counter) => {
      const total = counter.hits + counter.misses;
      return total === 0 ? null : Math.round((counter.hits / total) * 1000) / 1000;
    };
    return {
      read: {
        entries: readCache.size,
        bytes: readBytes,
        ...cacheStats.read,
        hit_rate: rate(cacheStats.read),
      },
      negative: {
        entries: negativeReadCache.size,
        ttl_ms: NEGATIVE_CACHE_TTL_MS,
        oldest_age_ms: oldestNegativeAge(),
      },
      info: {
        entries: infoCache.size,
        bytes: infoBytes,
        ...cacheStats.info,
        hit_rate: rate(cacheStats.info),
      },
      list: {
        entries: listCache.size,
        ttl_ms: LIST_CACHE_MS,
        ...cacheStats.list,
        hit_rate: rate(cacheStats.list),
      },
      search: {
        entries: searchCache.size,
        ttl_ms: SEARCH_CACHE_MS,
        ...cacheStats.search,
        hit_rate: rate(cacheStats.search),
      },
      references: {
        entries: referencesCache.size,
        ttl_ms: SEARCH_CACHE_MS,
        ...cacheStats.references,
        hit_rate: rate(cacheStats.references),
      },
      recent: {
        entries: recentCache.size,
        ttl_ms: RECENT_CACHE_MS,
        ...cacheStats.recent,
        hit_rate: rate(cacheStats.recent),
      },
    };
  }

  return {
    readFileCached,
    fileInfoCached,
    listCached,
    searchCached,
    invalidatePath,
    invalidateListCaches,
    invalidateAllCaches,
    clear,
    report,
    /** recent_files TTL cache. */
    recent: {
      lookup: (key: string) => ttlLookup(recentCache, key, RECENT_CACHE_MS, cacheStats.recent),
      store: (key: string, response: RustResponse) => ttlStore(recentCache, key, response),
    },
    /** symbol_references TTL cache (keyed on the inner search args). */
    references: {
      lookup: (key: string) => ttlLookup(referencesCache, key, SEARCH_CACHE_MS, cacheStats.references),
      store: (key: string, response: RustResponse) => ttlStore(referencesCache, key, response),
    },
  };
}

export type CacheLayer = ReturnType<typeof createCacheLayer>;
