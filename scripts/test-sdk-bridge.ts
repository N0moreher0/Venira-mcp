/**
 * JS SDK + internal dispatcher (ROADMAP_MINIMAL_MODE.md, Phase 0 + 2 + 3).
 *
 * Pins:
 *   1. ONE registry: SDK_FUNCTIONS (child runtime) === SDK_API_CORE (contract),
 *      the preamble stays one line, the contract/help render.
 *   2. The bridge runs end-to-end: a contained `execute_js` snippet calls
 *      `venira.*` over the IPC channel and the parent dispatcher answers with envelopes.
 *      Argument normalization per function (read opts merge, edit single vs
 *      array, shell batch, shellStatus cancel -> kill_key, git sub remap).
 *   3. Batch in one turn: a chained snippet produces one dispatch call per
 *      operation, in order, each answered separately (Phase 0: per-call
 *      results, not one merged envelope).
 *   4. Errors: `ok:false` envelopes come back as VALUES; policy stops
 *      (approval_required / command_denied) THROW and carry the envelope
 *      (data.approval with approval_id); unknown/blocked ops (execute_js,
 *      workspace_switch) throw `[invalid_request]`.
 *   5. The `.d.ts` contract is injected into the `execute_js` description ONLY
 *      in mode minimal; the other modes keep the TOOL_DOCS description.
 *
 * Run with: npm run test:sdk-bridge
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel: string) => import(pathToFileURL(path.join(repoRoot, rel)).href);

// A workspace of our own: lib/workspace.ts resolves WORKSPACE at import time.
const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "venira-sdk-bridge-"));
process.env.VENIRA_WORKSPACE = tmpWorkspace;
fs.writeFileSync(path.join(tmpWorkspace, "seed.txt"), "seed content\n");

const registry = (await load("lib/sdk-registry.ts")) as typeof import("../lib/sdk-registry.js");
const childRuntime = (await load("lib/sdk-child-runtime.ts")) as typeof import("../lib/sdk-child-runtime.js");
const bridgeMod = (await load("lib/sdk-bridge.ts")) as typeof import("../lib/sdk-bridge.js");
const executor = (await load("lib/js-executor.ts")) as typeof import("../lib/js-executor.js");
const output = (await load("lib/output.ts")) as typeof import("../lib/output.js");
const docs = (await load("tools/project-docs.ts")) as typeof import("../tools/project-docs.js");
const schemaMod = (await load("tools/project-schema.ts")) as typeof import("../tools/project-schema.js");

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

const withEnv = (env: Record<string, string | undefined>, fn: () => void): void => {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// ---- 1. one registry ----
await check("registry: SDK_FUNCTIONS matches SDK_API_CORE 1:1 (R5, no second copy)", () => {
  assert.deepEqual(
    [...childRuntime.SDK_FUNCTIONS],
    registry.SDK_API_CORE.map((e) => e.name),
  );
  assert.ok(!childRuntime.SDK_CHILD_PREAMBLE.includes("\n"), "the child preamble must stay ONE line");
});

await check("contract: the .d.ts block renders every core function + the example", () => {
  const dts = registry.sdkContractDts();
  assert.ok(dts.includes("declare const venira"), "the contract must declare the global");
  assert.ok(dts.includes("venira.snapshot"), "the example must show batching");
  for (const entry of registry.SDK_API_CORE) {
    assert.ok(dts.includes(` ${entry.name}(`), `contract must list ${entry.name}`);
  }
});

await check("help: topics render from the same registry", () => {
  const index = registry.sdkHelpText();
  assert.ok(index.includes('"ci"'), "the index must list topics");
  const ci = registry.sdkHelpText("ci");
  assert.ok(ci.includes("ci_status"), "help(ci) must list ci_status");
  assert.ok(registry.sdkHelpText("nope").includes("Unknown topic"));
});

// ---- 2-4. the bridge end-to-end ----
type Call = { op: string; args: Record<string, unknown> };
type Override = (op: string, args: Record<string, unknown>) => Record<string, unknown>;

type JsResult = Awaited<ReturnType<typeof executor.executeJs>>;

const stubDispatch =
  (calls: Call[], overrides?: Override) =>
  async (op: string, args: Record<string, unknown>) => {
    calls.push({ op, args });
    const envelope = overrides
      ? overrides(op, args)
      : { ok: true, status: "completed", request_id: "stub", kind: op, data: { echo: args } };
    return output.toolResult(envelope);
  };

const runSnippet = async (
  code: string,
  calls: Call[],
  overrides?: Override,
  options?: { timeout?: number },
): Promise<JsResult> => {
  const bridge = bridgeMod.createSdkBridge(stubDispatch(calls, overrides));
  try {
    return await executor.executeJs(code, {
      cwd: tmpWorkspace,
      timeout: options?.timeout ?? 20_000,
      bridge,
      contained: true,
    });
  } finally {
    bridge.close();
  }
};

const expectOk = (r: JsResult, label: string): void => {
  assert.equal(r.ok, true, `${label}: snippet failed (${r.error ?? r.stderr_tail.slice(0, 400)})`);
};

await check("bridge e2e: venira.read single file sends relative_path directly (cached path)", async () => {
  const calls: Call[] = [];
  const r = await runSnippet('const env = await venira.read("seed.txt"); console.log(env.kind);', calls);
  expectOk(r, "read");
  assert.equal(calls.length, 1, `one dispatch call, got ${calls.length}`);
  assert.equal(calls[0]?.op, "read_file");
  assert.equal(calls[0]?.args.relative_path, "seed.txt");
  assert.ok(r.stdout_tail.includes("read_file"));
});

await check("bridge e2e: read opts merge into a single call", async () => {
  const calls: Call[] = [];
  const r = await runSnippet('await venira.read("big.ts", { start_line: 5, end_line: 10 });', calls);
  expectOk(r, "read opts");
  assert.equal(calls[0]?.args.start_line, 5);
  assert.equal(calls[0]?.args.end_line, 10);
});

await check("bridge e2e: batch read keeps max_response_bytes_per_item top-level", async () => {
  const calls: Call[] = [];
  const r = await runSnippet(
    'const envs = await venira.read(["a.ts", "b.ts"], { max_response_bytes_per_item: 1024 }); console.log(envs.ok);',
    calls,
  );
  expectOk(r, "batch read");
  assert.equal(calls.length, 1, "three reads still cost ONE dispatch");
  assert.equal(calls[0]?.args.max_response_bytes_per_item, 1024);
  assert.equal(((calls[0]?.args.requests as unknown[]) ?? []).length, 2);
});

await check("bridge e2e: search accepts a string, an array, or an object", async () => {
  const calls: Call[] = [];
  const r = await runSnippet(
    'await venira.search("foo"); await venira.search(["foo", { pattern: "bar", weight: 2 }]);',
    calls,
  );
  expectOk(r, "search");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.args.query, "foo");
  assert.equal(((calls[1]?.args.queries as unknown[]) ?? []).length, 2);
});

await check("bridge e2e: edit single object vs array (multi-file atomic)", async () => {
  const calls: Call[] = [];
  const r = await runSnippet(
    'await venira.edit({ relative_path: "a.ts", old_text: "x", new_text: "y" }, "why");' +
      'await venira.edit([{ relative_path: "a.ts", old_text: "x", new_text: "y" }, { relative_path: "b.ts", old_text: "1", new_text: "2" }], "why2");',
    calls,
  );
  expectOk(r, "edit");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.args.relative_path, "a.ts");
  assert.equal(calls[0]?.args.reason, "why");
  assert.equal(((calls[1]?.args.edits as unknown[]) ?? []).length, 2);
});

await check("bridge e2e: write defaults to mode=overwrite and carries reason", async () => {
  const calls: Call[] = [];
  const r = await runSnippet('await venira.write("out.txt", "hello", "test write");', calls);
  expectOk(r, "write");
  assert.equal(calls[0]?.args.mode, "overwrite");
  assert.equal(calls[0]?.args.reason, "test write");
  assert.equal(calls[0]?.args.content, "hello");
});

await check("bridge e2e: shell batch answers one envelope per command, in order", async () => {
  const calls: Call[] = [];
  const r = await runSnippet(
    'const out = await venira.shell(["echo one", { command: "echo two" }]); console.log(JSON.stringify(out.length));',
    calls,
  );
  expectOk(r, "shell batch");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.op, "shell_run");
  assert.equal(calls[0]?.args.command, "echo one");
  assert.equal(calls[1]?.args.command, "echo two");
  assert.ok(r.stdout_tail.includes("2"));
});

await check("bridge e2e: shellStatus action=cancel maps to the cancel op + kill_key", async () => {
  const calls: Call[] = [];
  const r = await runSnippet(
    'await venira.shellStatus("run-1", { wait_seconds: 3 }); await venira.shellStatus("run-1", { action: "cancel", killKey: "key-9" });',
    calls,
  );
  expectOk(r, "shellStatus");
  assert.equal(calls[0]?.op, "shell_status");
  assert.equal(calls[0]?.args.wait_seconds, 3);
  assert.equal(calls[1]?.op, "cancel");
  assert.equal(calls[1]?.args.run_id, "run-1");
  assert.equal(calls[1]?.args.kill_key, "key-9");
});

await check("bridge e2e: cancel without killKey throws the expected signature", async () => {
  const r = await runSnippet(
    'try { await venira.shellStatus("run-1", { action: "cancel" }); } catch (e) { console.log("SIG:", e.message); }',
    [],
  );
  expectOk(r, "killKey guard");
  assert.ok(r.stdout_tail.includes("killKey"), "the error must name killKey");
});

await check("bridge e2e: snapshot + git sub-remap mirror the tool handlers", async () => {
  const calls: Call[] = [];
  const r = await runSnippet(
    'await venira.snapshot("create", { label: "L" }); await venira.git("branch", { sub: "create", name: "feat", reason: "r" });',
    calls,
  );
  expectOk(r, "snapshot/git");
  assert.equal(calls[0]?.op, "snapshot");
  assert.equal(calls[0]?.args.action, "create");
  assert.equal(calls[0]?.args.label, "L");
  assert.equal(calls[1]?.op, "git_branch");
  assert.equal(calls[1]?.args.action, "create");
  assert.equal(calls[1]?.args.name, "feat");
});

await check("bridge e2e: memory write refuses an empty note", async () => {
  const r = await runSnippet(
    'try { await venira.memory("write", "  "); } catch (e) { console.log("SIG:", e.message); }',
    [],
  );
  expectOk(r, "memory guard");
  assert.ok(r.stdout_tail.includes("venira.memory"));
});

await check("bridge e2e (Phase 0): a chained snippet dispatches per call, in order", async () => {
  const calls: Call[] = [];
  const r = await runSnippet(
    'const a = await venira.snapshot("create", { label: "before" });' +
      'const b = await venira.search("seed");' +
      'const c = await venira.read("seed.txt");' +
      'const d = await venira.edit({ relative_path: "seed.txt", old_text: "seed", new_text: "grown" }, "rename");' +
      'const e = await venira.recent(5);' +
      'console.log([a.ok, b.ok, c.ok, d.ok, e.ok].join(","));',
    calls,
  );
  expectOk(r, "chained");
  assert.deepEqual(
    calls.map((c) => c.op),
    ["snapshot", "search", "read_file", "edit_file", "recent_files"],
    "every operation must dispatch separately, in script order",
  );
  assert.ok(r.stdout_tail.includes("true,true,true,true,true"));
});

await check("bridge e2e: ok:false envelopes come back as values (batch keeps going)", async () => {
  const calls: Call[] = [];
  const overrides: Override = (op, args) => {
    if (op === "read_file" && (args.relative_path === "boom.txt" || (Array.isArray(args.requests) && (args.requests as Array<Record<string, unknown>>).some((r) => r.relative_path === "boom.txt")))) {
      return { ok: false, status: "error", kind: op, error: { code: "not_found", message: "[not_found] File does not exist: boom.txt" } };
    }
    return { ok: true, status: "completed", request_id: "stub", kind: op, data: { echo: args } };
  };
  const r = await runSnippet(
    'const bad = await venira.read("boom.txt"); const good = await venira.read("seed.txt");' +
      'console.log(bad.ok + "/" + good.ok);',
    calls,
    overrides,
  );
  expectOk(r, "ok:false value");
  assert.equal(calls.length, 2, "a failed item must not stop the batch");
  assert.ok(r.stdout_tail.includes("false/true"), `got ${r.stdout_tail.trim()}`);
});

await check("bridge e2e: approval_required THROWS and carries the approval payload", async () => {
  const overrides: Override = () => ({
    ok: false,
    status: "error",
    kind: "shell_run",
    error: { code: "approval_required", message: "[approval_required] shell needs a human (rule: ask.danger)" },
    data: { approval_required: true, approval_id: "ap-123", approval: { approval_id: "ap-123", approve_command: "venira approve ap-123" } },
  });
  const r = await runSnippet(
    'try { await venira.shell("git reset --hard"); } catch (e) { console.log("HALT:" + e.name + ":" + e.envelope.data.approval.approve_command); }',
    [],
    overrides,
  );
  expectOk(r, "approval throw");
  assert.ok(r.stdout_tail.includes("HALT:VeniraPolicyError:venira approve ap-123"), r.stdout_tail);
});

await check("bridge e2e: blocked ops (execute_js, workspace_switch) throw [invalid_request]", async () => {
  const r = await runSnippet(
    'for (const op of ["execute_js", "workspace_switch", "not_an_op"]) { try { await venira.raw(op, {}); console.log("NO GUARD"); } catch (e) { console.log("BLOCKED:" + e.name); } }',
    [],
  );
  expectOk(r, "blocked ops");
  assert.equal((r.stdout_tail.match(/BLOCKED:VeniraBridgeError/g) ?? []).length, 3, r.stdout_tail);
});

// ---- 5. description injection ----
type ToolCfg = { description?: string };
const captureExecuteJs = (mode: string): string => {
  let captured: ToolCfg | undefined;
  const fakeServer = {
    registerTool: (name: string, cfg: ToolCfg) => {
      if (name === "execute_js") captured = cfg;
    },
  } as never;
  const cfg = schemaMod.config(
    "Execute JS",
    { speed_profile: "test", batch_safe: false },
    { destructiveHint: true, openWorldHint: false },
  ) as ToolCfg;
  withEnv({ VENIRA_TOOL_MODE: mode }, () => {
    docs.applyToolDocs(fakeServer);
    (fakeServer as unknown as { registerTool: (n: string, c: ToolCfg) => void }).registerTool("execute_js", cfg);
  });
  return captured?.description ?? "";
};

await check("contract injection: minimal carries the SDK contract, other modes do not", () => {
  const minimal = captureExecuteJs("minimal");
  const deflt = captureExecuteJs("default");
  assert.ok(minimal.includes("declare const venira"), "minimal must ship the contract");
  assert.ok(minimal.includes("## JS SDK contract"), "the contract header must be present");
  assert.ok(!deflt.includes("declare const venira"), "default must keep the plain description");
  const expert = captureExecuteJs("expert");
  assert.ok(!expert.includes("declare const venira"), "expert must keep the plain description");
});

fs.rmSync(tmpWorkspace, { recursive: true, force: true });

if (failures > 0) {
  console.error(`[test-sdk-bridge] ${failures} check(s) failed`);
  process.exit(1);
}
console.log("[test-sdk-bridge] ok");
