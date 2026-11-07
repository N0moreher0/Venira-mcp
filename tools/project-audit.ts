import { promises as fs } from "node:fs";
import path from "node:path";
import { auditKeyPath, verifyAuditRows } from "../lib/audit-hash.js";
import { readHexKey } from "../lib/keyfile.js";
import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { SESSION_ID } from "../lib/session.js";

// project_read_audit handler and the audit-DB health probe used by project_health. The caller resolves the audit DB path (it depends on
// the corehost data dir), so this module only needs the path. Extracted verbatim
// from tools/project.ts (P1 #6, step 5b); behavior is unchanged.

type Args = Record<string, unknown>;

export async function runReadAudit(args: Args, dbPath: string): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const limit = Math.max(1, Math.min(200, Number(args.limit ?? 50)));
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const where: string[] = [];
    const values: unknown[] = [];
    if (typeof args.session_id === "string") { where.push("session_id = ?"); values.push(args.session_id); }
    if (typeof args.operation === "string") { where.push("operation = ?"); values.push(args.operation); }
    if (typeof args.outcome === "string") { where.push("outcome = ?"); values.push(args.outcome); }
    if (typeof args.since_unix === "number") { where.push("started_at >= ?"); values.push(Math.floor(args.since_unix * 1000)); }
    // `reason` is a newer additive column: probe first so an older DB file
    // (written before the migration) still returns rows instead of erroring.
    const columns = new Set(
      (db.prepare("PRAGMA table_info(project_tool_audit)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const reasonColumn = columns.has("reason") ? ", reason" : "";
    const sql =
      `SELECT session_id, operation, outcome, reason_code, request_id, started_at, completed_at, elapsed_ms${reasonColumn} ` +
      `FROM project_tool_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY started_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...values, limit + 1) as unknown[];
    const truncated = rows.length > limit;
    let verified: boolean | null = null;
    let verifyDetail: Record<string, unknown> | undefined;
    if (args.verify === true && columns.has("row_hash")) {
      try {
        // Recompute the digest, not just the links: a link-only check passes
        // even when a row's operation/reason was edited in place.
        const fields = ["session_id", "project_id", "operation", "request_id", "started_at", "prev_hash", "row_hash"];
        if (columns.has("reason")) fields.push("reason");
        if (columns.has("args_hash")) fields.push("args_hash");
        const all = db
          .prepare(`SELECT ${fields.join(", ")} FROM project_tool_audit ORDER BY id ASC`)
          .all() as Array<Record<string, unknown>>;
        let key: Buffer | null = null;
        try {
          key = readHexKey(auditKeyPath(path.dirname(dbPath)), "audit");
        } catch {
          key = null; // keyed rows cannot be verified without the key; reported below
        }
        const window = all.length > 50_000 ? all.slice(-50_000) : all;
        const result = verifyAuditRows(
          window.map((r) => ({
            session_id: String(r.session_id ?? ""),
            project_id: String(r.project_id ?? ""),
            operation: String(r.operation ?? ""),
            request_id: (r.request_id as string | null | undefined) ?? null,
            started_at: Number(r.started_at ?? 0),
            reason: (r.reason as string | null | undefined) ?? null,
            args_hash: (r.args_hash as string | null | undefined) ?? null,
            prev_hash: (r.prev_hash as string | null | undefined) ?? null,
            row_hash: (r.row_hash as string | null | undefined) ?? null,
          })),
          key,
        );
        verified = result.ok;
        verifyDetail = { ...result, total_rows: all.length, checked_rows: window.length, keyed: Boolean(key) };
      } catch (error) {
        verified = false;
        verifyDetail = { ok: false, reason: "verify_failed", error: error instanceof Error ? error.message : String(error) };
      }
    }
    db.close();
    const data = {
      db_path: dbPath,
      count: truncated ? limit : rows.length,
      truncated,
      ...(verified !== null ? { verified } : {}),
      ...(verifyDetail ? { verify_detail: verifyDetail } : {}),
      rows: rows.slice(0, limit).map((r) => {
        const row = r as Record<string, unknown>;
        return {
          session_id: row.session_id,
          operation: row.operation,
          outcome: row.outcome,
          ...(row.reason_code ? { reason_code: row.reason_code } : {}),
          ...(typeof row.reason === "string" && row.reason ? { reason: row.reason } : {}),
          request_id: row.request_id,
          started_at: typeof row.started_at === "number" ? Math.floor(row.started_at / 1000) : row.started_at,
          ...(row.completed_at != null ? { completed_at: Math.floor((row.completed_at as number) / 1000) } : {}),
          ...(row.elapsed_ms != null ? { elapsed_ms: row.elapsed_ms } : {}),
        };
      }),
    };
    const response: RustResponse = {
      status: "completed",
      result: { kind: "audit_read", data },
      truncated,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("read_audit", elapsedMs, true);
    return toolResult(buildEnvelope("read_audit", response, { requestId, elapsedMs, cached: false }));
  } catch (error) {
    // WAL locked or DB missing: report audit_unavailable (non-retryable), do not crash.
    const msg = error instanceof Error ? error.message : String(error);
    const elapsedMs = performance.now() - started;
    recordMetric("read_audit", elapsedMs, false);
    return toolResult(
      errorEnvelope("read_audit", new Error(`[audit_unavailable] ${msg}`), { requestId, elapsedMs }),
      true,
    );
  }
}

export async function auditHealth(dbPath: string): Promise<Record<string, unknown>> {
  let exists = false;
  let bytes = 0;
  try {
    const stat = await fs.stat(dbPath);
    exists = stat.isFile();
    bytes = stat.size;
  } catch {
    return { path: dbPath, exists: false, reachable: false };
  }
  if (!exists) return { path: dbPath, exists: false, reachable: false };

  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const total = db.prepare("SELECT count(*) AS n FROM project_tool_audit").get() as { n?: unknown };
      const orphan = db
        .prepare(
          "SELECT count(*) AS n FROM project_tool_audit WHERE outcome = 'running' AND completed_at IS NULL",
        )
        .get() as { n?: unknown };
      const mine = db
        .prepare("SELECT outcome, count(*) AS n FROM project_tool_audit WHERE session_id = ? GROUP BY outcome")
        .all(SESSION_ID) as { outcome?: string; n?: unknown }[];
      let loopFailures: Array<{ operation: string; reason_code: string; count: number }> = [];
      let adoptionRuns: Array<{ operation: string; count: number; duration_ms: number }> = [];
      try {
        const loopRows = db
          .prepare(
            `SELECT operation, COALESCE(reason_code, 'operation_failed') AS reason_code, COUNT(*) AS n
             FROM project_tool_audit
             WHERE outcome = 'failed'
               AND started_at >= ?
               AND args_hash IS NOT NULL
             GROUP BY operation, reason_code, args_hash
             HAVING COUNT(*) >= 2
             ORDER BY n DESC
             LIMIT 20`,
          )
          .all(Date.now() - 10 * 60 * 1000) as Array<{ operation?: string; reason_code?: string; n?: number }>;
        loopFailures = loopRows.map((row) => ({
            operation: row.operation ?? "unknown",
            reason_code: row.reason_code ?? "operation_failed",
            count: Number(row.n ?? 0),
          }));
      } catch {
        // Legacy databases without args_hash remain healthy; the migration may
        // not have completed yet in a concurrently opened health reader.
      }
      try {
        const adoptionRows = db
          .prepare(
            `SELECT id, session_id, operation, outcome, started_at, completed_at
             FROM project_tool_audit
             WHERE started_at >= ?
             ORDER BY id ASC`,
          )
          .all(Date.now() - 10 * 60 * 1000) as Array<{
          id: number;
          session_id: string;
          operation: string;
          outcome: string;
          started_at: number;
          completed_at?: number | null;
        }>;
        const eligible = new Set(["read_file", "edit_file"]);
        let current: { operation: string; session_id: string; count: number; started_at: number; ended_at: number } | null = null;
        const flush = () => {
          if (current && current.count >= 3) {
            adoptionRuns.push({
              operation: current.operation,
              count: current.count,
              duration_ms: Math.max(0, current.ended_at - current.started_at),
            });
          }
          current = null;
        };
        for (const row of adoptionRows) {
          const canJoin =
            row.outcome === "succeeded" &&
            eligible.has(row.operation) &&
            current !== null &&
            current.operation === row.operation &&
            current.session_id === row.session_id &&
            row.started_at - current.ended_at <= 60_000;
          if (canJoin && current) {
            current.count += 1;
            current.ended_at = row.completed_at ?? row.started_at;
          } else {
            flush();
            if (row.outcome === "succeeded" && eligible.has(row.operation)) {
              current = {
                operation: row.operation,
                session_id: row.session_id,
                count: 1,
                started_at: row.started_at,
                ended_at: row.completed_at ?? row.started_at,
              };
            }
          }
        }
        flush();
        adoptionRuns = adoptionRuns.sort((a, b) => b.count - a.count).slice(0, 20);
      } catch {
        // Legacy or concurrently migrated audit databases remain usable.
      }
      return {
        path: dbPath,
        exists: true,
        bytes,
        reachable: true,
        total_rows: Number(total?.n ?? 0),
        orphan_running: Number(orphan?.n ?? 0),
        session: Object.fromEntries(mine.map((row) => [row.outcome ?? "unknown", Number(row.n ?? 0)])),
        loop_failures: loopFailures,
        adoption_runs: adoptionRuns,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      path: dbPath,
      exists: true,
      bytes,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
