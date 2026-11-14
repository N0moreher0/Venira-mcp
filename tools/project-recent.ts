import { promises as fs } from "node:fs";
import path from "node:path";
import { queryRecentFiles } from "../lib/corehost.js";
import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { toHostPath, WORKSPACE, isProtectedPath } from "../lib/workspace.js";

// recent_files: SQLite index first, bounded filesystem scan as fallback.
// Extracted from tools/project.ts (P1 #6, step 5c); behavior is unchanged.

type Args = Record<string, unknown>;

// ---------------------------------------------------------------------------
// recent_files: bounded filesystem scan (no external backend).
// ---------------------------------------------------------------------------
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".venv",
  "__pycache__",
  ".cache",
  ".turbo",
  "coverage",
]);
const RECENT_MAX_DIRS = 300;
const RECENT_MAX_FILES = 4000;

type RecentEntry = { abs: string; rel: string; size: number; mtimeMs: number };

async function scanRecent(args: Args): Promise<{
  entries: RecentEntry[];
  scannedFiles: number;
  scannedDirs: number;
  truncated: boolean;
}> {
  const root = toHostPath(args.relative_path as string | undefined);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`[invalid_request] Not a directory: ${root}. Hint: Pass a folder path or omit relative_path.`);
  }
  const maxDepth = Math.max(1, Math.min(6, Number(args.depth ?? 2)));
  const maxFiles = Math.max(1, Math.min(100, Number(args.limit ?? 20)));
  const includeIgnored = args.include_ignored === true;

  const queue: { abs: string; depth: number }[] = [{ abs: root, depth: 0 }];
  const files: { abs: string; rel: string }[] = [];
  let scannedDirs = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (scannedDirs >= RECENT_MAX_DIRS || files.length >= RECENT_MAX_FILES) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    scannedDirs += 1;
    let entries;
    try {
      entries = await fs.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir.abs, entry.name);
      // Roadmap item 15 (P2): the file tools refuse the data dir, the
      // checkpoint store and the credential files - the recent list must not
      // advertise them (it listed data/venira.db and data/audit.key when the
      // data dir sits inside the workspace).
      if (isProtectedPath(abs)) continue;
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        if (!includeIgnored && IGNORED_DIRS.has(entry.name)) continue;
        if (dir.depth < maxDepth) queue.push({ abs, depth: dir.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(WORKSPACE, abs);
      files.push({
        abs,
        rel: rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : abs,
      });
      if (files.length >= RECENT_MAX_FILES) {
        truncated = true;
        break;
      }
    }
  }
  const found: RecentEntry[] = [];
  const chunkSize = 64;
  for (let index = 0; index < files.length; index += chunkSize) {
    const chunk = files.slice(index, index + chunkSize);
    const stats = await Promise.all(
      chunk.map(async (file) => {
        try {
          const stat = await fs.stat(file.abs);
          return { ...file, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    for (const item of stats) if (item) found.push(item);
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    entries: found.slice(0, maxFiles),
    scannedFiles: found.length,
    scannedDirs,
    truncated: truncated || found.length > maxFiles,
  };
}

/**
 * What the handler needs from the host module. Injected (instead of imported) so
 * this file never depends on tools/project.ts and the cache/edit-log stay owned
 * by one place.
 */
export type RecentFilesDeps = {
  /** Cached response for this request key, if still fresh. Also records the hit/miss. */
  lookup: (key: string) => RustResponse | null | undefined;
  /** Remember a response for this request key (TTL handled by the caller). */
  store: (key: string, response: RustResponse) => void;
  /** Absolute paths written/edited in this session (oldest first). */
  recentEdits: ReadonlySet<string>;
};

export async function runRecentFiles(args: Args, deps: RecentFilesDeps): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const root = toHostPath(args.relative_path as string | undefined);
  const key = `${root}\u0000${args.depth ?? 2}\u0000${args.limit ?? 20}\u0000${args.include_ignored === true ? 1 : 0}`;
  try {
    const cached = deps.lookup(key);
    if (cached) {
      const elapsedMs = performance.now() - started;
      recordMetric("recent_files", elapsedMs, true);
      return toolResult(buildEnvelope("recent_files", cached, { requestId, elapsedMs, cached: true }));
    }

    // P2: Try the SQLite index first (no bounded scan needed when the index is populated).
    const maxFiles = Math.max(1, Math.min(100, Number(args.limit ?? 20)));
    // The index is keyed by the WORKSPACE root, not by the requested directory:
    // filtering it by a subdirectory used to miss every indexed row and
    // silently fall back to the scan. Query the workspace and filter here.
    const rootRel = path.relative(WORKSPACE, root).replace(/\\/g, "/");
    const indexAll = queryRecentFiles(maxFiles * 3, false, WORKSPACE);
    const indexHits = indexAll
      .filter((hit) => !hit.outside_workspace)
      .filter((hit) => !rootRel || hit.relative_path === rootRel || hit.relative_path.startsWith(`${rootRel}/`))
      .filter(
        (hit) =>
          args.include_ignored === true ||
          !IGNORED_DIRS.has((hit.relative_path.split("/")[0] ?? "").toLowerCase()),
      )
      .slice(0, maxFiles);
    if (indexHits.length > 0) {
      const data = {
        relative_path: rootRel,
        source: "index" as const,
        entries: indexHits.map((hit) => ({
          relative_path: hit.relative_path,
          size_bytes: hit.size,
          modified_unix_seconds: Math.floor((hit.mtime_ms || hit.updated_at) / 1000),
          modified_ago_seconds: Math.max(0, Math.floor((Date.now() - (hit.mtime_ms || hit.updated_at)) / 1000)),
          // Roadmap item 15 (P2): a path outside the workspace was listed like
          // every other one. The file tools cannot read it back, so say so.
          ...(hit.outside_workspace ? { outside_workspace: true } : {}),
        })),
        scanned_files: indexHits.length,
        scanned_dirs: 0,
        truncated: indexAll.length > indexHits.length,
      };
      const response: RustResponse = { status: "completed", result: { kind: "recent_files", data } };
      deps.store(key, response);
      const elapsedMs = performance.now() - started;
      recordMetric("recent_files", elapsedMs, true);
      return toolResult(buildEnvelope("recent_files", response, { requestId, elapsedMs, cached: false }));
    }

    // Node-side fallback: bounded filesystem scan (no external backend).
    const scan = await scanRecent(args);
    const editedRecently = [...new Set([...deps.recentEdits].filter((abs) => abs.startsWith(root)))].slice(0, 20);
    const data = {
      relative_path: rootRel,
      source: "fallback_scan" as const,
      entries: scan.entries.map((entry) => ({
        relative_path: entry.rel,
        size_bytes: entry.size,
        modified_unix_seconds: Math.floor(entry.mtimeMs / 1000),
        modified_ago_seconds: Math.max(0, Math.floor((Date.now() - entry.mtimeMs) / 1000)),
      })),
      scanned_files: scan.scannedFiles,
      scanned_dirs: scan.scannedDirs,
      truncated: scan.truncated,
      ...(scan.truncated
        ? { hint: "Scan hit its limit; lower depth, raise limit, or pass a narrower relative_path." }
        : {}),
      ...(editedRecently.length > 0
        ? {
            session_edits: editedRecently.map((abs) => {
              const rel = path.relative(WORKSPACE, abs);
              return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : abs;
            }),
          }
        : {}),
    };
    const response: RustResponse = {
      status: "completed",
      result: { kind: "recent_files", data },
    };
    deps.store(key, response);
    const elapsedMs = performance.now() - started;
    recordMetric("recent_files", elapsedMs, true);
    return toolResult(buildEnvelope("recent_files", response, { requestId, elapsedMs }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("recent_files", elapsedMs, false);
    return toolResult(errorEnvelope("recent_files", error, { requestId, elapsedMs }), true);
  }
}
