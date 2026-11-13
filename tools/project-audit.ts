import { promises as fs } from "node:fs";
import path from "node:path";
import { auditKeyPath, verifyAuditRows } from "../lib/audit-hash.js";
import { readHexKey } from "../lib/keyfile.js";
import { recordMetric } from "../lib/metrics.js";
import { OUTPUT_MODE, buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { SESSION_ID } from "../lib/session.js";

// project_read_audit handler and the audit-DB health probe used by project_health. The caller resolves the audit DB path (it depends on
// the corehost data dir), so this module only needs the path. Extracted verbatim
// from tools/project.ts (P1 #6, step 5b); behavior is unchanged.

type Args = Record<string, unknown>;

export async function runReadAudit(args: Args, dbPath: string): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  // compact mode trims payloads over 8 KiB, so ask for fewer rows by default and let each carry its summary.
  const limit = Math.max(1, Math.min(200, Number(args.limit ?? (OUTPUT_MODE === "compact" ? 15 : 50))));
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const where: string[] = [];
    const values: unknown[] = [];
    if (typeof args.session_id === "string") { where.push("a.session_id = ?"); values.push(args.session_id); }
    if (typeof args.operation === "string") { where.push("a.operation = ?"); values.push(args.operation); }
    if (typeof args.request_id === "string") { where.push("a.request_id = ?"); values.push(args.request_id); }
    if (typeof args.outcome === "string") {
      // The log stores succeeded/failed; the tool's documented words are success/failure. Accept both.
      const outcomes: Record<string, string> = { success: "succeeded", failure: "failed" };
      where.push("a.outcome = ?");
      values.push(outcomes[args.outcome] ?? args.outcome);
    }
    if (typeof args.since_unix === "number") { where.push("a.started_at >= ?"); values.push(Math.floor(args.since_unix * 1000)); }
    // `reason` is a newer additive column: probe first so an older DB file
    // (written before the migration) still returns rows instead of erroring.
    const columns = new Set(
      (db.prepare("PRAGMA table_info(project_tool_audit)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    // The readable args/result of each job live in a separate table (lib/audit-detail.ts); an older DB
    // file may not have it yet.
    const hasDetail =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_tool_audit_detail'").get() !== undefined;
    const detailColumns = hasDetail
      ? ", d.args_summary, d.result_summary, d.args_json, d.result_json, d.result_bytes, d.stored_truncated"
      : "";
    const reasonColumn = columns.has("reason") ? ", reason" : "";
    // The hash of the arguments and the (redacted) command are what say
    // *which* call a row belongs to; the roadmap called the missing "why" out
    // (the reason was logged, the path and the command hash were not).
    const argsHashColumn = columns.has("args_hash") ? ", args_hash" : "";
    const commandColumn = columns.has("command") ? ", command" : "";
    const sql =
      `SELECT a.session_id, a.operation, a.outcome, a.reason_code, a.request_id, a.started_at, a.completed_at, a.elapsed_ms${reasonColumn}${argsHashColumn}${commandColumn}${detailColumns} ` +
      `FROM project_tool_audit a ${hasDetail ? "LEFT JOIN project_tool_audit_detail d ON d.request_id = a.request_id " : ""}${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY a.started_at DESC LIMIT ?`;
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
    // What the job was asked and what it returned. Short summaries always; the redacted JSON only in
    // VENIRA_OUTPUT_MODE=full, within a total budget so a 200-row read cannot flood the context (pass
    // request_id to get one job in full).
    let jsonBudget = 256 * 1024;
    const detailFields = (row: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      if (typeof row.args_summary === "string" && row.args_summary) out.args_summary = row.args_summary;
      if (typeof row.result_summary === "string" && row.result_summary) out.result_summary = row.result_summary;
      if (typeof row.result_bytes === "number") out.result_bytes = row.result_bytes;
      if (OUTPUT_MODE !== "full") return out;
      const parse = (text: unknown): unknown => {
        if (typeof text !== "string") return undefined;
        try {
          return JSON.parse(text);
        } catch {
          return text; // cut at the storage cap: still readable, just not valid JSON
        }
      };
      const size = (typeof row.args_json === "string" ? row.args_json.length : 0) + (typeof row.result_json === "string" ? row.result_json.length : 0);
      if (size === 0) return out;
      if (size > jsonBudget) return { ...out, detail_omitted: true };
      jsonBudget -= size;
      const args = parse(row.args_json);
      const result = parse(row.result_json);
      return {
        ...out,
        ...(args !== undefined ? { args } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(row.stored_truncated ? { detail_truncated: true } : {}),
      };
    };
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
          ...(typeof row.args_hash === "string" && row.args_hash ? { args_hash: row.args_hash } : {}),
          ...(typeof row.command === "string" && row.command ? { command: row.command } : {}),
          request_id: row.request_id,
          // Roadmap item 15 (P2): every timestamp the tools report is epoch
          // MILLISECONDS and says so in its name (snapshots and traces already
          // did; the audit rows were the odd one out in seconds).
          started_at_ms: typeof row.started_at === "number" ? row.started_at : Number(row.started_at ?? 0),
          ...(row.completed_at != null ? { completed_at_ms: Number(row.completed_at) } : {}),
          ...(row.elapsed_ms != null ? { elapsed_ms: row.elapsed_ms } : {}),
          ...detailFields(row),
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
