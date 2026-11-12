/**
 * corehost read-side file ops: read_file, get_file_info, list_files.
 * Extracted from corehost.ts; behaviour is unchanged.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveInWorkspace, errorWithData, type RustResponse } from "./corehost-common.js";
import { isProtectedPath } from "./workspace.js";


export async function opReadFile(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(absPath);
  } catch {
    throw new Error(
      `[not_found] Path does not exist: ${args.relative_path}. Hint: check with project_list_files.`,
    );
  }
  if (isProtectedPath(canonicalPath)) {
    throw new Error(
      `[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: this file contains secrets or the audit DB and cannot be read via path ops.`,
    );
  }
  let stat;
  try {
    stat = await fs.stat(canonicalPath);
  } catch {
    throw new Error(
      `[not_found] Path does not exist: ${args.relative_path}. Hint: check with project_list_files.`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `[invalid_request] Not a file: ${args.relative_path}. Hint: use project_list_files for folders.`,
    );
  }

  // Handle multiple ranges (new) vs single range (legacy start_line/end_line)
  const rangesArg = args.ranges as Array<{ start_line: number; end_line?: number; max_bytes?: number }> | undefined;
  const maxBytesGlobal = (args.max_bytes as number | undefined) ?? 1_048_576;

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(canonicalPath);
  } catch (error) {
    throw new Error(
      `[io_error] Cannot read ${canonicalPath}: ${error instanceof Error ? error.message : String(error)}. Hint: file may be locked.`,
    );
  }
  const content = bytes.toString("utf8");
  // Roadmap item 17: `sha256` is the hash of the WHOLE file (raw bytes), so it
  // can be handed to project_edit_file / project_write_file as expected_sha256
  // even when this call returned only a slice. `text_sha256` hashes the text
  // that was actually returned.
  const fileSha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  const allLines = content.split("\n");
  const lastLineOfAll = allLines.length;

  // If ranges provided, use them; else fall back to single range
  const effectiveRanges = rangesArg ?? [
    {
      start_line: (args.start_line as number | undefined) ?? 1,
      end_line: (args.end_line as number | undefined) ?? Infinity,
      max_bytes: maxBytesGlobal,
    },
  ];

  const results: Array<{ start_line: number; end_line: number; text: string; text_sha256: string; truncated: boolean; next_start_line?: number }> = [];

  for (const range of effectiveRanges) {
    const startLine = range.start_line ?? 1;
    const endLine = range.end_line ?? Infinity;
    const maxBytes = range.max_bytes ?? maxBytesGlobal;

    const startIdx = Math.max(0, startLine - 1);
    const endIdx = Math.min(allLines.length, endLine);
    let lines = allLines.slice(startIdx, endIdx);
    let truncated = false;

    const joined = lines.join("\n");
    const bytes = Buffer.byteLength(joined, "utf8");
    if (bytes > maxBytes) {
      // Truncate by bytes: keep full lines that fit, then truncate the last line.
      let kept = 0;
      const keptLines: string[] = [];
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line + "\n", "utf8");
        if (kept + lineBytes > maxBytes) {
          truncated = true;
          break;
        }
        keptLines.push(line);
        kept += lineBytes;
      }
      lines = keptLines;
    }

    const text = lines.join("\n");
    const firstLine = startLine;
    const lastLine = startIdx + lines.length;

    results.push({
      start_line: firstLine,
      end_line: lastLine,
      text,
      text_sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
      truncated,
      ...(truncated && lastLine < lastLineOfAll ? { next_start_line: lastLine + 1 } : {}),
    });
  }

  // Backward compatibility: if using legacy params (no ranges arg), return flat format
  const isLegacy = !rangesArg;
  const rel = path.relative(root, absPath).replace(/\\/g, "/");

  let data: Record<string, unknown>;
  if (isLegacy) {
    const first = results[0];
    data = {
      relative_path: rel,
      kind: "file",
      sha256: fileSha256,
      sha256_scope: "file",
      text_sha256: first.text_sha256,
      text: first.text,
      first_line: first.start_line,
      last_line: first.end_line,
      total_bytes: stat.size,
      total_lines: lastLineOfAll,
      truncated: first.truncated,
      ...(first.next_start_line !== undefined ? { next_start_line: first.next_start_line } : {}),
    };
  } else {
    data = {
      relative_path: rel,
      kind: "file",
      sha256: fileSha256,
      sha256_scope: "file",
      ranges: results,
      total_bytes: stat.size,
      total_lines: lastLineOfAll,
    };
  }

  return {
    status: "completed",
    truncated: results.some((r) => r.truncated),
    result: { kind: "file_read", data },
  };
}

export async function opGetFileInfo(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  if (isProtectedPath(absPath)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not probe protected files.`);
  }
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new Error(
      `[not_found] Path does not exist: ${args.relative_path}. Hint: check with project_list_files.`,
    );
  }
  return {
    status: "completed",
    result: {
      kind: "file_info",
      data: {
        relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
        kind: stat.isDirectory() ? "directory" : "file",
        size_bytes: stat.size,
        modified_unix_seconds: Math.floor(stat.mtimeMs / 1000),
      },
    },
  };
}

const LIST_FILE_TTL_MS = 100;
const listFilesCache = new Map<string, { expire: number; response: RustResponse }>();

/** Drop all cached listings (used when the workspace root is switched). */
export function clearListFilesCache(): void {
  listFilesCache.clear();
}

export async function opListFiles(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const targetPath = resolveInWorkspace(args.relative_path as string, root);
  if (isProtectedPath(targetPath)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not list protected files.`);
  }
  const limit = Math.min(200, (args.limit as number | undefined) ?? 200);
  const depth = Math.min(3, Math.max(1, (args.depth as number | undefined) ?? 1));
  const includeIgnored = args.include_ignored === true;

  const IGNORED = new Set([
    ".git", "node_modules", "target", "dist", "build",
    ".next", ".venv", "__pycache__", ".cache", ".turbo", "coverage",
  ]);

  // Short-lived cache by (path, depth, limit, includeIgnored) — a listing is
  // stable enough for 300ms and many cascaded/parallel list calls benefit.
  const listKey = `${targetPath}\u0000${depth}\u0000${limit}\u0000${includeIgnored ? 1 : 0}`;
  const now = Date.now();
  const cachedList = listFilesCache.get(listKey);
  if (cachedList && now < cachedList.expire) {
    // LRU: move to end
    listFilesCache.delete(listKey);
    listFilesCache.set(listKey, { response: cachedList.response, expire: now + LIST_FILE_TTL_MS });
    return cachedList.response;
  }

  type Entry = { relative_path: string; kind: "file" | "directory"; size_bytes: number };
  const entries: Entry[] = [];
  let truncated = false;

  async function walk(absDir: string, relDir: string, currentDepth: number): Promise<void> {
    if (entries.length >= limit) { truncated = true; return; }
    if (currentDepth > depth) return;
    let dirEntries;
    try {
      dirEntries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    // Parallel stat for the children of this level. Items that need skip or
    // fail to stat become null and are dropped.
    const resolved = await Promise.all(
      dirEntries.map(async (entry) => {
        if (entry.isSymbolicLink()) return null;
        const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
        const absEntry = path.join(absDir, entry.name);
        const isDir = entry.isDirectory();
        if (!includeIgnored && IGNORED.has(entry.name) && isDir) return null;
        let size = 0;
        if (!isDir) {
          try { size = (await fs.stat(absEntry)).size; }
          catch { return null; }
        }
        if (isProtectedPath(absEntry)) return null;
        return { entry, relPath, absEntry, isDir, size };
      }),
    );

    for (const meta of resolved) {
      if (!meta) continue;
      if (entries.length >= limit) { truncated = true; break; }
      const { relPath, absEntry, isDir, size } = meta;
      entries.push({
        relative_path: relPath.replace(/\\/g, "/"),
        kind: isDir ? "directory" : "file",
        size_bytes: size,
      });
      if (isDir && currentDepth < depth) {
        await walk(absEntry, relPath, currentDepth + 1);
        if (entries.length >= limit) { truncated = true; }
      }
    }
  }

  await walk(targetPath, "", 1);

  const response = {
    status: "completed",
    truncated,
    result: {
      kind: "file_list",
      data: {
        relative_path: path.relative(root, targetPath).replace(/\\/g, "/"),
        entries,
        truncated,
        hint: truncated
          ? "Result truncated: raise limit (max 200) or narrow relative_path/depth."
          : undefined,
      },
    },
  };

  // LRU: evict oldest until under cap
  listFilesCache.set(listKey, { expire: now + LIST_FILE_TTL_MS, response });
  while (listFilesCache.size > 64) {
    const oldest = listFilesCache.keys().next().value;
    if (oldest === undefined) break;
    listFilesCache.delete(oldest);
  }
  return response;
}
