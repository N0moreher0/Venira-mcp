/**
 * Where checkpoints live, and which paths the file tools must never touch.
 *
 * Layout (one shared root for every project and every MCP client):
 *
 *   <root>/<project>/project.json   { workspace, name, created_at }
 *   <root>/<project>/index/<id>.json.gz
 *   <root>/<project>/blobs/<ab>/<sha256>
 *
 * Root, first match wins:
 *   1. VENIRA_SNAPSHOT_DIR   exact store folder, used as-is (single project, no sub-folders)
 *   2. VENIRA_SNAPSHOT_ROOT  shared root (absolute path)
 *   3. <per-user data dir>/snapshots   e.g. %LOCALAPPDATA%\venira\snapshots
 *
 * The default is the per-user data dir, NOT the (possibly workspace-adjacent)
 * VENIRA_DATA_DIR, so checkpoints sit outside every project tree.
 *
 * Project folder name = sanitized workspace folder name. If another workspace
 * already owns that name (recorded in project.json) the newcomer gets a
 * `-<hash8>` suffix, so two repos called `app` never share a store and every
 * client opening the same workspace resolves to the same folder.
 *
 * No imports from ./workspace.js on purpose (workspace.ts imports this file).
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const META_FILE = "project.json";

function absoluteEnvPath(name: string): string | null {
  const value = (process.env[name] ?? "").trim();
  if (!value) return null;
  if (!path.isAbsolute(value)) {
    throw new Error(`[config_invalid] ${name} must be an absolute path (got '${value}').`);
  }
  return path.resolve(value);
}

function sanitizeProjectName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);
  return cleaned || "workspace";
}

/** Stable identity of a workspace path (case-insensitive on Windows). */
function workspaceKey(workspace: string): string {
  let resolved = path.resolve(workspace);
  try {
    resolved = fs.realpathSync.native(resolved); // same folder, however a client spells the path (8.3 names, symlinks)
  } catch {
    /* workspace not on disk yet: use the resolved string */
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function hash8(workspace: string): string {
  return crypto.createHash("sha256").update(workspaceKey(workspace)).digest("hex").slice(0, 8);
}

/** Shared root holding one sub-folder per project. */
export function snapshotRootDir(userDataDir: string): string {
  return absoluteEnvPath("VENIRA_SNAPSHOT_ROOT") ?? path.join(userDataDir, "snapshots");
}

/**
 * Optional off-machine copy target (`VENIRA_SNAPSHOT_MIRROR_DIR`, absolute), or null when unset.
 * A plain directory: OneDrive/Dropbox folder, NAS share, USB drive or rclone mount.
 */
export function snapshotMirrorRootDir(): string | null {
  return absoluteEnvPath("VENIRA_SNAPSHOT_MIRROR_DIR");
}

/** Exact store override, or null. */
export function snapshotExactDir(): string | null {
  return absoluteEnvPath("VENIRA_SNAPSHOT_DIR");
}

function readMetaWorkspace(dir: string): string | null | undefined {
  // undefined = no folder / no readable meta, null = folder exists but is unowned
  const metaPath = path.join(dir, META_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { workspace?: unknown };
    return typeof parsed.workspace === "string" ? parsed.workspace : null;
  } catch {
    return fs.existsSync(dir) ? null : undefined;
  }
}

const projectDirCache = new Map<string, string>();

/** Pick `<root>/<name>` for this workspace, falling back to `<name>-<hash8>` on a name clash. */
export function snapshotProjectDir(root: string, workspace: string): string {
  const cacheKey = `${root}\u0000${workspaceKey(workspace)}`;
  const cached = projectDirCache.get(cacheKey);
  if (cached) return cached;

  const base = sanitizeProjectName(path.basename(path.resolve(workspace)));
  const clean = path.join(root, base);
  const hashed = path.join(root, `${base}-${hash8(workspace)}`);
  const mine = workspaceKey(workspace);

  let chosen = hashed;
  for (const dir of [clean, hashed]) {
    const owner = readMetaWorkspace(dir);
    if (owner === undefined) { chosen = dir; break; }                 // free -> claim it
    if (owner !== null && workspaceKey(owner) === mine) { chosen = dir; break; } // already ours
    if (owner === null && dir === hashed) { chosen = dir; break; }    // unowned hashed folder: ours by construction
  }
  projectDirCache.set(cacheKey, chosen);
  return chosen;
}

/** Store folder for a workspace. */
export function snapshotStoreDir(workspace: string, userDataDir: string): string {
  return snapshotExactDir() ?? snapshotProjectDir(snapshotRootDir(userDataDir), workspace);
}

/** Record which workspace owns `storeDir` (no-op for an exact VENIRA_SNAPSHOT_DIR store or if already written). */
export function ensureProjectMeta(storeDir: string, workspace: string): void {
  if (snapshotExactDir()) return;
  const metaPath = path.join(storeDir, META_FILE);
  if (fs.existsSync(metaPath)) return;
  fs.mkdirSync(storeDir, { recursive: true });
  const body = {
    workspace: path.resolve(workspace),
    name: path.basename(path.resolve(workspace)),
    created_at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(metaPath, JSON.stringify(body, null, 2), { flag: "wx" });
  } catch {
    /* another process wrote it first */
  }
}

/** Folders the file tools must refuse to read, write, search or delete. Never throws. */
export function snapshotProtectedRoots(userDataDir: string, workspace: string): string[] {
  const roots = new Set<string>();
  try { roots.add(snapshotStoreDir(workspace, userDataDir)); } catch { /* bad env: ignore */ }
  try { roots.add(snapshotRootDir(userDataDir)); } catch { /* bad env: ignore */ }
  try {
    const mirror = snapshotMirrorRootDir(); // the backup must be as unreachable for tools as the store itself
    if (mirror) roots.add(mirror);
  } catch { /* bad env: ignore */ }
  return [...roots];
}
