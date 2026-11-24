/**
 * Mode `minimal` (ROADMAP_MINIMAL_MODE.md, phase 1): one door.
 *
 * Pins:
 *   1. `modeBlocksTool("minimal", ...)` is an allowlist: `execute_js` + `shell_status`
 *      survive, everything else stays out (the setup tools only with
 *      VENIRA_SETUP_TOOLS=1).
 *   2. The mode is read from `VENIRA_TOOL_MODE` AND from `venira.config.json`
 *      (env wins, an invalid env falls back to the config file).
 *   3. `shell_status` in minimal carries the merged cancel (`action` + `kill_key`)
 *      and routes `action="cancel"` to the `cancel` op; the other modes keep the
 *      plain schema and their own `shell_cancel` tool.
 *   4. The `execute_js` gate: in minimal the door must not disappear -- an operator
 *      who set nothing gets `semi-auto` (strict profile -> `ask`); an explicit
 *      `off` is respected.
 *
 * Run with: npm run test:minimal-mode
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel: string) => import(pathToFileURL(path.join(repoRoot, rel)).href);
/** A fresh module instance (query string busts the ESM cache) -- needed for import-time constants. */
let freshTag = 0;
const loadFresh = (rel: string) =>
  import(`${pathToFileURL(path.join(repoRoot, rel)).href}?fresh=${(freshTag += 1)}`);

// A workspace of our own, so `venira.config.json` can be read without touching the repo.
// Set BEFORE the first dynamic import: lib/workspace.ts resolves WORKSPACE at import time.
const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "venira-minimal-mode-"));
fs.writeFileSync(path.join(tmpWorkspace, "venira.config.json"), JSON.stringify({ toolMode: "core" }));
process.env.VENIRA_WORKSPACE = tmpWorkspace;

const toolMode = (await load("tools/project-tool-mode.ts")) as typeof import("../tools/project-tool-mode.js");
const modeNames = (await load("lib/tool-mode-names.ts")) as typeof import("../lib/tool-mode-names.js");
const shellTools = (await load("tools/project-register-shell.ts")) as typeof import("../tools/project-register-shell.js");

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

// ---- the mode list ----
await check("the canonical mode list carries minimal", () => {
  assert.deepEqual([...modeNames.TOOL_MODES].sort(), ["core", "default", "expert", "minimal"]);
  assert.equal(modeNames.isToolModeName("minimal"), true);
  assert.equal(modeNames.isToolModeName("nope"), false);
});

// ---- the allowlist ----
await check("minimal mode: keeps execute_js + shell_status and blocks every other tool", () => {
  assert.deepEqual([...toolMode.MINIMAL_TOOLS].sort(), ["execute_js", "shell_status"]);
  for (const name of ["execute_js", "shell_status"]) {
    assert.equal(toolMode.modeBlocksTool("minimal", name, false), false, `${name} must stay in minimal`);
  }
  for (const name of [
    "shell_run", "shell_cancel", "shell_cancel_session", "read_file", "write_file", "edit_file",
    "search", "list_files", "recent_files", "outline_symbol", "symbol_references", "snapshot",
    "git", "memory", "switch_workspace", "delete_path", "create", "move_path", "copy_path",
    "get_file_info", "apply_patch", "secret", "dependency_graph", "change_impact", "diff_files",
    "ci_status", "ci_wait", "pr_create", "health", "trace_status", "read_audit",
    "explain_error", "plan_read_batch",
  ]) {
    assert.equal(toolMode.modeBlocksTool("minimal", name, false), true, `${name} must stay out of minimal`);
  }
});

await check("minimal mode: setup tools join only with VENIRA_SETUP_TOOLS=1", () => {
  for (const name of toolMode.SETUP_TOOLS) {
    assert.equal(toolMode.modeBlocksTool("minimal", name, false), true, `${name} must stay out by default`);
    assert.equal(toolMode.modeBlocksTool("minimal", name, true), false, `${name} must join with setup tools on`);
  }
});

await check("minimal mode: the other modes are untouched", () => {
  for (const name of ["execute_js", "shell_status", "shell_run", "read_file", "git"]) {
    assert.equal(toolMode.modeBlocksTool("core", name, false), false, `core must keep ${name}`);
    assert.equal(toolMode.modeBlocksTool("default", name, false), false, `default must keep ${name}`);
    assert.equal(toolMode.modeBlocksTool("expert", name, false), false, `expert must keep ${name}`);
  }
  assert.equal(toolMode.modeBlocksTool("core", "secret", false), true, "core must not advertise secret");
  assert.equal(toolMode.modeBlocksTool("default", "ci_status", false), true, "default excludes CI/CD");
});

// ---- where the mode comes from ----
await check("getToolMode() reads minimal from the env and the config file (env wins)", () => {
  withEnv({ VENIRA_TOOL_MODE: undefined }, () => {
    // venira.config.json in the temp workspace says "core".
    assert.equal(toolMode.getToolMode(), "core", "config file supplies the mode");
  });
  withEnv({ VENIRA_TOOL_MODE: "minimal" }, () => {
    assert.equal(toolMode.getToolMode(), "minimal", "env wins over the config file");
  });
  withEnv({ VENIRA_TOOL_MODE: "not-a-mode" }, () => {
    assert.equal(toolMode.getToolMode(), "core", "an invalid env falls back to the config file");
  });
  withEnv({ VENIRA_TOOL_MODE: undefined }, () => {
    fs.writeFileSync(path.join(tmpWorkspace, "venira.config.json"), JSON.stringify({ toolMode: "minimal" }));
    assert.equal(toolMode.getToolMode(), "minimal", "the config file can select minimal too");
    fs.writeFileSync(path.join(tmpWorkspace, "venira.config.json"), JSON.stringify({ toolMode: "core" }));
  });
});

// ---- the merged shell_status ----
type Registered = { inputSchema?: Record<string, unknown>; handler?: (args: unknown) => unknown };
const registerShell = (mode: string): { tools: Map<string, Registered>; calls: { op: string; args: unknown }[] } => {
  const tools = new Map<string, Registered>();
  const calls: { op: string; args: unknown }[] = [];
  const runOne = async (op: string, args: unknown) => {
    calls.push({ op, args });
    return {} as never;
  };
  const fakeServer = {
    registerTool: (name: string, cfg: Record<string, unknown>, handler?: (args: unknown) => unknown) => {
      tools.set(name, { ...(cfg as Registered), handler });
    },
  } as never;
  withEnv({ VENIRA_TOOL_MODE: mode }, () => {
    shellTools.registerShellTools(fakeServer, {
      runOne,
      shellDeps: { execute: (async () => ({})) as never, callHost: (async () => ({})) as never } as never,
    });
  });
  return { tools, calls };
};

await check("minimal mode: shell_status carries the merged cancel (action + kill_key)", () => {
  const { tools } = registerShell("minimal");
  const status = tools.get("shell_status");
  assert.ok(status, "shell_status must be registered");
  const shape = status?.inputSchema ?? {};
  assert.ok("action" in shape, "shell_status must advertise action in minimal");
  assert.ok("kill_key" in shape, "shell_status must advertise kill_key in minimal");
  // The standalone cancel tool is still registered in code, but minimal blocks it.
  assert.equal(toolMode.modeBlocksTool("minimal", "shell_cancel", false), true);
});

await await check("minimal mode: action=cancel routes to the cancel op, otherwise to shell_status", () => {
  const { tools, calls } = registerShell("minimal");
  const handler = tools.get("shell_status")?.handler;
  assert.ok(handler, "shell_status must have a handler");
  handler({ run_id: "run-1", action: "cancel", kill_key: "key-1" });
  handler({ run_id: "run-2" });
  assert.equal(calls[0]?.op, "cancel", "action=cancel must call the cancel op");
  assert.deepEqual(calls[0]?.args, { run_id: "run-1", kill_key: "key-1" });
  assert.equal(calls[1]?.op, "shell_status", "a plain call must stay shell_status");
});

await check("other modes: shell_status keeps the plain schema (no action, no kill_key)", () => {
  const { tools } = registerShell("default");
  const shape = tools.get("shell_status")?.inputSchema ?? {};
  assert.ok(!("action" in shape), "default must not advertise action");
  assert.ok(!("kill_key" in shape), "default must not advertise kill_key");
});

// ---- the execute_js gate ----
const jsExecGate = async (env: Record<string, string | undefined>): Promise<{ mode: string; allow: boolean }> => {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const ws = (await loadFresh("lib/workspace.ts")) as typeof import("../lib/workspace.js");
    return { mode: ws.JS_EXEC_MODE, allow: ws.ALLOW_JS_EXEC };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

await check("minimal mode: execute_js stays available without an explicit VENIRA_JS_EXEC_MODE", async () => {
  const gate = await jsExecGate({ VENIRA_TOOL_MODE: "minimal", VENIRA_JS_EXEC_MODE: undefined });
  assert.equal(gate.mode, "semi-auto", "minimal defaults to semi-auto");
  assert.equal(gate.allow, true, "execute_js must stay registered");
});

await check("minimal mode: a strict profile asks instead of semi-auto", async () => {
  const gate = await jsExecGate({
    VENIRA_TOOL_MODE: "minimal",
    VENIRA_JS_EXEC_MODE: undefined,
    VENIRA_SECURITY_PROFILE: "strict",
  });
  assert.equal(gate.mode, "ask", "strict profile -> ask");
});

await check("minimal mode: an explicit off is respected (the operator wins)", async () => {
  const gate = await jsExecGate({ VENIRA_TOOL_MODE: "minimal", VENIRA_JS_EXEC_MODE: "off" });
  assert.equal(gate.mode, "off", "an explicit off must not be overridden");
  assert.equal(gate.allow, false);
});

await check("other modes: the default stays off (unchanged behaviour)", async () => {
  const gate = await jsExecGate({ VENIRA_TOOL_MODE: "default", VENIRA_JS_EXEC_MODE: undefined });
  assert.equal(gate.mode, "off", "default mode keeps the server default");
  const explicit = await jsExecGate({ VENIRA_TOOL_MODE: "default", VENIRA_JS_EXEC_MODE: "semi-auto" });
  assert.equal(explicit.mode, "semi-auto", "an explicit value still wins");
});

fs.rmSync(tmpWorkspace, { recursive: true, force: true });

if (failures > 0) {
  console.error(`[test-minimal-mode] ${failures} check(s) failed`);
  process.exit(1);
}
console.log("[test-minimal-mode] ok");
