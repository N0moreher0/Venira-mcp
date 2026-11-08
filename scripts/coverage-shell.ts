/**
 * Shell-policy coverage gate.
 *
 * Runs the shell-policy suites under Node's V8 test coverage (`lib/shell-*.ts` only), prints the report and
 * enforces two things:
 *
 *   1. the aggregate floors (Node's own `--test-coverage-*` flags), and
 *   2. a floor per module from `scripts/coverage-floors.json` (Node only gates the aggregate, so this
 *      script parses the table; see `scripts/coverage-report.ts`).
 *
 * The suites double as the shell-policy part of `npm run verify`: a failing suite fails this command.
 *
 *   npm run coverage:shell                        run, print the report, enforce all floors
 *   npm run coverage:shell -- --update-floors     rewrite scripts/coverage-floors.json from this run
 *                                                  (only when every suite passed)
 *
 * Floors sit `margin` points below the measured numbers. Header comment blocks count as uncovered lines
 * (tsx strips comments before V8 measures), so line percentages are a lower bound and a small margin keeps
 * the gate stable. A new `lib/shell-*.ts` module has no floor yet and fails the gate until the floors are
 * regenerated on purpose.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_FILES_ROW, checkFloors, deriveFloors, parseCoverageReport } from "./coverage-report.js";
import type { FloorsFile } from "./coverage-report.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLOORS_FILE = path.join(repoRoot, "scripts", "coverage-floors.json");
const MARGIN = 4;
const AGGREGATE = { lines: 92, branches: 92, functions: 95 };
const SUITES = [
  "scripts/test-shell-policy-adversarial.ts",
  "scripts/test-shell-policy-fuzz.ts",
  "scripts/test-balanced-read-only.ts",
  "scripts/test-restore-checkpoint.ts",
  "scripts/test-shell-security-regressions.ts",
  "scripts/test-shell-session-cache.ts",
  "scripts/test-shell-policy-file.ts",
  "scripts/test-shell-tokenizer-edges.ts",
  "scripts/test-shell-unavailable.ts",
];

const updateFloors = process.argv.includes("--update-floors");

function runSuites(): Promise<{ code: number; output: string }> {
  const args = [
    "--import",
    "tsx",
    "--test",
    "--test-reporter=spec",
    "--experimental-test-coverage",
    "--enable-source-maps",
    `--test-coverage-lines=${AGGREGATE.lines}`,
    `--test-coverage-branches=${AGGREGATE.branches}`,
    `--test-coverage-functions=${AGGREGATE.functions}`,
    "--test-coverage-include=lib/shell-*.ts",
    ...SUITES,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output: chunks.join("") }));
  });
}

/** The coverage table only (the suites' own output is long and only matters when something fails). */
function reportBlock(output: string): string {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("start of coverage report"));
  const end = lines.findIndex((line) => line.includes("end of coverage report"));
  return start >= 0 && end >= start ? lines.slice(start, end + 1).join("\n") : "";
}

const { code, output } = await runSuites();
const report = reportBlock(output);
if (report) console.log(report);
if (code !== 0) {
  console.error("\n--- last 60 lines of the suite output ---");
  console.error(output.split(/\r?\n/).slice(-60).join("\n"));
}

const measured = parseCoverageReport(output);
const aggregate = measured.get(ALL_FILES_ROW);
if (!aggregate || measured.size < 2) {
  console.error("coverage:shell: no coverage table in the output (did the suites run?)");
  process.exit(code !== 0 ? code : 1);
}

if (updateFloors) {
  if (code !== 0) {
    console.error("coverage:shell: floors not updated because a suite failed");
    process.exit(code);
  }
  const floors = deriveFloors(measured, MARGIN);
  writeFileSync(FLOORS_FILE, `${JSON.stringify(floors, null, 2)}\n`);
  console.log(`coverage:shell: wrote ${path.relative(repoRoot, FLOORS_FILE)} (${Object.keys(floors.modules).length} modules, margin ${MARGIN})`);
  process.exit(0);
}

if (!existsSync(FLOORS_FILE)) {
  console.error("coverage:shell: scripts/coverage-floors.json is missing. Run: npm run coverage:shell -- --update-floors");
  process.exit(1);
}
const floors = JSON.parse(readFileSync(FLOORS_FILE, "utf8")) as FloorsFile;
const { violations, missing, stale } = checkFloors(measured, floors);

for (const name of stale) console.warn(`coverage:shell: warning: floor for ${name} but it is not in the report (renamed or removed?)`);
if (missing.length > 0) {
  console.error(`coverage:shell: no floor for ${missing.join(", ")}. Run: npm run coverage:shell -- --update-floors`);
}
for (const violation of violations) console.error(`coverage:shell: ${violation}`);

const failed = code !== 0 || violations.length > 0 || missing.length > 0;
console.log(
  `coverage:shell: ${measured.size - 1} modules, all files ${aggregate.lines.toFixed(2)}% lines / ${aggregate.branches.toFixed(2)}% branches / ${aggregate.functions.toFixed(2)}% functions; ` +
    (failed ? "FAILED" : "all module floors met"),
);
process.exit(failed ? (code !== 0 ? code : 1) : 0);
