import assert from "node:assert/strict";
import crypto from "node:crypto";
import { hashAuditRow, verifyAuditRows, type AuditHashVersion, type AuditVerifyRow } from "../lib/audit-hash.js";

const key = crypto.randomBytes(32);

function makeRow(i: number): AuditVerifyRow {
  return {
    session_id: `s-${i % 3}`,
    project_id: "p",
    operation: i % 2 ? "read_file" : "shell_run",
    request_id: `req-${i}`,
    started_at: 1_000 + i,
    reason: null,
    args_hash: null,
    parent_call_id: null,
    prev_hash: null,
    row_hash: null,
  };
}

/** Linear keyed chain of `n` rows, optionally preceded by `legacy` rows that never had a hash. */
function buildChain(n: number, legacy = 0, version: AuditHashVersion = 3): AuditVerifyRow[] {
  const rows: AuditVerifyRow[] = [];
  for (let i = 0; i < legacy; i++) rows.push(makeRow(i));
  let prev = "";
  for (let i = 0; i < n; i++) {
    const row = makeRow(legacy + i);
    row.prev_hash = prev || null;
    row.row_hash = hashAuditRow(prev, row, key, version);
    prev = row.row_hash;
    rows.push(row);
  }
  return rows;
}

/** Append rows onto an existing chain (so v2 and v3 rows can be mixed). */
function extendChain(
  base: AuditVerifyRow[],
  count: number,
  version: AuditHashVersion,
  parentCallId?: string,
): AuditVerifyRow[] {
  const rows = [...base];
  let prev = (rows[rows.length - 1]?.row_hash as string | null | undefined) ?? "";
  for (let i = 0; i < count; i++) {
    const row = makeRow(1000 + rows.length + i);
    row.prev_hash = prev || null;
    if (parentCallId) row.parent_call_id = parentCallId;
    row.row_hash = hashAuditRow(prev, row, key, version);
    prev = row.row_hash;
    rows.push(row);
  }
  return rows;
}

const clone = (rows: AuditVerifyRow[]) => rows.map((r) => ({ ...r }));

// 1. A clean chain verifies.
{
  const result = verifyAuditRows(buildChain(20), key);
  assert.equal(result.ok, true);
  assert.equal(result.verified_rows, 20);
  assert.equal(result.legacy_rows, 0);
  assert.equal(result.forks, 0);
}

// 2. Rows written before hashing existed (no row_hash at all) are legacy, not a failure.
{
  const result = verifyAuditRows(buildChain(20, 7), key);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.legacy_rows, 7);
  assert.equal(result.verified_rows, 20);
}

// 3. Stripping the hash from a row AFTER the chain started is still detected.
{
  const rows = buildChain(20, 7);
  rows[7 + 5].row_hash = null;
  const result = verifyAuditRows(rows, key);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_hash");
  assert.equal(result.failed_row, 7 + 5);
}

// 4. Editing an authenticated column is detected.
{
  const rows = buildChain(20);
  rows[10].operation = "write_file";
  const result = verifyAuditRows(rows, key);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "hash_mismatch");
  assert.equal(result.failed_row, 10);
}

// 5. Concurrent writers that chained onto the same tip form a benign fork: counted, not failed.
{
  const base = buildChain(10);
  const tip = base[base.length - 1].row_hash as string;
  // Two sibling processes both read `tip`; the second one's row lands after the first.
  const a = makeRow(100);
  a.prev_hash = tip;
  a.row_hash = hashAuditRow(tip, a, key);
  const b = makeRow(101);
  b.prev_hash = tip;
  b.row_hash = hashAuditRow(tip, b, key);
  // The next row chains onto a (the writer that saw `a` last), not the physically previous row.
  const c = makeRow(102);
  c.prev_hash = a.row_hash;
  c.row_hash = hashAuditRow(a.row_hash as string, c, key);
  const result = verifyAuditRows([...base, a, b, c], key);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.forks, 2);
  assert.equal(result.verified_rows, 13);
}

// 6. A deleted row leaves its successor pointing at a hash nobody knows: still an error.
{
  const rows = buildChain(20);
  rows.splice(8, 1);
  const result = verifyAuditRows(rows, key);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "broken_link");
  assert.equal(result.failed_row, 8);
}

// 7. A keyed chain cannot be verified without the key.
{
  const result = verifyAuditRows(buildChain(5), null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "key_unavailable");
}

// 8. Verification does not mutate its input.
{
  const rows = buildChain(5, 2);
  const before = JSON.stringify(rows);
  verifyAuditRows(clone(rows), key);
  assert.equal(JSON.stringify(rows), before);
}

// 9. Phase 4: a v2 chain and a v3 chain can live in one DB. Rows written before
// `parent_call_id` existed must keep verifying after the upgrade.
{
  const v2 = buildChain(5, 0, 2);
  const mixed = extendChain(v2, 5, 3, "exec-req-1");
  const result = verifyAuditRows(mixed, key);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verified_rows, 10);
  assert.equal(result.legacy_rows, 0);
  // The stored prefixes say which payload each row used.
  assert.ok(String(v2[0].row_hash).startsWith("h1:"), `v2 row prefix: ${v2[0].row_hash}`);
  assert.ok(String(mixed[7].row_hash).startsWith("h2:"), `v3 row prefix: ${mixed[7].row_hash}`);
  assert.equal(mixed[7].parent_call_id, "exec-req-1");
}

// 10. The parent call id is authenticated: blanking it on a v3 row breaks the chain.
{
  const rows = extendChain(buildChain(3, 0, 2), 3, 3, "exec-req-2");
  rows[4].parent_call_id = "some-other-call";
  const result = verifyAuditRows(rows, key);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, "hash_mismatch");
  assert.equal(result.failed_row, 4);
}

// 11. Re-hashing a v2 row with the v3 payload (the naive migration) is what would
// break old rows; the versioned prefix is why that does not happen. The forged
// row itself still matches its stored hash, so the NEXT row's link is what fails.
{
  const v2 = buildChain(4, 0, 2);
  const naive = clone(v2);
  naive[1].row_hash = hashAuditRow(naive[0].row_hash as string, naive[1], key, 3);
  const result = verifyAuditRows(naive, key);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, "broken_link");
  assert.equal(result.failed_row, 2);
}

console.log("audit-verify regression tests passed");
