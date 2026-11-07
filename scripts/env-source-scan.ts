/**
 * Shared scanner: which `VENIRA_*` names does the runtime source reference?
 * Used by `check-docs.ts` and `test-env-registry.ts` so both agree on what
 * "the source" means. Test files, the verify harness, this scanner and the
 * registry itself are excluded: they would make the comparison circular.
 */
import fs from "node:fs";
import path from "node:path";

const RUNTIME_ROOTS = ["lib", "tools", "scripts", "server.ts"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SKIP_FILE = /(^|[\\/])(env-registry\.ts|env-source-scan\.ts|check-docs\.ts|verify\.ts|test-[^\\/]*\.ts|policy-corpus[^\\/]*\.ts)$/;

/** Whole variable names only: no `VENIRA_GIT_*` wildcards, no template fragments such as `VENIRA_${x}`. */
const NAME = /VENIRA_[A-Z0-9]+(?:_[A-Z0-9]+)*(?![A-Z0-9_*])/g;

function walk(target: string, out: string[]): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (/\.(ts|mjs|js)$/.test(target) && !SKIP_FILE.test(target)) out.push(target);
    return;
  }
  for (const name of fs.readdirSync(target)) {
    if (!SKIP_DIRS.has(name)) walk(path.join(target, name), out);
  }
}

export function runtimeSourceFiles(root: string = process.cwd()): string[] {
  const files: string[] = [];
  for (const entry of RUNTIME_ROOTS) walk(path.join(root, entry), files);
  return files.sort();
}

/** name -> files (relative to root) that mention it. */
export function scanRuntimeEnvNames(root: string = process.cwd()): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of runtimeSourceFiles(root)) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).replace(/\\/g, "/");
    for (const match of new Set(text.match(NAME) ?? [])) {
      const files = found.get(match) ?? [];
      files.push(rel);
      found.set(match, files);
    }
  }
  return found;
}
