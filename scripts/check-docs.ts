import fs from "node:fs";
const readme = fs.readFileSync("README.md", "utf8");
let failed = false;
if (readme.includes("37 workspace-scoped tools")) {
  console.error("README still says 37 tools; expected 40+.");
  failed = true;
}
if (!readme.includes("VENIRA_PROFILE")) {
  console.error("README missing VENIRA_PROFILE.");
  failed = true;
}
process.exit(failed ? 1 : 0);
