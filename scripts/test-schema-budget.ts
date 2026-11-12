/**
 * Phase 0 of ROADMAP_TOOL_SCHEMA.md: schema size budget.
 *
 * Measures what `tools/list` costs per tool (name + title + description + annotations +
 * JSON Schema of the input), prints a table, and fails when the total or any single tool grows
 * past the ceilings recorded in scripts/schema-budget.json.
 *
 * Size is an approximation: zod's own JSON Schema conversion, not the MCP SDK's serializer, and
 * tokens are estimated as bytes / 4. It is meant for before/after comparison, not absolute truth.
 *
 * Usage:
 *   npm run test:schema-budget                          check against the recorded ceilings
 *   npm run test:schema-budget -- --update              ratchet ceilings DOWN to current values
 *   npm run test:schema-budget -- --update --allow-increase
 *                                                       also accept growth (intentional only)
 *   npm run test:schema-budget -- --table               print the table only, never fail
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

process.env.VENIRA_JS_EXEC_MODE = "ask"; // so project_execute_js registers too (expert=44, default=33)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const budgetPath = path.join(repoRoot, "scripts", "schema-budget.json");
const load = (rel: string) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const dummy = async () => ({}) as never;

const args = new Set(process.argv.slice(2));
const UPDATE = args.has("--update");
const ALLOW_INCREASE = args.has("--allow-increase");
const TABLE_ONLY = args.has("--table");

type ToolCfg = {
  title?: string;
  description?: string;
  annotations?: unknown;
  inputSchema?: Record<string, unknown>;
};
const registered = new Map<string, ToolCfg>();
const fakeServer = {
  registerTool: (name: string, cfg: Record<string, unknown>) => {
    assert.ok(!registered.has(name), `duplicate registration: ${name}`);
    registered.set(name, cfg as ToolCfg);
  },
} as never;

const files = (await load("tools/project-register-files.ts")) as typeof import("../tools/project-register-files.js");
const shell = (await load("tools/project-register-shell.ts")) as typeof import("../tools/project-register-shell.js");
const ops = (await load("tools/project-register-ops.ts")) as typeof import("../tools/project-register-ops.js");
const codeintel = (await load(
  "tools/project-register-codeintel.ts",
)) as typeof import("../tools/project-register-codeintel.js");
const workflow = (await load(
  "tools/project-register-workflow.ts",
)) as typeof import("../tools/project-register-workflow.js");
const vcs = (await load("tools/project-register-vcs.ts")) as typeof import("../tools/project-register-vcs.js");
const toolMode = (await load("tools/project-tool-mode.ts")) as typeof import("../tools/project-tool-mode.js");
const docs = (await load("tools/project-docs.ts")) as typeof import("../tools/project-docs.js");

// Measure what tools/list really serves: registerProjectTools patches registerTool with TOOL_DOCS
// (model-facing descriptions) before any register* call, so the fake server must be patched too.
// Without this the table measured the inline fallback descriptions and ignored TOOL_DOCS edits.
docs.applyToolDocs(fakeServer);

files.registerFileTools(fakeServer, {
  runOne: dummy,
  hybridDeps: { execute: dummy } as never,
  recentFilesDeps: { lookup: dummy, store: dummy, recentEdits: new Set() } as never,
  batchDeps: { execute: dummy, maxBatchResponseBytes: 1 } as never,
  maxBatchItemBytes: 1,
  runSearchSelective: dummy,
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
});
workflow.registerWorkflowTools(fakeServer, {
  runDetectHarnesses: dummy,
  runInstallSelf: dummy,
  runExplainError: dummy,
  runPlanReadBatch: dummy,
  runSnapshot: dummy,
});
vcs.registerVcsTools(fakeServer, { runOne: dummy, runSecret: dummy });

/** Bytes one tool contributes to tools/list. */
function toolBytes(name: string, cfg: ToolCfg): number {
  const shape = cfg.inputSchema ?? {};
  const schema = (shape as { _zod?: unknown })._zod ? shape : z.object(shape as never);
  const inputSchema = z.toJSONSchema(schema as never, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete inputSchema.$schema;
  return Buffer.byteLength(
    JSON.stringify({
      name,
      title: cfg.title,
      description: cfg.description,
      annotations: cfg.annotations,
      inputSchema,
    }),
    "utf8",
  );
}

const defaultExcluded = new Set(toolMode.TOOL_MODE_EXCLUDES.default);
const rows = [...registered.entries()]
  .map(([name, cfg]) => ({ name, bytes: toolBytes(name, cfg), inDefault: !defaultExcluded.has(name) }))
  .sort((a, b) => b.bytes - a.bytes);

const expertTotal = rows.reduce((n, r) => n + r.bytes, 0);
const defaultRows = rows.filter((r) => r.inDefault);
const defaultTotal = defaultRows.reduce((n, r) => n + r.bytes, 0);
const tokens = (bytes: number) => Math.ceil(bytes / 4);
const kb = (bytes: number) => (bytes / 1024).toFixed(1);

type Budget = {
  expert: { tool_count: number; total_bytes: number };
  default: { tool_count: number; total_bytes: number };
  tools: Record<string, number>;
};
const current: Budget = {
  expert: { tool_count: rows.length, total_bytes: expertTotal },
  default: { tool_count: defaultRows.length, total_bytes: defaultTotal },
  tools: Object.fromEntries([...rows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => [r.name, r.bytes])),
};

const saved: Budget | undefined = fs.existsSync(budgetPath)
  ? (JSON.parse(fs.readFileSync(budgetPath, "utf8")) as Budget)
  : undefined;

// ---- table ----
const pad = (s: string, n: number) => s.padEnd(n);
const num = (s: string | number, n: number) => String(s).padStart(n);
console.log(`${pad("tool", 30)} ${num("bytes", 7)} ${num("~tok", 6)} ${num("ceiling", 8)}  mode`);
for (const r of rows) {
  const ceiling = saved?.tools[r.name];
  console.log(
    `${pad(r.name, 30)} ${num(r.bytes, 7)} ${num(tokens(r.bytes), 6)} ${num(ceiling ?? "-", 8)}  ${r.inDefault ? "D+E" : "E"}`,
  );
}
console.log("-".repeat(62));
console.log(
  `expert : ${rows.length} tools, ${expertTotal} B (${kb(expertTotal)} KB, ~${tokens(expertTotal)} tokens)` +
    (saved ? `, ceiling ${saved.expert.total_bytes} B` : ""),
);
console.log(
  `default: ${defaultRows.length} tools, ${defaultTotal} B (${kb(defaultTotal)} KB, ~${tokens(defaultTotal)} tokens)` +
    (saved ? `, ceiling ${saved.default.total_bytes} B` : ""),
);

if (TABLE_ONLY) process.exit(0);

// ---- update ----
if (UPDATE) {
  let next = current;
  if (saved && !ALLOW_INCREASE) {
    // Ratchet: a ceiling only moves down. Tools or totals that grew keep their old ceiling.
    next = {
      expert: {
        tool_count: current.expert.tool_count,
        total_bytes: Math.min(current.expert.total_bytes, saved.expert.total_bytes),
      },
      default: {
        tool_count: current.default.tool_count,
        total_bytes: Math.min(current.default.total_bytes, saved.default.total_bytes),
      },
      tools: Object.fromEntries(
        Object.entries(current.tools).map(([name, bytes]) => [name, Math.min(bytes, saved.tools[name] ?? bytes)]),
      ),
    };
  }
  fs.writeFileSync(budgetPath, JSON.stringify(next, null, 2) + "\n");
  console.log(`[schema-budget] wrote ${path.relative(repoRoot, budgetPath)}${saved ? " (ratchet down)" : " (new baseline)"}`);
  process.exit(0);
}

// ---- check ----
assert.ok(
  saved,
  "scripts/schema-budget.json is missing. Create the baseline with: npm run test:schema-budget -- --update",
);
const failures: string[] = [];
if (current.expert.tool_count !== saved.expert.tool_count) {
  failures.push(`expert tool count ${current.expert.tool_count}, expected ${saved.expert.tool_count}`);
}
if (current.default.tool_count !== saved.default.tool_count) {
  failures.push(`default tool count ${current.default.tool_count}, expected ${saved.default.tool_count}`);
}
if (current.expert.total_bytes > saved.expert.total_bytes) {
  failures.push(`expert total ${current.expert.total_bytes} B > ceiling ${saved.expert.total_bytes} B`);
}
if (current.default.total_bytes > saved.default.total_bytes) {
  failures.push(`default total ${current.default.total_bytes} B > ceiling ${saved.default.total_bytes} B`);
}
for (const [name, bytes] of Object.entries(current.tools)) {
  const ceiling = saved.tools[name];
  if (ceiling === undefined) failures.push(`${name}: no recorded ceiling (new tool? run with --update --allow-increase)`);
  else if (bytes > ceiling) failures.push(`${name}: ${bytes} B > ceiling ${ceiling} B`);
}
for (const name of Object.keys(saved.tools)) {
  if (!(name in current.tools)) failures.push(`${name}: recorded in the budget but no longer registered`);
}
assert.deepEqual(failures, [], `schema budget exceeded:\n  ${failures.join("\n  ")}`);
console.log("[test-schema-budget] ok");
