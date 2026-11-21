/**
 * Guardrail for roadmap item 16 (tool schema and description clarity).
 *
 * Pins:
 *   1. Every parameter of every registered tool has a non-empty description, so an
 *      LLM client can call the tool from the schema alone.
 *   2. Deprecated parameters are gone from the published schema
 *      (shell_run.approval_token / approval_scope, snapshot.scope, edit_file.guard). Phase 5 removed
 *      scope and guard entirely, so the handlers refuse them instead of silently widening the
 *      operation; the loose objects keep them reachable so the refusal can name the replacement.
 *   3. Every registered tool has a TOOL_DOCS entry (the model-facing wording).
 *   4. edit_file's typed edits[] item shape stays in sync with the runtime
 *      EDIT_ITEM_KEYS validator.
 *   5. (ROADMAP_TOOL_SCHEMA.md, phase 3) The fuzzy edit options are advertised, and mentioned in the
 *      model-facing text, only when VENIRA_EDIT_FUZZY=1; with it off they are still let through to the
 *      handler (which refuses them with a clear error) instead of being stripped.
 *   6. (phase 4) create advertises directory-only arguments; shell_run.background is advertised
 *      as a boolean (item 20) while its handler keeps accepting 1/0, booleans and strings. (phase 5) the removed
 *      file arguments still reach the handler, which refuses them with `[unsupported]`.
 *
 * Run with: npm run test:tool-schema
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

process.env.VENIRA_JS_EXEC_MODE = "ask"; // so execute_js registers too
process.env.VENIRA_TOOL_MODE = "default";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel: string) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const dummy = async () => ({}) as never;

const registered = new Map<string, { inputSchema?: Record<string, unknown>; description?: string }>();
const fakeServer = {
  registerTool: (name: string, cfg: Record<string, unknown>) => {
    assert.ok(!registered.has(name), `duplicate registration: ${name}`);
    registered.set(name, cfg as never);
  },
} as never;

const files = (await load(
  "tools/project-register-files.ts",
)) as typeof import("../tools/project-register-files.js");
const shell = (await load(
  "tools/project-register-shell.ts",
)) as typeof import("../tools/project-register-shell.js");
const ops = (await load(
  "tools/project-register-ops.ts",
)) as typeof import("../tools/project-register-ops.js");
const codeintel = (await load(
  "tools/project-register-codeintel.ts",
)) as typeof import("../tools/project-register-codeintel.js");
const workflow = (await load(
  "tools/project-register-workflow.ts",
)) as typeof import("../tools/project-register-workflow.js");
const vcs = (await load(
  "tools/project-register-vcs.ts",
)) as typeof import("../tools/project-register-vcs.js");
const git = (await load(
  "tools/project-register-git.ts",
)) as typeof import("../tools/project-register-git.js");
const docs = (await load(
  "tools/project-docs.ts",
)) as typeof import("../tools/project-docs.js");
const schema = (await load(
  "tools/project-schema.ts",
)) as typeof import("../tools/project-schema.js");
const argHints = (await load(
  "lib/arg-hints.ts",
)) as typeof import("../lib/arg-hints.js");
const toolMode = (await load(
  "tools/project-tool-mode.ts",
)) as typeof import("../tools/project-tool-mode.js");

const fileToolDeps = {
  runOne: dummy,
  hybridDeps: { execute: dummy } as never,
  recentFilesDeps: { lookup: dummy, store: dummy, recentEdits: new Set() } as never,
  batchDeps: { execute: dummy, maxBatchResponseBytes: 1 } as never,
  maxBatchItemBytes: 1,
  runSearchSelective: dummy,
};
files.registerFileTools(fakeServer, fileToolDeps);
shell.registerShellTools(fakeServer, {
  runOne: dummy,
  shellDeps: { execute: dummy, callHost: dummy } as never,
});
ops.registerOpsTools(fakeServer, {
  runOne: dummy,
  runCreate: dummy,
  healthDeps: {
    hostSnapshot: dummy,
    refreshCapability: dummy,
    capability: dummy,
    queue: { depth: 0 },
    caches: dummy,
    shells: dummy,
    startedAt: 0,
    permissionMode: "x",
    shellElicit: false,
  } as never,
  auditDbPath: () => "",
  shellDeps: { execute: dummy, callHost: dummy } as never,
  clearCaches: () => undefined,
});
codeintel.registerCodeIntelTools(fakeServer, {
  runOne: dummy,
  runSymbolReferences: dummy,
});
workflow.registerWorkflowTools(fakeServer, {
  runDetectHarnesses: dummy,
  runInstallSelf: dummy,
  runExplainError: dummy,
  runPlanReadBatch: dummy,
  runSnapshot: dummy,
});
vcs.registerVcsTools(fakeServer, { runOne: dummy, runSecret: dummy });
git.registerGitTools(fakeServer, { runOne: dummy });

/** Walk a zod schema; collect paths whose named properties lack a description. */
const missing: string[] = [];
const MAX_DEPTH = 5;
function describeOf(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const d = (node as { description?: unknown }).description;
  return typeof d === "string" && d.trim().length > 0 ? d : undefined;
}
function defOf(node: unknown): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const z = (node as { _zod?: { def?: Record<string, unknown> } })._zod;
  return z?.def;
}
/**
 * The parameter map of a registered tool: a raw shape, or a zod object (edit_file is registered as
 * a loose object so the handler sees fuzzy options even when they are not advertised).
 */
function shapeOf(input: unknown): Record<string, unknown> {
  const shape = defOf(input)?.shape as Record<string, unknown> | undefined;
  return shape ?? (input as Record<string, unknown>);
}
/** Description on the node or on an inner optional/default wrapper's target. */
function effectiveDescription(node: unknown): string | undefined {
  let current = node;
  let depth = 0;
  while (current && typeof current === "object" && depth < 4) {
    const d = describeOf(current);
    if (d) return d;
    const inner = defOf(current)?.innerType;
    if (inner === undefined) return undefined;
    current = inner;
    depth += 1;
  }
  return undefined;
}
function walk(node: unknown, where: string, depth: number): void {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return;
  const def = defOf(node);
  if (!def) return;
  const inner = def.innerType;
  if (inner !== undefined) {
    if (!effectiveDescription(node)) missing.push(where);
    walk(inner, where, depth + 1);
    return;
  }
  const shape = def.shape as Record<string, unknown> | undefined;
  if (shape) {
    for (const [key, child] of Object.entries(shape)) {
      if (!effectiveDescription(child)) missing.push(`${where}.${key}`);
      walk(child, `${where}.${key}`, depth + 1);
    }
    return;
  }
  const options = def.options as unknown[] | undefined;
  if (Array.isArray(options)) {
    options.forEach((opt, i) => walk(opt, `${where}[v${i}]`, depth + 1));
    return;
  }
  const element = def.element;
  if (element !== undefined) {
    walk(element, `${where}[]`, depth + 1);
  }
}

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

check("every parameter has a description", () => {
  for (const [tool, cfg] of registered) {
    const shape = shapeOf(cfg.inputSchema);
    assert.ok(cfg.inputSchema, `${tool}: no inputSchema captured`);
    for (const [key, child] of Object.entries(shape)) {
      if (!effectiveDescription(child)) missing.push(`${tool}.${key}`);
      walk(child, `${tool}.${key}`, 0);
    }
  }
  assert.deepEqual(missing, [], `parameters without a description:\n  ${missing.join("\n  ")}`);
});

check("flags are advertised as booleans and still parse 1/0/true/false", () => {
  for (const [name, flag] of [["flag01", schema.flag01], ["backgroundFlag", schema.backgroundFlag]] as const) {
    const json = z.toJSONSchema(flag as unknown as z.ZodType, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    assert.equal(json.type, "boolean", `${name} must be advertised as boolean`);
    assert.equal(json.minimum, undefined, `${name} must not advertise an integer range`);
    assert.equal(json.maximum, undefined, `${name} must not advertise an integer range`);
    assert.equal(json.anyOf, undefined, `${name} must not publish an anyOf (it would carry the integer 0|1 branch)`);
  }
  const parse = (value: unknown) => (schema.flag01 as unknown as z.ZodType).parse(value);
  assert.equal(parse(true), true);
  assert.equal(parse(1), true);
  assert.equal(parse(false), false);
  assert.equal(parse(0), false);
  for (const bad of [2, -1, "1", "yes", null, undefined, {}]) {
    assert.throws(() => parse(bad), `flag01 must refuse ${JSON.stringify(bad)}`);
  }
  const bg = (value: unknown) => (schema.backgroundFlag as unknown as z.ZodType).parse(value);
  assert.equal(bg("0"), false);
  assert.equal(bg(true), true);
});

check("deprecated parameters are gone from the schema", () => {
  const shellKeys = Object.keys(registered.get("shell_run")!.inputSchema!);
  assert.ok(!shellKeys.includes("approval_token"), `shell_run still advertises approval_token: ${shellKeys.join(",")}`);
  assert.ok(!shellKeys.includes("approval_scope"), `shell_run still advertises approval_scope: ${shellKeys.join(",")}`);
  const snapshotKeys = Object.keys(shapeOf(registered.get("snapshot")!.inputSchema));
  assert.ok(!snapshotKeys.includes("scope"), `snapshot still advertises the removed scope alias: ${snapshotKeys.join(",")}`);
  assert.ok(snapshotKeys.includes("paths"), "snapshot must advertise paths (the replacement for scope)");
  const editKeys = Object.keys(shapeOf(registered.get("edit_file")!.inputSchema));
  assert.ok(!editKeys.includes("guard"), `edit_file still advertises the removed guard flag: ${editKeys.join(",")}`);
  assert.ok(editKeys.includes("expected_sha256"), "edit_file must advertise expected_sha256 (the replacement for guard)");
});

check("removed scope and guard still reach the handlers (loose objects, not stripped)", () => {
  // A cached client sends the old names; stripping them would silently widen the checkpoint to the
  // whole workspace (scope) or silently skip verification (guard). Loose objects let the handlers
  // refuse them with `[unsupported]` and name the replacement.
  const snapshotInput = registered.get("snapshot")!.inputSchema as unknown as z.ZodType;
  const snap = snapshotInput.safeParse({ action: "create", scope: ["lib"] });
  assert.ok(snap.success, "a cached client's scope call must reach the handler, not be stripped");
  assert.deepEqual((snap.data as Record<string, unknown>).scope, ["lib"]);

  const editInput = registered.get("edit_file")!.inputSchema as unknown as z.ZodType;
  const edit = editInput.safeParse({ relative_path: "a.ts", old_text: "x", new_text: "y", guard: "sha256" });
  assert.ok(edit.success, "a cached client's guard call must reach the handler, not be stripped");
  assert.equal((edit.data as Record<string, unknown>).guard, "sha256");
});

check("deprecated handler tolerance: old_text_fuzzy stays, guard is gone", () => {
  // old_text_fuzzy was never read by a handler, so an older client's leftover field is harmless and
  // stays accepted. guard was a real behavior switch: phase 5 removed it, so it is unknown now.
  assert.ok(argHints.EDIT_ITEM_KEYS.includes("old_text_fuzzy"));
  assert.ok(!(argHints.EDIT_ITEM_KEYS as readonly string[]).includes("guard"), "guard must leave EDIT_ITEM_KEYS");
  assert.ok(!(argHints.EDIT_ITEM_LEGACY_KEYS as readonly string[]).includes("guard"), "guard must leave EDIT_ITEM_LEGACY_KEYS");
});

check("every registered tool has a TOOL_DOCS entry", () => {
  const undocumented = [...registered.keys()].filter((t) => !(t in docs.TOOL_DOCS));
  assert.deepEqual(undocumented, [], `tools missing TOOL_DOCS: ${undocumented.join(", ")}`);
});

const LEGACY = argHints.EDIT_ITEM_LEGACY_KEYS as readonly string[];
const FUZZY = argHints.EDIT_ITEM_FUZZY_KEYS as readonly string[];

check("editBatchItem keys match EDIT_ITEM_KEYS (minus legacy keys; fuzzy keys only when fuzzy is on)", () => {
  const advertisedKeys = argHints.EDIT_ITEM_KEYS.filter((k) => !LEGACY.includes(k));
  const off = Object.keys(defOf(schema.editBatchItemFor(false))!.shape as Record<string, unknown>);
  const on = Object.keys(defOf(schema.editBatchItemFor(true))!.shape as Record<string, unknown>);
  assert.deepEqual([...off].sort(), advertisedKeys.filter((k) => !FUZZY.includes(k)).sort());
  assert.deepEqual([...on].sort(), [...advertisedKeys].sort());
});

check("legacy edit keys stay accepted at runtime but are not advertised", () => {
  for (const legacy of argHints.EDIT_ITEM_LEGACY_KEYS) {
    assert.ok(argHints.EDIT_ITEM_KEYS.includes(legacy), `${legacy} must stay in EDIT_ITEM_KEYS`);
    for (const tool of ["edit_file"]) {
      assert.ok(
        !(legacy in shapeOf(registered.get(tool)!.inputSchema)),
        `${tool} still advertises legacy key ${legacy}`,
      );
    }
    const batchKeys = Object.keys(defOf(schema.editBatchItemFor(true))!.shape as Record<string, unknown>);
    assert.ok(!batchKeys.includes(legacy), `editBatchItem still advertises legacy key ${legacy}`);
  }
});

// ---- Phase 4: create advertises directory-only arguments ----
check("create advertises directory-only arguments", () => {
  const createInput = registered.get("create")!.inputSchema as unknown as z.ZodType;
  const keys = Object.keys(shapeOf(createInput));
  for (const legacy of ["kind", "content", "mode", "expected_sha256"]) {
    assert.ok(!keys.includes(legacy), `create still advertises the removed file argument ${legacy}`);
  }
  assert.ok(keys.includes("relative_path"), "create must still require relative_path");
});

// Phase 5: the removed file arguments still reach the handler, which refuses them with `[unsupported]`
// instead of creating an empty directory where the caller wanted a file.
check("create still lets the removed file arguments through to the handler", () => {
  const createInput = registered.get("create")!.inputSchema as unknown as z.ZodType;
  const parsed = createInput.safeParse({
    relative_path: "a.txt",
    kind: "file",
    content: "x",
    mode: "append",
    expected_sha256: "ab",
  });
  assert.ok(parsed.success, "a cached client's kind=file call must reach the handler, not be stripped");
  const data = parsed.data as Record<string, unknown>;
  assert.equal(data.kind, "file");
  assert.equal(data.content, "x");
  assert.equal(data.mode, "append");
  assert.equal(data.expected_sha256, "ab");
});

// ---- Phase 3: the fuzzy edit options are advertised only when VENIRA_EDIT_FUZZY=1 ----
type Registered = Map<string, { inputSchema?: unknown; description?: string }>;

/** Register the file tools with TOOL_DOCS applied (what tools/list serves) and VENIRA_EDIT_FUZZY = `value`. */
function registerFilesWithFuzzy(value: "0" | "1"): Registered {
  const saved = process.env.VENIRA_EDIT_FUZZY;
  process.env.VENIRA_EDIT_FUZZY = value;
  try {
    const tools: Registered = new Map();
    const server = {
      registerTool: (name: string, cfg: Record<string, unknown>) => {
        tools.set(name, cfg as never);
      },
    } as never;
    docs.applyToolDocs(server);
    files.registerFileTools(server, fileToolDeps);
    return tools;
  } finally {
    if (saved === undefined) delete process.env.VENIRA_EDIT_FUZZY;
    else process.env.VENIRA_EDIT_FUZZY = saved;
  }
}

const fuzzyOff = registerFilesWithFuzzy("0");
const fuzzyOn = registerFilesWithFuzzy("1");

// Item 20: a flag is published as a JSON Schema boolean; an integer 0|1 flag must not come back.
check("file tools: no integer 0|1 flag is advertised (item 20)", () => {
  for (const [name, cfg] of fuzzyOff) {
    const raw = cfg.inputSchema as unknown;
    const zschema = raw instanceof z.ZodType ? raw : z.object((raw ?? {}) as z.ZodRawShape);
    const json = z.toJSONSchema(zschema, { io: "input", unrepresentable: "any" }) as {
      properties?: Record<string, { type?: string; minimum?: number; maximum?: number; anyOf?: Array<{ type?: string }> }>;
    };
    for (const [prop, def] of Object.entries(json.properties ?? {})) {
      assert.ok(
        !(def.type === "integer" && def.minimum === 0 && def.maximum === 1),
        `${name}.${prop} must be advertised as boolean, not integer 0|1`,
      );
      assert.ok(
        !(def.anyOf ?? []).some((branch) => branch.type === "integer" && (branch as { maximum?: number }).maximum === 1),
        `${name}.${prop} must not publish an anyOf with an integer 0|1 branch`,
      );
    }
  }
});
// ---- Phase 8 patch 2: the setup tools are advertised only when VENIRA_SETUP_TOOLS=1 ----
const SETUP_TOOLS = ["detect_harnesses", "install_self"];

/** Register the workflow tools with VENIRA_SETUP_TOOLS = `value` (undefined = unset) and return the names. */
function workflowToolNames(value: "0" | "1" | undefined): string[] {
  const saved = process.env.VENIRA_SETUP_TOOLS;
  if (value === undefined) delete process.env.VENIRA_SETUP_TOOLS;
  else process.env.VENIRA_SETUP_TOOLS = value;
  try {
    const names: string[] = [];
    const server = { registerTool: (name: string) => void names.push(name) } as never;
    workflow.registerWorkflowTools(server, {
      runDetectHarnesses: dummy,
      runInstallSelf: dummy,
      runExplainError: dummy,
      runPlanReadBatch: dummy,
      runSnapshot: dummy,
    });
    return names;
  } finally {
    if (saved === undefined) delete process.env.VENIRA_SETUP_TOOLS;
    else process.env.VENIRA_SETUP_TOOLS = saved;
  }
}

check("setup tools: not advertised by default (unset or 0), the other workflow tools stay", () => {
  for (const value of [undefined, "0"] as const) {
    const names = workflowToolNames(value);
    assert.deepEqual(names.filter((n) => SETUP_TOOLS.includes(n)), []);
    assert.deepEqual(names.sort(), ["explain_error", "plan_read_batch", "snapshot"]);
  }
});

check("setup tools: VENIRA_SETUP_TOOLS=1 advertises detect_harnesses and install_self", () => {
  assert.deepEqual(workflowToolNames("1").filter((n) => SETUP_TOOLS.includes(n)).sort(), [...SETUP_TOOLS].sort());
});

// ---- core mode is an allowlist of the must-have tools ----
check("core mode: every allowlisted tool is a real registered tool (no typo or renamed tool)", () => {
  const missingTools = toolMode.CORE_TOOLS.filter((name) => !registered.has(name));
  assert.deepEqual(missingTools, [], `CORE_TOOLS names no registered tool: ${missingTools.join(", ")}`);
  assert.equal(new Set(toolMode.CORE_TOOLS).size, toolMode.CORE_TOOLS.length, "CORE_TOOLS has a duplicate");
});

check("core mode: keeps shell, execute_js, read, search, list, edit, snapshot and git", () => {
  for (const name of [
    "shell_run", "shell_status", "execute_js", "read_file", "search", "list_files",
    "edit_file", "write_file", "snapshot", "git",
    "create", "move_path", "recent_files", "outline_symbol", "memory",
  ]) {
    assert.ok(toolMode.CORE_TOOLS.includes(name), `core must keep ${name}`);
  }
  assert.ok(toolMode.CORE_TOOLS.includes("delete_path"), "delete_path stays in every mode (shell rm is hard-denied)");
});

check("core mode: blocks every other tool, and core stays inside the default surface", () => {
  for (const name of registered.keys()) {
    const inCore = toolMode.CORE_TOOLS.includes(name);
    assert.equal(toolMode.modeBlocksTool("core", name, false), !inCore, `core handling of ${name}`);
    if (inCore) assert.equal(toolMode.modeBlocksTool("default", name, false), false, `${name} is in core but not in default`);
  }
  for (const name of ["secret", "edit_batch", "health", "apply_patch", "copy_path", "get_file_info", "dependency_graph", "ci_status"]) {
    assert.equal(toolMode.modeBlocksTool("core", name, false), true, `core must not advertise ${name}`);
  }
});

check("core mode: setup tools join only with VENIRA_SETUP_TOOLS=1; default and expert never block them", () => {
  for (const name of SETUP_TOOLS) {
    assert.equal(toolMode.modeBlocksTool("core", name, false), true, `${name} must stay out of core by default`);
    assert.equal(toolMode.modeBlocksTool("core", name, true), false, `${name} must join core with VENIRA_SETUP_TOOLS=1`);
    assert.equal(toolMode.modeBlocksTool("default", name, false), false);
    assert.equal(toolMode.modeBlocksTool("expert", name, false), false);
  }
});

check("core mode: applyDisabledTools registers only the allowlist (plus setup tools with VENIRA_SETUP_TOOLS=1)", () => {
  const registerAll = (setup: "0" | "1", disable?: string): string[] => {
    const saved = {
      mode: process.env.VENIRA_TOOL_MODE,
      setup: process.env.VENIRA_SETUP_TOOLS,
      disable: process.env.VENIRA_DISABLE_TOOLS,
    };
    process.env.VENIRA_TOOL_MODE = "core";
    process.env.VENIRA_SETUP_TOOLS = setup;
    if (disable === undefined) delete process.env.VENIRA_DISABLE_TOOLS;
    else process.env.VENIRA_DISABLE_TOOLS = disable;
    const originalError = console.error;
    console.error = () => undefined; // the mode logs its surface on stderr
    try {
      const names: string[] = [];
      const server = { registerTool: (name: string) => void names.push(name) };
      toolMode.applyDisabledTools(server as never);
      for (const name of new Set([...registered.keys(), ...SETUP_TOOLS])) server.registerTool(name);
      return names;
    } finally {
      console.error = originalError;
      for (const [key, value] of [
        ["VENIRA_TOOL_MODE", saved.mode],
        ["VENIRA_SETUP_TOOLS", saved.setup],
        ["VENIRA_DISABLE_TOOLS", saved.disable],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  assert.deepEqual(registerAll("0").sort(), [...toolMode.CORE_TOOLS].sort());
  assert.deepEqual(registerAll("1").sort(), [...toolMode.CORE_TOOLS, ...SETUP_TOOLS].sort());
  // VENIRA_DISABLE_TOOLS still layers on top of the allowlist.
  assert.deepEqual(registerAll("0", "git,execute_js").sort(), toolMode.CORE_TOOLS.filter((n) => n !== "git" && n !== "execute_js").sort());
});

const fuzzyIn = (keys: string[]) => keys.filter((k) => FUZZY.includes(k)).sort();
const editFileKeys = (tools: Registered) => Object.keys(shapeOf(tools.get("edit_file")!.inputSchema));
/** The zod schema of one edit_file edits[] item (`edits` is an array of loose objects). */
const batchItemSchema = (tools: Registered) => {
  const edits = (shapeOf(tools.get("edit_file")!.inputSchema) as Record<string, unknown>).edits;
  let cur: Record<string, unknown> | undefined = defOf(edits);
  while (cur && cur.type === "optional") cur = defOf(cur.innerType);
  const element = cur?.element;
  if (!element) throw new Error("edit_file#edits[] element schema not found");
  return element as z.ZodType;
};
const batchItemKeys = (tools: Registered) => Object.keys(defOf(batchItemSchema(tools))!.shape as Record<string, unknown>);
/** JSON Schema of one tool's input, as tools/list would carry it. */
function jsonOf(input: unknown): string {
  const schema = (input as { _zod?: unknown })._zod ? input : z.object(input as never);
  return JSON.stringify(z.toJSONSchema(schema as never, { io: "input", unrepresentable: "any" }));
}

type SearchToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type SearchToolHandler = (args: Record<string, unknown>) => Promise<SearchToolResult>;

function registerSearchForTest(
  runOne: (operation: string, args: Record<string, unknown>) => Promise<SearchToolResult>,
): { schema: Record<string, unknown>; call: (args: Record<string, unknown>) => Promise<SearchToolResult> } {
  let handler: SearchToolHandler | undefined;
  let inputSchema: unknown;
  const server = {
    registerTool: (name: string, config: Record<string, unknown>, callback: SearchToolHandler) => {
      if (name === "search") {
        inputSchema = config.inputSchema;
        handler = callback;
      }
    },
  } as never;
  files.registerFileTools(server, { ...fileToolDeps, runOne: runOne as never });
  if (!inputSchema || !handler) throw new Error("search tool did not register");
  const schema = shapeOf(inputSchema);
  const validator = inputSchema instanceof z.ZodType ? inputSchema : z.object(schema as never);
  return {
    schema,
    call: async (args) => handler!(validator.parse(args) as Record<string, unknown>),
  };
}

check("search schema: advanced weighted queries are omitted only in core mode", () => {
  const saved = process.env.VENIRA_TOOL_MODE;
  try {
    process.env.VENIRA_TOOL_MODE = "default";
    const full = registerSearchForTest(async () => ({ content: [{ type: "text", text: "{}" }] }));
    assert.ok("queries" in full.schema);
    assert.ok("files_hint" in full.schema);
    assert.match(effectiveDescription(full.schema.query) ?? "", /query OR searches\[\] \(not both\)/);
    process.env.VENIRA_TOOL_MODE = "core";
    const core = registerSearchForTest(async () => ({ content: [{ type: "text", text: "{}" }] }));
    assert.ok(!("queries" in core.schema));
    assert.ok(!("files_hint" in core.schema));
  } finally {
    if (saved === undefined) delete process.env.VENIRA_TOOL_MODE;
    else process.env.VENIRA_TOOL_MODE = saved;
  }
});

check("search schema: content aliases parse to content while only content/glob are advertised", () => {
  const search = registered.get("search")!;
  const shape = shapeOf(search.inputSchema);
  let searches = defOf(shape.searches);
  while (searches && searches.type === "optional") searches = defOf(searches.innerType);
  const item = searches?.element as { _zod?: unknown } | undefined;
  const typeSchema = shapeOf(item).type as z.ZodType;
  const typeJson = z.toJSONSchema(typeSchema, { io: "input", unrepresentable: "any" }) as { enum?: unknown[] };
  assert.deepEqual(typeJson.enum, ["content", "glob"]);
  for (const alias of ["grep", "rg"]) {
    assert.equal(typeSchema.parse(alias), "content");
  }
});

await checkAsync("search batch: rejects clashes, isolates args and caps concurrency at four", async () => {
  let dispatched = 0;
  let active = 0;
  let maxActive = 0;
  const operationArgs: Record<string, unknown>[] = [];
  const search = registerSearchForTest(async (_operation, args) => {
    dispatched += 1;
    operationArgs.push(args);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: "completed", data: {} }) }] };
  });

  for (const [field, value] of [
    ["query", "top-level"],
    ["queries", [{ pattern: "weighted" }]],
    ["files_hint", ["src/a.ts"]],
    ["kind", "definition"],
  ] as const) {
    const result = await search.call({ searches: [{ type: "content", pattern: "step" }], [field]: value });
    const envelope = JSON.parse(result.content[0].text) as { error?: { code?: string }; hint?: string };
    assert.equal(envelope.error?.code, "invalid_request");
    assert.match(envelope.hint ?? "", /either|one/i);
  }
  assert.equal(dispatched, 0, "clashing calls must not dispatch a search");

  const result = await search.call({
    relative_path: "src",
    exclude_glob: "*.min.js",
    case_sensitive: true,
    include_hidden: false,
    limit: 12,
    context_lines: 2,
    whole_word: true,
    files_only: true,
    invert: true,
    searches: Array.from({ length: 8 }, (_, index) => ({ type: "content", pattern: `p${index}` })),
  });
  const envelope = JSON.parse(result.content[0].text) as { status: string };
  assert.equal(envelope.status, "completed");
  assert.equal(dispatched, 8);
  assert.equal(maxActive, 4, "search batch should run at most four requests concurrently");
  assert.deepEqual(operationArgs[0], {
    exclude_glob: "*.min.js",
    case_sensitive: true,
    include_hidden: false,
    limit: 12,
    context_lines: 2,
    whole_word: true,
    query: "p0",
    relative_path: "src",
    kind: "literal_content",
    regex: true,
  });
});

await checkAsync("search batch: rejects glob filters on path-glob steps", async () => {
  let dispatched = 0;
  const search = registerSearchForTest(async () => {
    dispatched += 1;
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });
  const result = await search.call({ searches: [{ type: "glob", pattern: "*.ts", glob: "src/**" }] });
  const envelope = JSON.parse(result.content[0].text) as {
    data: { responses: { error?: { code?: string } }[] };
  };
  assert.equal(dispatched, 0);
  assert.equal(envelope.data.responses[0].error?.code, "invalid_request");
  assert.equal(result.isError, true);
});

await checkAsync("partial batches keep successful item content visible to MCP clients", async () => {
  const search = registerSearchForTest(async (_operation, args) => ({
    content: [{
      type: "text",
      text: JSON.stringify(args.query === "bad"
        ? { ok: false, status: "failed", error: { code: "invalid_request", message: "bad pattern" } }
        : { ok: true, status: "completed", data: { hits: ["good"] } }),
    }],
  }));
  const partial = await search.call({ searches: [{ type: "content", pattern: "bad" }, { type: "content", pattern: "good" }] });
  const partialEnvelope = JSON.parse(partial.content[0].text) as { status: string; partial?: boolean };
  assert.equal(partialEnvelope.status, "partial");
  assert.equal(partialEnvelope.partial, true);
  assert.equal(partial.isError, undefined);

  const allFailed = await search.call({ searches: [{ type: "content", pattern: "bad" }] });
  assert.equal(allFailed.isError, true);
});

check("fuzzy off: edit_file and its edits[] items do not advertise the fuzzy options", () => {
  assert.deepEqual(fuzzyIn(editFileKeys(fuzzyOff)), []);
  assert.deepEqual(fuzzyIn(batchItemKeys(fuzzyOff)), []);
});

check("fuzzy on: edit_file and its edits[] items advertise all three fuzzy options", () => {
  assert.deepEqual(fuzzyIn(editFileKeys(fuzzyOn)), [...FUZZY].sort());
  assert.deepEqual(fuzzyIn(batchItemKeys(fuzzyOn)), [...FUZZY].sort());
});

check("fuzzy off: nothing about fuzzy matching in edit_file's text or schema", () => {
  for (const tool of ["edit_file"]) {
    const cfg = fuzzyOff.get(tool)!;
    assert.ok(!/fuzzy/i.test(cfg.description ?? ""), `${tool} description still mentions fuzzy matching`);
    assert.ok(!/fuzzy/i.test(jsonOf(cfg.inputSchema)), `${tool} schema still mentions fuzzy matching`);
  }
});

check("fuzzy on: the edit_file text explains the fuzzy fallback", () => {
  const cfg = fuzzyOn.get("edit_file")!;
  assert.match(cfg.description ?? "", /fuzzy_distance/);
  const oldText = shapeOf(cfg.inputSchema).old_text;
  assert.match(effectiveDescription(oldText) ?? "", /near-match/);
});

check("fuzzy off: edit_file and its edits[] items still let fuzzy options through to the handler", () => {
  const input = { relative_path: "a.txt", old_text: "x", new_text: "y", case_insensitive: 1, fuzzy_distance: 2 };
  const editFile = fuzzyOff.get("edit_file")!.inputSchema as z.ZodType;
  const one = editFile.safeParse(input);
  assert.ok(one.success, "edit_file rejected a fuzzy option while fuzzy is off");
  assert.equal((one.data as Record<string, unknown>).case_insensitive, 1, "edit_file stripped case_insensitive");
  assert.equal((one.data as Record<string, unknown>).fuzzy_distance, 2, "edit_file stripped fuzzy_distance");
  const item = batchItemSchema(fuzzyOff).safeParse(input);
  assert.ok(item.success, "edits[] item rejected a fuzzy option while fuzzy is off");
  assert.equal((item.data as Record<string, unknown>).case_insensitive, 1, "edits[] item stripped case_insensitive");
});

check("fuzzy on: the options are typed (flag becomes boolean, distance is capped at 10)", () => {
  const editFile = fuzzyOn.get("edit_file")!.inputSchema as z.ZodType;
  const base = { relative_path: "a.txt", old_text: "x", new_text: "y" };
  const ok = editFile.safeParse({ ...base, case_insensitive: 1, fuzzy_distance: 2 });
  assert.ok(ok.success);
  assert.equal((ok.data as Record<string, unknown>).case_insensitive, true);
  assert.equal(editFile.safeParse({ ...base, fuzzy_distance: 11 }).success, false);
});

check("fuzzy on: every edit-tool parameter still has a description", () => {
  missing.length = 0;
  for (const [tool, cfg] of fuzzyOn) {
    for (const [key, child] of Object.entries(shapeOf(cfg.inputSchema))) {
      if (!effectiveDescription(child)) missing.push(`${tool}.${key}`);
      walk(child, `${tool}.${key}`, 0);
    }
  }
  assert.deepEqual(missing, [], `parameters without a description (fuzzy on):\n  ${missing.join("\n  ")}`);
});

// ---- Phase 7: start_line minimum, hidden max_response_bytes_per_item, config() without dead text ----
const batchModule = (await load("tools/project-batch.ts")) as typeof import("../tools/project-batch.js");
const propsOf = (input: unknown): Record<string, any> => JSON.parse(jsonOf(input)).properties ?? {};

await checkAsync("read_file partial batches do not set MCP isError unless every item fails", async () => {
  const deps = {
    execute: async (_operation: string, args: Record<string, unknown>) => {
      if (args.relative_path === "bad") throw new Error("[not_found] missing file");
      return {
        response: { status: "completed", result: { kind: "read_file", data: { relative_path: "good", text: "ok" } } },
        cached: false,
      };
    },
    maxBatchResponseBytes: 1_000_000,
  };
  const partial = await batchModule.runReadFileBatch(
    [{ relative_path: "bad" }, { relative_path: "good" }],
    batchModule.READ_ITEM_BYTES_MAX,
    deps as never,
  );
  assert.equal(partial.isError, undefined);
  const allFailed = await batchModule.runReadFileBatch(
    [{ relative_path: "bad" }],
    batchModule.READ_ITEM_BYTES_MAX,
    deps as never,
  );
  assert.equal(allFailed.isError, true);
});

check("read_file advertises start_line with minimum 1 (also in ranges[]) but still parses 0", () => {
  const input = registered.get("read_file")!.inputSchema;
  const props = propsOf(input);
  assert.equal(props.start_line.minimum, 1, "start_line must advertise minimum 1");
  assert.equal(props.ranges.items.properties.start_line.minimum, 1, "ranges[].start_line must advertise minimum 1");
  const parsed = ((input as { _zod?: unknown })._zod ? (input as unknown as z.ZodType) : z.object(input as never)).safeParse({ relative_path: "a.txt", start_line: 0, ranges: [{ start_line: 0 }] });
  assert.ok(parsed.success, "start_line=0 must reach the handler, which answers with a hint");
});

check("max_response_bytes_per_item is not advertised on the batch tools but still reaches the handler", () => {
  for (const [tool, payload] of [
    ["read_file", { requests: [{ relative_path: "a.txt" }], max_response_bytes_per_item: 2048 }],
    ["edit_file", { edits: [{ relative_path: "a.txt", old_text: "x", new_text: "y" }], max_response_bytes_per_item: 512 }],
  ] as const) {
    const input = registered.get(tool)!.inputSchema;
    assert.ok(!("max_response_bytes_per_item" in propsOf(input)), `${tool} still advertises max_response_bytes_per_item`);
    assert.ok(!jsonOf(input).includes("max_response_bytes_per_item"), `${tool} schema text still names max_response_bytes_per_item`);
    // read_file is registered as a raw shape; edit_file as a loose object (has _zod).
    const schema = (input as { _zod?: unknown })._zod ? (input as unknown as z.ZodType) : z.object(input as never);
    const parsed = schema.safeParse(payload);
    assert.ok(parsed.success, `${tool}: the hidden key must pass the schema`);
    assert.equal(
      (parsed.data as Record<string, unknown>).max_response_bytes_per_item,
      payload.max_response_bytes_per_item,
      `${tool}: the SDK stripped max_response_bytes_per_item`,
    );
  }
});

check("the hidden per-item budget is range-checked by the handler (not by zod)", () => {
  const { checkItemBytes, READ_ITEM_BYTES_MIN, READ_ITEM_BYTES_MAX, EDIT_ITEM_BYTES_MIN, EDIT_ITEM_BYTES_MAX } = batchModule;
  assert.equal(checkItemBytes("read_file", undefined, READ_ITEM_BYTES_MIN, READ_ITEM_BYTES_MAX), undefined);
  assert.equal(checkItemBytes("read_file", 2048, READ_ITEM_BYTES_MIN, READ_ITEM_BYTES_MAX), undefined);
  assert.equal(checkItemBytes("edit_file", EDIT_ITEM_BYTES_MIN, EDIT_ITEM_BYTES_MIN, EDIT_ITEM_BYTES_MAX), undefined);
  for (const bad of [1, READ_ITEM_BYTES_MAX + 1, 1.5, "2048", Number.NaN, null]) {
    const result = batchModule.checkItemBytes("read_file", bad, READ_ITEM_BYTES_MIN, READ_ITEM_BYTES_MAX);
    assert.ok(result, `${String(bad)} must be rejected`);
    const text = JSON.stringify(result);
    assert.match(text, /invalid_request/);
    assert.match(text, /max_response_bytes_per_item/);
  }
});

check("config() carries only machine metadata; the description comes from TOOL_DOCS", () => {
  const cfg = schema.config("Some tool", { speed_profile: "fast", batch_safe: true }, { readOnlyHint: true });
  assert.ok(!("description" in cfg), "config() must not invent a description");
  assert.deepEqual(Object.keys((cfg._meta as { venira: object }).venira).sort(), ["batch_safe", "speed_profile"]);
  const tools = new Map<string, { description?: string; _meta?: { venira?: Record<string, unknown> } }>();
  const server = {
    registerTool: (name: string, c: Record<string, unknown>) => {
      tools.set(name, c as never);
    },
  } as never;
  docs.applyToolDocs(server);
  files.registerFileTools(server, fileToolDeps);
  const read = tools.get("read_file")!;
  assert.match(read.description ?? "", /Use when:/);
  assert.equal(read._meta?.venira?.use_when, docs.TOOL_DOCS.read_file.use);
  assert.equal(read._meta?.venira?.batch_safe, true, "speed/batch metadata must survive applyToolDocs");
});

console.log(`[test-tool-schema] ${checks} checks passed.`);
