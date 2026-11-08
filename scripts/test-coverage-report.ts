/**
 * Unit tests for the coverage gate helpers (`scripts/coverage-report.ts`): parsing Node's coverage table,
 * deriving floors and checking measured numbers against them. Fixed samples, no process spawning.
 *
 * Run with: npm run test:coverage-report
 */
import assert from "node:assert/strict";
import { ALL_FILES_ROW, checkFloors, deriveFloors, parseCoverageReport } from "./coverage-report.js";
import type { FloorsFile, Metrics } from "./coverage-report.js";

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

const RULE = "-".repeat(60);
const spec = [
  "ℹ tests 8",
  "ℹ start of coverage report",
  `ℹ ${RULE}`,
  "ℹ file                  | line % | branch % | funcs % | uncovered lines",
  `ℹ ${RULE}`,
  "ℹ lib                   |        |          |         | ",
  "ℹ  shell-cache.ts       |  92.31 |    97.54 |  100.00 | 1-18 20",
  "ℹ  shell-parser.ts      | 100.00 |    86.67 |  100.00 | ",
  "ℹ  shell-policy-tables.ts |  97.44 |    91.45 |   93.80 | 1-4 161",
  `ℹ ${RULE}`,
  "ℹ all files             |  93.72 |    93.67 |   96.56 | ",
  `ℹ ${RULE}`,
  "ℹ end of coverage report",
  "ℹ  ignored.ts | 1.00 | 1.00 | 1.00 | after the report",
].join("\n");

check("parses_the_spec_reporter_table_with_paths_from_directory_rows", () => {
  const rows = parseCoverageReport(spec);
  assert.deepEqual([...rows.keys()].sort(), ["all files", "lib/shell-cache.ts", "lib/shell-parser.ts", "lib/shell-policy-tables.ts"]);
  assert.deepEqual(rows.get("lib/shell-cache.ts"), { lines: 92.31, branches: 97.54, functions: 100 });
  assert.deepEqual(rows.get("lib/shell-policy-tables.ts"), { lines: 97.44, branches: 91.45, functions: 93.8 });
  assert.deepEqual(rows.get(ALL_FILES_ROW), { lines: 93.72, branches: 93.67, functions: 96.56 });
});

check("parses_the_tap_reporter_prefix_and_ignores_rows_outside_the_report", () => {
  const tap = spec.replaceAll("ℹ", "#");
  assert.deepEqual(parseCoverageReport(tap), parseCoverageReport(spec));
  assert.equal(parseCoverageReport(spec).has("lib/ignored.ts"), false);
  assert.equal(parseCoverageReport("no table here").size, 0);
});

check("nested_directories_build_the_full_path_and_siblings_reset_it", () => {
  const nested = [
    "ℹ start of coverage report",
    "ℹ lib                |        |        |        | ",
    "ℹ  deep              |        |        |        | ",
    "ℹ   a.ts             |  90.00 |  80.00 |  70.00 | ",
    "ℹ  b.ts              |  91.00 |  81.00 |  71.00 | ",
    "ℹ tools              |        |        |        | ",
    "ℹ  c.ts              |  92.00 |  82.00 |  72.00 | ",
    "ℹ end of coverage report",
  ].join("\n");
  assert.deepEqual([...parseCoverageReport(nested).keys()], ["lib/deep/a.ts", "lib/b.ts", "tools/c.ts"]);
});

check("rows_with_unreadable_numbers_are_skipped_not_guessed", () => {
  const broken = ["ℹ start of coverage report", "ℹ  odd.ts | n/a | 1 | 1 | ", "ℹ  ok.ts | 50 | 60 | 70 | ", "ℹ end of coverage report"].join("\n");
  assert.deepEqual([...parseCoverageReport(broken).keys()], ["ok.ts"]);
});

const measured = new Map<string, Metrics>([
  ["lib/a.ts", { lines: 92.31, branches: 97.54, functions: 100 }],
  ["lib/b.ts", { lines: 3.5, branches: 2, functions: 0 }],
  [ALL_FILES_ROW, { lines: 50, branches: 50, functions: 50 }],
]);

check("derive_floors_takes_the_margin_off_in_whole_percents_and_never_goes_below_zero", () => {
  const floors = deriveFloors(measured, 4);
  assert.equal(floors.margin, 4);
  assert.deepEqual(floors.modules["lib/a.ts"], { lines: 88, branches: 93, functions: 96 });
  assert.deepEqual(floors.modules["lib/b.ts"], { lines: 0, branches: 0, functions: 0 });
  assert.equal(ALL_FILES_ROW in floors.modules, false, "the aggregate row has no module floor");
});

check("the_run_that_produced_the_floors_always_passes_them", () => {
  const result = checkFloors(measured, deriveFloors(measured, 4));
  assert.deepEqual(result, { violations: [], missing: [], stale: [] });
});

check("a_drop_below_a_floor_names_the_module_and_the_metric", () => {
  const floors = deriveFloors(measured, 4);
  const dropped = new Map(measured).set("lib/a.ts", { lines: 80, branches: 97.54, functions: 90 });
  const { violations } = checkFloors(dropped, floors);
  assert.equal(violations.length, 2);
  assert.match(violations[0] as string, /^lib\/a\.ts: lines 80\.00% is below the floor of 88%$/);
  assert.match(violations[1] as string, /^lib\/a\.ts: functions 90\.00% is below the floor of 96%$/);
});

check("exactly_at_the_floor_passes", () => {
  const floors: FloorsFile = { margin: 4, modules: { "lib/a.ts": { lines: 88, branches: 93, functions: 96 } } };
  const edge = new Map<string, Metrics>([["lib/a.ts", { lines: 88, branches: 93, functions: 96 }]]);
  assert.deepEqual(checkFloors(edge, floors).violations, []);
});

check("a_new_module_is_missing_and_a_removed_module_is_stale", () => {
  const floors: FloorsFile = {
    margin: 4,
    modules: { "lib/a.ts": { lines: 0, branches: 0, functions: 0 }, "lib/gone.ts": { lines: 0, branches: 0, functions: 0 } },
  };
  const { missing, stale, violations } = checkFloors(measured, floors);
  assert.deepEqual(missing, ["lib/b.ts"]);
  assert.deepEqual(stale, ["lib/gone.ts"]);
  assert.deepEqual(violations, []);
});

console.log(`coverage-report: ${checks} checks passed`);
