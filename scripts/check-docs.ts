import fs from "node:fs";
const readme = fs.readFileSync("README.md", "utf8");
let failed = false;
if (readme.includes("37 workspace-scoped tools")) {
  console.error("README still says 37 tools; expected 40+.");
  failed = true;
}
if (!readme.includes("44 tools by default") || !readme.includes("## 4. Tools (44)")) {
  console.error("README tool count is out of date; expected 44 tools by default.");
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
process.exit(failed ? 1 : 0);
