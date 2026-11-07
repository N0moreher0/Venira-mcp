import assert from "node:assert/strict";
import crypto from "node:crypto";
import { hashAuditRow, verifyAuditRows, type AuditVerifyRow } from "../lib/audit-hash.js";

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
    prev_hash: null,
    row_hash: null,
  };
}

/** Linear keyed chain of `n` rows, optionally preceded by `legacy` rows that never had a hash. */
function buildChain(n: number, legacy = 0): AuditVerifyRow[] {
  const rows: AuditVerifyRow[] = [];
  for (let i = 0; i < legacy; i++) rows.push(makeRow(i));
  let prev = "";
  for (let i = 0; i < n; i++) {
    const row = makeRow(legacy + i);
    row.prev_hash = prev || null;
    row.row_hash = hashAuditRow(prev, row, key);
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

console.log("audit-verify regression tests passed");
