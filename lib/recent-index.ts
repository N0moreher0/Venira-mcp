/**
 * corehost recent-files index (SQLite project_file_index).
 * Extracted from corehost.ts; behaviour is unchanged. Best-effort: errors
 * are logged, never thrown.
 */
import path from "node:path";
import { WORKSPACE } from "./workspace.js";
import { ensureAuditDb } from "./audit-store.js";


// ---------------------------------------------------------------------------
// P2: Recent files index (SQLite)
// ---------------------------------------------------------------------------

/** Record a file edit in the project_file_index (SQLite) so that
 *  project_recent_files can use an indexed query instead of a bounded scan.
 *  Best-effort: errors are logged, never thrown.
 */
export function recordRecentFile(absPath: string, root: string): void {
  const db = ensureAuditDb();
  if (!db) return;
  const rel = path.relative(root, absPath).replace(/\\/g, "/");
  try {
    db.prepare(
      `INSERT OR REPLACE INTO project_file_index (workspace_root, path, mtime_ms, size, updated_at)
       VALUES (?, ?, 0, 0, ?)`,
    ).run(root, rel, Date.now());
  } catch (error) {
    console.error(`[corehost] recent index write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Update mtime/size for a recently-touched file in the index. */
export function recordRecentFileMeta(absPath: string, stat: { mtimeMs: number; size: number }): void {
  const db = ensureAuditDb();
  if (!db) return;
  const root = WORKSPACE;
  const rel = path.relative(root, absPath).replace(/\\/g, "/");
  try {
    db.prepare(
      `UPDATE project_file_index SET mtime_ms = ?, size = ?, updated_at = ? WHERE workspace_root = ? AND path = ?`,
    ).run(stat.mtimeMs, stat.size, Date.now(), root, rel);
  } catch (error) {
    console.error(`[corehost] recent index update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** P2: Query the recent-files index, optionally limiting the result. */
export function queryRecentFiles(limit: number, includeDirs: boolean, workspaceRoot: string = WORKSPACE): Array<{ relative_path: string; mtime_ms: number; size: number; kind: string; updated_at: number }> {
  const db = ensureAuditDb();
  if (!db) return [];
  try {
    const wsClause = "workspace_root = ?";
    const kindClause = includeDirs ? "" : " AND kind = 'file'";
    const rows = db.prepare(
      `SELECT path, mtime_ms, size, kind, updated_at FROM project_file_index WHERE ${wsClause}${kindClause} ORDER BY updated_at DESC LIMIT ?`,
    ).all(workspaceRoot, limit) as Array<{ path: string; mtime_ms: number; size: number; kind: string; updated_at: number }>
    return rows.map((r) => ({ relative_path: r.path, mtime_ms: r.mtime_ms, size: r.size, kind: r.kind, updated_at: r.updated_at }));
  } catch (error) {
    console.error(`[corehost] recent index query failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** P2: Remove a file from the recent-files index on delete. */
export function removeFromRecentIndex(absPath: string, root: string): void {
  const db = ensureAuditDb();
  if (!db) return;
  const rel = path.relative(root, absPath).replace(/\\/g, "/");
  try {
    db.prepare("DELETE FROM project_file_index WHERE workspace_root = ? AND path = ?").run(root, rel);
  } catch (error) {
    console.error("[corehost] recent index delete failed: " + (error instanceof Error ? error.message : String(error)));
  }
}
