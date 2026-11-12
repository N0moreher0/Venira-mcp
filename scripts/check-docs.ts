import fs from "node:fs";
import { scanRuntimeEnvNames } from "./env-source-scan.js";
const readme = fs.readFileSync("README.md", "utf8");
let failed = false;
if (readme.includes("37 workspace-scoped tools")) {
  console.error("README still says 37 tools; expected the Default/Expert tool modes.");
  failed = true;
}
if (readme.includes("44 tools by default")) {
  console.error("README tool count is out of date; expected Default/Expert tool modes.");
  failed = true;
}
if (!readme.includes("Two tool modes") || !readme.includes("VENIRA_TOOL_MODE")) {
  console.error("README tool-mode contract is out of date; expected Default/Expert modes (VENIRA_TOOL_MODE) documented.");
  failed = true;
}
if (!readme.includes("VENIRA_PROFILE")) {
  console.error("README missing VENIRA_PROFILE.");
  failed = true;
}
if (!readme.includes("> **Security scope.**") || !readme.includes("not a sandbox")) {
  console.error("README is missing the security-limit notice.");
  failed = true;
}
if (readme.includes("| `VENIRA_NETWORK` |")) {
  console.error("README documents VENIRA_NETWORK, which has been removed.");
  failed = true;
}
for (const tool of ["project_dependency_graph", "project_change_impact", "project_ci_wait"]) {
  if (!readme.includes(tool)) {
    console.error(`README is missing ${tool}.`);
    failed = true;
  }
}
// Tool counts: README must state the Default/Expert counts that doctor.ts treats as the contract.
// Default = Expert minus the 11 PR/CI tools minus project_explain_error and project_plan_read_batch = 40 - 13 = 27.
// Expert = 43 - 1 (project_selective_search merged into project_search) - 2 (setup tools, VENIRA_SETUP_TOOLS=1) = 40.
// +1 tool with VENIRA_JS_EXEC_MODE=ask|semi-auto|auto (project_execute_js). schema-budget records that set (28/41).
// Update check-docs.ts, doctor.ts, README and schema-budget.json together.
const EXPECTED_DEFAULT_TOOLS = 27;
const EXPECTED_EXPERT_TOOLS = 40;
for (const phrase of [
  `${EXPECTED_DEFAULT_TOOLS} coding tools`,
  `${EXPECTED_EXPERT_TOOLS} tools`,
  `(${EXPECTED_DEFAULT_TOOLS} tools)`,
  `(${EXPECTED_EXPERT_TOOLS} tools)`,
]) {
  if (!readme.includes(phrase)) {
    console.error(`README tool count drifted: expected to find "${phrase}".`);
    failed = true;
  }
}

// Env table: every VENIRA_* variable documented in the first column must still exist in the runtime source
// (same scanner as test-env-registry.ts, so docs, registry and source agree on what "source" means).
const runtimeNames = scanRuntimeEnvNames();
const documented = new Set<string>();
for (const line of readme.split(/\r?\n/)) {
  if (!line.startsWith("| `VENIRA_")) continue;
  const firstCell = line.split("|")[1] ?? "";
  for (const m of firstCell.matchAll(/`(VENIRA_[A-Z0-9_]+)`/g)) documented.add(m[1]);
}
for (const name of documented) {
  if (!runtimeNames.has(name)) {
    console.error(`README documents ${name}, but it is not in the runtime source.`);
    failed = true;
  }
}

// Release versions: package.json, package-lock.json, server.json and lib/version.ts must agree
// (1.20.0 shipped with lib/version.ts left at 1.19.0, which made the doctor preflight and CI fail).
{
  const pkgVersion = (JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }).version;
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as {
    version?: string;
    packages?: Record<string, { version?: string }>;
  };
  const server = JSON.parse(fs.readFileSync("server.json", "utf8")) as {
    version?: string;
    packages?: Array<{ version?: string }>;
  };
  const versionTs = /VERSION\s*=\s*"([^"]+)"/.exec(fs.readFileSync("lib/version.ts", "utf8"))?.[1];
  const found: Array<[string, string | undefined]> = [
    ["package-lock.json", lock.version],
    ['package-lock.json packages[""]', lock.packages?.[""]?.version],
    ["server.json", server.version],
    ...(server.packages ?? []).map((p, i): [string, string | undefined] => [`server.json packages[${i}]`, p.version]),
    ["lib/version.ts", versionTs],
  ];
  for (const [where, value] of found) {
    if (value !== pkgVersion) {
      console.error(`${where} is ${value ?? "missing"}, but package.json is ${pkgVersion}. Bump them together.`);
      failed = true;
    }
  }
}

if (!failed) {
  console.log(`check:docs ok (tool counts ${EXPECTED_DEFAULT_TOOLS}/${EXPECTED_EXPERT_TOOLS}, ${documented.size} documented env vars found in source)`);
}
process.exit(failed ? 1 : 0);
