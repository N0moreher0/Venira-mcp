/**
 * Standalone corehost: pure Node implementation of the `project_tool.*`
 * operations. Replaces the Rust `venira_corehost_rs.exe` — no external
 * binary needed.
 *
 * Implements:
 *   - file I/O (read_file, get_file_info, write_file, edit_file,
 *     create_directory, delete_path)
 *   - directory listing (list_files)
 *   - content search (search: literal_content, file_name, directory_name,
 *     definition — via simple line scan)
 *   - async shell (shell_run, shell_status, cancel)
 *   - scope open/close (long-lived capability token, TTL 2h)
 *   - audit trail via SQLite (better-sqlite3, WAL mode)
 *
 * The audit DB defaults to the per-user OS data directory unless
 * VENIRA_DATA_DIR is set.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  promises as fs,
} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import type { HostSnapshot } from "./types.js";
import { loadAuditKey, hashAuditRow } from "./audit-hash.js";
import {
  commandKey,
  commandHash,
  describeShellPolicy,
  enabledShellOverrides,
  evaluateShellCommand,
  grantSessionApproval,
  hasSessionApproval,
  issueApprovalToken,
  parseShellCommand,
  recordApproval,
  recordDecision,
  redactSecrets,
  shellStats,
  shellOverrideMatches,
  verifyApprovalToken,
  isShellOverride,
  type Decision,
  type ShellOverride,
} from "./shell-policy.js";
import { getShellCache, setShellCache } from "./shell-cache.js";
import {
  editMatchLocations,
  levenshtein,
  normalizeForFuzzy,
} from "./file-ops-helpers.js";
import * as approvals from "./approvals.js";
import { WORKSPACE, PLATFORM, resolveWithin, isProtectedPath, activeDataDir, dynamicWorkspaceEnabled, switchWorkspaceRoot, allowedWorkspaceRoots } from "./workspace.js";
import {
  opSnapshotCreate,
  opSnapshotDelete,
  opSnapshotList,
  opSnapshotRestore,
  sanitizeReason,
} from "./snapshots.js";
import {
  opCiLogs,
  opCiStatus,
  opCiTrigger,
  opPrClose,
  opPrComment,
  opPrCreate,
  opPrList,
  opPrMerge,
  opPrReopen,
} from "./git-provider.js";
import {
  assertSecretName,
  assertSecretUsable,
  deleteSecret,
  getSecretValueSync,
  listSecrets,
  markSecretUsed,
  MAX_EXPIRY_DAYS,
  redactSecretValues,
  setSecret,
} from "./secrets.js";
import { GithubDeviceFlow } from "./github-device-flow.js";
import { envChoice, envFlag, parseBackgroundFlag } from "./env.js";
import { buildChangeImpact, buildDependencyGraph } from "./dependency-graph.js";
import { opCiWait } from "./ci-wait.js";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

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

function ensureAuditDb(): Database.Database | null {
  if (auditDb) return auditDb;
  try {
    const dbPath = auditDbPath();
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    auditDb = new Database(dbPath);
    auditDb.pragma("journal_mode = WAL");
    auditDb.pragma("synchronous = NORMAL");
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
    auditDb.exec(`
      CREATE TABLE IF NOT EXISTS project_file_index (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'file',
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_file_index_mtime ON project_file_index(updated_at DESC);
    `);
    // Additive migration for the recent-files index (SQLite has no ADD COLUMN IF NOT EXISTS).
    const indexColumns = new Set(
      (auditDb.prepare("PRAGMA table_info(project_file_index)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const [name, type] of [
      ["kind", "TEXT NOT NULL DEFAULT 'file'"],
    ] as const) {
      if (!indexColumns.has(name)) auditDb.exec(`ALTER TABLE project_file_index ADD COLUMN ${name} ${type}`);
    }
    // R8 retention + VACUUM (best-effort)
    try {
      const days = Number(process.env.VENIRA_AUDIT_KEEP_DAYS ?? 90);
      if (Number.isFinite(days) && days > 0) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        auditDb.prepare("DELETE FROM project_tool_audit WHERE started_at < ?").run(cutoff);
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

type AuditRow = {
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (auditStrict()) throw new Error(`[audit_unavailable] audit write failed: ${msg}`);
    console.error(`[corehost] audit write failed: ${msg}`);
  }
}

function auditStart(
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

function auditFinish(
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
function auditDecision(
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

// ---------------------------------------------------------------------------
// Capability / scope
// ---------------------------------------------------------------------------
type Scope = {
  capability_id: string;
  project_id: string;
  session_id: string;
  opened_at: number;
  expires_at: number;
};

export const SCOPE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const openScopes = new Map<string, Scope>();

function openScope(
  sessionId: string,
  projectId: string | null,
  permissionMode: string,
): Scope {
  const capabilityId = crypto.randomUUID();
  const projectIdResolved = projectId ?? "chat-terminal";
  const now = Date.now();
  const scope: Scope = {
    capability_id: capabilityId,
    project_id: projectIdResolved,
    session_id: sessionId,
    opened_at: now,
    expires_at: now + SCOPE_TTL_MS,
  };
  openScopes.set(capabilityId, scope);
  console.error(
    `[corehost] scope opened (${permissionMode}): ${capabilityId} → ${projectIdResolved}`,
  );
  return scope;
}

function closeScope(capabilityId: string): void {
  const scope = openScopes.get(capabilityId);
  if (!scope) return;
  openScopes.delete(capabilityId);
  console.error(`[corehost] scope closed: ${capabilityId}`);
}

function isScopeValid(capabilityId: string): boolean {
  const scope = openScopes.get(capabilityId);
  return !!scope && scope.expires_at > Date.now();
}

// ---------------------------------------------------------------------------
// Shell run tracking
// ---------------------------------------------------------------------------

type ShellRun = {
  run_id: string;
  kill_key: string;
  command: string;
  shell: string;
  cwd: string;
  process: ChildProcess | null;
  stdout_tail: string;
  stderr_tail: string;
  stdout_full: string;
  stderr_full: string;
  running: boolean;
  exit_code: number | null;
  cancelled: boolean;
  started_at: number;
  finished_at?: number;
  /** Resolves once stdout/stderr are fully flushed ('close' or 'error'). */
  closedPromise: Promise<void>;
  /** Policy decision that authorised this run (audit + status output). */
  decision: { tier: string; rule: string; reason: string; approver: string | null };
  /** Requested timeout (0 = none). */
  timeout_ms: number;
  timed_out: boolean;
  /** Bytes dropped because of the output cap. */
  dropped_bytes: number;
  /** setTimeout handle, cleared on exit. */
  timer: NodeJS.Timeout | null;
};

// R4: prune finished shellRuns older than 30 min, keep at most 64 finished.
function pruneShellRuns(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  const finished: string[] = [];
  for (const [id, run] of shellRuns) {
    if (!run.running && run.started_at < cutoff) finished.push(id);
  }
  for (const id of finished) shellRuns.delete(id);
  // cap finished
  const finishedAll = [...shellRuns.entries()].filter(([, r]) => !r.running);
  if (finishedAll.length > 64) {
    finishedAll.sort((a, b) => (a[1].finished_at ?? 0) - (b[1].finished_at ?? 0));
    const excess = finishedAll.length - 64;
    for (let i = 0; i < excess; i++) shellRuns.delete(finishedAll[i][0]);
  }
}

const shellRuns = new Map<string, ShellRun>();
const TAIL_LIMIT = (() => {
  const value = Number(process.env.VENIRA_SHELL_TAIL_MAX);
  return Number.isFinite(value) && value >= 256 ? Math.floor(value) : 2000;
})();
/** VENIRA_SHELL_EXIT_EARLY=1: pollers return immediately when the exit code is
 * already known, without waiting out the full wait_seconds window. */
export const SHELL_EXIT_EARLY = envFlag("VENIRA_SHELL_EXIT_EARLY", false);
/** VENIRA_SHELL_TIMEOUT_POLICY=soft (default): an expired command only warns and is
 * left to finish; =hard: kill the whole process tree at the timeout. */
export const SHELL_TIMEOUT_POLICY: "soft" | "hard" =
  envChoice("VENIRA_SHELL_TIMEOUT_POLICY", "soft", ["soft", "hard"]);

/** Hard cap per stream; keeps a runaway build from exhausting server memory. */
const MAX_OUTPUT_BYTES = (() => {
  const value = Number(process.env.VENIRA_SHELL_MAX_OUTPUT_BYTES);
  return Number.isFinite(value) && value > 0 ? value : 256 * 1024;
})();

/** Upper bound for a caller-supplied timeout_ms; shell runs default to 10 minutes. */
export const SHELL_MAX_TIMEOUT_MS = (() => {
  const value = Number(process.env.VENIRA_SHELL_MAX_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30 * 60 * 1000;
})();

function trimTail(buffer: string): string {
  if (buffer.length <= TAIL_LIMIT) return buffer;
  return buffer.slice(-TAIL_LIMIT);
}

/** Append with a byte cap; returns true when bytes were dropped. */
function appendCapped(current: string, chunk: string, limit: number): { text: string; dropped: number } {
  const remaining = limit - current.length;
  if (remaining <= 0) return { text: current, dropped: chunk.length };
  if (chunk.length <= remaining) return { text: current + chunk, dropped: 0 };
  return { text: current + chunk.slice(0, remaining), dropped: chunk.length - remaining };
}

/**
 * Environment allow list. The shell inherits only what toolchains actually
 * need; agent secrets (API keys, registry tokens) are not passed through.
 * Opt out with VENIRA_SHELL_ENV_PASS_ALL=1, extend with
 * VENIRA_SHELL_ENV_ALLOW="VAR1,VAR2".
 */
const BASE_ENV_ALLOW = [
  "PATH", "Path", "PATHEXT", "COMSPEC", "ComSpec", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
  "USERNAME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "PWD",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "JAVA_HOME", "DOTNET_ROOT", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME",
  "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "NVM_HOME", "NVM_SYMLINK",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CI",
];

function buildShellEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  if (envFlag("VENIRA_SHELL_ENV_PASS_ALL", false)) {
    return { ...process.env, ...overrides };
  }
  const extra = (process.env.VENIRA_SHELL_ENV_ALLOW ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const allow = new Set([...BASE_ENV_ALLOW, ...extra]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allow.has(key)) env[key] = value;
  }
  // Keep PATH resolvable even if the host named it unusually.
  if (!env.PATH && !env.Path && process.env.PATH) env.PATH = process.env.PATH;
  // Explicit `secret_env` injections are added last so they win over inherited
  // values of the same name; they never come from the audit-visible args.
  return { ...env, ...overrides };
}

/**
 * `secret_env` names are validated up front (cheap) but their values are only
 * decrypted at spawn time — after the policy gate approved the command.
 */
function normalizeSecretEnv(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("[invalid_request] `secret_env` must be an array of secret names.");
  }
  if (value.length > 16) {
    throw new Error("[invalid_request] At most 16 `secret_env` names per shell run.");
  }
  const names: string[] = [];
  for (const entry of value) {
    const name = assertSecretName(entry);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Kill the whole process tree, not just the direct child: `npm test` spawns
 * node which spawns the test runner, and `process.kill(pid)` leaves those
 * grandchildren running (and holding ports/files).
 */
function killTree(child: ChildProcess | null): void {
  if (!child || child.pid === undefined) return;
  recordApproval("killed_tree");
  if (PLATFORM === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* fall through to child.kill */
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
}

/** Snapshot of policy + runtime counters for project_health. */
export function shellPolicySnapshot() {
  return {
    policy: describeShellPolicy(),
    stats: shellStats(),
    limits: { max_output_bytes: MAX_OUTPUT_BYTES, max_timeout_ms: SHELL_MAX_TIMEOUT_MS, tail_chars: TAIL_LIMIT },
    tracked_runs: shellRuns.size,
  };
}

// ---------------------------------------------------------------------------
// File / directory operations
// ---------------------------------------------------------------------------

type RustResponse = {
  status?: string;
  truncated?: boolean;
  hint?: string;
  result?: { kind?: string; data?: unknown };
};

function resolveInWorkspace(input: string | undefined, root: string): string {
  return resolveWithin(root, input);
}

type ErrorWithData = Error & { data?: unknown };

function errorWithData(code: string, message: string, data: unknown): ErrorWithData {
  const error = new Error(`[${code}] ${message}`) as ErrorWithData;
  error.data = data;
  return error;
}

async function opReadFile(
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

  const startLine = (args.start_line as number | undefined) ?? 1;
  const endLine = (args.end_line as number | undefined) ?? Infinity;
  const maxBytes = (args.max_bytes as number | undefined) ?? 1_048_576;

  let content: string;
  try {
    content = await fs.readFile(canonicalPath, "utf8");
  } catch (error) {
    throw new Error(
      `[io_error] Cannot read ${canonicalPath}: ${error instanceof Error ? error.message : String(error)}. Hint: file may be locked.`,
    );
  }

  const allLines = content.split("\n");
  const lastLineOfAll = allLines.length;
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

  const data: Record<string, unknown> = {
    relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
    kind: "file",
    text,
    first_line: firstLine,
    last_line: lastLine,
    total_bytes: stat.size,
    total_lines: lastLineOfAll,
    truncated,
  };
  if (truncated && lastLine < lastLineOfAll) {
    data.next_start_line = lastLine + 1;
  }

  return {
    status: "completed",
    truncated,
    result: { kind: "file_read", data },
  };
}

async function opGetFileInfo(
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

async function opListFiles(
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



let ripgrepAvailableCache: boolean | null = null;
async function ripgrepInstalled(): Promise<boolean> {
  if (ripgrepAvailableCache !== null) return ripgrepAvailableCache;
  try {
    const result = await new Promise<boolean>((resolve) => {
      const child = spawn("rg", ["--version"], { timeout: 5000 });
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignored */ }
        resolve(false);
      }, 5000);
      child.on("exit", (code: number | null) => {
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(code === 0);
      });
      child.on("error", () => {
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(false);
      });
      child.stdout?.resume();
      child.stderr?.resume();
    });
    ripgrepAvailableCache = result;
  } catch {
    ripgrepAvailableCache = false;
  }
  return ripgrepAvailableCache;
}

function ripgrepExec(args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string; error?: any; }> {
  return new Promise((resolve) => {
    const child = spawn("rg", args, { timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch { /* ignored */ }
      resolve({ status: null, stdout, stderr, error: { code: "ETIMEDOUT" } });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { stdout += d; });
    child.stderr?.on("data", (d: string) => { stderr += d; });
    child.on("error", (e: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: e });
    });
    child.on("exit", (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

/**
 * Score a search hit so the most useful results surface first — agents
 * usually only read the first few hits, so ranking matters more than raw
 * ripgrep order (which is filesystem order).
 *
 * Scoring (higher = better):
 *   - whole-word match      +40   (identifier found as a standalone token)
 *   - prefix match          +20   (line starts with the query)
 *   - file-name match       +30   (query appears in the file name)
 *   - shallow depth         +10   (files closer to workspace root)
 *   - early line            +10   (line number < 10)
 * Case-insensitive matching throughout; `needle` is pre-lowercased.
 */
function scoreHit(hit: Record<string, unknown>, needle: string, rel: string): number {
  let score = 0;
  const snippet = String(hit.snippet ?? "").toLowerCase();
  const lineLower = snippet;
  // whole-word: needle bounded by non-identifier chars on both sides
  const wordRe = new RegExp(`(?:^|[^A-Za-z0-9_$])${needle}(?:[^A-Za-z0-9_$]|$)`, "i");
  if (wordRe.test(lineLower)) score += 40;
  else if (lineLower.includes(needle)) score += 15; // substring fallback
  if (lineLower.startsWith(needle)) score += 20; // prefix (definition-like)
  const base = path.basename(rel).toLowerCase();
  if (base.includes(needle)) score += 30;
  else if (rel.toLowerCase().includes(needle)) score += 15;
  const depth = rel.split("/").length;
  score += Math.max(0, 10 - depth); // shallow files first
  const ln = Number(hit.line_number ?? 0);
  if (ln > 0 && ln <= 10) score += 10; // early line
  return score;
}

/**
 * Sort hits so the most relevant are first, then stable by (path, line).
 */
function rankHits(hits: Array<Record<string, unknown>>, needle: string): void {
  hits.sort((a, b) => {
    const sa = scoreHit(a, needle, String(a.relative_path ?? ""));
    const sb = scoreHit(b, needle, String(b.relative_path ?? ""));
    if (sb !== sa) return sb - sa;
    const ra = String(a.relative_path ?? "");
    const rb = String(b.relative_path ?? "");
    if (ra !== rb) return ra < rb ? -1 : 1;
    const la = Number(a.line_number ?? 0);
    const lb = Number(b.line_number ?? 0);
    return la - lb;
  });
}

async function opSearch(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const query = args.query as string;
  const kind = (args.kind as string) ?? "literal_content";
  const searchRoot = resolveInWorkspace(args.relative_path as string, root);
  if (isProtectedPath(searchRoot)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not search protected files.`);
  }
  const glob = args.glob as string | undefined;
  const excludeGlob = args.exclude_glob as string | undefined;
  const caseSensitive = args.case_sensitive !== false;
  const limit = Math.min(200, (args.limit as number | undefined) ?? 200);
  const contextLines = Math.min(20, (args.context_lines as number | undefined) ?? 0);
  const countOnly = args.count_only === true;

  // Simple glob-to-regex (supports *, ?, [seq])
  function globToRegex(g: string): RegExp {
    if (g.length > 256) {
      throw new Error("[resource_limit] glob is too long; limit it to 256 characters.");
    }
    let re = "";
    for (const ch of g) {
      if (ch === "*") re += ".*";
      else if (ch === "?") re += ".";
      else if (ch === "[") re += "[";
      else if (ch === "]") re += "]";
      else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
  }

  const includeRe = glob ? globToRegex(glob) : null;
  const excludeRe = excludeGlob ? globToRegex(excludeGlob) : null;

  const IGNORED = new Set([
    ".git", "node_modules", "target", "dist", "build",
    ".next", ".venv", "__pycache__", ".cache", ".turbo", "coverage",
  ]);

  type Hit = {
    relative_path: string;
    line_number?: number;
    snippet?: string;
    context?: string[];
  };
  const hits: Hit[] = [];
  const diagnostics: string[] = [];
  let complete = true;
  let totalMatchLines = 0;

  async function collectFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    async function walk(d: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const abs = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED.has(entry.name)) continue;
          await walk(abs);
        } else if (entry.isFile()) {
          if (isProtectedPath(abs)) continue;
          files.push(abs);
        }
      }
    }
    await walk(dir);
    return files;
  }

  const needle = caseSensitive ? query : query.toLowerCase();

  if (kind === "file_name" || kind === "directory_name") {
    const files = await collectFiles(searchRoot);
    for (const abs of files) {
      if (hits.length >= limit) { complete = false; break; }
      const basename = path.basename(abs);
      const match = caseSensitive ? basename.includes(query) : basename.toLowerCase().includes(needle);
      if (!match) continue;
      if (kind === "file_name" && (await fs.stat(abs)).isDirectory()) continue;
      if (kind === "directory_name" && !(await fs.stat(abs)).isDirectory()) continue;
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      hits.push({ relative_path: rel });
      totalMatchLines += 1;
    }
  } else {
    // literal_content, regex, definition — Phase 1 (bounded parallel
    // chunked reads) + Phase 2 (binary-ext + null-byte guards).
    // Ripgrep-backed fast path if available (safe spawn, no shell).
    // Include/exclude globs map to `rg --glob` (a negated glob for exclude);
    // they no longer silently disable this path on huge workspaces.
    // context_lines maps to `rg -C <n>`.
    if (envFlag("VENIRA_USE_RIPGREP", true) && kind === "literal_content" && !countOnly) {
      if (await ripgrepInstalled()) {
        try {
          const argList = ["--json", "-n", "--max-filesize=1M", "--color=never"];
          if (!caseSensitive) argList.push("-i");
          if (contextLines > 0) argList.push("-C", String(contextLines));
          if (args.regex === true) { argList.push("-e", String(query)); }
          else { argList.push("-F", "-e", String(query)); }
          if (glob) argList.push("--glob", String(glob));
          if (excludeGlob) argList.push("--glob", `!${excludeGlob}`);
          argList.push("--max-count", String(limit));
          argList.push(searchRoot);
          const resp = await ripgrepExec(argList, 10000);

          if (!resp.error || (resp.error as any).code !== "ETIMEDOUT") {
            const lines = String(resp.stdout ?? "").split(/\r?\n/).filter(Boolean);
            for (const raw of lines) {
              let rec: any = null;
              try { rec = JSON.parse(raw); } catch { continue; }
              if (rec?.type !== "match") continue;
              const pth = String(rec.data?.path?.text ?? "");
              const abs = path.isAbsolute(pth) ? pth : path.resolve(root, pth);
              if (isProtectedPath(abs)) continue;
              const rel = path.relative(root, abs).replace(/\\/g, "/");
              const ln = Number(rec.data?.line_number ?? 0);
              const lineText = String(rec.data?.lines?.text ?? "").replace(/\n$/, "");
              const snippet = lineText.trim().slice(0, 200);
              hits.push({ relative_path: rel, line_number: ln, snippet });
              totalMatchLines += 1;
              if (hits.length >= limit) { complete = false; break; }
            }
            rankHits(hits, needle);
            return {
              status: "completed",
              truncated: !complete,
              result: {
                kind: "search",
                data: {
                  hits,
                  complete,
                  diagnostics,
                  total_match_lines: totalMatchLines,
                  files_matched: new Set(hits.map((h) => h.relative_path)).size,
                  hint: hits.length === 0 ? "No matches. Broaden the search: drop glob/relative_path, set regex=0, or use kind=file_name." : undefined,
                },
              },
            };
          }
        } catch {
          // fall through to JS scanning
        }
      }
    }

    const files = await collectFiles(searchRoot);
    const useRegex = args.regex === true;
    let contentRe: RegExp | null = null;
    if (useRegex) {
      if (query.length > 512 || /(?:\([^)]*[+*][^)]*\)|\[[^\]]+\][+*])[+*{]/.test(query)) {
        throw new Error("[resource_limit] Regex too complex");
      }
      try { contentRe = new RegExp(query, caseSensitive ? "" : "i"); }
      catch (error) { throw new Error(`[invalid_request] Invalid regex: ${error instanceof Error ? error.message : String(error)}`); }
    }

    const BINARY_EXT = new Set([".png",".jpg",".jpeg",".gif",".webp",".bmp",".ico",".tiff",
      ".woff",".woff2",".ttf",".otf",".eot",".svg",".pdf",".zip",".gz",".tgz",".7z",".rar",".tar",
      ".mp3",".mp4",".mov",".avi",".mkv",".webm",".exe",".dll",".so",".dylib",".o",".a",
      ".wasm",".pyc",".class",".jar"]);

    type FileEntry = { abs: string; rel: string; content: string };
    const entries: Array<FileEntry | null> = [];
    const READ_CHUNK = 16;
    for (let ci = 0; ci < files.length; ci += READ_CHUNK) {
      const chunk = files.slice(ci, ci + READ_CHUNK);
      const results = await Promise.all(chunk.map(async (abs): Promise<FileEntry | null> => {
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        if (includeRe && !includeRe.test(rel)) return null;
        if (excludeRe && excludeRe.test(rel)) return null;
        if (BINARY_EXT.has(path.extname(rel).toLowerCase())) return null;
        let content: string;
        try { content = await fs.readFile(abs, "utf8"); }
        catch { return null; }
        if (Buffer.byteLength(content, "utf8") > 1_048_576) return null;
        if (content.indexOf("\u0000") >= 0) return null;
        return { abs, rel, content };
      }));
      entries.push(...results);
    }

    const needleConst = needle;
    for (const entry of entries) {
      if (!entry) continue;
      if (hits.length >= limit) { complete = false; break; }
      const { rel, content } = entry;

      const lines = content.split("\n");
      const matchIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineLower = caseSensitive ? line : line.toLowerCase();
        const match = useRegex
          ? (contentRe as RegExp).test(line)
          : kind === "definition"
            ? /^\s*(?:export\s+)?(?:function|class|const|let|var|type|interface|struct|fn|impl|trait|enum)\s+/.test(line) &&
              lineLower.includes(needleConst)
            : lineLower.includes(needleConst);
        if (match) matchIndices.push(i);
      }
      if (matchIndices.length === 0) continue;
      totalMatchLines += matchIndices.length;

      for (const idx of matchIndices) {
        if (hits.length >= limit) {
          complete = false;
          break;
        }
        const snippet = lines[idx].trim().slice(0, 200);
        const hit: Hit = { relative_path: rel, line_number: idx + 1 };
        if (!countOnly) hit.snippet = snippet;
        if (contextLines > 0 && !countOnly) {
          const start = Math.max(0, idx - contextLines);
          const end = Math.min(lines.length, idx + contextLines + 1);
          hit.context = lines.slice(start, end);
        }
        hits.push(hit);
      }
    }
    rankHits(hits, needleConst);
  }

  const filesMatched = new Set(hits.map((h) => h.relative_path)).size;

  return {
    status: "completed",
    result: {
      kind: "search",
      data: {
        hits,
        complete,
        diagnostics,
        total_match_lines: totalMatchLines,
        files_matched: filesMatched,
        hint:
          hits.length === 0
            ? "No matches. Broaden the search: drop glob/relative_path, set regex=0, or use kind=file_name."
            : undefined,
      },
    },
  };
}

async function opWriteFile(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  if (isProtectedPath(absPath)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not write protected files.`);
  }
  // Enforce expected_sha256 (anti-overwrite guard): compare against current
  // file content before mutating.
  const expectedSha = args.expected_sha256;
  if (typeof expectedSha === "string" && expectedSha) {
    let current = "";
    try {
      const buf = await fs.readFile(absPath);
      current = crypto.createHash("sha256").update(buf).digest("hex");
    } catch {
      /* file may not exist: treat as empty hash */
    }
    if (current !== String(expectedSha).toLowerCase()) {
      throw errorWithData(
        "stale_content",
        `sha256 hiện tại (${current.slice(0, 12)}…) khác expected_sha256. Hint: đọc lại file rồi thử lại.`,
        { sha256: current || null, expected_sha256: String(expectedSha).toLowerCase() },
      );
    }
  }

  const content = args.content as string;
  const mode = (args.mode as string | undefined) ?? "overwrite";
  const createDirs = args.create_dirs === true;

  if (createDirs) {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
  }

  const action = mode === "create" ? "created" : mode === "append" ? "appended" : "overwritten";
  let bytesWritten = Buffer.byteLength(content, "utf8");

  if (mode === "create" && existsSync(absPath)) {
    throw new Error(
      `[conflict] File already exists: ${args.relative_path} (mode=create). Hint: use mode=overwrite to replace.`,
    );
  }

  if (mode === "append") {
    try {
      await fs.appendFile(absPath, content, "utf8");
    } catch (error) {
      throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
    }
    // R11: update recent-files index on append
    recordRecentFile(absPath, root);
    try {
      await fs.stat(absPath).then((s) => recordRecentFileMeta(absPath, s));
    } catch { /* best-effort */ }
  } else {
    // R1: atomic write (temp + fsync + rename); mode:"create" guarded by existsSync check above.
    const dir = path.dirname(absPath);
    const tmp = path.join(dir, `.venira-tmp-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(tmp, content, "utf8");
      try {
        const fh = await fs.open(tmp, "r+");
        await fh.sync();
        await fh.close();
      } catch { /* best-effort */ }
      await fs.rename(tmp, absPath);
    } catch (error) {
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
    }
    // P2: Update recent-files index
    recordRecentFile(absPath, root);
    try {
      await fs.stat(absPath).then((s) => recordRecentFileMeta(absPath, s));
    } catch { /* best-effort */ }
  }

  let sha256After = "";
  try {
    const written = await fs.readFile(absPath);
    sha256After = crypto.createHash("sha256").update(written).digest("hex");
  } catch {
    /* sha256 is best-effort */
  }

  return {
    status: "completed",
    result: {
      kind: "file_written",
      data: {
        relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
        action,
        bytes_written: bytesWritten,
        sha256_after: sha256After || undefined,
        reason: sanitizeReason(args.reason),
      },
    },
  };
}

async function opEditFile(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  if (isProtectedPath(absPath)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not edit protected files.`);
  }
  const edits = args.edits as
    | Array<{ old_text: string; new_text: string; replace_all?: boolean }>
    | undefined;
  const oldText = args.old_text as string | undefined;
  const newText = args.new_text as string | undefined;
  const replaceAll = args.replace_all === true;
  
  // P2: Fuzzy edit support
  const fuzzyEnabled = envFlag("VENIRA_EDIT_FUZZY", false);
  const fuzzyDistance = Number(args.fuzzy_distance ?? 3);
  const ignoreIndentation = args.ignore_indentation === true;
  const caseInsensitive = args.case_insensitive === true;

  const editList = edits ?? (oldText !== undefined ? [{ old_text: oldText, new_text: newText ?? "", replace_all: replaceAll }] : []);
  if (editList.length === 0) {
    throw new Error(
      `[invalid_request] No edits provided. Pass old_text/new_text or edits[].`,
    );
  }

  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch {
    throw new Error(`[not_found] File does not exist: ${args.relative_path}. Hint: create it with project_write_file first.`);
  }

  // R2: detect BOM + EOL style of the file.
  const hadBom = content.startsWith("\ufeff");
  const body = hadBom ? content.slice(1) : content;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const eolLabel = eol === "\r\n" ? "crlf" : "lf";
  // work on body without BOM; normalize line endings internally (keep original eol in body)
  content = body;

  // helper to normalize incoming text line endings to the file's EOL
  const normalizeEol = (s: string) => s.replace(/\r\n|\r|\n/g, eol);

  let sha256Before = "";
  try {
    sha256Before = crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  } catch {
    /* best-effort */
  }

  // Enforce expected_sha256 (anti-overwrite guard).
  const expectedSha2 = args.expected_sha256;
  if (typeof expectedSha2 === "string" && expectedSha2) {
    if (sha256Before !== String(expectedSha2).toLowerCase()) {
      throw errorWithData(
        "stale_content",
        `sha256 hiện tại (${sha256Before.slice(0, 12)}…) khác expected_sha256. Hint: đọc lại file rồi thử lại.`,
        {
          sha256: sha256Before || null,
          expected_sha256: String(expectedSha2).toLowerCase(),
          mtime_ms: (await fs.stat(absPath)).mtimeMs,
        },
      );
    }
  }

  let replacements = 0;
  let usedFuzzy = false;
  for (const edit of editList) {
    const old_text = normalizeEol(edit.old_text as string);
    const new_text = normalizeEol((edit.new_text ?? "") as string);
    const replace_all = edit.replace_all;
    if (typeof old_text !== "string" || old_text.length === 0) {
      throw new Error(`[invalid_request] old_text must be a non-empty string (field: ${args.relative_path}).`);
    }
    if (old_text === new_text) continue;
    if (!(replace_all || replaceAll)) {
      const occurrences = (content.split(old_text).length - 1);
      if (occurrences > 1) {
        throw errorWithData(
          "old_text_ambiguous",
          `old_text matches ${occurrences} locations in ${args.relative_path}. Extend old_text to include more context or set replace_all=true.`,
          {
            occurrences,
            matches: editMatchLocations(content, old_text),
            suggestion: "extend old_text with surrounding context or set replace_all=true",
          },
        );
      }
    }
    let idx = content.indexOf(old_text);
    
    // P2: Fuzzy match fallback
    if (idx === -1 && fuzzyEnabled) {
      const fuzzyResult = findFuzzyMatch(content, old_text, fuzzyDistance, ignoreIndentation, caseInsensitive);
      if (fuzzyResult !== -1) {
        idx = fuzzyResult;
        usedFuzzy = true;
        console.error(`[corehost] fuzzy match found at offset ${idx} (distance ${fuzzyDistance})`);
      }
    }
    
    if (idx === -1) {
      throw errorWithData(
        "old_text_not_found",
        `old_text not found in ${args.relative_path}. Hint: re-read the file to confirm the exact text.${fuzzyEnabled ? " (Fuzzy edit enabled with distance " + fuzzyDistance + ")" : ""}`,
        { occurrences: 0, suggestion: "re-read file and copy exact old_text" },
      );
    }
    if (replace_all || replaceAll) {
      const parts = content.split(old_text);
      content = parts.join(new_text);
      replacements += parts.length - 1;
    } else {
      content = content.slice(0, idx) + new_text + content.slice(idx + old_text.length);
      replacements += 1;
    }
  }

  // Prepend BOM if original had it
  const finalContent = hadBom ? "\ufeff" + content : content;

  // R1: atomic write
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.venira-tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, finalContent, "utf8");
    try {
      const fh = await fs.open(tmp, "r+");
      await fh.sync();
      await fh.close();
    } catch { /* best-effort */ }
    await fs.rename(tmp, absPath);
  } catch (error) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
  }

  // P2: Update recent-files index
  recordRecentFile(absPath, root);
  try {
    await fs.stat(absPath).then((s) => {
      recordRecentFileMeta(absPath, s);
    });
  } catch { /* best-effort */ }

  let sha256After = "";
  try {
    sha256After = crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  } catch {
    /* best-effort */
  }

  return {
    status: "completed",
    result: {
      kind: "file_written",
      data: {
        relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
        action: "edited",
        replacements,
        sha256_before: sha256Before || undefined,
        sha256_after: sha256After || undefined,
        fuzzy_used: usedFuzzy || undefined,
        reason: sanitizeReason(args.reason),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// P2: Recent files index (SQLite)
// ---------------------------------------------------------------------------

/** Record a file edit in the project_file_index (SQLite) so that
 *  project_recent_files can use an indexed query instead of a bounded scan.
 *  Best-effort: errors are logged, never thrown.
 */
function recordRecentFile(absPath: string, root: string): void {
  const db = ensureAuditDb();
  if (!db) return;
  const rel = path.relative(root, absPath).replace(/\\/g, "/");
  try {
    db.prepare(
      `INSERT OR REPLACE INTO project_file_index (path, mtime_ms, size, updated_at)
       VALUES (?, 0, 0, ?)`,
    ).run(rel, Date.now());
  } catch (error) {
    console.error(`[corehost] recent index write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Update mtime/size for a recently-touched file in the index. */
function recordRecentFileMeta(absPath: string, stat: { mtimeMs: number; size: number }): void {
  const db = ensureAuditDb();
  if (!db) return;
  const root = WORKSPACE;
  const rel = path.relative(root, absPath).replace(/\\/g, "/");
  try {
    db.prepare(
      `UPDATE project_file_index SET mtime_ms = ?, size = ?, updated_at = ? WHERE path = ?`,
    ).run(stat.mtimeMs, stat.size, Date.now(), rel);
  } catch (error) {
    console.error(`[corehost] recent index update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** P2: Query the recent-files index, optionally limiting the result. */
export function queryRecentFiles(limit: number, includeDirs: boolean): Array<{ relative_path: string; mtime_ms: number; size: number; kind: string; updated_at: number }> {
  const db = ensureAuditDb();
  if (!db) return [];
  try {
    const where = includeDirs ? "" : `WHERE kind = 'file'`;
    const rows = db.prepare(
      `SELECT path, mtime_ms, size, kind, updated_at FROM project_file_index ${where} ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as Array<{ path: string; mtime_ms: number; size: number; kind: string; updated_at: number }>
    return rows.map((r) => ({ relative_path: r.path, mtime_ms: r.mtime_ms, size: r.size, kind: r.kind, updated_at: r.updated_at }));
  } catch (error) {
    console.error(`[corehost] recent index query failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * P2: Find the best fuzzy match of `needle` in `haystack` (Levenshtein distance <= maxDist).
 * Returns the start offset of the best match, or -1 if none found.
 */
function findFuzzyMatch(
  haystack: string,
  needle: string,
  maxDistance: number,
  ignoreIndentation: boolean,
  caseInsensitive: boolean,
): number {
  const hNorm = normalizeForFuzzy(haystack, ignoreIndentation, caseInsensitive);
  const nNorm = normalizeForFuzzy(needle, ignoreIndentation, caseInsensitive);
  if (!hNorm || !nNorm) return -1;
  
  let bestOffset = -1;
  let bestDistance = Infinity;
  
  // Sliding window: try matching nNorm at every position in hNorm
  const nLen = nNorm.length;
  for (let i = 0; i < hNorm.length && i + nLen <= hNorm.length; i++) {
    const window = hNorm.slice(i, i + nLen);
    const dist = levenshtein(window, nNorm);
    if (dist <= maxDistance && dist < bestDistance) {
      bestDistance = dist;
      bestOffset = i;
    }
  }
  return bestOffset;
}

/** Normalize for fuzzy matching: collapse whitespace, optionally lowercase. */
async function opCreateDirectory(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  const createParents = args.create_parents !== false;
  try {
    await fs.mkdir(absPath, { recursive: createParents });
  } catch (error) {
    throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    status: "completed",
    result: {
      kind: "directory_created",
      data: {
        relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
        reason: sanitizeReason(args.reason),
      },
    },
  };
}

async function opDeletePath(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  // Refuse to delete the workspace root (or an ancestor of it). One call with
  // `relative_path: "."` and recursive=1 used to wipe the whole tree, and this
  // op is explicitly not undoable.
  const caseFold = (value: string) => (PLATFORM === "win32" ? value.toLowerCase() : value);
  const rootTarget = caseFold(path.resolve(root));
  const deleteTarget = caseFold(path.resolve(absPath));
  const rootInsideTarget = path.relative(deleteTarget, rootTarget);
  const targetCoversRoot =
    rootInsideTarget === "" ||
    (!rootInsideTarget.startsWith("..") && !path.isAbsolute(rootInsideTarget));
  if (targetCoversRoot) {
    throw new Error(
      `[invalid_request] Refusing to delete the workspace root: ${args.relative_path}. ` +
        "Hint: pass the path of a file or subdirectory inside the workspace.",
    );
  }
  if (isProtectedPath(absPath)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not delete protected files.`);
  }
  const recursive = args.recursive === true;
  let entriesDeleted = 0;
  let bytesDeleted = 0;

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new Error(`[not_found] Path does not exist: ${args.relative_path}.`);
  }

  if (stat.isDirectory() && !recursive) {
    throw new Error(
      `[invalid_request] Directory requires recursive=1: ${args.relative_path}.`,
    );
  }

  async function countFiles(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await countFiles(abs);
      } else if (entry.isFile()) {
        try {
          const s = await fs.stat(abs);
          bytesDeleted += s.size;
        } catch { /* ignore */ }
        entriesDeleted += 1;
      }
    }
  }

  if (stat.isDirectory()) {
    await countFiles(absPath);
    entriesDeleted += 1; // the directory itself
  } else {
    bytesDeleted = stat.size;
    entriesDeleted = 1;
  }

  try {
    await fs.rm(absPath, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
  }

  // P2: Remove from recent-files index
  removeFromRecentIndex(absPath, root);

  return {
    status: "completed",
    result: {
      kind: "path_deleted",
      data: {
        relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
        kind: stat.isDirectory() ? "directory" : "file",
        entries_deleted: entriesDeleted,
        bytes_deleted: bytesDeleted,
        reason: sanitizeReason(args.reason),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Shell operations (native, no Rust)
// ---------------------------------------------------------------------------

function defaultShellForPlatform(): string {
  // OPTIMIZATION: cmd.exe starts ~99% faster than PowerShell on Windows
  // (8ms vs 2300ms). Most agent commands work in both shells.
  // Users can override with VENIRA_DEFAULT_SHELL=powershell if needed.
  if (PLATFORM === "win32") return "cmd";
  // macOS: respect $SHELL (zsh/bash); Linux: fall back to bash/zsh.
  if (process.env.SHELL && process.env.SHELL !== "") {
    const base = process.env.SHELL.split("/").pop();
    if (base) return base;
  }
  return "bash";
}

function shellCommandFor(shell: string, command: string): { file: string; args: string[] } {
  switch (shell) {
    case "powershell":
      return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
    case "cmd":
      return { file: "cmd.exe", args: ["/c", command] };
    case "bash":
      return { file: "bash", args: ["-c", command] };
    case "sh":
      return { file: "sh", args: ["-c", command] };
    case "zsh":
      return { file: "zsh", args: ["-c", command] };
    case "fish":
      return { file: "fish", args: ["-c", command] };
    default:
      const fallback = defaultShellForPlatform();
      return shellCommandFor(fallback, command);
  }
}

function clampTimeout(value: unknown): number {
  const raw = value === undefined || value === null || value === "" ? 600_000 : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 600_000;
  return Math.min(Math.floor(raw), SHELL_MAX_TIMEOUT_MS);
}

async function opShellRun(
  args: Record<string, unknown>,
  root: string,
  sessionId: string,
): Promise<RustResponse> {
  const command = String(args.command ?? "");
  if (!command.trim()) {
    throw new Error("[invalid_request] `command` must be a non-empty string.");
  }
  const shell = (args.shell as string | undefined) ?? process.env.VENIRA_DEFAULT_SHELL ?? defaultShellForPlatform();
  const cwd = resolveInWorkspace(args.relative_cwd as string | undefined, root);
  
  // Shell output cache: check if we have a cached result for this exact command
  const cached = getShellCache(command, cwd);
  if (cached && !args.approval_token && !args.approval_id && !args.override) {
    // Return cached result without spawning process
    const runId = crypto.randomUUID().slice(0, 12);
    return {
      status: "completed",
      result: {
        kind: "shell_run",
        data: {
          run_id: runId,
          shell_id: runId,
          // Cached result has no live process -> cancellation is not applicable.
          kill_key: "",
          shell: (args.shell as string | undefined) ?? process.env.VENIRA_DEFAULT_SHELL ?? defaultShellForPlatform(),
          running: false,
          exit_code: cached.exitCode,
          background: false,
          foreground: true,
          stdout_tail: cached.output.slice(-4000),
          stderr_tail: cached.error.slice(-4000),
          truncated: false,
          dropped_bytes: 0,
          timed_out: false,
          timeout_ms: 0,
          stdout: cached.output,
          stderr: cached.error,
          policy: { decision: "allow", rule: "cache.hit", mode: "permissive", approver: null },
        },
      },
    };
  }
  
  const runId = crypto.randomUUID().slice(0, 12);
  const killKey = crypto.randomBytes(16).toString("hex");
  const secretNames = normalizeSecretEnv(args.secret_env);
  let override: ShellOverride | undefined;
  if (args.override !== undefined) {
    if (!isShellOverride(args.override)) {
      throw new Error("[invalid_request] override must be ALLOW_GIT_PUSH or ALLOW_ENV_READ.");
    }
    override = args.override;
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!reason || reason.length > 400) {
      throw new Error("[invalid_request] A non-empty reason of at most 400 characters is required with override.");
    }
    if (!enabledShellOverrides().has(override)) {
      throw new Error(
        `[override_not_enabled] Override ${override} is not enabled by the operator (rule: override.${override}). ` +
          `Set VENIRA_SHELL_OVERRIDES=${override} explicitly to enable it.`,
      );
    }
    if (!shellOverrideMatches(override, command, cwd)) {
      throw new Error(
        `[override_scope_mismatch] Override ${override} does not cover this command (rule: override.${override}); ` +
          `remove override or use a command within its documented scope.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 1. Policy gate: deny → throw, ask → approval flow, allow → continue.
  // -------------------------------------------------------------------------
  const evaluatedDecision = evaluateShellCommand(command, cwd, {
    ...(override ? { override, overrideReason: String(args.reason).trim() } : {}),
  });
  const decision: Decision =
    secretNames.length > 0 && evaluatedDecision.tier !== "deny"
      ? {
          ...evaluatedDecision,
          tier: "ask",
          rule: "ask.secret_env_injection",
          reason: "Injecting stored secrets into a shell child requires explicit human approval.",
        }
      : evaluatedDecision;
  recordDecision(decision);
  const parsed = parseShellCommand(command);
  const approvalKey = commandKey(parsed);
  // Everything an approval covers: a grant only redeems for this exact call.
  const approvalBinding = approvals.bindingHash({
    command,
    shell,
    cwd,
    secret_env: secretNames,
    rule: decision.rule,
  });
  let approver: string | null = decision.rule.startsWith("override.")
    ? `agent:${decision.rule.slice("override.".length)}`
    : null;

  if (decision.tier === "deny") {
    throw new Error(
      `[command_denied] Blocked by ${decision.rule}: ${decision.reason} ` +
        `Hint: policy refuses this command; do not retry. Ask the user to run it manually if it is genuinely needed.`,
    );
  }

  for (const name of secretNames) assertSecretUsable(name);

  if (decision.tier === "ask") {
    const token = typeof args.approval_token === "string" ? args.approval_token.trim() : "";
    const approvalId = typeof args.approval_id === "string" ? args.approval_id.trim() : "";
    const wantSession = args.approval_scope === "session";
    if (token) {
    const verdict = verifyApprovalToken(token, sessionId, decision, `${shell}|${cwd}|${secretNames.slice().sort().join(",")}`);
      if (!verdict.ok) {
        throw new Error(
          `[approval_invalid] Approval token ${verdict.reason ?? "rejected"} (rule: ${decision.rule}). ` +
            `Hint: tokens are single-use and expire; call project_shell_run again without a token to receive a fresh approval_required envelope.`,
        );
      }
      approver = "user:token";
      recordApproval("approved");
      if (wantSession && approvals.sessionScopeAllowed(decision.rule)) grantSessionApproval(sessionId, decision, approvalKey);
    } else if (hasSessionApproval(sessionId, decision, approvalKey)) {
      approver = "user:session";
      recordApproval("approved");
    } else if (approvalId) {
      const v = approvals.verifyApprovalGrant(approvalId, sessionId, approvalBinding);
      if (!v.ok) {
        const hint =
          v.reason === "binding_mismatch" || v.reason === "bad_signature"
            ? `This approval was granted for a different command, shell, cwd or secret_env. Call project_shell_run again without approval_id to get a new approval_id for this exact command.`
            : `Run \`npx venira-mcp --approve ${approvalId}\` in a terminal first, then retry with approval_id="${approvalId}".`;
        throw new Error(`[approval_invalid] Approval ${approvalId} ${v.reason ?? "rejected"}. Hint: ${hint}`);
      }
      approver = "user:cli";
      recordApproval("approved");
      // Scope comes from the human's grant, never from the model's arguments.
      if (v.scope === "session" && approvals.sessionScopeAllowed(decision.rule)) {
        grantSessionApproval(sessionId, decision, approvalKey);
      }
      approvals.consumeApproval(approvalId);
    } else {
      const autoToken =
        decision.rule !== "ask.secret_env_injection" &&
        envFlag("VENIRA_SHELL_AUTO_APPROVE_TOKEN", false);
      const issued = autoToken
        ? issueApprovalToken(sessionId, decision, undefined, `${shell}|${cwd}|${secretNames.slice().sort().join(",")}`)
        : null;
      const pendingId = crypto.randomUUID();
      approvals.createPendingApproval({
        approval_id: pendingId,
        session_id: sessionId,
        command: redactSecrets(command),
        shell,
        cwd,
        secret_env: secretNames.slice(),
        rule: decision.rule,
        reason: decision.reason,
        tool: "project_shell_run",
        binding: approvalBinding,
        expires_at: issued?.expires_at ?? Date.now() + 5 * 60 * 1000,
        status: "pending",
        created_at: Date.now(),
      });
      return {
        status: "completed",
        result: {
          kind: "shell_approval",
          data: {
            approval_required: true,
            approval_id: pendingId,
            command: redactSecrets(command),
            shell,
            cwd,
            rule: decision.rule,
            reason: decision.reason,
            mode: decision.mode,
            ...(issued ? { approval_token: issued.token, expires_at: issued.expires_at } : {}),
            retry_with: {
              tool: "project_shell_run",
              arguments: {
                command,
                shell,
                ...(typeof args.relative_cwd === "string" ? { relative_cwd: args.relative_cwd } : {}),
                ...(secretNames.length > 0 ? { secret_env: secretNames } : {}),
                ...(issued ? { approval_token: issued.token } : { approval_id: pendingId }),
              },
            },
            ...(!issued
              ? {
                  note: `A human must run: npx venira-mcp --approve ${pendingId} (then retry with approval_id).${
                    decision.rule === "ask.secret_env_injection"
                      ? " Secret injection cannot use automatic approval tokens."
                      : " Or set VENIRA_SHELL_AUTO_APPROVE_TOKEN=1 to enable legacy behavior."
                  }`,
                }
              : {}),
          },
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // 2. Execution with hardening: env scrub, output cap, timeout, tree kill.
  // -------------------------------------------------------------------------
  const timeoutMs = clampTimeout(args.timeout_ms);
  const foreground = !parseBackgroundFlag(args.background);
  const { file, args: spawnArgs } = shellCommandFor(shell, command);

  // Secrets are decrypted only now (post-approval) and handed to the child
  // through the environment: the command string stays free of values.
  const secretEnvValues: Record<string, string> = {};
  for (const name of secretNames) {
    // Expiry/missing are checked here: an unusable credential must fail before
    // the child process starts, with a rotation hint the agent can act on.
    assertSecretUsable(name);
    const value = getSecretValueSync(name);
    if (value === undefined) {
      throw new Error(
        `[secret_missing] secret_env refers to "${name}" but it is not in the secret store. ` +
          `Hint: run project_secret action=list, or action=set name=${name}.`,
      );
    }
    secretEnvValues[name] = value;
  }
  // Best-effort rotation bookkeeping: last_used_at / use_count.
  for (const name of secretNames) {
    void markSecretUsed(name, "tool").catch(() => undefined);
  }

  let child: ChildProcess;
  try {
    child = spawn(file, spawnArgs, {
      cwd,
      env: buildShellEnv(secretEnvValues),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // POSIX: own process group so a timeout/cancel can kill grandchildren.
      detached: PLATFORM !== "win32",
    });
  } catch (error) {
    throw new Error(`[io_error] Cannot start shell: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Resolved by 'close' (stdio flushed) or 'error'; a foreground caller awaits
  // it so the final stdout/stderr chunk cannot be lost.
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const run: ShellRun = {
    run_id: runId,
    kill_key: killKey,
    command,
    shell,
    cwd,
    process: child,
    stdout_tail: "",
    stderr_tail: "",
    stdout_full: "",
    stderr_full: "",
    running: true,
    exit_code: null,
    cancelled: false,
    started_at: Date.now(),
    closedPromise,
    decision: { tier: decision.tier, rule: decision.rule, reason: decision.reason, approver },
    timeout_ms: timeoutMs,
    timed_out: false,
    dropped_bytes: 0,
    timer: null,
  };
  shellRuns.set(runId, run);
  pruneShellRuns();

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const out = appendCapped(run.stdout_full, text, MAX_OUTPUT_BYTES);
    run.stdout_full = out.text;
    if (out.dropped > 0) {
      run.dropped_bytes += out.dropped;
      recordApproval("output_capped");
    }
    // OPTIMIZATION: Only trim tail once at end, not on every chunk
    // run.stdout_tail = trimTail(run.stdout_full);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const out = appendCapped(run.stderr_full, text, MAX_OUTPUT_BYTES);
    run.stderr_full = out.text;
    if (out.dropped > 0) {
      run.dropped_bytes += out.dropped;
      recordApproval("output_capped");
    }
    // OPTIMIZATION: Only trim tail once at end, not on every chunk
    // run.stderr_tail = trimTail(run.stderr_full);
  });
  child.on("exit", (code, signal) => {
    run.running = false;
    run.finished_at = Date.now();
    run.cancelled = signal === "SIGTERM" || signal === "SIGKILL";
    run.exit_code = code ?? (signal ? -1 : 0);
    run.process = null;
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
  });
  // 'close' fires after stdio has flushed; a foreground caller must wait for it
  // or the last stdout/stderr chunk can be lost.
  child.on("close", () => {
    // 'close' is the only safe moment to trim tails and cache final output.
    // On Windows 'exit' can fire before the last 'data' events, so trimming at
    // 'exit' (or right after spawn on the async path) used to freeze empty
    // tails forever — and could even poison the shell cache with empty output.
    run.stdout_tail = trimTail(run.stdout_full);
    run.stderr_tail = trimTail(run.stderr_full);
    if (run.exit_code === 0 && run.stdout_full.length < 10000) {
      setShellCache(command, cwd, run.stdout_full, run.stderr_full, run.exit_code ?? 0);
    }
    resolveClosed();
  });
  child.on("error", (error) => {
    run.running = false;
    run.finished_at = Date.now();
    resolveClosed();
    run.exit_code = -1;
    run.process = null;
    run.stderr_tail = (run.stderr_tail + `\n[spawn error] ${error.message}`).slice(-TAIL_LIMIT);
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
  });

  if (timeoutMs > 0) {
    const policy = SHELL_TIMEOUT_POLICY;
    run.timer = setTimeout(() => {
      if (!run.running) return;
      run.timed_out = true;
      if (policy === "hard") {
        // hard: kill the whole process tree at the deadline.
        recordApproval("timed_out");
        killTree(run.process);
      } else {
        // soft: only warn; the command keeps running and can still be polled/cancelled.
        recordApproval("timeout_warn");
      }
    }, timeoutMs);
    run.timer.unref?.();
  }

  if (foreground) {
    // Foreground: block until the process has exited *and* stdout/stderr are
    // flushed, so the call returns the complete final output. There is no 2 s
    // cap here: the only bound is timeout_ms (plus the tool-call budget).
    await run.closedPromise;
  } else {
    // Async: wait briefly for the process to actually start (or fail
    // immediately), then return the run_id for polling.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!run.running || run.exit_code !== null) resolve();
        else setTimeout(check, 50);
      };
      setTimeout(check, 50);
      setTimeout(resolve, 2000);
    });
  }

  // Foreground: output is final now (we awaited 'close'), so trim tails and
  // cache here. The async path does the same in the 'close' handler instead —
  // trimming here would freeze empty tails before the child produced output.
  if (foreground) {
    run.stdout_tail = trimTail(run.stdout_full);
    run.stderr_tail = trimTail(run.stderr_full);
    if (run.exit_code === 0 && run.stdout_full.length < 10000) {
      setShellCache(command, cwd, run.stdout_full, run.stderr_full, run.exit_code ?? 0);
    }
  }

  return {
    status: "completed",
    result: {
      kind: "shell_run",
      data: {
        run_id: runId,
        shell_id: runId,
        kill_key: run.kill_key,
        shell,
        running: run.running,
        exit_code: run.exit_code,
        background: !foreground,
        foreground,
        stdout_tail: redactSecretValues(run.stdout_tail),
        stderr_tail: redactSecretValues(run.stderr_tail),
        truncated: run.stdout_full.length >= MAX_OUTPUT_BYTES || run.stderr_full.length >= MAX_OUTPUT_BYTES,
        dropped_bytes: run.dropped_bytes,
        timed_out: run.timed_out,
        timeout_ms: run.timeout_ms,
        ...(foreground
          ? {
              stdout: redactSecretValues(run.stdout_full),
              stderr: redactSecretValues(run.stderr_full),
            }
          : {}),
        ...(secretNames.length > 0 ? { secret_env: secretNames } : {}),
        policy: { decision: run.decision.tier, rule: run.decision.rule, mode: decision.mode, approver },
      },
    },
  };
}

async function opShellStatus(
  args: Record<string, unknown>,
): Promise<RustResponse> {
  const runId = args.run_id as string;
  const waitSeconds = Math.min(30, Math.max(0, Number(args.wait_seconds ?? 0)));
  const run = shellRuns.get(runId);
  if (!run) {
    throw new Error(`[not_found] Unknown run_id: ${runId}.`);
  }

  if (waitSeconds > 0 && run.running) {
    // P1: VENIRA_SHELL_EXIT_EARLY=1 — return as soon as the exit code is known
    // instead of waiting out the entire window.
    const pollEarly = SHELL_EXIT_EARLY;
    const deadline = Date.now() + waitSeconds * 1000;
    while (run.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (pollEarly && !run.running) break;
    }
  }

  return {
    status: "completed",
    result: {
      kind: "shell_run",
      data: {
        run_id: runId,
        shell_id: runId,
        shell: run.shell,
        running: run.running,
        exit_code: run.exit_code,
        cancelled: run.cancelled,
        stdout_tail: redactSecretValues(trimTail(run.stdout_full)),
        stderr_tail: redactSecretValues(trimTail(run.stderr_full)),
        truncated: run.stdout_full.length >= MAX_OUTPUT_BYTES || run.stderr_full.length >= MAX_OUTPUT_BYTES,
        dropped_bytes: run.dropped_bytes,
        timed_out: run.timed_out,
        timeout_ms: run.timeout_ms,
        elapsed_ms: Date.now() - run.started_at,
        policy: {
          decision: run.decision.tier,
          rule: run.decision.rule,
          approver: run.decision.approver,
        },
      },
    },
  };
}

function opShellCancel(args: Record<string, unknown>): RustResponse {
  const runId = args.run_id as string;
  const killKey = args.kill_key as string | undefined;
  const run = shellRuns.get(runId);
  if (!run) {
    throw new Error(`[not_found] Unknown run_id: ${runId}.`);
  }
  if (!killKey || killKey !== run.kill_key) {
    throw new Error(`[invalid_request] Missing or incorrect kill_key. Each shell process has a unique kill_key returned in the shell_run response. Provide kill_key to authorize cancellation.`);
  }
  if (run.running) {
    killTree(run.process);
    run.cancelled = true;
    run.running = false;
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
  }
  return {
    status: "completed",
    result: {
      kind: "cancellation",
      data: {
        accepted: true,
        cleanup_complete: !run.running,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// CoreHost class (drop-in replacement for the Rust CoreHost)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Secrets (`project_secret`)
//
// Values are never returned by default: `get`/`list` expose only metadata
// (length + sha256 prefix + update time) so an agent can confirm a key exists
// without ever putting it in a transcript. `reveal=1` is an explicit opt-in
// *and* needs VENIRA_SECRET_ALLOW_REVEAL=1 on the host, so a compromised agent
// cannot exfiltrate keys from a normal install.
// ---------------------------------------------------------------------------

const MAX_REVEAL_VALUE_CHARS = 16 * 1024;
const githubDeviceFlow = new GithubDeviceFlow();

/**
 * Expiry arguments for `project_secret action=set`:
 * `expires_in_days` (1..3650) or `expires_at` (epoch ms / ISO-8601), not both.
 * Returns undefined when the caller did not set an expiry (keep the previous one).
 */
function parseExpiryArgs(args: Record<string, unknown>): number | null | undefined {
  const rawDays = args.expires_in_days;
  const rawAt = args.expires_at;
  if (rawDays !== undefined && rawAt !== undefined) {
    throw new Error("[invalid_request] Pass either expires_in_days or expires_at, not both.");
  }
  if (rawDays !== undefined) {
    const days = Number(rawDays);
    if (!Number.isFinite(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
      throw new Error(
        `[invalid_request] \`expires_in_days\` must be between 1 and ${MAX_EXPIRY_DAYS}. Hint: 90 for quarterly rotation.`,
      );
    }
    return Date.now() + Math.round(days * 24 * 60 * 60 * 1000);
  }
  if (rawAt === undefined || rawAt === null) return undefined;
  if (typeof rawAt === "number" && Number.isFinite(rawAt)) return rawAt;
  if (typeof rawAt === "string") {
    const parsed = Date.parse(rawAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(
    "[invalid_request] `expires_at` must be epoch milliseconds or ISO-8601 (e.g. \"2027-01-31T00:00:00Z\").",
  );
}

async function opSecret(args: Record<string, unknown>): Promise<RustResponse> {
  const action = String(args.action ?? "").trim().toLowerCase();
  const rawName = typeof args.name === "string" ? args.name.trim() : "";

  if (action === "list") {
    const secrets = listSecrets();
    return {
      status: "completed",
      result: {
        kind: "secret",
        data: {
          action: "list",
          count: secrets.length,
          secrets,
          store: process.env.VENIRA_DATA_DIR?.trim() ? "VENIRA_DATA_DIR" : "default_data_dir",
        },
      },
      ...(secrets.length === 0
        ? { hint: "No secrets stored. Hint: project_secret action=set name=GITHUB_TOKEN value=<token>." }
        : {}),
    };
  }

  if (!rawName) {
    throw new Error(
      "[invalid_request] `name` is required for this action. Hint: use an env-var style name, e.g. GITHUB_TOKEN.",
    );
  }
  const name = assertSecretName(rawName);

  switch (action) {
    case "get": {
      const meta = listSecrets().find((entry) => entry.name === name);
      if (!meta) {
        throw new Error(
          `[not_found] Secret "${name}" is not stored. Hint: run project_secret action=list to see available names.`,
        );
      }
      const reveal = args.reveal === true;
      const base = {
        action: "get",
        name: meta.name,
        length: meta.length,
        sha256_12: meta.sha256_12,
        fingerprint_scheme: meta.fingerprint_scheme,
        updated_at: meta.updated_at,
        expires_at: meta.expires_at,
        expired: meta.expired,
        days_left: meta.days_left,
        last_used_at: meta.last_used_at,
        use_count: meta.use_count,
        rotated_at: meta.rotated_at,
        revealed: false,
      };
      if (meta.expired) {
        return {
          status: "completed",
          result: { kind: "secret", data: base },
          hint:
            `"${name}" expired at ${meta.expires_at === null ? "unknown" : new Date(meta.expires_at).toISOString()} and will not be injected. ` +
            `Hint: rotate it with action=set name=${name} value=<new value> expires_in_days=<n>.`,
        };
      }
      if (!reveal) {
        return {
          status: "completed",
          result: { kind: "secret", data: base },
          hint:
            "Metadata only (the value stays out of the transcript). Hint: inject it with project_shell_run secret_env=[\"" +
            name +
            '"], or set VENIRA_SECRET_ALLOW_REVEAL=1 and pass reveal=1.',
        };
      }
      if (!envFlag("VENIRA_SECRET_ALLOW_REVEAL", false)) {
        throw new Error(
          "[reveal_denied] Plaintext reveal is disabled on this host. " +
            "Hint: inject the value via project_shell_run secret_env instead; set VENIRA_SECRET_ALLOW_REVEAL=1 only if the user explicitly wants the value printed.",
        );
      }
      const value = getSecretValueSync(name);
      if (value === undefined) {
        throw new Error(
          `[secret_store_locked] Secret "${name}" could not be decrypted. Hint: the key file may be missing; restore data/secrets.key or re-set the secret.`,
        );
      }
      return {
        status: "completed",
        result: {
          kind: "secret",
          data: {
            ...base,
            revealed: true,
            value: value.slice(0, MAX_REVEAL_VALUE_CHARS),
          },
        },
        hint: "Revealed because reveal=1 and VENIRA_SECRET_ALLOW_REVEAL=1. The value is now in this transcript.",
      };
    }

    case "set": {
      let value: string | undefined;
      if (typeof args.value === "string") {
        value = args.value;
      } else if (typeof args.value_env === "string" && args.value_env.trim()) {
        // Preferred path: take the value from the host env so it never appears
        // in the tool arguments (and therefore never in a transcript/log).
        const envName = args.value_env.trim();
        value = process.env[envName];
        if (value === undefined) {
          throw new Error(
            `[invalid_request] value_env "${envName}" is not set in the host environment. ` +
              `Hint: pass value=<secret> directly, or export ${envName} before starting the server.`,
          );
        }
      }
      if (value === undefined) {
        throw new Error(
          "[invalid_request] `value` is required. Hint: pass value=<secret>, or value_env=<HOST_ENV_VAR> to avoid writing it in the tool call.",
        );
      }
      const result = await setSecret(name, value, { expiresAt: parseExpiryArgs(args) });
      const expiryNote =
        result.expires_at === null
          ? ""
          : ` Expires ${new Date(result.expires_at).toISOString()} (${result.days_left} day(s)).`;
      return {
        status: "completed",
        result: {
          kind: "secret",
          data: { action: "set", ...result },
        },
        hint: result.created
          ? `Stored "${name}" (encrypted).${expiryNote} Hint: use project_shell_run secret_env=["${name}"] to inject it.`
          : `Rotated "${name}" (encrypted).${expiryNote} The previous value is overwritten and the use counter is reset.`,
      };
    }

    case "delete": {
      const result = await deleteSecret(name);
      return {
        status: "completed",
        result: { kind: "secret", data: { action: "delete", ...result } },
        ...(result.deleted ? {} : { hint: `"${name}" was not stored; nothing to delete.` }),
      };
    }

    default:
      throw new Error(
        `[invalid_request] Unknown secret action "${action}". Hint: use get | set | list | delete.`,
      );
  }
}

async function opGithubConnect(args: Record<string, unknown>): Promise<RustResponse> {
  const action = String(args.action ?? "").trim().toLowerCase();
  if (action === "start") {
    const data = await githubDeviceFlow.start(args.replace_existing === true);
    return {
      status: "completed",
      result: { kind: "github_connect", data },
      hint:
        `Open ${data.verification_uri}, sign in to GitHub, and enter code ${data.user_code}. ` +
        `After approving, call project_github_connect action=poll with pending_id; wait at least ${data.poll_interval_seconds}s between polls. ` +
        "Never ask the user to paste a token into chat.",
    };
  }
  if (action === "poll") {
    const pendingId = typeof args.pending_id === "string" ? args.pending_id.trim() : "";
    if (!pendingId) {
      throw new Error("[invalid_request] `pending_id` is required for action=poll.");
    }
    const data = await githubDeviceFlow.poll(pendingId);
    return {
      status: "completed",
      result: { kind: "github_connect", data },
      ...(data.status === "pending"
        ? { hint: `Authorization is not complete. Wait ${String(data.wait_seconds)}s, then poll again.` }
        : {}),
    };
  }
  throw new Error('[invalid_request] action must be "start" or "poll".');
}

async function opDependencyGraph(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const built = await buildDependencyGraph(args, root);
  return {
    status: "completed",
    result: { kind: "dependency_graph", data: built.data },
    ...(built.truncated ? { truncated: true } : {}),
    ...(built.hint ? { hint: built.hint } : {}),
  };
}

async function opChangeImpact(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const built = await buildChangeImpact(args, root);
  return {
    status: "completed",
    result: { kind: "change_impact", data: built.data },
    ...(built.truncated ? { truncated: true } : {}),
    ...(built.hint ? { hint: built.hint } : {}),
  };
}

type OperationHandler = (args: Record<string, unknown>, root: string, sessionId: string) => Promise<RustResponse>;

const operations: Record<string, OperationHandler> = {
  read_file: opReadFile,
  get_file_info: opGetFileInfo,
  list_files: opListFiles,
  search: opSearch,
  write_file: opWriteFile,
  edit_file: opEditFile,
  create_directory: opCreateDirectory,
  delete_path: opDeletePath,
  recent_files: async (args: Record<string, unknown>) => opRecentFiles(args),
  snapshot_create: opSnapshotCreate,
  snapshot_list: (args: Record<string, unknown>) => opSnapshotList(args),
  snapshot_restore: opSnapshotRestore,
  snapshot_delete: opSnapshotDelete,
  // Git provider / CI provider / secrets
  pr_create: opPrCreate,
  pr_comment: opPrComment,
  pr_merge: opPrMerge,
  pr_list: opPrList,
  pr_close: opPrClose,
  pr_reopen: opPrReopen,
  ci_status: opCiStatus,
  ci_trigger: opCiTrigger,
  ci_logs: opCiLogs,
  ci_wait: opCiWait,
  dependency_graph: opDependencyGraph,
  change_impact: opChangeImpact,
  secret: opSecret,
  github_connect: opGithubConnect,
};

/**
 * A short, secret-free description of an outbound/secret operation for the
 * audit `command` column. Names and ids only — never tokens or message bodies.
 */
function describeExternalOp(operation: string, args: Record<string, unknown>): string | undefined {
  const repo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : "(resolved)";
  const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string).slice(0, 80) : "");
  let summary: string;
  switch (operation) {
    case "pr_create":
      summary = `POST /pulls repo=${repo} head=${str("head") || "(current)"} base=${str("base") || "(default)"} title="${str("title")}"`;
      break;
    case "pr_comment": {
      const inline =
        typeof args.path === "string" && args.path
          ? ` inline path=${str("path")} line=${String(args.line ?? "?")}`
          : " (general)";
      summary = `POST /issues/${String(args.pr ?? "?")}/comments repo=${repo}${inline}`;
      break;
    }
    case "pr_merge":
      summary = `PUT /pulls/${String(args.pr ?? "?")}/merge repo=${repo} method=${str("method") || "merge"} delete_branch=${args.delete_branch === true}`;
      break;
    case "pr_list":
      summary = `GET /pulls repo=${repo} state=${str("state") || "open"} head=${str("head") || "(any)"}`;
      break;
    case "pr_close":
      summary = `PATCH /pulls/${String(args.pr ?? "?")} repo=${repo} state=closed`;
      break;
    case "pr_reopen":
      summary = `PATCH /pulls/${String(args.pr ?? "?")} repo=${repo} state=open`;
      break;
    case "ci_status":
      summary =
        typeof args.ref === "string" || args.pr !== undefined
          ? `GET /commits/${str("ref") || `pr:${String(args.pr ?? "?")}`}/check-runs repo=${repo}`
          : `GET /actions/runs repo=${repo} run=${String(args.run_id ?? "(recent)")} branch=${str("branch") || "(any)"}`;
      break;
    case "ci_trigger":
      summary = `POST /actions/workflows/${str("workflow")}/dispatches repo=${repo} ref=${str("ref") || "(current)"}`;
      break;
    case "ci_logs":
      summary = `GET /actions/logs repo=${repo} run=${String(args.run_id ?? "-")} job=${String(args.job_id ?? "-")}`;
      break;
    case "ci_wait": {
      const selector =
        args.run_id !== undefined
          ? `run=${String(args.run_id)}`
          : args.ref !== undefined
            ? `ref=${str("ref")}`
            : args.pr !== undefined
              ? `pr=${String(args.pr)}`
              : `branch=${str("branch")}`;
      summary = `WAIT ci repo=${repo} ${selector} until=${str("until") || "terminal"} timeout=${String(args.timeout_ms ?? 45000)}`;
      break;
    }
    case "secret": {
      const action = String(args.action ?? "").toLowerCase();
      const name = typeof args.name === "string" ? args.name : "";
      summary = `secret_${action || "?"} name=${name}${args.reveal === true ? " reveal=1" : ""}`;
      break;
    }
    case "github_connect":
      summary = `github_device_${String(args.action ?? "?").toLowerCase()}`;
      break;
    default:
      return undefined;
  }
  return redactSecretValues(summary).slice(0, 400);
}


/** P2: opRecentFiles — index-backed recent files (falls back to Node-side bounded scan). */

/** P2: Remove a file from the recent-files index on delete. */
function removeFromRecentIndex(absPath: string, root: string): void {
  const db = ensureAuditDb();
  if (!db) return;
  const rel = path.relative(root, absPath).replace(/\\/g, "/");
  try {
    db.prepare("DELETE FROM project_file_index WHERE path = ?").run(rel);
  } catch (error) {
    console.error("[corehost] recent index delete failed: " + (error instanceof Error ? error.message : String(error)));
  }
}
async function opRecentFiles(args: Record<string, unknown>): Promise<RustResponse> {
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 10)));
  const includeDirs = args.include_ignored === true;

  // P2: Query the SQLite index first; if empty or unavailable, fall back to a bounded scan.
  const indexed = queryRecentFiles(limit, includeDirs);
  if (indexed.length > 0) {
    return {
      status: "completed",
      result: {
        kind: "recent_files",
        data: {
          source: "index",
          entries: indexed,
        },
      },
    };
  }

  // Node-side fallback: bounded filesystem scan (skip node_modules/target/.git)
  const SKIP_DIRS = new Set(["node_modules", "target", "build", "dist", ".git", ".venv", "venv", "__pycache__"]);
  const entries: Array<{ relative_path: string; mtime_ms: number; size: number; kind: string }> = [];

  async function walk(dir: string, rel: string): Promise<void> {
    let items: string[];
    try {
      items = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of items) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const relPath = rel ? path.posix.join(rel, name) : name;
      try {
        const s = await fs.stat(abs);
        if (s.isDirectory()) {
          await walk(abs, relPath);
        } else if (s.isFile()) {
          entries.push({
            relative_path: relPath,
            mtime_ms: s.mtimeMs,
            size: s.size,
            kind: "file",
          });
        }
      } catch {
        /* ignore */
      }
    }
  }

  await walk(WORKSPACE, "");
  entries.sort((a, b) => b.mtime_ms - a.mtime_ms);
  const result = entries.slice(0, limit);

  return {
    status: "completed",
    result: {
      kind: "recent_files",
      data: {
        source: "fallback_scan",
        entries: result,
      },
    },
  };
}



export class CoreHost {
  private started = false;

  snapshot(): HostSnapshot {
    return {
      running: true,
      pid: process.pid,
      pending_requests: 0,
      exe: null, // standalone — no external binary
      exe_error: null,
      started_at: this.started ? Date.now() : null,
      restarts: 0,
    };
  }

  async call<T = unknown>(method: string, params: unknown, _timeoutMs?: number): Promise<T> {
    this.started = true;
    const p = params as Record<string, any>;

    switch (method) {
      case "ping":
        return { ok: true, pong: true } as T;

      case "project_tool.scope.open": {
        const scope = openScope(
          p.session_id,
          p.project_id ?? null,
          p.permission_mode ?? "allow_all",
        );
        return { capability_id: scope.capability_id, project_id: scope.project_id } as T;
      }

      case "project_tool.scope.close": {
        closeScope(p.capability_id);
        return { closed: true } as T;
      }

      case "project_tool.shell.cancel_session": {
        for (const [, run] of shellRuns) {
          if (run.running) {
            killTree(run.process);
            run.cancelled = true;
            run.running = false;
            if (run.timer) {
              clearTimeout(run.timer);
              run.timer = null;
            }
          }
        }
        return { cancelled: true } as T;
      }

      case "project_tool.workspace.switch": {
        if (!dynamicWorkspaceEnabled() && !envFlag("VENIRA_UNRESTRICTED", false)) {
          throw new Error('[workspace_switch_denied] dynamic workspace disabled; set VENIRA_DYNAMIC_WORKSPACE=1 plus VENIRA_WORKSPACE_ROOTS.');
        }
        const target = String((p as any).root ?? (p as any).relative_path ?? (p as any).absolute_path ?? "");
        if (!target.trim()) throw new Error("[invalid_request] root/relative_path required.");
        const next = switchWorkspaceRoot(target);
        listFilesCache.clear();
        return { workspace_root: next, allowed_roots: allowedWorkspaceRoots() } as T;
      }

      case "project_tool.execute": {
        const operation = p.operation.name as string;
        const args = p.operation.arguments as Record<string, unknown>;
        const requestId = p.request_id as string;
        const sessionId = p.session_id as string;
        const capabilityId = p.capability_id as string;

        if (!isScopeValid(capabilityId)) {
          throw new Error("[capability_expired] Capability is expired or revoked. Hint: the scope re-opens automatically on the next call.");
        }

        const reasonText = sanitizeReason(
          redactSecretValues(redactSecrets(typeof p.reason === "string" ? p.reason : "")),
        );
        // Read-only observation windows are not audited: creating a row and then
        // deleting it would cut the hash chain (the next row's prev_hash would
        // point at a row that no longer exists).
        if (operation === "shell_status") {
          const response = await opShellStatus(args);
          return response as T;
        }
        const externalSummary = describeExternalOp(operation, args);
        const argsHash = crypto
          .createHash("sha256")
          .update(JSON.stringify(args, Object.keys(args).sort()))
          .digest("hex");
        const startedAt = auditStart(sessionId, p.project_id ?? "chat-terminal", operation, requestId, {
          reason: reasonText,
          args_hash: argsHash,
          ...(externalSummary ? { command: externalSummary } : {}),
        });

        if (operation === "shell_run") {
          const projectId = p.project_id ?? "chat-terminal";
          const commandText =
            typeof args.command === "string"
              ? redactSecretValues(redactSecrets(args.command)).slice(0, 4000)
              : null;
          try {
            const response = await opShellRun(args, WORKSPACE, sessionId);
            const data = response.result?.data as Record<string, any> | undefined;
            const approval = response.result?.kind === "shell_approval";
            const policy = (data?.policy ?? {}) as Record<string, any>;
            auditDecision(sessionId, requestId, {
              decision: approval ? "ask" : (policy.decision as string | undefined),
              policy_rule: approval ? (data?.rule as string | undefined) : (policy.rule as string | undefined),
              command: commandText ?? undefined,
              approver: approval ? "pending" : (policy.approver as string | undefined),
            });
            // `ask` did not execute anything: record why the call stopped.
            if (approval) {
              auditFinish(sessionId, projectId, operation, requestId, startedAt, "failed", "approval_required");
            } else {
              auditFinish(sessionId, projectId, operation, requestId, startedAt, "succeeded");
            }
            return response as T;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const codeMatch = /^\[([a-z0-9_]+)\]/i.exec(message);
            const reasonCode = codeMatch ? codeMatch[1] : "operation_failed";
            const ruleMatch =
              /Blocked by ([A-Za-z0-9_.]+)/.exec(message) ?? /\(rule: ([A-Za-z0-9_.]+)\)/.exec(message);
            auditDecision(sessionId, requestId, {
              decision:
                reasonCode === "command_denied"
                  ? "deny"
                  : reasonCode.startsWith("override_")
                    ? "deny"
                  : reasonCode === "approval_invalid" || reasonCode === "approval_required"
                    ? "ask"
                    : undefined,
              policy_rule: ruleMatch ? ruleMatch[1] : undefined,
              command: commandText ?? undefined,
            });
            auditFinish(sessionId, projectId, operation, requestId, startedAt, "failed", reasonCode);
            throw error;
          }
        }
        if (operation === "cancel") {
          const response = opShellCancel(args);
          auditFinish(sessionId, p.project_id ?? "chat-terminal", "cancel", requestId, startedAt, "succeeded");
          return response as T;
        }

        const handler = operations[operation];
        if (!handler) {
          auditFinish(sessionId, p.project_id ?? "chat-terminal", operation, requestId, startedAt, "failed", "unsupported");
          throw new Error(`[unsupported] Unknown operation: ${operation}`);
        }

        try {
          const response = await handler(args, WORKSPACE, sessionId);
          auditFinish(sessionId, p.project_id ?? "chat-terminal", operation, requestId, startedAt, "succeeded");
          return response as T;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const codeMatch = /^\[([a-z0-9_]+)\]/i.exec(message);
          const reasonCode = codeMatch ? codeMatch[1] : "operation_failed";
          auditFinish(sessionId, p.project_id ?? "chat-terminal", operation, requestId, startedAt, "failed", reasonCode);
          throw error;
        }
      }

      default:
        throw new Error(`[invalid_request] Unknown method: ${method}`);
    }
  }

  close(): void {
    for (const run of shellRuns.values()) {
      if (run.running) {
        killTree(run.process);
        run.cancelled = true;
        run.running = false;
        if (run.timer) {
          clearTimeout(run.timer);
          run.timer = null;
        }
      }
    }
    shellRuns.clear();
    for (const capId of openScopes.keys()) closeScope(capId);
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
}
