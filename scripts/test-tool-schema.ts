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
 *   4. project_edit_batch's typed item shape stays in sync with the runtime
 *      EDIT_ITEM_KEYS validator.
 *   5. (ROADMAP_TOOL_SCHEMA.md, phase 3) The fuzzy edit options are advertised, and mentioned in the
 *      model-facing text, only when VENIRA_EDIT_FUZZY=1; with it off they are still let through to the
 *      handler (which refuses them with a clear error) instead of being stripped.
 *   6. (phase 4) project_create advertises directory-only arguments; shell_run.background is advertised
 *      as the integer 0|1 while its handler keeps accepting booleans and strings. (phase 5) the removed
 *      file arguments still reach the handler, which refuses them with `[unsupported]`.
 *
 * Run with: npm run test:tool-schema
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

process.env.VENIRA_JS_EXEC_MODE = "ask"; // so project_execute_js registers too

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
const docs = (await load(
  "tools/project-docs.ts",
)) as typeof import("../tools/project-docs.js");
const schema = (await load(
  "tools/project-schema.ts",
)) as typeof import("../tools/project-schema.js");
const argHints = (await load(
  "lib/arg-hints.ts",
)) as typeof import("../lib/arg-hints.js");

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
 * The parameter map of a registered tool: a raw shape, or a zod object (project_edit_file is registered as
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

check("deprecated parameters are gone from the schema", () => {
  const shellKeys = Object.keys(registered.get("project_shell_run")!.inputSchema!);
  assert.ok(!shellKeys.includes("approval_token"), `shell_run still advertises approval_token: ${shellKeys.join(",")}`);
  assert.ok(!shellKeys.includes("approval_scope"), `shell_run still advertises approval_scope: ${shellKeys.join(",")}`);
  const snapshotKeys = Object.keys(shapeOf(registered.get("project_snapshot")!.inputSchema));
  assert.ok(!snapshotKeys.includes("scope"), `snapshot still advertises the removed scope alias: ${snapshotKeys.join(",")}`);
  assert.ok(snapshotKeys.includes("paths"), "snapshot must advertise paths (the replacement for scope)");
  const editKeys = Object.keys(shapeOf(registered.get("project_edit_file")!.inputSchema));
  assert.ok(!editKeys.includes("guard"), `edit_file still advertises the removed guard flag: ${editKeys.join(",")}`);
  assert.ok(editKeys.includes("expected_sha256"), "edit_file must advertise expected_sha256 (the replacement for guard)");
});

check("removed scope and guard still reach the handlers (loose objects, not stripped)", () => {
  // A cached client sends the old names; stripping them would silently widen the checkpoint to the
  // whole workspace (scope) or silently skip verification (guard). Loose objects let the handlers
  // refuse them with `[unsupported]` and name the replacement.
  const snapshotInput = registered.get("project_snapshot")!.inputSchema as unknown as z.ZodType;
  const snap = snapshotInput.safeParse({ action: "create", scope: ["lib"] });
  assert.ok(snap.success, "a cached client's scope call must reach the handler, not be stripped");
  assert.deepEqual((snap.data as Record<string, unknown>).scope, ["lib"]);

  const editInput = registered.get("project_edit_file")!.inputSchema as unknown as z.ZodType;
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
    for (const tool of ["project_edit_file"]) {
      assert.ok(
        !(legacy in shapeOf(registered.get(tool)!.inputSchema)),
        `${tool} still advertises legacy key ${legacy}`,
      );
    }
    const batchKeys = Object.keys(defOf(schema.editBatchItemFor(true))!.shape as Record<string, unknown>);
    assert.ok(!batchKeys.includes(legacy), `editBatchItem still advertises legacy key ${legacy}`);
  }
});

// ---- Phase 4: project_create advertises directory-only arguments ----
check("project_create advertises directory-only arguments", () => {
  const createInput = registered.get("project_create")!.inputSchema as unknown as z.ZodType;
  const keys = Object.keys(shapeOf(createInput));
  for (const legacy of ["kind", "content", "mode", "expected_sha256"]) {
    assert.ok(!keys.includes(legacy), `project_create still advertises the removed file argument ${legacy}`);
  }
  assert.ok(keys.includes("relative_path"), "project_create must still require relative_path");
});

// Phase 5: the removed file arguments still reach the handler, which refuses them with `[unsupported]`
// instead of creating an empty directory where the caller wanted a file.
check("project_create still lets the removed file arguments through to the handler", () => {
  const createInput = registered.get("project_create")!.inputSchema as unknown as z.ZodType;
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
const fuzzyIn = (keys: string[]) => keys.filter((k) => FUZZY.includes(k)).sort();
const editFileKeys = (tools: Registered) => Object.keys(shapeOf(tools.get("project_edit_file")!.inputSchema));
/** The zod schema of one project_edit_batch item (`edits` is an array of loose objects). */
const batchItemSchema = (tools: Registered) =>
  defOf(shapeOf(tools.get("project_edit_batch")!.inputSchema).edits)!.element as z.ZodType;
const batchItemKeys = (tools: Registered) => Object.keys(defOf(batchItemSchema(tools))!.shape as Record<string, unknown>);
/** JSON Schema of one tool's input, as tools/list would carry it. */
function jsonOf(input: unknown): string {
  const schema = (input as { _zod?: unknown })._zod ? input : z.object(input as never);
  return JSON.stringify(z.toJSONSchema(schema as never, { io: "input", unrepresentable: "any" }));
}

check("fuzzy off: edit_file and edit_batch items do not advertise the fuzzy options", () => {
  assert.deepEqual(fuzzyIn(editFileKeys(fuzzyOff)), []);
  assert.deepEqual(fuzzyIn(batchItemKeys(fuzzyOff)), []);
});

check("fuzzy on: edit_file and edit_batch items advertise all three fuzzy options", () => {
  assert.deepEqual(fuzzyIn(editFileKeys(fuzzyOn)), [...FUZZY].sort());
  assert.deepEqual(fuzzyIn(batchItemKeys(fuzzyOn)), [...FUZZY].sort());
});

check("fuzzy off: nothing about fuzzy matching in the edit tools' text or schema", () => {
  for (const tool of ["project_edit_file", "project_edit_batch"]) {
    const cfg = fuzzyOff.get(tool)!;
    assert.ok(!/fuzzy/i.test(cfg.description ?? ""), `${tool} description still mentions fuzzy matching`);
    assert.ok(!/fuzzy/i.test(jsonOf(cfg.inputSchema)), `${tool} schema still mentions fuzzy matching`);
  }
});

check("fuzzy on: the edit_file text explains the fuzzy fallback", () => {
  const cfg = fuzzyOn.get("project_edit_file")!;
  assert.match(cfg.description ?? "", /fuzzy_distance/);
  const oldText = shapeOf(cfg.inputSchema).old_text;
  assert.match(effectiveDescription(oldText) ?? "", /near-match/);
});

check("fuzzy off: edit_file and edit_batch items still let fuzzy options through to the handler", () => {
  const input = { relative_path: "a.txt", old_text: "x", new_text: "y", case_insensitive: 1, fuzzy_distance: 2 };
  const editFile = fuzzyOff.get("project_edit_file")!.inputSchema as z.ZodType;
  const one = editFile.safeParse(input);
  assert.ok(one.success, "edit_file rejected a fuzzy option while fuzzy is off");
  assert.equal((one.data as Record<string, unknown>).case_insensitive, 1, "edit_file stripped case_insensitive");
  assert.equal((one.data as Record<string, unknown>).fuzzy_distance, 2, "edit_file stripped fuzzy_distance");
  const item = batchItemSchema(fuzzyOff).safeParse(input);
  assert.ok(item.success, "edit_batch item rejected a fuzzy option while fuzzy is off");
  assert.equal((item.data as Record<string, unknown>).case_insensitive, 1, "edit_batch item stripped case_insensitive");
});

check("fuzzy on: the options are typed (flag becomes boolean, distance is capped at 10)", () => {
  const editFile = fuzzyOn.get("project_edit_file")!.inputSchema as z.ZodType;
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

console.log(`[test-tool-schema] ${checks} checks passed.`);
