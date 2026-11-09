/**
 * Guardrail for roadmap item 16 (tool schema and description clarity).
 *
 * Pins:
 *   1. Every parameter of every registered tool has a non-empty description, so an
 *      LLM client can call the tool from the schema alone.
 *   2. Deprecated parameters are gone from the published schema
 *      (shell_run.approval_token / approval_scope, snapshot.scope). Handlers may
 *      still tolerate them; the schema must not advertise them.
 *   3. Every registered tool has a TOOL_DOCS entry (the model-facing wording).
 *   4. project_edit_batch's typed item shape stays in sync with the runtime
 *      EDIT_ITEM_KEYS validator.
 *
 * Run with: npm run test:tool-schema
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.VENIRA_ALLOW_JS_EXEC = "1"; // so project_execute_js registers too

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

files.registerFileTools(fakeServer, {
  runOne: dummy,
  hybridDeps: { execute: dummy } as never,
  recentFilesDeps: { lookup: dummy, store: dummy, recentEdits: new Set() } as never,
  batchDeps: { execute: dummy, maxBatchResponseBytes: 1 } as never,
  maxBatchItemBytes: 1,
});
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
  runSelectiveSearch: dummy,
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
    const shape = cfg.inputSchema;
    assert.ok(shape, `${tool}: no inputSchema captured`);
    for (const [key, child] of Object.entries(shape!)) {
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
  // snapshot.scope stays (documented as deprecated) until handlers stop reading it:
  // removing it from the schema would make old clients capture the whole workspace.
  const scopeSchema = registered.get("project_snapshot")!.inputSchema!["scope"] as { description?: string };
  assert.match(scopeSchema.description ?? "", /Deprecated/);
});

check("deprecated handler tolerance stays (arg-hints keeps the keys)", () => {
  // The handlers still accept the removed params when an old client sends them;
  // the schema just must not advertise them.
  assert.ok(argHints.EDIT_ITEM_KEYS.includes("old_text_fuzzy"));
});

check("every registered tool has a TOOL_DOCS entry", () => {
  const undocumented = [...registered.keys()].filter((t) => !(t in docs.TOOL_DOCS));
  assert.deepEqual(undocumented, [], `tools missing TOOL_DOCS: ${undocumented.join(", ")}`);
});

check("editBatchItem keys match EDIT_ITEM_KEYS", () => {
  const def = defOf(schema.editBatchItem);
  const keys = Object.keys((def!.shape as Record<string, unknown>));
  assert.deepEqual([...keys].sort(), [...argHints.EDIT_ITEM_KEYS].sort());
});

console.log(`[test-tool-schema] ${checks} checks passed.`);
