import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "venira-audit-fallback-"));
process.env.VENIRA_DATA_DIR = dataDir;
process.env.VENIRA_AUDIT_STRICT = "0";

try {
  // Copy the built modules under the temp directory so createRequire cannot
  // discover this checkout's node_modules (which may contain SQLite).
  const isolatedDist = path.join(dataDir, "isolated-dist");
  await cp(path.resolve("dist"), isolatedDist, { recursive: true });
  const storeUrl = pathToFileURL(path.join(isolatedDist, "lib", "audit-store.js"));
  const store = await import(storeUrl.href);
  assert.equal(store.ensureAuditDb(), null, "clean install should not load the absent SQLite binding");

  const startedAt = store.auditStart("fallback-test", "test-project", "read_file", "fallback-request");
  assert.doesNotThrow(() => store.auditFinish("fallback-test", "test-project", "read_file", "fallback-request", startedAt, "succeeded"));

  process.env.VENIRA_AUDIT_STRICT = "1";
  assert.throws(
    () => store.auditStart("fallback-test", "test-project", "read_file", "strict-request"),
    /audit_unavailable.*VENIRA_AUDIT_STRICT=1/,
    "strict mode must fail closed when the audit store is unavailable",
  );
  console.log("Audit fallback smoke passed (best-effort mode continues; strict mode fails closed).");
} finally {
  process.env.VENIRA_AUDIT_STRICT = "0";
  await rm(dataDir, { recursive: true, force: true });
}
