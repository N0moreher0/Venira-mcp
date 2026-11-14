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
import { resolveWithin } from "./workspace.js";
import type { RustResponse } from "./output.js";
import { MANIFEST_VERSION, MAX_TOTAL_BYTES, KEEP_CHECKPOINTS, MAX_DELETE_EXTRA, effectiveMaxFiles, DEFAULT_EXCLUDES, snapshotDataDir, indexPath, blobRoot, blobPath, protectedPrefixes, isProtected, isAuditDbFile, newId, validId, sanitizeReason, type SnapshotManifest, readManifest, writeManifest, listManifests, listManifestsDetailed, hashBuffer, fileSignature, normalizeRel, pathHasSymlinkAncestor } from "./snapshot-store.js";
import { walkForSnapshot, storeBlob } from "./snapshot-walk.js";
import { runMirrorAfterCreate } from "./snapshot-mirror.js";
export { snapshotDataDir, sanitizeReason, type SnapshotManifest } from "./snapshot-store.js";

export async function opSnapshotCreate(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  // Phase 5: the `scope` alias is gone (ROADMAP_TOOL_SCHEMA.md). Fail closed: a cached client that still
  // sends only `scope` must not silently capture the whole workspace, so it gets an error that names `paths`.
  if (args.scope !== undefined) {
    throw new Error(
      '[unsupported] snapshot.scope was removed. Hint: send paths instead, e.g. paths: ["lib"] (paths defaults to ["."], the whole workspace).',
    );
  }
  const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]) : ["."];
  const requested = rawPaths.length > 0 ? rawPaths.map((p) => String(p)) : ["."];
  if (requested.length > 64) {
    throw new Error("[invalid_request] paths[] is limited to 64 entries.");
  }
  const protectedDirs = protectedPrefixes(root);
  const maxFilesCap = effectiveMaxFiles();
  const maxFiles = Math.max(1, Math.min(maxFilesCap, Number(args.max_files ?? maxFilesCap) || maxFilesCap));
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
      throw new Error(`[not_found] Path does not exist: ${requested[i]}. Hint: check with list_files.`);
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

  // Optional off-machine copy: best-effort, bounded, never changes this checkpoint's status.
  const mirror = await runMirrorAfterCreate(root);

  return {
    status: "completed",
    result: {
      kind: "snapshot_create",
      data: {
        id: manifest.id,
        label: manifest.label,
        // Roadmap item 15 (P2): every timestamp the tools report is epoch
        // milliseconds and says so in its name.
        created_at_ms: manifest.created_at,
        file_count: manifest.file_count,
        total_bytes: manifest.total_bytes,
        new_blob_bytes: manifest.new_blob_bytes,
        dirs: manifest.dirs.length,
        truncated: manifest.truncated,
        skipped: manifest.skipped.slice(0, 50),
        store: snapshotDataDir(),
        ...(mirror ? { mirror } : {}),
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
  const { manifests, unreadable } = await listManifestsDetailed();
  const rows = manifests.slice(0, limit).map((m) => ({
    id: m.id,
    label: m.label,
    created_at_ms: m.created_at,
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
        unreadable: unreadable.length > 0 ? unreadable.map((u) => ({ id: u.id, code: u.code })) : undefined,
        hint: unreadable.length > 0
          ? "Some checkpoint indexes could not be read (see unreadable[].code). They are kept, and blob cleanup is paused until they are resolved: snapshot_version_unsupported -> upgrade venira-mcp; snapshot_corrupt -> delete the index file by hand if it is truly broken."
          : undefined,
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
        // Roadmap item 15 (P2): a dry run verified nothing (it compares the
        // size only), so it did not report `verify: true`.
        ...(dryRun ? { verify: false } : { verify }),
        restored_count: restored.length,
        restored: restored.slice(0, 200),
        unchanged_count: unchanged.length,
        ...(dryRun
          ? { dry_run_note: "dry_run compares size only; it verifies nothing and writes nothing - run without dry_run to restore the files." }
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
        gc_skipped: gc.skipped,
        unreadable_manifests: gc.unreadable,
      },
    },
  };
}

/**
 * Remove blobs that no remaining checkpoint references.
 * Refuses to run while any manifest is unreadable: such a manifest still owns blobs we cannot enumerate
 * (corrupt index, or written by a newer venira-mcp), so deleting "unreferenced" blobs could destroy its data.
 */
async function gcBlobs(): Promise<{ removed: number; bytes: number; skipped?: "unreadable_manifests"; unreadable?: number }> {
  const { manifests, unreadable } = await listManifestsDetailed();
  if (unreadable.length > 0) return { removed: 0, bytes: 0, skipped: "unreadable_manifests", unreadable: unreadable.length };
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
  unreadable: number;
  logical_bytes: number;
  latest?: string;
}> {
  const { manifests, unreadable } = await listManifestsDetailed();
  return {
    store: snapshotDataDir(),
    checkpoints: manifests.length,
    unreadable: unreadable.length,
    logical_bytes: manifests.reduce((sum, m) => sum + m.total_bytes, 0),
    latest: manifests[0]?.id,
  };
}
