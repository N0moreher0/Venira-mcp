/**
 * Pure helpers for the shell-policy coverage gate (`npm run coverage:shell`).
 *
 * Node's V8 test coverage prints one table; its `--test-coverage-*` flags only gate the aggregate. This
 * module parses that table so each `lib/shell-*.ts` module can also be held to its own floor:
 *
 *   - `parseCoverageReport`  table text -> metrics per module (plus the `all files` row)
 *   - `deriveFloors`         measured metrics -> floors a margin below them
 *   - `checkFloors`          measured metrics vs. floors -> violations / modules without a floor
 *
 * No I/O here, so `scripts/test-coverage-report.ts` can pin the behaviour on fixed samples.
 */

export type Metrics = { lines: number; branches: number; functions: number };
export type FloorsFile = { margin: number; modules: Record<string, Metrics> };
export type FloorCheck = {
  /** Module measured below one of its floors, one message per metric. */
  violations: string[];
  /** Modules in the report that have no floor yet (a new module must be added on purpose). */
  missing: string[];
  /** Modules with a floor that did not appear in the report (renamed or deleted). */
  stale: string[];
};

export const ALL_FILES_ROW = "all files";
const METRIC_KEYS: Array<keyof Metrics> = ["lines", "branches", "functions"];

/**
 * Parse the coverage table. Works for the `spec` reporter (`ℹ ` prefix) and the `tap` reporter (`# `
 * prefix). Directory rows have empty numbers and set the path prefix for the indented rows below them.
 */
export function parseCoverageReport(output: string): Map<string, Metrics> {
  const rows = new Map<string, Metrics>();
  const dirs: Array<{ indent: number; name: string }> = [];
  let inReport = false;
  for (const raw of output.split(/\r?\n/)) {
    if (raw.includes("start of coverage report")) {
      inReport = true;
      continue;
    }
    if (raw.includes("end of coverage report")) break;
    if (!inReport) continue;
    const cells = raw.replace(/^[ℹ#]\s?/u, "").split("|");
    if (cells.length < 4) continue;
    const label = cells[0] ?? "";
    const name = label.trim();
    if (name === "" || name === "file" || /^-+$/.test(name)) continue;
    const indent = label.length - label.trimStart().length;
    while (dirs.length > 0 && (dirs[dirs.length - 1] as { indent: number }).indent >= indent) dirs.pop();
    const [lines = "", branches = "", functions = ""] = cells.slice(1, 4).map((cell) => cell.trim());
    if (lines === "" && branches === "" && functions === "") {
      dirs.push({ indent, name });
      continue;
    }
    const values = [Number(lines), Number(branches), Number(functions)];
    if (values.some((value) => !Number.isFinite(value))) continue;
    const key = name === ALL_FILES_ROW ? name : [...dirs.map((dir) => dir.name), name].join("/");
    rows.set(key, { lines: values[0] as number, branches: values[1] as number, functions: values[2] as number });
  }
  return rows;
}

/** Floors `margin` points below the measured numbers (whole percents, never below 0). */
export function deriveFloors(measured: Map<string, Metrics>, margin: number): FloorsFile {
  const modules: Record<string, Metrics> = {};
  for (const key of [...measured.keys()].filter((name) => name !== ALL_FILES_ROW).sort()) {
    const row = measured.get(key) as Metrics;
    modules[key] = {
      lines: Math.max(0, Math.floor(row.lines - margin)),
      branches: Math.max(0, Math.floor(row.branches - margin)),
      functions: Math.max(0, Math.floor(row.functions - margin)),
    };
  }
  return { margin, modules };
}

export function checkFloors(measured: Map<string, Metrics>, floors: FloorsFile): FloorCheck {
  const violations: string[] = [];
  const missing: string[] = [];
  for (const [key, row] of measured) {
    if (key === ALL_FILES_ROW) continue;
    const floor = floors.modules[key];
    if (!floor) {
      missing.push(key);
      continue;
    }
    for (const metric of METRIC_KEYS) {
      if (row[metric] < floor[metric]) {
        violations.push(`${key}: ${metric} ${row[metric].toFixed(2)}% is below the floor of ${floor[metric]}%`);
      }
    }
  }
  const stale = Object.keys(floors.modules)
    .filter((key) => !measured.has(key))
    .sort();
  return { violations, missing: missing.sort(), stale };
}
