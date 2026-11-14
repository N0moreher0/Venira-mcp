/**
 * Audit store: the SQLite (better-sqlite3, WAL) audit trail and recent-file index
 * database used by corehost. Extracted unchanged from `lib/corehost.ts`; the hash
 * chain, strict mode and retention behave exactly as before.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { loadAuditKey, hashAuditRow } from "./audit-hash.js";
import { activeDataDir } from "./workspace.js";
import { envFlag } from "./env.js";

let auditDb: Database.Database | null = null;
let auditColumns: Set<string> | null = null;
let auditKeyLoaded = false;
let auditKey: Buffer | null = null;

function auditSigningKey(): Buffer | null {
  if (!auditKeyLoaded) {
    auditKey = loadAuditKey(activeDataDir());
    auditKeyLoaded = true;
  }
  return auditKey;
}

function auditStrict(): boolean {
  return envFlag("VENIRA_AUDIT_STRICT", false);
}

function auditDbPath(): string {
  return path.join(activeDataDir(), "venira.db");
}

export function ensureAuditDb(): Database.Database | null {
  if (auditDb) return auditDb;
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as new (dbPath: string, options?: unknown) => Database.Database;
    const dbPath = auditDbPath();
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    auditDb = new Database(dbPath);
    auditDb.pragma("journal_mode = WAL");
    auditDb.pragma("synchronous = NORMAL");
    auditDb.pragma("busy_timeout = 5000");
    auditDb.exec(`
      CREATE TABLE IF NOT EXISTS project_tool_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason_code TEXT,
        request_id TEXT UNIQUE,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        elapsed_ms INTEGER
      );
    `);
    // What each job was asked to do and what it returned (lib/audit-detail.ts). A separate table keyed by
    // request_id, so the hash-chained rows above stay exactly as they were.
    auditDb.exec(`
      CREATE TABLE IF NOT EXISTS project_tool_audit_detail (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        args_summary TEXT,
        result_summary TEXT,
        args_json TEXT,
        result_json TEXT,
        result_bytes INTEGER,
        stored_truncated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    // Additive migration for shell-policy auditing. SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so probe the table first.
    const columns = new Set(
      (auditDb.prepare("PRAGMA table_info(project_tool_audit)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const [name, type] of [
      ["started_at", "INTEGER"],
      ["completed_at", "INTEGER"],
      ["elapsed_ms", "INTEGER"],
      ["decision", "TEXT"],
      ["policy_rule", "TEXT"],
      ["command", "TEXT"],
      ["approver", "TEXT"],
      ["reason", "TEXT"],
      ["prev_hash", "TEXT"],
      ["row_hash", "TEXT"],
      ["args_hash", "TEXT"],
    ] as const) {
      if (!columns.has(name)) auditDb.exec(`ALTER TABLE project_tool_audit ADD COLUMN ${name} ${type}`);
    }
    
    // P2: Recent files index (SQLite cache, updated on write/edit/delete)
    // P2: Recent-files index is scoped per workspace so a shared data dir (the
    // default per-user OS dir) cannot leak entries from one project into another.
    // Composite PK keeps the same relative path distinct across workspaces.
    const indexColumns = new Set(
      (auditDb.prepare("PRAGMA table_info(project_file_index)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const indexPkCols = (auditDb.prepare("PRAGMA table_info(project_file_index)").all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).length;
    const needsRebuild = !indexColumns.has("workspace_root") || indexPkCols < 2;
    if (needsRebuild) {
      auditDb.exec(`
        CREATE TABLE IF NOT EXISTS project_file_index_new (
          workspace_root TEXT NOT NULL,
          path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'file',
          mtime_ms INTEGER NOT NULL,
          size INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_root, path)
        );
        CREATE INDEX IF NOT EXISTS idx_file_index_mtime_new ON project_file_index_new(updated_at DESC);
      `);
      // Carry over only rows that already carry a workspace_root (legacy rows
      // without one are dropped to avoid cross-workspace leakage).
      if (indexColumns.has("workspace_root")) {
        try {
          auditDb.exec(`
            INSERT OR IGNORE INTO project_file_index_new (workspace_root, path, kind, mtime_ms, size, updated_at)
            SELECT workspace_root, path, kind, mtime_ms, size, updated_at
            FROM project_file_index WHERE workspace_root IS NOT NULL;
          `);
        } catch { /* best-effort */ }
      }
      auditDb.exec("DROP TABLE IF EXISTS project_file_index;");
      auditDb.exec("ALTER TABLE project_file_index_new RENAME TO project_file_index;");
      auditDb.exec("CREATE INDEX IF NOT EXISTS idx_file_index_mtime ON project_file_index(updated_at DESC);");
    }
    auditDb.exec(`
      CREATE TABLE IF NOT EXISTS project_file_index (
        workspace_root TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'file',
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_root, path)
      );
      CREATE INDEX IF NOT EXISTS idx_file_index_mtime ON project_file_index(updated_at DESC);
    `);
    // R8 retention + VACUUM (best-effort)
    try {
      const days = Number(process.env.VENIRA_AUDIT_KEEP_DAYS ?? 90);
      if (Number.isFinite(days) && days > 0) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        auditDb.prepare("DELETE FROM project_tool_audit WHERE started_at < ?").run(cutoff);
        auditDb.prepare("DELETE FROM project_tool_audit_detail WHERE created_at < ?").run(cutoff);
        auditDb.prepare("DELETE FROM project_file_index WHERE updated_at < ?").run(cutoff);
        auditDb.exec("VACUUM;");
      }
    } catch { /* best-effort */ }
    return auditDb;
  } catch (error) {
    console.error(
      `[corehost] audit DB unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export type AuditRow = {
  session_id: string;
  project_id: string;
  operation: string;
  outcome: string;
  reason_code?: string | null;
  request_id?: string;
  started_at: number;
  completed_at?: number | null;
  elapsed_ms?: number | null;
  decision?: string | null;
  policy_rule?: string | null;
  command?: string | null;
  approver?: string | null;
  /** Free-text "why" supplied by the caller (edit/write/delete/snapshot). */
  reason?: string | null;
  args_hash?: string | null;
};

// Cache the previous row hash to avoid a SELECT-per-write round trip in
// auditInsert. lastAuditPrevId tracks the observed DB max id so external
// mutations can be re-synced instead of silently breaking the chain.
let lastAuditPrevHash = "";
let lastAuditPrevId = -1;

function auditInsert(row: AuditRow): void {
  const db = ensureAuditDb();
  if (!db) {
    if (auditStrict()) throw new Error("[audit_unavailable] audit database unavailable and VENIRA_AUDIT_STRICT=1");
    return;
  }
  try {
    if (!auditColumns) {
      auditColumns = new Set(
        (db.prepare("PRAGMA table_info(project_tool_audit)").all() as Array<{ name: string }>).map((c) => c.name),
      );
    }
    const columns = auditColumns;
    // Serialize hash lookup + insert across multiple MCP server processes that
    // share the same SQLite audit database. IMMEDIATE acquires the write lock
    // before reading the chain tip, preventing sibling processes from forking it.
    const writeAuditRow = db.transaction(() => {
    let prevHash = lastAuditPrevHash;
    if (columns.has("prev_hash") || columns.has("row_hash")) {
      try {
        const row = db.prepare("SELECT MAX(id) AS mx FROM project_tool_audit").get() as { mx?: number | null } | undefined;
        const maxId = row?.mx ?? 0;
        if (maxId === 0) {
          lastAuditPrevHash = "";
          lastAuditPrevId = 0;
          prevHash = "";
        } else if (maxId === lastAuditPrevId) {
          prevHash = lastAuditPrevHash;
        } else {
          const last = db.prepare("SELECT row_hash FROM project_tool_audit ORDER BY id DESC LIMIT 1").get() as { row_hash?: string } | undefined;
          prevHash = last?.row_hash ?? "";
          lastAuditPrevHash = prevHash;
          lastAuditPrevId = maxId;
        }
      } catch { /* ignore */ }
    }
    const rowHash = columns.has("row_hash")
      ? hashAuditRow(prevHash, row, auditSigningKey())
      : "";
    const entries: Array<[string, unknown]> = [
      ["session_id", row.session_id],
      ["project_id", row.project_id],
      ["operation", row.operation],
      ["outcome", row.outcome],
      ["reason_code", row.reason_code ?? "running"],
      ["request_id", row.request_id ?? null],
      // started_at is NOT NULL in the schema; it was dropped from this list
      // during the legacy-schema adaptation (9ff1d46), which made every
      // audit INSERT fail with a NOT NULL constraint error -- silently
      // swallowed outside VENIRA_AUDIT_STRICT=1, so the audit table stayed
      // empty with no visible error.
      ["started_at", row.started_at],
      ["completed_at", row.completed_at ?? null],
      ["decision", row.decision ?? null],
      ["policy_rule", row.policy_rule ?? null],
      ["command", row.command ?? null],
      ["approver", row.approver ?? null],
      ["reason", row.reason ?? null],
      ["args_hash", row.args_hash ?? null],
    ];
    // Older per-user databases used created_at as the required timestamp
    // instead of started_at. Keep writing it when that legacy column exists;
    // otherwise SQLite rejects the whole insert before the modern columns can
    // be stored.
    if (columns.has("created_at")) entries.push(["created_at", row.started_at]);
    if (columns.has("prev_hash")) entries.push(["prev_hash", prevHash || null]);
    if (columns.has("row_hash")) entries.push(["row_hash", rowHash || null]);
    const colNames = entries.map(([c]) => c).join(", ");
    const placeholders = entries.map(([c]) => `@${c}`).join(", ");
    const params = Object.fromEntries(entries);
    db.prepare(
      `INSERT INTO project_tool_audit (${colNames}) VALUES (${placeholders})`,
    ).run(params);
    if (columns.has("row_hash")) {
      lastAuditPrevHash = rowHash;
      try {
        const row = db.prepare("SELECT MAX(id) AS mx FROM project_tool_audit").get() as { mx?: number | null } | undefined;
        lastAuditPrevId = row?.mx ?? lastAuditPrevId;
      } catch { /* ignore */ }
    }
    });
    writeAuditRow.immediate();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (auditStrict()) throw new Error(`[audit_unavailable] audit write failed: ${msg}`);
    console.error(`[corehost] audit write failed: ${msg}`);
  }
}

export function auditStart(
  sessionId: string,
  projectId: string,
  operation: string,
  requestId: string,
  extra: {
    decision?: string;
    policy_rule?: string;
    command?: string;
    approver?: string;
    reason?: string;
    args_hash?: string;
  } = {},
): number {
  const startedAt = Date.now();
  auditInsert({
    session_id: sessionId,
    project_id: projectId,
    operation,
    outcome: "running",
    request_id: requestId,
    started_at: startedAt,
    decision: extra.decision ?? null,
    policy_rule: extra.policy_rule ?? null,
    command: extra.command ?? null,
    approver: extra.approver ?? null,
    reason: extra.reason ?? null,
    args_hash: extra.args_hash ?? null,
  });
  return startedAt;
}

export function auditFinish(
  sessionId: string,
  projectId: string,
  operation: string,
  requestId: string,
  startedAt: number,
  outcome: "succeeded" | "failed",
  reasonCode?: string,
): void {
  const completedAt = Date.now();
  const db = ensureAuditDb();
  if (!db) {
    if (auditStrict()) throw new Error("[audit_unavailable] audit database unavailable and VENIRA_AUDIT_STRICT=1");
    return;
  }
  try {
    db.prepare(
      `UPDATE project_tool_audit
       SET outcome = @outcome, reason_code = @reason_code, completed_at = @completed_at, elapsed_ms = @elapsed
       WHERE request_id = @request_id AND session_id = @session_id`
    ).run({
      outcome,
      reason_code: reasonCode ?? "finished",
      completed_at: completedAt,
      elapsed: completedAt - startedAt,
      request_id: requestId,
      session_id: sessionId,
    });
  } catch (error) {
    if (auditStrict()) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`[audit_unavailable] audit finish failed: ${msg}`);
    }
    /* audit DB may have been closed */
  }
}

/** Attach the shell-policy outcome to an audit row (shell operations only). */
export function auditDecision(
  sessionId: string,
  requestId: string,
  extra: { decision?: string; policy_rule?: string; command?: string; approver?: string },
): void {
  const db = ensureAuditDb();
  if (!db) {
    if (auditStrict()) throw new Error("[audit_unavailable] audit database unavailable and VENIRA_AUDIT_STRICT=1");
    return;
  }
  try {
    db.prepare(
      `UPDATE project_tool_audit
       SET decision = @decision, policy_rule = @policy_rule, command = @command, approver = @approver
       WHERE request_id = @request_id AND session_id = @session_id`
    ).run({
      decision: extra.decision ?? null,
      policy_rule: extra.policy_rule ?? null,
      command: extra.command ?? null,
      approver: extra.approver ?? null,
      request_id: requestId,
      session_id: sessionId,
    });
  } catch (error) {
    if (auditStrict()) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`[audit_unavailable] audit decision update failed: ${msg}`);
    }
    /* audit DB may have been closed */
  }
}

/** Mark still-running rows as orphaned and close the handle (called from CoreHost.close()). */
export function closeAuditDb(): void {
  if (auditDb) {
    try {
      auditDb
        .prepare(
          "UPDATE project_tool_audit SET outcome = ?, reason_code = ?, completed_at = ?, elapsed_ms = COALESCE(elapsed_ms, 0) WHERE outcome = ?",
        )
        .run("failed", "orphan", Date.now(), "running");
      auditDb.close();
    } catch {
      /* already closed */
    }
    auditDb = null;
  }
}

export type AuditDetailRow = {
  args_summary: string;
  result_summary: string;
  args_json: string | null;
  result_json: string | null;
  result_bytes: number;
  stored_truncated: boolean;
};

/**
 * Store the readable args/result of a job next to its audit row (best-effort: the detail is an aid, so
 * a failure here never fails the tool call, even under VENIRA_AUDIT_STRICT=1, which guards the chain).
 */
export function auditDetailInsert(
  sessionId: string,
  requestId: string,
  operation: string,
  detail: AuditDetailRow,
): void {
  const db = ensureAuditDb();
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO project_tool_audit_detail
         (request_id, session_id, operation, args_summary, result_summary, args_json, result_json, result_bytes, stored_truncated, created_at)
       VALUES (@request_id, @session_id, @operation, @args_summary, @result_summary, @args_json, @result_json, @result_bytes, @stored_truncated, @created_at)`,
    ).run({
      request_id: requestId,
      session_id: sessionId,
      operation,
      args_summary: detail.args_summary,
      result_summary: detail.result_summary,
      args_json: detail.args_json,
      result_json: detail.result_json,
      result_bytes: detail.result_bytes,
      stored_truncated: detail.stored_truncated ? 1 : 0,
      created_at: Date.now(),
    });
  } catch (error) {
    console.error(`[corehost] audit detail write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
