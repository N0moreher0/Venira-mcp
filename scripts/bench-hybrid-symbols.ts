/**
 * Benchmark: cost of symbol extraction in `search` hybrid mode, and what the 32-file cap hides.
 *
 * Hybrid search tags a hit `symbol_index` when it sits on a definition line. To find those lines it reads and
 * parses every file that produced a hit, but only the first 32 distinct files in walk order
 * (`tools/project-hybrid.ts`, `.slice(0, 32)`). This script answers two questions with the real code path:
 *
 *   1. Cost: how long does reading + `extractSymbols` take for 32 / 64 / 128 / 200 files of small, medium and
 *      large size? (200 is the most distinct files one search can return: the over-fetch is 200 hits.)
 *   2. Effect: when the definition lives in a file past the cap, does the ranking still surface it?
 *
 * It runs in a temp workspace, changes nothing in the repo and is not part of `verify`.
 *
 *   npm run bench:hybrid-symbols            (BENCH_RUNS=5 by default; the median of the runs is reported)
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would point the workspace at the real one
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-bench-hybrid-"));
const workspace = path.join(tempDir, "ws");
await mkdir(workspace, { recursive: true });
process.env.VENIRA_WORKSPACE = workspace;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");

const load = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(repoRoot, rel)).href)) as T;
const hybrid = await load<typeof import("../tools/project-hybrid.js")>("tools/project-hybrid.ts");
const codeintel = await load<typeof import("../tools/project-codeintel.js")>("tools/project-codeintel.ts");
const symbolDiff = await load<typeof import("../lib/symbol-diff.js")>("lib/symbol-diff.ts");

const RUNS = Math.max(1, Number(process.env.BENCH_RUNS) || 5);
const FILE_COUNTS = [32, 64, 128, 200];
const PROFILES = [
  { name: "small", lines: 200 },
  { name: "medium", lines: 2_000 },
  { name: "large", lines: 10_000 },
] as const;

function makeSource(id: number, lines: number): string {
  const out: string[] = [`// bench file ${id}`];
  for (let i = 0; i < lines; i++) {
    switch (i % 5) {
      case 0:
        out.push(`export function fn_${id}_${i}(a: number, b: number): number {`);
        break;
      case 1:
        out.push(`  const value = a * ${i} + b; // helper`);
        break;
      case 2:
        out.push(`  return value + ${i};`);
        break;
      case 3:
        out.push("}");
        break;
      default:
        out.push(`export const CONST_${id}_${i} = ${i};`);
    }
  }
  return `${out.join("\n")}\n`;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
};
const pad = (value: string | number, width: number): string => String(value).padStart(width);
const ms = (value: number): string => value.toFixed(1);

/** The production loop: concurrent reads, synchronous parse per file (`computeHybridSearch`). */
async function symbolize(files: string[]): Promise<number> {
  const started = performance.now();
  await Promise.allSettled(
    files.map(async (rel) => {
      const text = await codeintel.readTextFile(rel);
      if (text !== null) symbolDiff.extractSymbols(text);
    }),
  );
  return performance.now() - started;
}

// ---------------------------------------------------------------------------
// 1. Cost
// ---------------------------------------------------------------------------
console.log(`hybrid symbol extraction cost (median of ${RUNS} runs, node ${process.version}, ${os.cpus()[0]?.model ?? "cpu"})`);
console.log(`${pad("profile", 8)} ${pad("file KB", 8)} ${FILE_COUNTS.map((n) => pad(`${n} files`, 12)).join(" ")}   ms/file`);
const summary: Record<string, Record<string, number>> = {};
for (const profile of PROFILES) {
  const dir = path.join(workspace, profile.name);
  await mkdir(dir, { recursive: true });
  const names: string[] = [];
  let bytes = 0;
  for (let i = 0; i < Math.max(...FILE_COUNTS); i++) {
    const source = makeSource(i, profile.lines);
    bytes = Buffer.byteLength(source);
    const rel = `${profile.name}/f${String(i).padStart(3, "0")}.ts`;
    await writeFile(path.join(workspace, rel), source);
    names.push(rel);
  }
  await symbolize(names.slice(0, 8)); // warm-up (JIT, fs cache)
  const row: Record<string, number> = {};
  for (const count of FILE_COUNTS) {
    const samples: number[] = [];
    for (let run = 0; run < RUNS; run++) samples.push(await symbolize(names.slice(0, count)));
    row[String(count)] = median(samples);
  }
  summary[profile.name] = row;
  const perFile = (row[String(FILE_COUNTS[0])] as number) / (FILE_COUNTS[0] as number);
  console.log(
    `${pad(profile.name, 8)} ${pad((bytes / 1024).toFixed(0), 8)} ${FILE_COUNTS.map((n) => pad(ms(row[String(n)] as number), 12)).join(" ")}   ${perFile.toFixed(2)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Effect of the cap on ranking
// ---------------------------------------------------------------------------
const IDENT = "BenchTarget";
async function defAtIndex(defIndex: number): Promise<{ file: string; source: string; found: boolean }> {
  const dir = path.join(workspace, `demo-${defIndex}`);
  await mkdir(dir, { recursive: true });
  const hits: Record<string, unknown>[] = [];
  for (let i = 0; i < 200; i++) {
    const rel = `demo-${defIndex}/f${String(i).padStart(3, "0")}.ts`;
    const source = makeSource(i, 40);
    if (i === defIndex) {
      const body = `${source}export function ${IDENT}(): number { return 1; }\n`;
      await writeFile(path.join(workspace, rel), body);
      hits.push({ relative_path: rel, line_number: body.split("\n").length - 1, snippet: `export function ${IDENT}(): number { return 1; }` });
    } else {
      await writeFile(path.join(workspace, rel), source);
      hits.push({ relative_path: rel, line_number: 1, snippet: `const x = ${IDENT}(1);` });
    }
  }
  const deps = {
    execute: async () =>
      ({ response: { status: "completed", result: { kind: "search", data: { hits, complete: true } } }, cached: false }) as never,
  };
  const { response } = await hybrid.computeHybridSearch({ query: IDENT, hybrid: 1, limit: 1 }, deps);
  const top = ((response.result?.data as { hits?: Array<{ relative_path: string; source: string }> })?.hits ?? [])[0];
  return { file: top?.relative_path ?? "(none)", source: top?.source ?? "(none)", found: top?.source === "symbol_index" };
}

console.log(`\nranking with the 32-file cap (200 files hit "${IDENT}", limit 1; the definition is in file #N in walk order)`);
const effect: Record<string, boolean> = {};
for (const defIndex of [5, 31, 32, 150]) {
  const result = await defAtIndex(defIndex);
  effect[String(defIndex)] = result.found;
  console.log(`  def in file #${pad(defIndex, 3)}: top hit is ${pad(result.source, 16)} (${result.file}) -> ${result.found ? "definition surfaced" : "definition NOT surfaced"}`);
}

const medium = summary.medium as Record<string, number>;
console.log(
  `\nreading: lifting the cap from 32 to 200 files costs about ${ms((medium["200"] as number) - (medium["32"] as number))} ms more on medium (2k-line) files` +
    ` (${ms(medium["32"] as number)} -> ${ms(medium["200"] as number)} ms), and ${ms(((summary.large as Record<string, number>)["200"] as number))} ms on large (10k-line) files.`,
);
if (process.argv.includes("--json")) console.log(JSON.stringify({ summary, effect }));

await rm(tempDir, { recursive: true, force: true });
