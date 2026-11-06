import fs from "node:fs";
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
for (const tool of ["project_dependency_graph", "project_change_impact", "project_ci_wait"]) {
  if (!readme.includes(tool)) {
    console.error(`README is missing ${tool}.`);
    failed = true;
  }
}
// Tool counts: README must state the Default/Expert counts that doctor.ts treats as the contract
// (doctor expects 43 = Expert 42 + project_execute_js). Update all three together.
const EXPECTED_DEFAULT_TOOLS = 32;
const EXPECTED_EXPERT_TOOLS = 42;
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

// Env table: every VENIRA_* variable documented in the first column must still exist in the source.
const sourceRoots = ["lib", "tools", "scripts", "server.ts"];
const skipDirs = new Set(["node_modules", "dist", ".git"]);
function collectSource(p: string, out: string[]): void {
  if (!fs.existsSync(p)) return;
  const stat = fs.statSync(p);
  if (stat.isFile()) {
    if (/\.(ts|mjs|js)$/.test(p)) out.push(p);
    return;
  }
  for (const name of fs.readdirSync(p)) {
    if (!skipDirs.has(name)) collectSource(`${p}/${name}`, out);
  }
}
const sourceFiles: string[] = [];
for (const root of sourceRoots) collectSource(root, sourceFiles);
const source = sourceFiles
  .filter((f) => !f.endsWith("check-docs.ts"))
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n");
const documented = new Set<string>();
for (const line of readme.split(/\r?\n/)) {
  if (!line.startsWith("| `VENIRA_")) continue;
  const firstCell = line.split("|")[1] ?? "";
  for (const m of firstCell.matchAll(/`(VENIRA_[A-Z0-9_]+)`/g)) documented.add(m[1]);
}
for (const name of documented) {
  if (!source.includes(name)) {
    console.error(`README documents ${name}, but it does not appear in the source.`);
    failed = true;
  }
}

if (!failed) {
  console.log(`check:docs ok (tool counts ${EXPECTED_DEFAULT_TOOLS}/${EXPECTED_EXPERT_TOOLS}, ${documented.size} documented env vars found in source)`);
}
process.exit(failed ? 1 : 0);
