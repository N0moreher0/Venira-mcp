/**
 * Roadmap item 15 (P1): the payload and the guidance must be usable.
 *
 *   1. A `not_found` about a secret or a pending device flow pointed every
 *      tool at list_files - a round trip that could not help.
 *   2. `health` in compact mode was sliced into `preview_text`, a JSON
 *      string cut mid-word: every section was unreachable.
 *   3. A read batch with one failed item came back as ok:false, so a client
 *      that maps ok:false to isError could hide the successful reads.
 *   4. Writing into a missing parent directory was an io_error ("file may be
 *      locked, retry once") that leaked the temporary file name.
 *   5. The approval command ran `npx --yes venira-mcp`, which downloads the
 *      latest published package instead of the running build.
 *   6. The shell output carried ANSI colour codes around the real message.
 *
 * Run with: npm run test-p1-recovery
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "venira-p1-recovery-"));
const output = (await import("../lib/output.js")) as typeof import("../lib/output.js");
const gate = (await import("../lib/approval-gate.js")) as typeof import("../lib/approval-gate.js");
const filewrite = (await import("../lib/corehost-filewrite.js")) as typeof import("../lib/corehost-filewrite.js");
const invocation = (await import("../lib/shell-invocation.js")) as typeof import("../lib/shell-invocation.js");

let checks = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  checks += 1;
  try {
    await fn();
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    console.log(`not ok ${checks} - ${name} (${error instanceof Error ? error.message : String(error)})`);
    failures.push(name);
  }
}

const envelopeOf = (result: unknown) => result as {
  ok: boolean;
  status: string;
  hint?: string;
  next_actions?: Array<{ tool: string; arguments: Record<string, unknown> }>;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
};

// ---------------------------------------------------------------------------
// 1. Tool-specific recovery
// ---------------------------------------------------------------------------
await check("a missing secret points at secret, not at the file tree", () => {
  const env = envelopeOf(
    output.errorEnvelope("secret", new Error("[not_found] No such secret: TOKEN"), { requestId: "r1" }),
  );
  assert.equal(env.ok, false);
  assert.match(env.hint ?? "", /secret action=list/);
  assert.equal(env.next_actions?.[0]?.tool, "secret");
  assert.deepEqual(env.next_actions?.[0]?.arguments, { action: "list" });
});

await check("a missing device flow points at github_connect action=start", () => {
  const env = envelopeOf(
    output.errorEnvelope("github_connect", new Error("[not_found] Unknown pending_id: abc"), { requestId: "r2" }),
  );
  assert.match(env.hint ?? "", /action=start/);
  assert.equal(env.next_actions?.[0]?.tool, "github_connect");
  assert.deepEqual(env.next_actions?.[0]?.arguments, { action: "start" });
});

await check("a missing file still points at the file tree", () => {
  const env = envelopeOf(
    output.errorEnvelope("read_file", new Error("[not_found] Path does not exist: x.txt"), { requestId: "r3" }),
  );
  assert.match(env.hint ?? "", /list_files/);
  assert.equal(env.next_actions?.[0]?.tool, "list_files");
});

await check("an explicit hint still wins over the tool-specific one", () => {
  const env = envelopeOf(
    output.errorEnvelope("secret", new Error("[not_found] No such secret: TOKEN"), {
      requestId: "r4",
      hint: "my own hint",
    }),
  );
  assert.equal(env.hint, "my own hint");
});

// ---------------------------------------------------------------------------
// 2. health in compact mode drops whole sections
// ---------------------------------------------------------------------------
await check("the compact health preview keeps whole sections and names the dropped ones", () => {
  const data = {
    notice: "n",
    server: { version: "1.0.0" },
    capability: { state: "open" },
    queue: { depth: 0 },
    shell: { tail_max: 2000 },
    environment: { issues: [] },
    snapshots: { checkpoints: 12, blobs: "x".repeat(5000) },
    secrets: { store: "x".repeat(5000) },
    metrics: { p50: 1, p95: 2 },
    audit: { total_rows: 10 },
  };
  const preview = output.previewData("health", data) as Record<string, unknown>;
  assert.ok(preview.server, "the server section survives");
  assert.equal(preview.snapshots, undefined, "the bulky sections are dropped, not sliced");
  assert.equal(preview.metrics, undefined);
  assert.deepEqual((preview.sections_dropped as string[]).sort(), [
    "audit",
    "metrics",
    "secrets",
    "snapshots",
  ]);
  assert.ok((preview.sections_available as string[]).includes("audit"));
});

// ---------------------------------------------------------------------------
// 3. A partial batch says so
// ---------------------------------------------------------------------------
await check("a batch with one failed item is marked partial and counts the successes", () => {
  const env = output.batchEnvelope(
    "r5",
    [
      { ok: true, data: { relative_path: "a.txt" } },
      { ok: false, error: { code: "not_found", message: "nope" } },
    ],
    12,
  ) as Record<string, unknown>;
  assert.equal(env.ok, false);
  assert.equal(env.status, "partial");
  assert.equal(env.partial, true);
  const data = env.data as Record<string, unknown>;
  assert.equal(data.failed_count, 1);
  assert.equal(data.succeeded_count, 1);
});

await check("a batch without failures has no partial marker", () => {
  const env = output.batchEnvelope("r6", [{ ok: true }], 3) as Record<string, unknown>;
  assert.equal(env.ok, true);
  assert.equal(env.partial, undefined);
});

// ---------------------------------------------------------------------------
// 4. Writing into a missing parent directory
// ---------------------------------------------------------------------------
await check("a missing parent directory is an invalid_request, not a transient error", async () => {
  const error = await filewrite
    .opWriteFile({ relative_path: "missing-dir/file.txt", content: "x" }, root)
    .then(
      () => null,
      (e: Error) => e,
    );
  assert.ok(error, "the write must be refused");
  assert.match(error?.message ?? "", /^\[invalid_request\]/);
  assert.match(error?.message ?? "", /create_dirs=1/);
  assert.equal((error?.message ?? "").includes(".venira-tmp"), false, "no temporary file name");
  assert.equal((error?.message ?? "").includes("may be locked"), false, "no transient-error hint");
});

await check("create_dirs=1 creates the parent directory", async () => {
  const data = (
    await filewrite.opWriteFile(
      { relative_path: "new-dir/file.txt", content: "x", create_dirs: true, mode: "create" },
      root,
    )
  ).result?.data as Record<string, unknown>;
  assert.equal(data.action, "created");
  assert.equal(fs.readFileSync(path.join(root, "new-dir", "file.txt"), "utf8"), "x");
});

// ---------------------------------------------------------------------------
// 5. The approval command runs the installed build
// ---------------------------------------------------------------------------
await check("the approval command does not download the latest package", () => {
  const command = gate.approveCommand("approval-id-123");
  assert.match(command, /--approve approval-id-123/);
  assert.equal(/venira-mcp@latest/.test(command), false, "never the floating latest");
  assert.equal(
    /npx(\.cmd)?\s+--yes\s+venira-mcp\s/.test(command),
    false,
    "the npx form must be pinned to a version",
  );
  if (/venira-mcp@/.test(command)) {
    assert.match(command, /venira-mcp@\d+\.\d+\.\d+/, "the fallback is version-pinned");
  }
  assert.equal(command.includes("\n"), false, "one copy-paste line");
});

// ---------------------------------------------------------------------------
// 6. ANSI colour codes are stripped from the shell output
// ---------------------------------------------------------------------------
await check("ANSI escape sequences are removed", () => {
  assert.equal(invocation.stripAnsi("\u001b[31;1mboom\u001b[0m"), "boom");
  assert.equal(invocation.stripAnsi("plain"), "plain");
});

if (failures.length > 0) {
  console.error(`\nP1 recovery tests FAILED (${failures.length}/${checks}):`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log(`\nP1 recovery tests passed (${checks} checks).`);
}
