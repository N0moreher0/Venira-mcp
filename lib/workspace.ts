/**
 * Restrict all paths to WORKSPACE (default = the current working directory).
 * Standalone: no Rust host, no @grant paths — just plain workspace locking.
 */
import path from "node:path";
import fs from "node:fs";
export const PLATFORM = process.platform;

export const WORKSPACE = path.resolve(process.env.VENIRA_WORKSPACE ?? process.cwd());

import os from "node:os";
export function migrateLegacyDataDirIfNeeded(): void {
  if (process.env.VENIRA_DATA_DIR?.trim()) return;
  const legacy = path.join(WORKSPACE, "data");
  const modern = defaultDataDir();
  if (!fs.existsSync(legacy)) return;
  // Atomically claim `modern`: plain mkdirSync (no recursive) throws EEXIST
  // if the directory is already there. Several server processes can start
  // at once (verify spawns many), and the old existsSync-then-cpSync check
  // was a TOCTOU race -- every process that saw "modern missing" would
  // re-run cpSync, and a later copy could clobber a sibling process's
  // venira.db mid-write, silently wiping out audit rows written moments
  // earlier. Only the process that wins the exclusive mkdir migrates;
  // everyone else (an already-migrated dir, or a sibling mid-migration)
  // leaves it alone.
  try {
    fs.mkdirSync(path.dirname(modern), { recursive: true });
    fs.mkdirSync(modern);
  } catch {
    return; // modern already exists (real data or a concurrent migration)
  }
  try {
    fs.cpSync(legacy, modern, { recursive: true });
  } catch {
    // best-effort; fallback paths remain in place
  }
}

/** The data directory actually in use (env override, else the per-user default). */
export function activeDataDir(): string {
  const env = process.env.VENIRA_DATA_DIR?.trim();
  return env ? path.resolve(env) : defaultDataDir();
}

function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function defaultDataDir(): string {
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "venira");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "venira");
  return path.join(home, ".local", "share", "venira");
}

/** VENIRA_UNRESTRICTED=1: disable workspace lock, allow any absolute path (relative paths still resolve from WORKSPACE). */
export const UNRESTRICTED = ["1", "true", "on", "yes"].includes(
  (process.env.VENIRA_UNRESTRICTED ?? "").toLowerCase(),
);

/** VENIRA_ALLOW_JS_EXEC must be explicitly enabled (default off in v1.7.0). */
export const ALLOW_JS_EXEC = ["1", "true", "on", "yes"].includes(
  (process.env.VENIRA_ALLOW_JS_EXEC ?? "").toLowerCase(),
);

export const PROTECTED_BASENAMES = new Set([
  "approval.key",
  "secrets.json",
  "secrets.key",
  "venira.db",
  "venira.db-wal",
  "venira.db-shm",
  "venira.db-journal",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pgpass",
  "credentials.json",
]);

const PROTECTED_EXTENSIONS = new Set([
  ".asc",
  ".cer",
  ".crt",
  ".der",
  ".gpg",
  ".jks",
  ".keystore",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
]);

export function isProtectedPath(absPath: string): boolean {
  const canonicalPath = realPathOrSelf(path.resolve(absPath));
  const base = path.basename(canonicalPath).toLowerCase();
  if (PROTECTED_BASENAMES.has(base)) return true;
  if (base.startsWith("venira.db-")) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (PROTECTED_EXTENSIONS.has(path.extname(base))) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(base)) return true;
  // Everything under the data dir (approval store + key, audit DB, secrets) is
  // off-limits to the file tools: the agent must not be able to forge a grant.
  try {
    if (isInsideDir(canonicalPath, realPathOrSelf(activeDataDir()))) return true;
  } catch {
    /* fall through */
  }
  return false;
}

function realPathOrSelf(p: string): string {
  try {
    if (fs.existsSync(p)) return fs.realpathSync(p);
  } catch {
    /* fall through */
  }
  const parent = path.dirname(p);
  if (parent === p) return p;
  try {
    return path.join(realPathOrSelf(parent), path.basename(p));
  } catch {
    return p;
  }
}

export function toHostPath(input: string | undefined): string {
  const raw = (input ?? "").trim();
  const abs = path.resolve(WORKSPACE, raw === "" ? "." : raw);
  if (UNRESTRICTED) return abs;
  const rootReal = fs.existsSync(WORKSPACE) ? fs.realpathSync(WORKSPACE) : WORKSPACE;
  const targetReal = realPathOrSelf(abs);
  const rel = path.relative(rootReal, targetReal);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(
      `[path_escape] Path is outside the workspace (${WORKSPACE}): ${raw}. Hint: use a workspace-relative path or set VENIRA_UNRESTRICTED=1.`,
    );
  }
  return abs;
}

/**
 * Resolve `input` under an explicit `root` (used by the corehost operations,
 * which receive the workspace root per call). Same guarantee as
 * `toHostPath`: relative stays inside, absolute must stay inside unless
 * VENIRA_UNRESTRICTED=1.
 */
export function resolveWithin(root: string, input: string | undefined): string {
  const raw = (input ?? "").trim();
  const abs = path.resolve(root, raw === "" ? "." : raw);
  if (UNRESTRICTED) return abs;
  const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const targetReal = realPathOrSelf(abs);
  const rel = path.relative(rootReal, targetReal);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(
      `[scope_denied] Path escapes workspace (${root}): ${raw}. Hint: use a workspace-relative path or set VENIRA_UNRESTRICTED=1.`,
    );
  }
  return abs;
}

// ---------------------------------------------------------------------------
// P1: cache control (VENIRA_CACHE_ALL / VENIRA_CACHE_LIST_ONLY / VENIRA_CACHE_SEARCH_ONLY)
// ---------------------------------------------------------------------------
const envFlag = (name: string): boolean =>
  !["0", "false", "off", "no"].includes((process.env[name] ?? "").toLowerCase());

/** VENIRA_CACHE_ALL=0 disables every read/list/search/recent cache (strict "always fresh" mode). */
export const CACHE_ALL_ENABLED = envFlag("VENIRA_CACHE_ALL");
/** VENIRA_CACHE_LIST_ONLY=0 disables only the list_files TTL cache. */
export const CACHE_LIST_ONLY_ENABLED = envFlag("VENIRA_CACHE_LIST_ONLY");
/** VENIRA_CACHE_SEARCH_ONLY=0 disables only the search TTL cache. */
export const CACHE_SEARCH_ONLY_ENABLED = envFlag("VENIRA_CACHE_SEARCH_ONLY");
