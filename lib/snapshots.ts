/**
 * Checkpoints for the workspace ("file_snapshot").
 *
 * A checkpoint captures the bytes of one or more workspace paths and stores
 * them content-addressed under the data directory:
 *
 *   <data>/snapshots/index/<id>.json.gz   manifest (paths + sha256 + mtime)
 *   <data>/snapshots/blobs/<ab>/<sha256>  deduplicated file contents
 *
 * Only blobs that are not already present are written, so a second
 * checkpoint after a small edit costs one file. Restoring rewrites the
 * recorded files (verify sha256 by default) and never touches anything else
 * unless `delete_extra` is explicitly requested.
 *
 * Everything is workspace-scoped: every path goes through
 * `resolveWithin`, symlinks are skipped (never followed), and the
 * snapshot store itself is excluded from captures.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { resolveWithin } from "./workspace.js";
import { redactSecrets } from "./shell-policy.js";
import type { RustResponse } from "./output.js";

const SNAPSHOT_DIR_NAME = "snapshots";
const MANIFEST_VERSION = 1;

const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const MAX_FILES = envInt("VENIRA_SNAPSHOT_MAX_FILES", 4000);
const MAX_FILE_BYTES = envInt("VENIRA_SNAPSHOT_MAX_FILE_BYTES", 32 * 1024 * 1024);
const MAX_TOTAL_BYTES = envInt("VENIRA_SNAPSHOT_MAX_BYTES", 512 * 1024 * 1024);
const KEEP_CHECKPOINTS = Math.max(1, envInt("VENIRA_SNAPSHOT_KEEP", 20));
const MAX_DELETE_EXTRA = 500;

/** Default excludes: build output, VCS metadata and the store itself. */
const DEFAULT_EXCLUDES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  SNAPSHOT_DIR_NAME,
]);

export function snapshotDataDir(): string {
  const dataDir = process.env.VENIRA_DATA_DIR
    ? path.resolve(process.env.VENIRA_DATA_DIR)
    : path.join(path.resolve(process.env.VENIRA_WORKSPACE ?? process.cwd()), "data");
  return path.join(dataDir, SNAPSHOT_DIR_NAME);
}

function indexPath(id: string): string {
  return path.join(snapshotDataDir(), "index", `${id}.json.gz`);
}

function blobRoot(): string {
  return path.join(snapshotDataDir(), "blobs");
}

function blobPath(sha256: string): string {
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
function protectedPrefixes(root: string): string[] {
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

function isProtected(abs: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => abs === prefix || abs.startsWith(prefix + path.sep));
}

function isAuditDbFile(rel: string): boolean {
  const name = rel.split("/").pop()?.toLowerCase() ?? "";
  return AUDIT_DB_NAMES.has(name);
}

const ID_RE = /^snap-[0-9]{8}-[0-9]{6}-[a-z0-9]{4,12}$/;

function newId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `snap-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function validId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!ID_RE.test(id)) {
    throw new Error(
      "[invalid_request] Invalid checkpoint id. Use the id returned by project_snapshot (action=create|list).",
    );
  }
  return id;
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

async function readManifest(id: string): Promise<SnapshotManifest> {
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
    return JSON.parse(json) as SnapshotManifest;
  } catch (error) {
    throw new Error(
      `[snapshot_corrupt] Cannot read checkpoint '${id}' manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeManifest(manifest: SnapshotManifest): Promise<void> {
  const dir = path.join(snapshotDataDir(), "index");
  await fs.mkdir(dir, { recursive: true });
  const payload = gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"), { level: 6 });
  const tmp = path.join(dir, `.${manifest.id}.tmp-${crypto.randomBytes(3).toString("hex")}`);
  await fs.writeFile(tmp, payload);
  await fs.rename(tmp, indexPath(manifest.id));
}

async function listManifests(): Promise<SnapshotManifest[]> {
  const dir = path.join(snapshotDataDir(), "index");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const manifests: SnapshotManifest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json.gz")) continue;
    const id = name.slice(0, -".json.gz".length);
    if (!ID_RE.test(id)) continue;
    try {
      manifests.push(await readManifest(id));
    } catch {
      /* a corrupt manifest must not hide the other checkpoints */
    }
  }
  manifests.sort((a, b) => b.created_at - a.created_at);
  return manifests;
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fileSignature(absPath: string): Promise<{ size: number; mtimeMs: number; isFile: boolean } | null> {
  try {
    const stat = await fs.lstat(absPath);
    return { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
  } catch {
    return null;
  }
}

function normalizeRel(root: string, absPath: string): string {
  return path.relative(root, absPath).replace(/\\/g, "/");
}

/**
 * True when any existing ancestor of `absDir` (inside `root`) is a symlink.
 * Restore writes must not follow a symlink that was introduced after the
 * checkpoint, otherwise a crafted path could write outside the workspace.
 */
async function pathHasSymlinkAncestor(root: string, absDir: string): Promise<boolean> {
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

type WalkResult = {
  files: string[];
  dirs: string[];
  skipped: Array<{ path: string; reason: string }>;
  truncated: boolean;
};

async function walkForSnapshot(options: {
  root: string;
  roots: string[];
  excludes: Set<string>;
  maxFiles: number;
  maxTotalBytes: number;
  protectedPrefixes: string[];
}): Promise<WalkResult> {
  const { root, roots, excludes, maxFiles, maxTotalBytes, protectedPrefixes } = options;
  const result: WalkResult = { files: [], dirs: [], skipped: [], truncated: false };
  let totalBytes = 0;
  const seen = new Set<string>();
  const queue = roots.slice();

  const pushSkip = (rel: string, reason: string) => {
    if (result.skipped.length < 200) result.skipped.push({ path: rel, reason });
  };

  while (queue.length > 0) {
    if (result.files.length >= maxFiles || totalBytes >= maxTotalBytes) {
      result.truncated = true;
      break;
    }
    const abs = queue.shift() as string;
    const rel = normalizeRel(root, abs) || ".";
    if (seen.has(abs)) continue;
    seen.add(abs);

    // The checkpoint store + audit DB: never snapshot them.
    if (isProtected(abs, protectedPrefixes)) {
      pushSkip(rel, "excluded:data_dir");
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(abs);
    } catch {
      pushSkip(rel, "missing");
      continue;
    }
    if (stat.isSymbolicLink()) {
      pushSkip(rel, "symlink_skipped");
      continue;
    }

    if (stat.isDirectory()) {
      if (rel !== ".") result.dirs.push(rel);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        pushSkip(rel, "unreadable_dir");
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const childRel = rel === "." ? entry.name : `${rel}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          pushSkip(childRel, "symlink_skipped");
          continue;
        }
        const segments = childRel.split("/");
        if (segments.some((segment) => excludes.has(segment.toLowerCase()))) {
          pushSkip(childRel, "excluded");
          continue;
        }
        queue.push(path.join(abs, entry.name));
      }
      continue;
    }

    if (!stat.isFile()) {
      pushSkip(rel, "not_a_regular_file");
      continue;
    }
    if (isAuditDbFile(rel)) {
      pushSkip(rel, "excluded:audit_db");
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      pushSkip(rel, `too_large:${stat.size}`);
      continue;
    }
    if (totalBytes + stat.size > maxTotalBytes) {
      result.truncated = true;
      break;
    }
    totalBytes += stat.size;
    result.files.push(rel);
  }

  return result;
}

async function storeBlob(absPath: string): Promise<{ sha256: string; size: number; newBytes: number } | null> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absPath);
  } catch {
    return null;
  }
  const sha256 = hashBuffer(buffer);
  const dest = blobPath(sha256);
  try {
    await fs.access(dest);
    return { sha256, size: buffer.length, newBytes: 0 };
  } catch {
    /* blob not stored yet */
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${crypto.randomBytes(3).toString("hex")}`;
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, dest);
  return { sha256, size: buffer.length, newBytes: buffer.length };
}

export async function opSnapshotCreate(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]) : ["."];
  const requested = rawPaths.length > 0 ? rawPaths.map((p) => String(p)) : ["."];
  if (requested.length > 64) {
    throw new Error("[invalid_request] paths[] is limited to 64 entries.");
  }
  const protectedDirs = protectedPrefixes(root);
  const maxFiles = Math.max(1, Math.min(MAX_FILES, Number(args.max_files ?? MAX_FILES) || MAX_FILES));
  const maxTotalBytes = Math.max(
    1,
    Math.min(MAX_TOTAL_BYTES, Number(args.max_total_bytes ?? MAX_TOTAL_BYTES) || MAX_TOTAL_BYTES),
  );

  const roots = requested.map((p) => resolveWithin(root, p));
  const rootStats = await Promise.all(roots.map((abs) => fileSignature(abs)));
  const rootKinds: Array<{ path: string; kind: "file" | "dir" }> = [];
  const walkRoots: string[] = [];
  for (let i = 0; i < roots.length; i += 1) {
    const stat = rootStats[i];
    const rel = normalizeRel(root, roots[i]) || ".";
    if (!stat) {
      throw new Error(`[not_found] Path does not exist: ${requested[i]}. Hint: check with project_list_files.`);
    }
    rootKinds.push({ path: rel, kind: stat.isFile ? "file" : "dir" });
    walkRoots.push(roots[i]);
  }

  const excludes = new Set<string>();
  if (args.respect_default_excludes !== false) DEFAULT_EXCLUDES.forEach((v) => excludes.add(v.toLowerCase()));
  if (Array.isArray(args.exclude)) {
    for (const value of args.exclude as unknown[]) {
      const name = String(value).trim().toLowerCase();
      if (name) excludes.add(name);
    }
  }

  const walk = await walkForSnapshot({
    root,
    roots: walkRoots,
    excludes,
    maxFiles,
    maxTotalBytes,
    protectedPrefixes: protectedDirs,
  });

  const manifest: SnapshotManifest = {
    version: MANIFEST_VERSION,
    id: newId(),
    label: sanitizeReason(args.label),
    created_at: Date.now(),
    workspace: root,
    roots: rootKinds,
    files: [],
    dirs: walk.dirs,
    skipped: walk.skipped,
    file_count: 0,
    total_bytes: 0,
    new_blob_bytes: 0,
    truncated: walk.truncated,
  };

  // Hash/store with bounded concurrency: the walk is I/O bound on Windows, so
  // overlapping a few files cuts wall time ~2-3x without unbounded memory.
  type Stored = { rel: string; sha256: string; size: number; mtimeMs: number; newBytes: number } | null;
  const results: Stored[] = new Array(walk.files.length).fill(null);
  let cursor = 0;
  const workers = Math.min(4, walk.files.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= walk.files.length) return;
        const rel = walk.files[index];
        const abs = path.join(root, rel);
        const stored = await storeBlob(abs);
        if (!stored) continue;
        const stat = await fileSignature(abs);
        results[index] = {
          rel,
          sha256: stored.sha256,
          size: stored.size,
          mtimeMs: Math.round(stat?.mtimeMs ?? manifest.created_at),
          newBytes: stored.newBytes,
        };
      }
    }),
  );

  for (let i = 0; i < results.length; i += 1) {
    const stored = results[i];
    if (!stored) {
      if (manifest.skipped.length < 200) manifest.skipped.push({ path: walk.files[i], reason: "unreadable" });
      continue;
    }
    manifest.files.push({ path: stored.rel, sha256: stored.sha256, size: stored.size, mtime_ms: stored.mtimeMs });
    manifest.total_bytes += stored.size;
    manifest.new_blob_bytes += stored.newBytes;
  }
  manifest.file_count = manifest.files.length;

  await writeManifest(manifest);

  // Retention: keep the newest N checkpoints, then free unreferenced blobs.
  const manifests = await listManifests();
  const stale = manifests.slice(KEEP_CHECKPOINTS);
  let pruned = 0;
  for (const old of stale) {
    try {
      await fs.rm(indexPath(old.id), { force: true });
      pruned += 1;
    } catch {
      /* best-effort retention */
    }
  }
  if (pruned > 0) await gcBlobs();

  return {
    status: "completed",
    result: {
      kind: "snapshot_create",
      data: {
        id: manifest.id,
        label: manifest.label,
        created_at: manifest.created_at,
        file_count: manifest.file_count,
        total_bytes: manifest.total_bytes,
        new_blob_bytes: manifest.new_blob_bytes,
        dirs: manifest.dirs.length,
        truncated: manifest.truncated,
        skipped: manifest.skipped.slice(0, 50),
        store: snapshotDataDir(),
        hint: manifest.truncated
          ? "Checkpoint truncated by max_files/max_total_bytes. Narrow paths or raise the limits."
          : undefined,
      },
    },
    truncated: manifest.truncated,
  };
}

export async function opSnapshotList(args: Record<string, unknown>): Promise<RustResponse> {
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20) || 20));
  const manifests = await listManifests();
  const rows = manifests.slice(0, limit).map((m) => ({
    id: m.id,
    label: m.label,
    created_at: m.created_at,
    file_count: m.file_count,
    total_bytes: m.total_bytes,
    roots: m.roots.map((r) => r.path),
    truncated: m.truncated,
    workspace_match: m.workspace === path.resolve(process.env.VENIRA_WORKSPACE ?? process.cwd()),
  }));
  return {
    status: "completed",
    result: {
      kind: "snapshot_list",
      data: {
        count: rows.length,
        total: manifests.length,
        latest: rows[0]?.id,
        store: snapshotDataDir(),
        checkpoints: rows,
      },
    },
    truncated: manifests.length > rows.length,
  };
}

async function deleteExtraUnder(options: {
  root: string;
  manifest: SnapshotManifest;
  keep: Set<string>;
}): Promise<{ deleted: string[]; error?: string }> {
  const { root, manifest, keep } = options;
  const dirRoots = manifest.roots.filter((r) => r.kind === "dir");
  if (dirRoots.length === 0) return { deleted: [] };

  const protectedDirs = protectedPrefixes(root);
  const candidates: string[] = [];
  for (const dirRoot of dirRoots) {
    const absRoot = resolveWithin(root, dirRoot.path);
    const queue = [absRoot];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const abs = queue.shift() as string;
      if (seen.has(abs)) continue;
      if (isProtected(abs, protectedDirs)) continue;
      seen.add(abs);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.isDirectory()) continue;
        if (!entry.isFile()) continue;
        const rel = normalizeRel(root, path.join(abs, entry.name));
        if (keep.has(rel)) continue;
        if (isAuditDbFile(rel)) continue;
        candidates.push(rel);
        if (candidates.length > MAX_DELETE_EXTRA) {
          return {
            deleted: [],
            error: `[resource_limit] delete_extra would remove more than ${MAX_DELETE_EXTRA} files under ${dirRoot.path}; narrow paths[] or drop delete_extra.`,
          };
        }
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        if (DEFAULT_EXCLUDES.has(entry.name.toLowerCase())) continue;
        queue.push(path.join(abs, entry.name));
      }
    }
  }
  const deleted: string[] = [];
  for (const rel of candidates) {
    try {
      await fs.rm(path.join(root, rel), { force: true });
      deleted.push(rel);
    } catch {
      /* best-effort */
    }
  }
  return { deleted };
}

export async function opSnapshotRestore(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const id = validId(args.id);
  const manifest = await readManifest(id);
  if (path.resolve(manifest.workspace) !== path.resolve(root)) {
    throw new Error(
      `[scope_denied] Checkpoint '${id}' belongs to a different workspace (${manifest.workspace}). Hint: restore it from that workspace.`,
    );
  }
  const dryRun = args.dry_run === true;
  const verify = args.verify !== false;
  const filterPaths = Array.isArray(args.paths)
    ? (args.paths as unknown[]).map((p) => String(p))
    : null;

  let targets = manifest.files;
  if (filterPaths && filterPaths.length > 0) {
    const prefixes = filterPaths.map((p) => normalizeRel(root, resolveWithin(root, p)));
    targets = manifest.files.filter((file) =>
      prefixes.some((prefix) => file.path === prefix || file.path.startsWith(prefix === "." ? "" : `${prefix}/`)),
    );
  }

  if (targets.length === 0) {
    throw new Error(
      "[not_found] No files in this checkpoint match paths[]. Hint: list the checkpoint with action=list or omit paths[].",
    );
  }

  const restored: Array<{ path: string; size: number }> = [];
  const unchanged: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const protectedDirs = protectedPrefixes(root);
  // Parent directories verified once per restore (usually a handful).
  const verifiedDirs = new Set<string>([path.resolve(root)]);

  // Concurrency 4 keeps many small files fast without huge memory spikes.
  const CONCURRENCY = 4;
  const chunkSize = Math.ceil(targets.length / CONCURRENCY);

  const restoreOne = async (file: SnapshotManifest["files"][number]): Promise<void> => {
    const dest = resolveWithin(root, file.path);
    // Old manifests (or a doctored one) may point at the audit DB: never write
    // into the data dir or the checkpoint store, even if the manifest says so.
    if (isProtected(dest, protectedDirs)) {
      skipped.push({ path: file.path, reason: "excluded:data_dir" });
      return;
    }
    if (isAuditDbFile(file.path)) {
      skipped.push({ path: file.path, reason: "excluded:audit_db" });
      return;
    }
    const parent = path.dirname(dest);
    if (!verifiedDirs.has(parent)) {
      if (await pathHasSymlinkAncestor(root, parent)) {
        skipped.push({ path: file.path, reason: "symlink_ancestor" });
        return;
      }
      verifiedDirs.add(parent);
    }
    if (dryRun) {
      const stat = await fileSignature(dest);
      if (stat && stat.size === file.size) unchanged.push(file.path);
      else restored.push({ path: file.path, size: file.size });
      return;
    }
    const blob = blobPath(file.sha256);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(blob);
    } catch {
      skipped.push({ path: file.path, reason: "blob_missing" });
      return;
    }
    if (verify && hashBuffer(buffer) !== file.sha256) {
      skipped.push({ path: file.path, reason: "sha256_mismatch" });
      return;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.venira-restore-${crypto.randomBytes(3).toString("hex")}`;
    await fs.writeFile(tmp, buffer);
    try {
      await fs.rename(tmp, dest);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
    try {
      const atime = new Date(file.mtime_ms);
      await fs.utimes(dest, atime, atime);
    } catch {
      /* mtime restore is best-effort */
    }
    restored.push({ path: file.path, size: buffer.length });
  };

  const chunks: Array<Promise<void>> = [];
  for (let i = 0; i < targets.length; i += chunkSize) {
    const slice = targets.slice(i, i + chunkSize);
    chunks.push(
      (async () => {
        for (const file of slice) await restoreOne(file);
      })(),
    );
  }
  await Promise.all(chunks);

  let deleted: string[] = [];
  let deleteExtraError: string | undefined;
  if (args.delete_extra === true && filterPaths === null && !dryRun) {
    const keep = new Set(manifest.files.map((file) => file.path));
    const outcome = await deleteExtraUnder({ root, manifest, keep });
    deleted = outcome.deleted;
    deleteExtraError = outcome.error;
  }

  if (deleteExtraError) {
    throw new Error(deleteExtraError);
  }

  if (skipped.length > 0 && restored.length === 0) {
    const reasons = new Set(skipped.map((entry) => entry.reason));
    const first = `${skipped[0].path}: ${skipped[0].reason}`;
    if (reasons.has("symlink_ancestor") || reasons.has("excluded:data_dir")) {
      throw new Error(
        `[scope_denied] Refused to restore ${skipped.length} file(s) (${first}). Hint: a captured directory is now a symlink or inside the data dir; restore it manually or recreate the path.`,
      );
    }
    throw new Error(
      `[snapshot_corrupt] No file could be restored (${first}). The blob store may be pruned; create a new checkpoint.`,
    );
  }

  return {
    status: "completed",
    result: {
      kind: "snapshot_restore",
      data: {
        id,
        dry_run: dryRun,
        verify,
        restored_count: restored.length,
        restored: restored.slice(0, 200),
        unchanged_count: unchanged.length,
        ...(dryRun
          ? { dry_run_note: "dry_run compares size only; run without dry_run to rewrite files." }
          : {}),
        skipped,
        deleted_count: deleted.length,
        deleted: deleted.slice(0, 200),
        truncated: restored.length > 200 || deleted.length > 200,
      },
    },
    truncated: restored.length > 200 || deleted.length > 200,
  };
}

export async function opSnapshotDelete(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const id = validId(args.id);
  const manifest = await readManifest(id);
  // A shared VENIRA_DATA_DIR must not let one workspace drop another's checkpoint.
  if (path.resolve(manifest.workspace) !== path.resolve(root)) {
    throw new Error(
      `[scope_denied] Checkpoint '${id}' belongs to a different workspace (${manifest.workspace}). Hint: delete it from that workspace.`,
    );
  }
  await fs.rm(indexPath(id), { force: true });
  const gc = await gcBlobs();
  return {
    status: "completed",
    result: {
      kind: "snapshot_delete",
      data: {
        id,
        label: manifest.label,
        deleted: true,
        blobs_removed: gc.removed,
        bytes_freed: gc.bytes,
      },
    },
  };
}

/** Remove blobs that no remaining checkpoint references. */
async function gcBlobs(): Promise<{ removed: number; bytes: number }> {
  const manifests = await listManifests();
  const referenced = new Set<string>();
  for (const manifest of manifests) {
    for (const file of manifest.files) referenced.add(file.sha256);
  }
  let removed = 0;
  let bytes = 0;
  let shards: string[];
  try {
    shards = await fs.readdir(blobRoot());
  } catch {
    return { removed: 0, bytes: 0 };
  }
  for (const shard of shards) {
    const shardDir = path.join(blobRoot(), shard);
    let entries;
    try {
      entries = await fs.readdir(shardDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (referenced.has(entry.name)) continue;
      try {
        const stat = await fs.stat(path.join(shardDir, entry.name));
        await fs.rm(path.join(shardDir, entry.name), { force: true });
        removed += 1;
        bytes += stat.size;
      } catch {
        /* best-effort gc */
      }
    }
  }
  return { removed, bytes };
}

/** Cheap health summary (manifest-based; no blob walk). */
export async function snapshotHealth(): Promise<{
  store: string;
  checkpoints: number;
  logical_bytes: number;
  latest?: string;
}> {
  const manifests = await listManifests();
  return {
    store: snapshotDataDir(),
    checkpoints: manifests.length,
    logical_bytes: manifests.reduce((sum, m) => sum + m.total_bytes, 0),
    latest: manifests[0]?.id,
  };
}
