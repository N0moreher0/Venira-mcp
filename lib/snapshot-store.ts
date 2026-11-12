/**
 * Snapshots — cấu hình/giới hạn, đường dẫn kho, manifest, helper bảo vệ & id.
 * Tách khỏi snapshots.ts (re-export ở đó nên API công khai không đổi); hành vi giữ nguyên.
 */
import { readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { defaultDataDir, WORKSPACE } from "./workspace.js";
import { snapshotStoreDir, ensureProjectMeta } from "./snapshot-paths.js";
import { redactSecrets } from "./shell-policy.js";

const SNAPSHOT_DIR_NAME = "snapshots";
export const MANIFEST_VERSION = 1;

/**
 * Manifest migrations: `MIGRATIONS[n]` turns a version-n manifest into version n+1 (it must set `version`
 * to n+1). Empty while v1 is the only layout ever shipped. When the layout changes: bump MANIFEST_VERSION,
 * add the step here, and extend scripts/test-snapshot-lifecycle.ts. Old checkpoints are upgraded in memory
 * on read; the file on disk is never rewritten, so a downgrade of venira-mcp keeps working on old data.
 */
export type ManifestMigration = (manifest: Record<string, unknown>) => Record<string, unknown>;
const MIGRATIONS: Record<number, ManifestMigration> = {};

/**
 * Bring a parsed manifest to `target` (default: this build's MANIFEST_VERSION).
 * - missing / non-integer version -> `[snapshot_corrupt]`
 * - newer than this build         -> `[snapshot_version_unsupported]` (data is fine, the build is old)
 * - older with no migration step  -> `[snapshot_version_unsupported]`
 */
export function migrateManifest(
  value: unknown,
  options: { target?: number; migrations?: Record<number, ManifestMigration> } = {},
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[snapshot_corrupt] Checkpoint manifest must be an object.");
  }
  const target = options.target ?? MANIFEST_VERSION;
  const migrations = options.migrations ?? MIGRATIONS;
  let current = value as Record<string, unknown>;
  const rawVersion = current.version;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1) {
    throw new Error("[snapshot_corrupt] Checkpoint manifest has a missing or invalid version.");
  }
  let version: number = rawVersion;
  const label = typeof current.id === "string" ? current.id : "?";
  if (version > target) {
    throw new Error(
      `[snapshot_version_unsupported] Checkpoint '${label}' uses manifest v${version}, newer than the v${target} this venira-mcp reads. ` +
        "Hint: upgrade venira-mcp. The checkpoint and its blobs are kept untouched.",
    );
  }
  while (version < target) {
    const step = migrations[version];
    if (!step) {
      throw new Error(
        `[snapshot_version_unsupported] Checkpoint '${label}' uses manifest v${version} and this venira-mcp has no migration to v${target}. ` +
          "Hint: restore it with the venira-mcp version that wrote it. The checkpoint and its blobs are kept untouched.",
      );
    }
    current = step({ ...current });
    const next = current.version;
    if (typeof next !== "number" || next !== version + 1) {
      throw new Error(`[snapshot_corrupt] Migration from manifest v${version} did not produce v${version + 1}.`);
    }
    version = next;
  }
  return current;
}

const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const DEFAULT_MAX_FILES = 4000;
export const MAX_FILE_BYTES = envInt("VENIRA_SNAPSHOT_MAX_FILE_BYTES", 32 * 1024 * 1024);
export const MAX_TOTAL_BYTES = envInt("VENIRA_SNAPSHOT_MAX_BYTES", 512 * 1024 * 1024);
export const KEEP_CHECKPOINTS = Math.max(1, envInt("VENIRA_SNAPSHOT_KEEP", 20));
export const MAX_DELETE_EXTRA = 500;

/** Hard ceiling for a single checkpoint file cap, whatever the source (env / config / arg). */
const HARD_MAX_FILES = 20000;

/**
 * Per-workspace checkpoint cap: `<workspace>/venira.config.json` ->
 * `snapshot.maxFiles`. Lets one big repo raise the process-wide default
 * (`VENIRA_SNAPSHOT_MAX_FILES`) without touching other workspaces.
 */
function workspaceSnapshotMaxFiles(): number | null {
  const file = path.join(WORKSPACE, "venira.config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const root = parsed as { snapshot?: unknown } | null;
  const snapshot = root?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const n = Number((snapshot as { maxFiles?: unknown }).maxFiles);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return Math.min(n, HARD_MAX_FILES);
}

/** Effective checkpoint file cap: a per-workspace config may raise the global default. */
export function effectiveMaxFiles(): number {
  const fromEnv = envInt("VENIRA_SNAPSHOT_MAX_FILES", 0);
  const base = fromEnv > 0 ? fromEnv : DEFAULT_MAX_FILES;
  const fromWorkspace = workspaceSnapshotMaxFiles();
  return Math.max(base, fromWorkspace ?? 0);
}

/** Default excludes: build output, VCS metadata and the store itself. */
export const DEFAULT_EXCLUDES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target", // Rust build output (cargo target/)
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  SNAPSHOT_DIR_NAME,
]);

/**
 * File-level excludes for toolchain artifacts that must never enter a
 * checkpoint: Rust compiler dep files (`foo.d`) and MSVC PDBs (`foo.pdb`).
 * Matched against the full relative path; the trailing anchor keeps `*.d`
 * from swallowing TypeScript declaration files such as `foo.d.ts`.
 */
export const SNAPSHOT_FILE_EXCLUDE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\.pdb$/i, reason: "excluded:rust_pdb" },
  { re: /\.d$/i, reason: "excluded:rust_dep" },
];

/**
 * Store folder for this workspace (see snapshot-paths.ts for the layout and
 * VENIRA_SNAPSHOT_DIR / VENIRA_SNAPSHOT_ROOT precedence).
 */
export function snapshotDataDir(): string {
  return snapshotStoreDir(WORKSPACE, defaultDataDir());
}

/** Stamp the store with its owning workspace before the first write. */
export function ensureStoreMeta(): void {
  ensureProjectMeta(snapshotDataDir(), WORKSPACE);
}

export function indexPath(id: string): string {
  return path.join(snapshotDataDir(), "index", `${id}.json.gz`);
}

export function blobRoot(): string {
  return path.join(snapshotDataDir(), "blobs");
}

export function blobPath(sha256: string): string {
  return path.join(blobRoot(), sha256.slice(0, 2), sha256);
}

/**
 * Files that must never be captured/restored or dropped by `delete_extra`:
 * the audit DB (SQLite is open and locked) and the encrypted secret store
 * (a checkpoint would otherwise copy ciphertext + key outside the data dir).
 */
const AUDIT_DB_NAMES = new Set([
  "venira.db", "venira.db-wal", "venira.db-shm", "venira.db-journal",
  "secrets.json", "secrets.key",
]);


/**
 * Absolute prefixes a capture/restore must never touch:
 *   - the checkpoint store (would be self-referential),
 *   - the audit DB directory (SQLite files are open, locked and mostly noise).
 * If VENIRA_DATA_DIR is the workspace itself, excluding that dir would exclude
 * everything, so we only skip the SQLite files by name in that case.
 */
export function protectedPrefixes(root: string): string[] {
  const store = snapshotDataDir();
  const dataRoot = path.dirname(store);
  const resolvedRoot = path.resolve(root);
  const prefixes = [store];
  if (dataRoot !== resolvedRoot) {
    const rel = path.relative(resolvedRoot, dataRoot);
    // Only protect when the data dir actually sits inside the workspace.
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) prefixes.push(dataRoot);
  }
  return prefixes;
}

export function isProtected(abs: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => abs === prefix || abs.startsWith(prefix + path.sep));
}

export function isAuditDbFile(rel: string): boolean {
  const name = rel.split("/").pop()?.toLowerCase() ?? "";
  return AUDIT_DB_NAMES.has(name);
}

const ID_RE = /^snap-[0-9]{8}-[0-9]{6}-[a-z0-9]{4,12}$/;

export function newId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  // Roadmap item 15 (P2): the stamp used to be UTC while every other date
  // the agent sees (file mtimes, the checkpoint list, its own notes) is
  // local - so a checkpoint created at 00:10 local was labelled with the
  // previous day. The stamp is now LOCAL time; the exact instant is always
  // available as `created_at_ms` (epoch milliseconds).
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `snap-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function validId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!ID_RE.test(id)) {
    throw new Error(
      "[invalid_request] Invalid checkpoint id. Use the id returned by project_snapshot (action=create|list).",
    );
  }

  return id;
}

function validateManifest(value: unknown, expectedId: string): SnapshotManifest {
  if (!value || typeof value !== "object") {
    throw new Error("[snapshot_corrupt] Checkpoint manifest must be an object.");
  }
  const manifest = value as Partial<SnapshotManifest>;
  if (manifest.version !== MANIFEST_VERSION || manifest.id !== expectedId || typeof manifest.workspace !== "string" ||
      !Number.isFinite(manifest.created_at) || !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.roots) || !Array.isArray(manifest.dirs)) {
    throw new Error("[snapshot_corrupt] Checkpoint manifest has an invalid header.");
  }
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string" ||
        path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..") ||
        !/^[a-f0-9]{64}$/i.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        !Number.isFinite(file.mtime_ms)) {
      throw new Error("[snapshot_corrupt] Checkpoint manifest contains an invalid file entry.");
    }
  }
  return manifest as SnapshotManifest;
}

/** Keep audit/label text short, single-line and free of secrets. */
export function sanitizeReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return redactSecrets(text).slice(0, 400);
}

export type SnapshotManifest = {
  version: number;
  id: string;
  label?: string;
  created_at: number;
  /**
   * Workspace this checkpoint belongs to. A checkpoint is only restorable
   * into the same workspace, so a copied data dir cannot overwrite a
   * different project.
   */
  workspace: string;
  roots: Array<{ path: string; kind: "file" | "dir" }>;
  files: Array<{ path: string; sha256: string; size: number; mtime_ms: number }>;
  dirs: string[];
  skipped: Array<{ path: string; reason: string }>;
  file_count: number;
  total_bytes: number;
  new_blob_bytes: number;
  truncated: boolean;
};

export async function readManifest(id: string): Promise<SnapshotManifest> {
  const file = indexPath(id);
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch {
    throw new Error(
      `[not_found] Checkpoint '${id}' does not exist. Hint: list them with project_snapshot action=list.`,
    );
  }
  try {
    const json = gunzipSync(raw, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8");
    return validateManifest(migrateManifest(JSON.parse(json)), id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Keep the specific code: a newer/unmigratable manifest is not a corrupt one.
    if (message.startsWith("[snapshot_version_unsupported]")) throw new Error(message);
    throw new Error(`[snapshot_corrupt] Cannot read checkpoint '${id}' manifest: ${message}`);
  }
}

export async function writeManifest(manifest: SnapshotManifest): Promise<void> {
  ensureStoreMeta();
  const dir = path.join(snapshotDataDir(), "index");
  await fs.mkdir(dir, { recursive: true });
  const payload = gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"), { level: 6 });
  const tmp = path.join(dir, `.${manifest.id}.tmp-${crypto.randomBytes(3).toString("hex")}`);
  await fs.writeFile(tmp, payload);
  await fs.rename(tmp, indexPath(manifest.id));
}

export type UnreadableManifest = {
  id: string;
  code: "snapshot_corrupt" | "snapshot_version_unsupported";
  message: string;
};

/**
 * Every checkpoint index in the store, split into readable manifests and ones that could not be read.
 * Callers that delete anything based on "what is referenced" (blob gc) must look at `unreadable`:
 * an unreadable manifest still owns blobs, we just cannot say which.
 */
export async function listManifestsDetailed(): Promise<{ manifests: SnapshotManifest[]; unreadable: UnreadableManifest[] }> {
  const dir = path.join(snapshotDataDir(), "index");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { manifests: [], unreadable: [] };
  }
  const manifests: SnapshotManifest[] = [];
  const unreadable: UnreadableManifest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json.gz")) continue;
    const id = name.slice(0, -".json.gz".length);
    if (!ID_RE.test(id)) continue;
    try {
      manifests.push(await readManifest(id));
    } catch (error) {
      // a bad manifest must not hide the other checkpoints, but it must not vanish silently either
      const message = error instanceof Error ? error.message : String(error);
      unreadable.push({
        id,
        code: message.startsWith("[snapshot_version_unsupported]") ? "snapshot_version_unsupported" : "snapshot_corrupt",
        message,
      });
    }
  }
  manifests.sort((a, b) => b.created_at - a.created_at);
  unreadable.sort((a, b) => a.id.localeCompare(b.id));
  return { manifests, unreadable };
}

export async function listManifests(): Promise<SnapshotManifest[]> {
  return (await listManifestsDetailed()).manifests;
}

export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function fileSignature(absPath: string): Promise<{ size: number; mtimeMs: number; isFile: boolean } | null> {
  try {
    const stat = await fs.lstat(absPath);
    return { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
  } catch {
    return null;
  }
}

export function normalizeRel(root: string, absPath: string): string {
  return path.relative(root, absPath).replace(/\\/g, "/");
}

/**
 * True when any existing ancestor of `absDir` (inside `root`) is a symlink.
 * Restore writes must not follow a symlink that was introduced after the
 * checkpoint, otherwise a crafted path could write outside the workspace.
 */
export async function pathHasSymlinkAncestor(root: string, absDir: string): Promise<boolean> {
  const rel = path.relative(root, absDir);
  if (rel === "") return false;
  const parts = rel.split(path.sep);
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return true;
      if (!stat.isDirectory()) return true;
    } catch {
      // Missing from here down: mkdir creates real directories under verified
      // ancestors, so the rest of the chain is safe.
      return false;
    }
  }
  return false;
}
