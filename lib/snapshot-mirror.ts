/**
 * Snapshot mirror: an optional, append-only copy of the checkpoint store in a plain directory
 * (`VENIRA_SNAPSHOT_MIRROR_DIR`: a OneDrive/Dropbox folder, NAS share, USB drive, rclone mount).
 *
 * Layout is the store's own, so restoring from the mirror is copying the folder back:
 *
 *   <mirror>/<project>/project.json
 *   <mirror>/<project>/index/<id>.json.gz
 *   <mirror>/<project>/blobs/<ab>/<sha256>
 *
 * Rules:
 *   - Additive and idempotent. Blobs missing at the mirror are copied first, then the indexes whose blobs
 *     are all present, then `project.json`, so the mirror never holds an index whose blobs are absent.
 *   - Every copied byte is checked before it gets its final name (blob: sha256 equals its file name;
 *     index/meta: bytes equal the source). A bad copy is removed and reported, never kept.
 *   - Append-only: nothing in the mirror is ever deleted. The single overwrite is `verify=1` replacing a
 *     blob/index that no longer matches its source (repair). Pruning the mirror is a manual decision.
 *   - Best-effort and bounded: it stops between files once the time budget is spent (`partial`); the next
 *     run resumes because it only copies what is still missing.
 *   - Safety: the mirror dir must be absolute, must exist (an unmounted drive must not be silently
 *     recreated as a local folder), must not equal/contain/sit inside the local store, and must not sit
 *     inside the workspace (checkpoints would capture it).
 *
 * Health: `mirrorHealth()` reports whether a mirror is configured and the outcome of the last run in this process
 * (after `snapshot_create` or `action=mirror`); `health` surfaces it under `snapshots.mirror`.
 *
 * Not in scope: restore-from-mirror automation, mirror-side retention.
 */
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { RustResponse } from "./output.js";
import { defaultDataDir } from "./workspace.js";
import { snapshotExactDir, snapshotMirrorRootDir, snapshotRootDir } from "./snapshot-paths.js";
import { snapshotDataDir, indexPath, blobPath, hashBuffer, listManifestsDetailed } from "./snapshot-store.js";

const META_FILE = "project.json";
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_FAILED_REPORTED = 20;

/** Time budget after `snapshot_create` (small, so a slow share never stalls the tool) and for the manual action. */
export const MIRROR_AUTO_TIMEOUT_MS = 20_000;
export const MIRROR_MANUAL_TIMEOUT_MS = 100_000;

export type MirrorFailure = { kind: "blob" | "index" | "meta"; id: string; reason: string };

export type MirrorResult = {
  status: "ok" | "partial" | "error";
  dir?: string;
  copied_blobs: number;
  copied_indexes: number;
  bytes: number;
  verified_blobs?: number;
  repaired_blobs?: number;
  repaired_indexes?: number;
  skipped_unreadable?: number;
  timed_out?: boolean;
  failed_count?: number;
  failed?: MirrorFailure[];
  elapsed_ms: number;
  error?: string;
};

/** Outcome of the most recent mirror run in this process, as `health` reports it. */
export type MirrorLastRun = {
  at: string;
  source: "create" | "manual";
  status: MirrorResult["status"];
  copied_blobs: number;
  copied_indexes: number;
  bytes: number;
  elapsed_ms: number;
  timed_out?: boolean;
  failed_count?: number;
  error?: string;
};

export type MirrorHealth =
  | { configured: false }
  | { configured: true; dir: string | null; state: "never_run" | MirrorResult["status"]; last_run: MirrorLastRun | null; hint?: string };

let lastRun: MirrorLastRun | undefined;

function recordMirrorRun(source: MirrorLastRun["source"], result: MirrorResult): void {
  lastRun = {
    at: new Date().toISOString(),
    source,
    status: result.status,
    copied_blobs: result.copied_blobs,
    copied_indexes: result.copied_indexes,
    bytes: result.bytes,
    elapsed_ms: result.elapsed_ms,
    ...(result.timed_out ? { timed_out: true } : {}),
    ...(result.failed_count ? { failed_count: result.failed_count } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Test hook: forget the recorded run. */
export function resetMirrorHealthForTests(): void {
  lastRun = undefined;
}

/**
 * Mirror state for `health`: no I/O and never throws, so health stays fast. A malformed
 * `VENIRA_SNAPSHOT_MIRROR_DIR` still reads as configured (dir null) with the error of the last run.
 */
export function mirrorHealth(): MirrorHealth {
  if (!snapshotMirrorConfigured()) return { configured: false };
  let dir: string | null = null;
  try {
    dir = snapshotMirrorRootDir();
  } catch {
    dir = null;
  }
  const state = lastRun ? lastRun.status : "never_run";
  const hint =
    state === "never_run"
      ? "No mirror run in this session yet: it syncs after the next snapshot_create, or run snapshot action=mirror."
      : state === "ok"
        ? undefined
        : "Last mirror run was not clean: run snapshot action=mirror (it resumes) and read failed[] / error.";
  return { configured: true, dir, state, last_run: lastRun ?? null, ...(hint ? { hint } : {}) };
}

/** True when a mirror is configured (a malformed value counts: it must surface as an error, not be ignored). */
export function snapshotMirrorConfigured(): boolean {
  try {
    return snapshotMirrorRootDir() !== null;
  } catch {
    return true;
  }
}

/** Budget from `VENIRA_SNAPSHOT_MIRROR_TIMEOUT_MS` when it is a positive number, else the given default. */
export function mirrorTimeoutMs(defaultMs: number): number {
  const value = Number(process.env.VENIRA_SNAPSHOT_MIRROR_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultMs;
}

/**
 * Comparable form of a path: resolved, with the deepest existing ancestor realpath'd (symlinks and 8.3 names
 * cannot hide an overlap) and case-folded on Windows. Works for paths that do not exist yet.
 */
function canon(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) break;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
  const full = path.join(head, ...tail);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const base = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(base);
}

/** Resolve and validate the mirror target. Throws `[config_invalid]` with a specific reason. */
export function resolveMirrorTarget(root: string): { mirrorRoot: string; projectDir: string } {
  const configured = snapshotMirrorRootDir(); // throws [config_invalid] for a relative path
  if (!configured) {
    throw new Error(
      "[config_invalid] VENIRA_SNAPSHOT_MIRROR_DIR is not set. Hint: set it to an absolute folder (OneDrive, NAS share, USB drive, rclone mount) to enable the snapshot mirror.",
    );
  }
  const mirror = canon(configured);
  const storeDir = snapshotDataDir();
  const guards = [canon(storeDir)];
  if (!snapshotExactDir()) guards.push(canon(snapshotRootDir(defaultDataDir())));
  for (const guard of guards) {
    if (isInsideOrEqual(mirror, guard) || isInsideOrEqual(guard, mirror)) {
      throw new Error(
        `[config_invalid] VENIRA_SNAPSHOT_MIRROR_DIR (${configured}) must not equal, contain or sit inside the local checkpoint store (${storeDir}). Hint: point it at a different folder or drive.`,
      );
    }
  }
  if (isInsideOrEqual(mirror, canon(root))) {
    throw new Error(
      `[config_invalid] VENIRA_SNAPSHOT_MIRROR_DIR (${configured}) must not sit inside the workspace: checkpoints would capture the mirror. Hint: use a folder outside the project.`,
    );
  }
  const mirrorRoot = path.resolve(configured);
  return { mirrorRoot, projectDir: path.join(mirrorRoot, path.basename(path.resolve(storeDir))) };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readWorkspaceOf(metaFile: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(metaFile, "utf8")) as { workspace?: unknown };
    return typeof parsed.workspace === "string" ? parsed.workspace : null;
  } catch {
    return null;
  }
}

/** Write `data` next to `dest` under a temp name, prove it reads back identically (and passes `accept`), then rename. */
async function writeChecked(
  dest: string,
  data: Buffer,
  accept: (written: Buffer) => boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${crypto.randomBytes(3).toString("hex")}`;
  try {
    await fs.writeFile(tmp, data);
    const written = await fs.readFile(tmp);
    if (!written.equals(data) || !accept(written)) {
      await fs.rm(tmp, { force: true });
      return { ok: false, reason: "mirror_write_mismatch" };
    }
    await fs.rename(tmp, dest);
    return { ok: true };
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return { ok: false, reason: `mirror_write_failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
  }
}

async function copyBlob(sha: string, dest: string): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
  let data: Buffer;
  try {
    data = await fs.readFile(blobPath(sha));
  } catch {
    return { ok: false, reason: "local_blob_missing" };
  }
  if (hashBuffer(data) !== sha) return { ok: false, reason: "local_blob_corrupt" };
  const written = await writeChecked(dest, data, (buffer) => hashBuffer(buffer) === sha);
  return written.ok ? { ok: true, bytes: data.length } : written;
}

async function copyFileChecked(src: string, dest: string): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
  let data: Buffer;
  try {
    data = await fs.readFile(src);
  } catch {
    return { ok: false, reason: "local_file_missing" };
  }
  const written = await writeChecked(dest, data, () => true);
  return written.ok ? { ok: true, bytes: data.length } : written;
}

/** Names of the blobs already at the mirror (one readdir per shard, far cheaper than a stat per blob on a share). */
async function listMirrorBlobs(projectDir: string): Promise<Set<string>> {
  const found = new Set<string>();
  let shards: string[];
  try {
    shards = await fs.readdir(path.join(projectDir, "blobs"));
  } catch {
    return found;
  }
  for (const shard of shards) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(projectDir, "blobs", shard));
    } catch {
      continue;
    }
    for (const name of names) if (SHA_RE.test(name)) found.add(name);
  }
  return found;
}

async function listMirrorIndexes(projectDir: string): Promise<Set<string>> {
  try {
    return new Set(await fs.readdir(path.join(projectDir, "index")));
  } catch {
    return new Set();
  }
}

/**
 * Sync the local store to the mirror. Throws `[config_invalid]` / `[mirror_conflict]` for configuration
 * problems; per-file problems are reported in `failed[]` and make the status `partial`.
 */
export async function syncSnapshotMirror(
  root: string,
  options: { verify?: boolean; timeoutMs?: number } = {},
): Promise<MirrorResult> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? MIRROR_AUTO_TIMEOUT_MS);
  const verify = options.verify === true;
  const { mirrorRoot, projectDir } = resolveMirrorTarget(root);

  const rootStat = await fs.stat(mirrorRoot).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(
      `[config_invalid] VENIRA_SNAPSHOT_MIRROR_DIR (${mirrorRoot}) does not exist or is not a folder. Hint: create it, or mount the drive/share first; venira does not create the mirror root.`,
    );
  }

  // Never mix two workspaces in one mirror folder.
  const localMeta = path.join(snapshotDataDir(), META_FILE);
  const mirrorMeta = path.join(projectDir, META_FILE);
  const [localWorkspace, mirrorWorkspace] = await Promise.all([readWorkspaceOf(localMeta), readWorkspaceOf(mirrorMeta)]);
  if (localWorkspace && mirrorWorkspace && canon(localWorkspace) !== canon(mirrorWorkspace)) {
    throw new Error(
      `[mirror_conflict] ${projectDir} already belongs to another workspace (${mirrorWorkspace}). Hint: use a separate VENIRA_SNAPSHOT_MIRROR_DIR per workspace, or remove the stale folder by hand.`,
    );
  }
  await fs.mkdir(projectDir, { recursive: true });

  const { manifests, unreadable } = await listManifestsDetailed(); // newest first
  const result: MirrorResult = {
    status: "ok",
    dir: projectDir,
    copied_blobs: 0,
    copied_indexes: 0,
    bytes: 0,
    elapsed_ms: 0,
  };
  const failed: MirrorFailure[] = [];
  const fail = (entry: MirrorFailure) => failed.push(entry);
  let timedOut = false;
  const outOfTime = () => {
    if (Date.now() > deadline) timedOut = true;
    return timedOut;
  };

  // Every blob a readable checkpoint references, newest checkpoint first.
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const manifest of manifests) {
    for (const file of manifest.files) {
      const sha = file.sha256.toLowerCase();
      if (!seen.has(sha)) {
        seen.add(sha);
        wanted.push(sha);
      }
    }
  }

  // ---- Phase 1: blobs --------------------------------------------------------------------------------------
  const present = await listMirrorBlobs(projectDir);
  const ready = new Set<string>(); // blobs known good at the mirror
  let verified = 0;
  let repairedBlobs = 0;
  for (const sha of wanted) {
    if (outOfTime()) break;
    const dest = path.join(projectDir, "blobs", sha.slice(0, 2), sha);
    let repairing = false;
    if (present.has(sha)) {
      if (!verify) {
        ready.add(sha);
        continue;
      }
      const existing = await fs.readFile(dest).catch(() => null);
      if (existing && hashBuffer(existing) === sha) {
        verified += 1;
        ready.add(sha);
        continue;
      }
      repairing = true; // present but unreadable or wrong: re-copy from the local store
    }
    const copied = await copyBlob(sha, dest);
    if (!copied.ok) {
      fail({ kind: "blob", id: sha, reason: copied.reason });
      continue;
    }
    ready.add(sha);
    result.bytes += copied.bytes;
    if (repairing) repairedBlobs += 1;
    else result.copied_blobs += 1;
  }

  // ---- Phase 2: indexes (only those whose blobs are all at the mirror) -------------------------------------
  let repairedIndexes = 0;
  if (!timedOut) {
    const mirrorIndexes = await listMirrorIndexes(projectDir);
    for (const manifest of manifests) {
      if (outOfTime()) break;
      const name = `${manifest.id}.json.gz`;
      const dest = path.join(projectDir, "index", name);
      if (!manifest.files.every((file) => ready.has(file.sha256.toLowerCase()))) {
        fail({ kind: "index", id: manifest.id, reason: "blobs_incomplete" });
        continue;
      }
      let repairing = false;
      if (mirrorIndexes.has(name)) {
        if (!verify) continue;
        const [localBytes, mirrorBytes] = await Promise.all([
          fs.readFile(indexPath(manifest.id)).catch(() => null),
          fs.readFile(dest).catch(() => null),
        ]);
        if (localBytes && mirrorBytes && localBytes.equals(mirrorBytes)) continue;
        repairing = true;
      }
      const copied = await copyFileChecked(indexPath(manifest.id), dest);
      if (!copied.ok) {
        fail({ kind: "index", id: manifest.id, reason: copied.reason });
        continue;
      }
      result.bytes += copied.bytes;
      if (repairing) repairedIndexes += 1;
      else result.copied_indexes += 1;
    }
  }

  // ---- Phase 3: project.json (copied once; never rewritten) ------------------------------------------------
  if (!timedOut && localWorkspace && !mirrorWorkspace && !(await pathExists(mirrorMeta))) {
    const copied = await copyFileChecked(localMeta, mirrorMeta);
    if (copied.ok) result.bytes += copied.bytes;
    else fail({ kind: "meta", id: META_FILE, reason: copied.reason });
  }

  if (verify) result.verified_blobs = verified;
  if (repairedBlobs > 0) result.repaired_blobs = repairedBlobs;
  if (repairedIndexes > 0) result.repaired_indexes = repairedIndexes;
  if (unreadable.length > 0) result.skipped_unreadable = unreadable.length;
  if (timedOut) result.timed_out = true;
  if (failed.length > 0) {
    result.failed_count = failed.length;
    result.failed = failed.slice(0, MAX_FAILED_REPORTED);
  }
  result.status = timedOut || failed.length > 0 ? "partial" : "ok";
  result.elapsed_ms = Date.now() - started;
  return result;
}

/**
 * Best-effort sync after `snapshot_create`: returns undefined when no mirror is configured, never throws,
 * and never affects the checkpoint's own status. Configuration problems come back as `status: "error"`.
 */
export async function runMirrorAfterCreate(root: string): Promise<MirrorResult | undefined> {
  if (!snapshotMirrorConfigured()) return undefined;
  const started = Date.now();
  let result: MirrorResult;
  try {
    result = await syncSnapshotMirror(root, { verify: false, timeoutMs: mirrorTimeoutMs(MIRROR_AUTO_TIMEOUT_MS) });
  } catch (error) {
    result = {
      status: "error",
      copied_blobs: 0,
      copied_indexes: 0,
      bytes: 0,
      elapsed_ms: Date.now() - started,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    };
  }
  recordMirrorRun("create", result);
  return result;
}

/** `snapshot action=mirror`: the same sync on demand; configuration problems are errors, not results. */
export async function opSnapshotMirror(args: Record<string, unknown>, root: string): Promise<RustResponse> {
  const started = Date.now();
  let data: MirrorResult;
  try {
    data = await syncSnapshotMirror(root, {
      verify: args.verify === true,
      timeoutMs: mirrorTimeoutMs(MIRROR_MANUAL_TIMEOUT_MS),
    });
  } catch (error) {
    // Still an error to the caller, but health must also show that the last manual run failed.
    recordMirrorRun("manual", {
      status: "error",
      copied_blobs: 0,
      copied_indexes: 0,
      bytes: 0,
      elapsed_ms: Date.now() - started,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    });
    throw error;
  }
  recordMirrorRun("manual", data);
  const hint =
    data.timed_out || data.status === "partial"
      ? "Mirror is incomplete. Run action=mirror again: it resumes and only copies what is still missing (failed[] lists per-file reasons)."
      : undefined;
  return {
    status: "completed",
    result: { kind: "snapshot_mirror", data: { ...data, ...(hint ? { hint } : {}) } },
  };
}
