/**
 * JS SDK integration through the REAL wiring (ROADMAP_MINIMAL_MODE.md, Phase 3
 * done-for-real check): registerProjectTools on a fake MCP server captures the
 * `execute_js` handler; its sdkDispatch goes through runOne -> executeCached ->
 * CoreHost (policy + cache + audit SQLite), i.e. exactly what the running
 * server does.
 *
 * Pins:
 *   1. One execute_js turn: snapshot('create') -> search -> read -> edit ->
 *      re-read, five REAL tools through the dispatcher, in order.
 *   2. Policy: reading outside the workspace comes back as an ok:false
 *      path_escape envelope (a value, the batch keeps going).
 *   3. Policy: a hard-denied shell command stops the snippet with
 *      command_denied (VeniraPolicyError), and the rule id is visible.
 *   4. shell + shellStatus: an ask-rule command mid-chain (`node -e`) halts
 *      with VeniraPolicyError / approval_required and carries data.approval
 *      (approval_id + approve_command); a background run started by
 *      venira.shell answers with run_id + kill_key, a WRONG kill_key is
 *      refused, the right one is accepted, and the run is stopped.
 *
 *   5. audit tree: every op a snippet runs carries the `execute_js` request id
 *      as `parent_call_id`, and `read_audit { parent_call_id }` returns exactly
 *      that script's ops (Phase 4 command tree).
 *
 * Run with: npm run test:sdk-integration
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel: string) => import(pathToFileURL(path.join(repoRoot, rel)).href);

const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "venira-sdk-int-"));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "venira-sdk-int-data-"));
process.env.VENIRA_WORKSPACE = tmpWorkspace;
process.env.VENIRA_DATA_DIR = tmpData;
process.env.VENIRA_JS_EXEC_MODE = "auto"; // no approval prompt inside the test
process.env.VENIRA_OUTPUT_MODE = "full";

// A long-running but policy-clean run is not needed to pin the plumbing: the
// policy-clean commands (`npm --version`, `git status`) finish fast, and the
// interesting commands (`node -e`, `ping`) are ask-rules. Live process killing
// is pinned in test-sdk-bridge; here the REAL corehost registry is exercised.
fs.writeFileSync(path.join(tmpWorkspace, "seed.txt"), "hello world\n");

const project = (await load("tools/project.ts")) as typeof import("../tools/project.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
let executeJsHandler: Handler | undefined;
let readAuditHandler: Handler | undefined;
const fakeServer = {
  registerTool: (name: string, _cfg: unknown, handler?: Handler) => {
    if (name === "execute_js") executeJsHandler = handler;
    if (name === "read_audit") readAuditHandler = handler;
  },
  // The real McpServer always exposes `.server`; shell_run asks it whether the
  // client can elicit approvals. No `elicitation` capability => the CLI
  // approval flow, which is exactly what a non-eliciting client gets.
  server: {
    getClientCapabilities: () => ({}),
    elicitInput: async () => ({ action: "decline" }),
  },
} as never;

project.registerProjectTools(fakeServer);
assert.ok(executeJsHandler, "registerProjectTools must register execute_js (VENIRA_JS_EXEC_MODE=auto)");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}: ${(error as Error).message}`);
  }
};

const run = async (
  code: string,
  timeoutS = 90,
): Promise<{ envelope: Record<string, unknown>; stdout: string; stderr: string }> => {
  const result = await executeJsHandler!({ code, timeout_s: timeoutS });
  const envelope = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  if (result.isError) throw new Error(`execute_js failed: ${JSON.stringify(envelope).slice(0, 400)}`);
  const data = envelope.data as { stdout_tail?: string; stderr_tail?: string } | undefined;
  if (envelope.ok !== true) throw new Error(`snippet failed: ${JSON.stringify(envelope).slice(0, 400)}`);
  return { envelope, stdout: data?.stdout_tail ?? "", stderr: data?.stderr_tail ?? "" };
};

await check("integration: snapshot -> search -> read -> edit -> re-read in ONE execute_js", async () => {
  const { stdout } = await run(`
const snap = await venira.snapshot("create", { label: "sdk-integration" });
const hits = await venira.search("hello world", {});
const before = await venira.read("seed.txt");
const edit = await venira.edit({ relative_path: "seed.txt", old_text: "hello world", new_text: "grown world" }, "sdk integration edit");
const after = await venira.read("seed.txt");
console.log("STATS:" + [snap.ok, hits.ok, before.ok, edit.ok, after.ok].join(","));
console.log("AFTER:" + JSON.stringify(after.data && (after.data.content ?? after.data.text ?? after.data)).slice(0, 120));
`);
  assert.ok(stdout.includes("STATS:true,true,true,true,true"), `chain results: ${stdout}`);
  assert.ok(stdout.includes("grown world"), `the re-read must show the edit: ${stdout}`);
});

await check("integration: path_escape comes back as an ok:false VALUE", async () => {
  const { stdout } = await run(`
const outside = await venira.read("../outside.txt");
const inside = await venira.read("seed.txt");
console.log("RES:" + outside.ok + "/" + inside.ok);
console.log("CODE:" + ((outside.error && outside.error.code) || "?"));
`);
  assert.ok(stdout.includes("RES:false/true"), `blocked but batch continued: ${stdout}`);
  assert.ok(stdout.includes("CODE:path_escape"), `the error code must be path_escape: ${stdout}`);
});

await check("integration: a hard-denied shell command halts with command_denied", async () => {
  const { stdout } = await run(`
try {
  await venira.shell("rm -rf /");
  console.log("NOT-DENIED");
} catch (e) {
  console.log("DENIED:" + e.name);
  console.log("MSG:" + String(e.message || e).slice(0, 160));
}
`);
  assert.ok(!stdout.includes("NOT-DENIED"), "rm -rf / must never run");
  assert.ok(stdout.includes("DENIED:"), `the snippet must stop with a policy error: ${stdout}`);
  assert.ok(stdout.includes("command_denied") || stdout.includes("deny"), `the denial must name the rule: ${stdout}`);
});

await check("integration: an ask-rule shell call halts with approval_required + approval payload", async () => {
  const { stdout } = await run(`
console.log("BEFORE");
try {
  await venira.shell("node -e setInterval");
  console.log("RAN");
} catch (e) {
  const env = e.envelope || {};
  const data = env.data || {};
  console.log("STOP:" + e.name);
  console.log("CODE:" + String((env.error && env.error.code) || "?"));
  console.log("PAYLOAD:" + String(data.approval_id ? "id" : "no-id") + "/" + String(data.approval && data.approval.approve_command ? "cmd" : "no-cmd"));
}
console.log("AFTER");
`);
  assert.ok(stdout.includes("BEFORE"), `the snippet starts: ${stdout}`);
  assert.ok(!stdout.includes("RAN"), `the ask-rule command must not run: ${stdout}`);
  assert.ok(stdout.includes("STOP:VeniraPolicyError"), `policy stop must throw: ${stdout}`);
  assert.ok(stdout.includes("CODE:approval_required"), `the code must survive the bridge: ${stdout}`);
  assert.ok(stdout.includes("PAYLOAD:id/cmd"), `data.approval must reach the snippet: ${stdout}`);
  assert.ok(stdout.includes("AFTER"), `the snippet's own try/catch continues: ${stdout}`);
});

await check("integration: venira.shell + shellStatus cancel (real runShell, kill_key)", async () => {
  const { stdout } = await run(`
const started = await venira.shell("npm --version");
const runId = started.data && started.data.run_id;
const killKey = started.data && started.data.kill_key;
console.log("STARTED:" + started.ok + "/" + String(runId) + "/" + String(killKey).slice(0, 6));
const bad = await venira.shellStatus(runId, { action: "cancel", killKey: "wrong-key" });
const badText = String((bad.error && (bad.error.message || bad.error.code)) || bad.error || "?");
console.log("BAD:" + bad.ok + "/" + badText.slice(0, 120));
const good = await venira.shellStatus(runId, { action: "cancel", killKey });
console.log("GOOD:" + good.ok + "/" + JSON.stringify(good.data));
const after = await venira.shellStatus(runId);
console.log("AFTER:" + String(after.data && after.data.running));
`);
  assert.ok(/STARTED:true\/[^/]+\/[^/]+/.test(stdout), `the run must answer with run_id + kill_key: ${stdout}`);
  assert.ok(stdout.includes("BAD:false/"), `a wrong kill_key must be refused: ${stdout}`);
  assert.ok(/kill_key/i.test(stdout), `the refusal must name kill_key: ${stdout}`);
  assert.ok(stdout.includes("GOOD:true/"), `the right kill_key must be accepted: ${stdout}`);
  assert.ok(stdout.includes('"accepted":true'), `cancel must be accepted: ${stdout}`);
  assert.ok(stdout.includes("AFTER:false"), `the cancelled run must be stopped: ${stdout}`);
});

await check("integration: sub-ops carry parent_call_id = the execute_js request id", async () => {
  assert.ok(readAuditHandler, "registerProjectTools must register read_audit");
  // A file no earlier check touched: cached reads answer without a new corehost
  // job, and this check is about the audit row.
  fs.writeFileSync(path.join(tmpWorkspace, "audit-seed.txt"), "grown audit\n");
  const scripted = await run(`
const a = await venira.read("audit-seed.txt");
const b = await venira.search("grown audit", {});
console.log("OPS:" + a.ok + "/" + b.ok);
`);
  const callId = scripted.envelope.request_id;
  assert.ok(typeof callId === "string" && callId.length > 0, `execute_js must report a request_id: ${JSON.stringify(scripted.envelope).slice(0, 300)}`);

  // Another snippet, so the filter has to actually discriminate.
  const other = await run(`await venira.read("audit-seed.txt");`);
  const otherId = other.envelope.request_id;
  assert.notEqual(otherId, callId, "each execute_js call must get its own request id");

  const result = await readAuditHandler!({ parent_call_id: callId, limit: 50 });
  const envelope = JSON.parse(result.content[0]?.text ?? "{}") as {
    ok?: boolean;
    data?: { rows?: Array<Record<string, unknown>>; count?: number };
  };
  assert.equal(envelope.ok, true, `read_audit must answer ok: ${JSON.stringify(envelope).slice(0, 400)}`);
  const rows = envelope.data?.rows ?? [];
  const ops = rows.map((r) => r.operation);
  assert.ok(ops.includes("read_file"), `the script's read_file must be listed: ${JSON.stringify(ops)}`);
  assert.ok(ops.includes("search"), `the script's search must be listed: ${JSON.stringify(ops)}`);
  assert.ok(
    rows.every((r) => r.parent_call_id === callId),
    `every returned row must belong to this call: ${JSON.stringify(rows.map((r) => r.parent_call_id))}`,
  );
  assert.ok(!rows.some((r) => r.parent_call_id === otherId), "rows from the other snippet must not leak in");

  // The chain still verifies with parent-attributed rows in it.
  const verified = await readAuditHandler!({ parent_call_id: callId, limit: 50, verify: true });
  const verifiedEnvelope = JSON.parse(verified.content[0]?.text ?? "{}") as {
    ok?: boolean;
    data?: { verified?: boolean };
  };
  assert.equal(verifiedEnvelope.ok, true, `verify must answer ok: ${JSON.stringify(verifiedEnvelope).slice(0, 400)}`);
  assert.equal(verifiedEnvelope.data?.verified, true, `the v3 chain must verify: ${JSON.stringify(verifiedEnvelope.data?.verified)}`);
});

try {
  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
} catch {
  // Windows keeps the audit DB (better-sqlite3) locked until the process
  // exits; a leftover temp dir is harmless, the check results are what matter.
}

if (failures > 0) {
  console.error(`[test-sdk-integration] ${failures} check(s) failed`);
  process.exit(1);
}
console.log("[test-sdk-integration] ok");
