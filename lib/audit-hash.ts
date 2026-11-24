/**
 * Audit row hashing + tamper verification.
 *
 * The audit table is written and later *updated* (outcome/completed_at are
 * filled in when a call finishes), so a hash over every column would be
 * recomputed-correct only until the first update. The hash therefore covers
 * only the fields that are immutable after insert: who ran what, the request
 * id, the timestamp and the recorded "why"/args digest. Mutating those columns
 * later is exactly what tamper detection needs to catch.
 *
 * Rows are chained (`prev_hash` points at the previous `row_hash`). New hashes
 * are keyed with `audit.key` in the data dir:
 *
 *   h2:/s2:<digest>  ← current format (v3: includes parent_call_id)
 *   h1:<hmac-sha256(key, prev + "\x1f" + payload)>   ← v2: same, without parent_call_id
 *   s1:<sha256(prev + "\x1f" + payload)>             ← v2, key unavailable
 *   <64 hex chars>                                   ← pre-1.8.2 rows (legacy)
 *   <empty>                                          ← rows written before hashing existed (legacy)
 *
 * The version in the prefix is what keeps old rows verifiable: a row written
 * before `parent_call_id` existed is recomputed with the v2 payload (the field
 * simply is not part of it), a new row with the v3 payload. Without that, every
 * pre-migration row would suddenly report `hash_mismatch`.
 *
 * A keyed hash means someone who can edit `venira.db` (a backup, a sync tool,
 * a DBA, or the agent through SQL) but cannot read `audit.key` cannot rewrite
 * history without breaking verification. Legacy rows can only be checked for
 * chain continuity, which `verifyAuditRows()` reports separately instead of
 * pretending they are cryptographically verified.
 *
 * Rows with no hash at all that come *before* the first hashed row are the same
 * kind of legacy data (written before the chain existed) and are counted in
 * `legacy_rows`. An empty hash *after* the chain has started is still a failure
 * (`missing_hash`): that is what stripping a hash from a row looks like.
 */
import crypto from "node:crypto";
import path from "node:path";
import { readOrCreateHexKey } from "./keyfile.js";

export type AuditHashFields = {
  session_id: string;
  project_id: string;
  operation: string;
  request_id?: string | null;
  started_at: number;
  reason?: string | null;
  args_hash?: string | null;
  /** The `execute_js` call whose snippet ran this operation (Phase 4). */
  parent_call_id?: string | null;
};

/** Payload version: 2 = pre-`parent_call_id`, 3 = includes it. */
export type AuditHashVersion = 2 | 3;

const KEYED_PREFIX_V2 = "h1:";
const UNKEYED_PREFIX_V2 = "s1:";
const KEYED_PREFIX_V3 = "h2:";
const UNKEYED_PREFIX_V3 = "s2:";

/** New rows are hashed with the v3 payload (parent_call_id included). */
export const AUDIT_HASH_VERSION: AuditHashVersion = 3;

export function auditKeyPath(dataDir: string): string {
  return path.join(dataDir, "audit.key");
}

/** Canonical, order-independent-of-call-site payload for one row. */
export function auditPayload(row: AuditHashFields, version: AuditHashVersion = AUDIT_HASH_VERSION): string {
  const fields: unknown[] = [
    `venira-audit-v${version}`,
    row.session_id ?? "",
    row.project_id ?? "",
    row.operation ?? "",
    row.request_id ?? null,
    typeof row.started_at === "number" ? row.started_at : Number(row.started_at) || 0,
    row.reason ?? null,
    row.args_hash ?? null,
  ];
  // v3 appends the parent call: the field must not enter older payloads, or
  // every pre-migration row fails verification after an upgrade.
  if (version >= 3) fields.push(row.parent_call_id ?? null);
  return JSON.stringify(fields);
}

/** Which payload version a stored hash was written with (null = legacy row). */
export function auditHashVersion(hash: string): AuditHashVersion | null {
  if (hash.startsWith(KEYED_PREFIX_V3) || hash.startsWith(UNKEYED_PREFIX_V3)) return 3;
  if (hash.startsWith(KEYED_PREFIX_V2) || hash.startsWith(UNKEYED_PREFIX_V2)) return 2;
  return null;
}

/** True when the stored hash is keyed (HMAC), regardless of payload version. */
export function auditHashIsKeyed(hash: string): boolean {
  return hash.startsWith(KEYED_PREFIX_V3) || hash.startsWith(KEYED_PREFIX_V2);
}

/**
 * Compute the stored `row_hash`. `key === null` is a deliberate downgrade to an
 * unkeyed digest when the key file cannot be used; it is still better than no
 * chain at all and the prefix makes the weaker format visible.
 */
export function hashAuditRow(
  prevHash: string,
  row: AuditHashFields,
  key: Buffer | null,
  version: AuditHashVersion = AUDIT_HASH_VERSION,
): string {
  const input = `${prevHash}\u001f${auditPayload(row, version)}`;
  const keyedPrefix = version >= 3 ? KEYED_PREFIX_V3 : KEYED_PREFIX_V2;
  const unkeyedPrefix = version >= 3 ? UNKEYED_PREFIX_V3 : UNKEYED_PREFIX_V2;
  if (!key) return unkeyedPrefix + crypto.createHash("sha256").update(input).digest("hex");
  return keyedPrefix + crypto.createHmac("sha256", key).update(input).digest("hex");
}

export type AuditVerifyRow = AuditHashFields & {
  prev_hash?: string | null;
  row_hash?: string | null;
};

export type AuditVerifyResult = {
  ok: boolean;
  rows: number;
  verified_rows: number;
  legacy_rows: number;
  /** Rows chained onto an earlier (not the immediately preceding) known row: benign concurrent-writer forks. */
  forks?: number;
  reason?: "missing_hash" | "broken_link" | "hash_mismatch" | "key_unavailable";
  failed_row?: number;
};

/**
 * Verify continuity and, for keyed/unkeyed rows this version wrote, recompute
 * the digest. Legacy rows (no prefix) are counted, not recomputed: their hash
 * covered mutable columns and cannot be reproduced after `auditFinish()`.
 */
export function verifyAuditRows(rows: AuditVerifyRow[], key: Buffer | null): AuditVerifyResult {
  let prev = "";
  let started = false;
  let verifiedRows = 0;
  let legacyRows = 0;
  let forks = 0;
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const hash = row.row_hash ?? "";
    if (!hash) {
      if (started) {
        return { ok: false, rows: rows.length, verified_rows: verifiedRows, legacy_rows: legacyRows, reason: "missing_hash", failed_row: index };
      }
      legacyRows++; // pre-chain row: nothing to verify, nothing to link
      continue;
    }
    const prevHash = row.prev_hash ?? "";
    if (started && prevHash !== prev) {
      // Several MCP server processes share one audit DB. Before the writer
      // serialized hash lookup + insert (BEGIN IMMEDIATE), two of them could
      // chain onto the same tip. That fork is still authenticated (prev_hash is
      // inside the HMAC) so it is counted, not failed. A prev_hash that points
      // at no known row is what a deleted row looks like: that stays an error.
      if (seen.has(prevHash)) {
        forks++;
      } else {
        return { ok: false, rows: rows.length, verified_rows: verifiedRows, legacy_rows: legacyRows, forks, reason: "broken_link", failed_row: index };
      }
    }
    started = true;
    const version = auditHashVersion(hash);
    if (version !== null) {
      const keyed = auditHashIsKeyed(hash);
      if (keyed && !key) {
        return { ok: false, rows: rows.length, verified_rows: verifiedRows, legacy_rows: legacyRows, reason: "key_unavailable", failed_row: index };
      }
      const expected = hashAuditRow(prevHash, row, keyed ? key : null, version);
      const a = Buffer.from(expected);
      const b = Buffer.from(hash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, rows: rows.length, verified_rows: verifiedRows, legacy_rows: legacyRows, reason: "hash_mismatch", failed_row: index };
      }
      verifiedRows++;
    } else {
      legacyRows++;
    }
    prev = hash;
    seen.add(hash);
  }
  return { ok: true, rows: rows.length, verified_rows: verifiedRows, legacy_rows: legacyRows, forks };
}

/** Load the audit key, creating it on first use; null means "unkeyed fallback". */
export function loadAuditKey(dataDir: string): Buffer | null {
  try {
    return readOrCreateHexKey(auditKeyPath(dataDir), "audit");
  } catch (error) {
    console.error(
      `[venira-audit] ${error instanceof Error ? error.message : String(error)} ` +
        "Audit rows will use the weaker unkeyed digest until this is fixed.",
    );
    return null;
  }
}
