/**
 * Restrict all paths to WORKSPACE (default = the current working directory).
 * Standalone: no Rust host, no @grant paths — just plain workspace locking.
 */
import path from "node:path";
import fs from "node:fs";
import { envFlag } from "./env.js";
import { snapshotProtectedRoots } from "./snapshot-paths.js";
export const PLATFORM = process.platform;

export let WORKSPACE = path.resolve(process.env.VENIRA_WORKSPACE ?? process.cwd());

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
export const UNRESTRICTED = envFlag("VENIRA_UNRESTRICTED", false);

/**
 * `project_execute_js` mode — the single gate for the tool:
 *   - `off`  (default): the tool is not registered at all.
 *   - `ask`: registered; each call needs a human approval bound to the code.
 *   - `semi-auto`: registered; no approval step, but the snippet stays contained (network guard,
 *     workspace-only fs permission, scrubbed env).
 *   - `auto`: registered; no approval step AND no containment (full network, full fs, inherited env).
 *     Trusted personal machines only.
 * `VENIRA_ALLOW_JS_EXEC` / `VENIRA_JS_EXEC_APPROVAL` are removed (registry
 * `removed` entries keep them warning).
 */
export type JsExecMode = "off" | "ask" | "semi-auto" | "auto";

function resolveJsExecMode(): JsExecMode {
  const raw = process.env.VENIRA_JS_EXEC_MODE;
  if (raw === undefined || raw.trim() === "") return "off";
  const value = raw.trim().toLowerCase();
  if (value === "off" || value === "ask" || value === "semi-auto" || value === "auto") return value;
  throw new Error(`[config_invalid] VENIRA_JS_EXEC_MODE must be one of: off, ask, semi-auto, auto.`);
}

export const JS_EXEC_MODE: JsExecMode = resolveJsExecMode();
export const ALLOW_JS_EXEC = JS_EXEC_MODE !== "off";
export const JS_EXEC_APPROVAL = JS_EXEC_MODE === "ask";
export const JS_EXEC_CONTAINED = JS_EXEC_MODE !== "auto";

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

/**
 * Reduce a filename to the name the OS actually resolves. Two spellings beat a
 * naive basename check and must not slip through:
 *   - NTFS alternate data streams: `.env::$DATA` opens the default stream of
 *     `.env`. `fs.realpathSync` keeps the suffix (unlike `fs.promises.realpath`),
 *     so stripping it here keeps every caller consistent.
 *   - Win32 trims trailing dots/spaces from each path segment, so `.env.` is
 *     the same file as `.env`.
 */
function normalizedProtectedBase(canonicalPath: string): string {
  return path
    .basename(canonicalPath)
    .toLowerCase()
    .replace(/:[^\\/]*$/, "")
    .replace(/[. ]+$/, "");
}



export function dynamicWorkspaceEnabled(): boolean {
  return envFlag("VENIRA_DYNAMIC_WORKSPACE", false);
}

export function allowedWorkspaceRoots(): string[] {
  const roots: string[] = [WORKSPACE];
  if (dynamicWorkspaceEnabled()) {
    const raw = process.env.VENIRA_WORKSPACE_ROOTS ?? "";
    for (const part of raw.split(/[,;]/)) {
      const value = part.trim();
      if (!value) continue;
      const abs = path.resolve(value);
      if (fs.existsSync(abs) && !roots.includes(abs)) {
        roots.push(abs);
      }
    }
  }
  if (envFlag("VENIRA_UNRESTRICTED", false)) {
    roots.push("/");
  }
  return roots;
}

export function canSwitchWorkspace(target: string): string | null {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return null;
  // stat file check
  try { if (!fs.statSync(abs).isDirectory()) return null; } catch { return null; }
  const roots = allowedWorkspaceRoots();
  if (roots.length === 1 && roots[0] === WORKSPACE && !envFlag("VENIRA_DYNAMIC_WORKSPACE",false)) return null;
  return roots.some((root) => {
    try {
      const realRoot = fs.realpathSync(root);
      const realAbs = fs.realpathSync(abs);
      const rel = path.relative(realRoot, realAbs);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    } catch {
      return false;
    }
  }) ? abs : null;
}

export function switchWorkspaceRoot(target: string): string {
  const next = canSwitchWorkspace(target);
  if (!next) {
    throw new Error("[workspace_switch_denied] Path is not in allowed roots. Set VENIRA_DYNAMIC_WORKSPACE=1 and VENIRA_WORKSPACE_ROOTS.");
  }
  WORKSPACE = next;
  return WORKSPACE;
}

export function isProtectedPath(absPath: string): boolean {
  const canonicalPath = realPathOrSelf(path.resolve(absPath));
  const base = normalizedProtectedBase(canonicalPath);
  if (PROTECTED_BASENAMES.has(base)) return true;
  if (base.startsWith("venira.db-")) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (PROTECTED_EXTENSIONS.has(path.extname(base))) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(base)) return true;
  // Everything under the data dir (approval store + key, audit DB, secrets) is
  // off-limits to the file tools: the agent must not be able to forge a grant.
  // The checkpoint store (shared root and/or exact override) is equally off-limits.
  for (const root of canonicalProtectedRoots()) {
    if (isInsideDir(canonicalPath, root)) return true;
  }
  return false;
}

/**
 * Canonical (symlink-resolved) data dir + checkpoint roots. Resolving them costs
 * several realpath/exists syscalls, and isProtectedPath runs once per directory
 * entry, so the result is cached briefly. The cache key covers every input
 * (data dir, workspace, snapshot env vars), and the short TTL bounds staleness
 * if a link is created or replaced under one of these folders.
 */
const PROTECTED_ROOTS_TTL_MS = 2000;
let protectedRootsCache: { key: string; at: number; roots: string[] } | null = null;

function canonicalProtectedRoots(): string[] {
  try {
    const dataDir = activeDataDir();
    const key = [dataDir, WORKSPACE, defaultDataDir(), process.env.VENIRA_SNAPSHOT_DIR ?? "", process.env.VENIRA_SNAPSHOT_ROOT ?? ""].join("\u0000");
    const now = Date.now();
    if (protectedRootsCache && protectedRootsCache.key === key && now - protectedRootsCache.at < PROTECTED_ROOTS_TTL_MS) {
      return protectedRootsCache.roots;
    }
    const roots = [realPathOrSelf(dataDir)];
    try {
      for (const snapshotRoot of snapshotProtectedRoots(defaultDataDir(), WORKSPACE)) {
        roots.push(realPathOrSelf(snapshotRoot));
      }
    } catch {
      /* keep the data dir root */
    }
    protectedRootsCache = { key, at: now, roots };
    return roots;
  } catch {
    return []; // same behaviour as before: a failure here never blocks the other checks
  }
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
/** VENIRA_CACHE_ALL=0 disables every read/list/search/recent cache (strict "always fresh" mode). */
export const CACHE_ALL_ENABLED = envFlag("VENIRA_CACHE_ALL", true);
/** VENIRA_CACHE_LIST_ONLY=0 disables only the list_files TTL cache. */
export const CACHE_LIST_ONLY_ENABLED = envFlag("VENIRA_CACHE_LIST_ONLY", true);
/** VENIRA_CACHE_SEARCH_ONLY=0 disables only the search TTL cache. */
export const CACHE_SEARCH_ONLY_ENABLED = envFlag("VENIRA_CACHE_SEARCH_ONLY", true);
