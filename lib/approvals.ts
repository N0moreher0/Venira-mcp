import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { activeDataDir } from "./workspace.js";
import { readOrCreateHexKey, writeFileAtomicSync } from "./keyfile.js";

/**
 * Human-in-the-loop approvals for `ask`-tier shell commands.
 *
 * Flow: the server stores a pending record (bound to the exact command, shell,
 * cwd, secret_env and rule) and returns its approval_id. A human grants it with
 * `npx venira-mcp --approve <id>` in a real terminal. The grant file carries an
 * HMAC over (id, session, binding, scope, timestamp) keyed by a secret that
 * lives in the data dir, and the server recomputes that HMAC from the *current*
 * call when the id is redeemed. So a grant cannot be forged without the key,
 * cannot be replayed for a different command, and its scope (once / session) is
 * decided by the human at approval time, never by the model.
 *
 * Note: this is a guard rail, not a sandbox. An agent that can run arbitrary
 * code as the same OS user can still read the key; use a container or a
 * separate OS account when that matters.
 */

export type ApprovalScope = "once" | "session";

/** Rules whose session-wide approval is acceptable (override: VENIRA_SESSION_GRANT_RULES=a,b). */
const DEFAULT_SESSION_RULES = ["cd_outside_workspace"];

function normalizeRule(rule: string): string {
  return rule.trim().replace(/^(ask|deny)\./, "");
}

export function sessionScopeAllowed(rule: string): boolean {
  const extra = (process.env.VENIRA_SESSION_GRANT_RULES ?? "")
    .split(",")
    .map((r) => normalizeRule(r))
    .filter(Boolean);
  const allowed = new Set([...DEFAULT_SESSION_RULES, ...extra]);
  return allowed.has(normalizeRule(rule));
}

function dataDir(): string {
  return activeDataDir();
}

function approvalsDir(): string {
  const d = path.join(dataDir(), "approvals");
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function sharedSecret(): Buffer {
  const f = path.join(dataDir(), "approval.key");
  // 32-byte key stored as hex. Creation is atomic and the length is validated
  // on every read: a truncated/empty key would still be a usable HMAC key, so
  // silently accepting it would weaken every grant to "forgeable".
  return readOrCreateHexKey(f, "approval");
}

function pendingPath(id: string): string {
  return path.join(approvalsDir(), `${safeId(id)}.json`);
}
function grantPath(id: string): string {
  return path.join(approvalsDir(), `${safeId(id)}.granted`);
}

/** approval_ids are UUIDs we generated; refuse anything that could escape the dir. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error("invalid approval_id");
  return id;
}

export interface ApprovalBinding {
  command: string;
  shell: string;
  cwd: string;
  secret_env: string[];
  rule: string;
}

/** Stable hash of everything an approval is supposed to cover. */
export function bindingHash(b: ApprovalBinding): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([b.command, b.shell, b.cwd, [...b.secret_env].sort(), b.rule]))
    .digest("hex");
}

export interface PendingApproval {
  approval_id: string;
  session_id: string;
  command: string;
  shell: string;
  cwd: string;
  secret_env: string[];
  rule: string;
  reason: string;
  /** bindingHash() of the real (unredacted) call this approval covers. */
  binding?: string;
  expires_at: number;
  status: "pending" | "granted" | "consumed" | "denied" | "expired";
  approver?: string;
  scope?: ApprovalScope;
  created_at: number;
  /** HMAC over the immutable fields (see pendingMac). */
  mac?: string;
}

/**
 * The pending record is the human's view of what they are approving. Sign the
 * fields that decide the grant so a writer who can reach the approvals dir (but
 * not the key) cannot swap the command before the human says yes.
 */
function pendingMac(p: PendingApproval): string {
  return crypto
    .createHmac("sha256", sharedSecret())
    .update(
      JSON.stringify([
        "pending-v1",
        p.approval_id,
        p.session_id,
        p.binding ?? "",
        p.rule,
        p.created_at,
        p.expires_at,
      ]),
    )
    .digest("hex");
}

function macMatches(expectedHex: string, actualHex: string): boolean {
  const a = Buffer.from(expectedHex);
  const b = Buffer.from(actualHex);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createPendingApproval(p: PendingApproval): void {
  const record: PendingApproval = { ...p, mac: pendingMac(p) };
  writeFileAtomicSync(pendingPath(p.approval_id), JSON.stringify(record, null, 2));
}

export function readPendingApproval(id: string): PendingApproval | null {
  try {
    const raw = readFileSync(pendingPath(id), "utf8");
    const p = JSON.parse(raw) as PendingApproval;
    if (!p.mac || !macMatches(pendingMac(p), p.mac)) return null;
    if (p.expires_at <= Date.now()) {
      p.status = "expired";
    }
    return p;
  } catch {
    return null;
  }
}

function grantMac(id: string, sessionId: string, binding: string, scope: ApprovalScope, ts: number): string {
  return crypto
    .createHmac("sha256", sharedSecret())
    .update(`v2|${id}|${sessionId}|${binding}|${scope}|${ts}`)
    .digest("hex");
}

export function writeApprovalGrant(id: string, approver = "cli", scope: ApprovalScope = "once"): void {
  const p = readPendingApproval(id);
  if (!p) throw new Error(`unknown approval_id ${id}`);
  if (p.expires_at <= Date.now()) throw new Error(`approval ${id} expired`);
  if (p.status === "consumed") throw new Error(`approval ${id} was already used`);
  if (!p.binding) throw new Error(`approval ${id} has no binding and cannot be granted`);
  if (scope === "session" && !sessionScopeAllowed(p.rule)) {
    throw new Error(
      `session scope is not allowed for rule ${p.rule}; approve it once instead ` +
        `(or opt in with VENIRA_SESSION_GRANT_RULES).`,
    );
  }
  const ts = Date.now();
  const mac = grantMac(p.approval_id, p.session_id, p.binding, scope, ts);
  writeFileAtomicSync(grantPath(id), `${ts}\n${approver}\n${scope}\n${mac}`);
  p.status = "granted";
  p.approver = approver;
  p.scope = scope;
  writeFileAtomicSync(pendingPath(id), JSON.stringify(p, null, 2));
}

/**
 * `binding` must be the bindingHash() of the call that is redeeming the id; the
 * grant only verifies if its HMAC was computed over that exact binding.
 */
export function verifyApprovalGrant(
  id: string,
  sessionId: string,
  binding: string,
): { ok: boolean; reason?: string; scope?: ApprovalScope } {
  let p: PendingApproval | null;
  try {
    p = readPendingApproval(id);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!p) return { ok: false, reason: "not_found" };
  if (p.session_id !== sessionId) return { ok: false, reason: "session_mismatch" };
  if (p.expires_at <= Date.now()) return { ok: false, reason: "expired" };
  if (p.status === "consumed") return { ok: false, reason: "already_used" };
  if (p.status === "denied") return { ok: false, reason: "denied" };
  if (p.binding && p.binding !== binding) return { ok: false, reason: "binding_mismatch" };
  let granted: string;
  try {
    granted = readFileSync(grantPath(id), "utf8");
  } catch {
    return { ok: false, reason: "not_granted" };
  }
  const lines = granted.split("\n");
  if (lines.length !== 4) return { ok: false, reason: "malformed_grant" };
  const ts = Number(lines[0]);
  const scope = lines[2] as ApprovalScope;
  if (scope !== "once" && scope !== "session") return { ok: false, reason: "malformed_grant" };
  if (!Number.isFinite(ts) || ts > Date.now() || ts < p.created_at) return { ok: false, reason: "bad_timestamp" };
  const expected = Buffer.from(grantMac(id, sessionId, binding, scope, ts));
  const actual = Buffer.from(lines[3]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, scope };
}

export function consumeApproval(id: string): void {
  const p = readPendingApproval(id);
  if (!p) return;
  p.status = "consumed";
  try { writeFileAtomicSync(pendingPath(id), JSON.stringify(p, null, 2)); } catch { /* ignore */ }
  try { unlinkSync(grantPath(id)); } catch { /* ignore */ }
}

export function cleanupExpired(): void {
  try {
    for (const f of readdirSync(approvalsDir())) {
      if (f.endsWith(".json")) {
        const id = f.replace(/\.json$/, "");
        const p = readPendingApproval(id);
        if (p && p.expires_at <= Date.now()) {
          try { unlinkSync(pendingPath(id)); } catch {}
          try { unlinkSync(grantPath(id)); } catch {}
        }
      }
    }
  } catch { /* ignore */ }
}
