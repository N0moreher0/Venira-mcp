/**
 * Dependency graph — kiểu dùng chung + helper đường dẫn/bảo vệ.
 * Tách khỏi dependency-graph.ts; hành vi giữ nguyên.
 */
import path from "node:path";
import { isProtectedPath } from "./workspace.js";

export type GraphLanguage = "ts" | "js" | "tsx" | "jsx" | "py" | "rs" | "go" | "java" | "kotlin";
export type EdgeConfidence = "exact" | "likely" | "possible";
export type EdgeType = "import" | "extends" | "implements" | "references";

export const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function normalizeRel(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === "" ? "." : normalized;
}

export function isInside(rootAbs: string, abs: string): boolean {
  const rel = path.relative(rootAbs, abs);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

export function relFromRoot(rootAbs: string, abs: string): string {
  if (!isInside(rootAbs, abs)) {
    throw new Error(`[path_escape] Path is outside the workspace: ${abs}. Hint: use a workspace-relative path.`);
  }
  return normalizeRel(path.relative(rootAbs, abs));
}

export function protectedLike(absPath: string, rel: string): boolean {
  if (isProtectedPath(absPath)) return true;
  // The shared guard covers secrets.json/secrets.key; also skip other data
  // files named `secrets.*`, but never a source module such as secrets.ts.
  const base = path.basename(rel).toLowerCase();
  const ext = path.extname(base);
  const sourceExt = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs"]);
  return /^secrets\./.test(base) && !sourceExt.has(ext);
}
