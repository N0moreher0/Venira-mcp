/**
 * Restrict all paths to WORKSPACE (default = the current working directory).
 * Standalone: no Rust host, no @grant paths — just plain workspace locking.
 */
import path from "node:path";

export const PLATFORM = process.platform;

export const WORKSPACE = path.resolve(process.env.VENIRA_WORKSPACE ?? process.cwd());

/** VENIRA_UNRESTRICTED=1: disable workspace lock, allow any absolute path (relative paths still resolve from WORKSPACE). */
export const UNRESTRICTED = ["1", "true", "on", "yes"].includes(
  (process.env.VENIRA_UNRESTRICTED ?? "").toLowerCase(),
);

export function toHostPath(input: string | undefined): string {
  const raw = (input ?? "").trim();
  const abs = path.resolve(WORKSPACE, raw === "" ? "." : raw);
  if (UNRESTRICTED) return abs;
  const rel = path.relative(WORKSPACE, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(
      `[path_escape] Path is outside the workspace (${WORKSPACE}): ${raw}. Hint: use a workspace-relative path or set VENIRA_UNRESTRICTED=1.`,
    );
  }
  return abs;
}
