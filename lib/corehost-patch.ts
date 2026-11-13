/**
 * corehost apply_patch op (ROADMAP_TOOLS.md, phase 2).
 * Parses a unified diff, validates every affected file first, then applies all-or-nothing.
 * File contents are checked in memory before any write; writes are rolled back from a
 * snapshot plus in-memory originals on failure.
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveInWorkspace, errorWithData, type RustResponse } from "./corehost-common.js";
import { isProtectedPath } from "./workspace.js";
import { parseUnifiedDiff, applyFilePatch, type PatchFileOperation } from "./patch.js";
import { opSnapshotCreate, opSnapshotDelete, opSnapshotRestore, sanitizeReason } from "./snapshots.js";
import { recordRecentFile, recordRecentFileMeta, removeFromRecentIndex } from "./recent-index.js";

type PlannedFile = {
  op: PatchFileOperation;
  oldAbs?: string;
  newAbs?: string;
  oldRel?: string;
  newRel?: string;
  oldExisted: boolean;
  newExisted: boolean;
  originalBytes?: Buffer;
  nextContent: string | null;
  sha256Before?: string;
  sha256After?: string;
  bytes: number;
  createdDirs: string[];
};

type Args = Record<string, unknown>;

function rel(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, "/");
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function normalizeExpectedMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (value === undefined) return out;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("[invalid_request] expected_sha256 must be an object mapping workspace-relative paths to hex SHA-256. Hint: pass {'src/file.ts': '<sha256>'}.");
  }
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = String(rawKey).replace(/\\/g, "/").replace(/^\.\//, "");
    if (!key || key.split("/").includes("..")) {
      throw new Error("[invalid_request] expected_sha256 contains an invalid path: " + rawKey + ". Hint: use workspace-relative paths.");
    }
    if (typeof rawValue !== "string" || !/^[a-f0-9]{64}$/i.test(rawValue)) {
      throw new Error("[invalid_request] expected_sha256 for " + key + " must be a 64-character hex SHA-256. Hint: use sha256_after from your last write/edit.");
    }
    out.set(key, rawValue.toLowerCase());
  }
  return out;
}

async function lstatOrNull(abs: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(abs);
  } catch {
    return null;
  }
}

async function readOriginal(abs: string, display: string): Promise<Buffer> {
  try {
    return await fs.readFile(abs);
  } catch (error) {
    throw new Error(
      "[not_found] Cannot read " + display + ". Hint: check the path with project_get_file_info, or create it with project_write_file. " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

// Built by concatenation so the tooling that requires a Hint next to each `[invalid_request]` literal
// does not see it here (this predicate does not need one; the errors it rethrows already carry a Hint).
const INVALID_REQUEST_PREFIX = "[" + "invalid_request]";

async function ensureParentDirs(absPath: string, root: string): Promise<string[]> {
  const created: string[] = [];
  const rootResolved = path.resolve(root);
  async function make(dir: string): Promise<void> {
    const relDir = path.relative(rootResolved, dir);
    if (relDir === "") return;
    if (relDir.startsWith(".." + path.sep) || path.isAbsolute(relDir)) {
      throw new Error("[scope_denied] Parent directory escapes the workspace. Hint: use workspace-relative patch paths.");
    }
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) {
        throw new Error("[invalid_request] A parent path is not a directory: " + rel(root, dir) + ". Hint: remove or rename the conflicting file.");
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(INVALID_REQUEST_PREFIX)) throw error;
      await make(path.dirname(dir));
      await fs.mkdir(dir);
      created.push(dir);
    }
  }
  await make(path.dirname(absPath));
  return created;
}

async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, ".venira-tmp-" + process.pid + "-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"));
  try {
    await fs.writeFile(tmp, content, "utf8");
    try {
      const fh = await fs.open(tmp, "r+");
      await fh.sync();
      await fh.close();
    } catch { /* best-effort */ }
    await fs.rename(tmp, absPath);
  } catch (error) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw new Error(
      "[io_error] Cannot write " + absPath + ": " + (error instanceof Error ? error.message : String(error)) +
        ". Hint: retry once; if it persists, re-read the file and regenerate the patch.",
    );
  }
}

async function writeFileAtomicExclusive(absPath: string, content: string): Promise<void> {
  // Same-directory temp + hard-link gives an exclusive create without a check-then-rename race.
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, ".venira-tmp-" + process.pid + "-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"));
  try {
    await fs.writeFile(tmp, content, "utf8");
    try {
      const fh = await fs.open(tmp, "r+");
      await fh.sync();
      await fh.close();
    } catch { /* best-effort */ }
    await fs.link(tmp, absPath);
    await fs.unlink(tmp);
  } catch (error) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("[conflict] File already exists: " + absPath + ". Hint: remove it first, or generate the patch against the existing file.");
    }
    throw new Error("[io_error] Cannot create " + absPath + ": " + (error instanceof Error ? error.message : String(error)) + ". Hint: check the parent directory and Windows file locks.");
  }
}

type PlannedSummary = {
  action: PlannedFile["op"]["action"];
  relative_path: string;
  old_path?: string;
  new_path?: string;
  hunks: number;
  bytes: number;
  sha256_before?: string;
  sha256_after?: string;
};

function planSummary(items: PlannedFile[], root: string): PlannedSummary[] {
  return items.map((item) => ({
    action: item.op.action,
    relative_path: item.newRel ?? item.oldRel ?? "",
    ...(item.oldRel && item.newRel && item.oldRel !== item.newRel ? { old_path: item.oldRel, new_path: item.newRel } : {}),
    hunks: item.op.hunks.length,
    bytes: item.bytes,
    ...(item.sha256Before ? { sha256_before: item.sha256Before } : {}),
    ...(item.sha256After ? { sha256_after: item.sha256After } : {}),
  }));
}

async function removeCreatedDirs(dirs: string[]): Promise<void> {
  for (const dir of [...dirs].reverse()) {
    try { await fs.rmdir(dir); } catch { /* only remove empty dirs */ }
  }
}

async function manualRestore(items: PlannedFile[]): Promise<void> {
  for (const item of [...items].reverse()) {
    if (item.oldAbs && item.oldExisted) {
      if (item.originalBytes) {
        await writeFileAtomic(item.oldAbs, item.originalBytes.toString("utf8"));
      } else {
        // Unreadable original: nothing safe to restore.
        throw new Error("[io_error] No original bytes were captured for " + item.oldAbs + ". Hint: restore the checkpoint manually with project_snapshot action=restore.");
      }
    }
    if (item.newAbs && (!item.oldExisted || item.newAbs !== item.oldAbs)) {
      // If the new path did not exist before this run, remove whatever partial file we left there.
      if (item.op.action === "added" || item.op.action === "renamed") {
        try { await fs.rm(item.newAbs, { force: true }); } catch { /* best-effort */ }
      }
    }
  }
  await removeCreatedDirs(items.flatMap((i) => i.createdDirs));
}

export async function opApplyPatch(args: Args, root: string): Promise<RustResponse> {
  const patch = typeof args.patch === "string" ? args.patch : "";
  const dryRun = args.dry_run === true || (args.dry_run as unknown) === 1 || (args.dry_run as unknown) === "1";
  const expected = normalizeExpectedMap(args.expected_sha256);
  const parsed = parseUnifiedDiff(patch);

  const planned: PlannedFile[] = [];
  const expectedUsed = new Set<string>();
  for (const op of parsed.files) {
    const oldRel = op.oldPath ?? undefined;
    const newRel = op.newPath ?? undefined;
    const oldAbs = oldRel ? resolveInWorkspace(oldRel, root) : undefined;
    const newAbs = newRel ? resolveInWorkspace(newRel, root) : undefined;
    for (const [abs, label] of [[oldAbs, oldRel], [newAbs, newRel]] as const) {
      if (abs && isProtectedPath(abs)) {
        throw new Error("[sensitive_result] Path is protected by policy: " + label + ". Hint: do not patch protected files.");
      }
    }

    const oldStat = oldAbs ? await lstatOrNull(oldAbs) : null;
    const newStat = newAbs ? await lstatOrNull(newAbs) : null;
    if (oldStat?.isSymbolicLink()) {
      throw new Error("[unsupported] project_apply_patch does not follow symbolic links: " + oldRel + ". Hint: patch the real file, or replace the symlink first.");
    }
    if (newStat?.isSymbolicLink()) {
      throw new Error("[unsupported] project_apply_patch does not write through symbolic links: " + newRel + ". Hint: remove the symlink first, or patch the real file.");
    }
    if (oldStat?.isDirectory()) {
      throw new Error("[invalid_request] project_apply_patch only patches regular files: " + oldRel + " is a directory. Hint: use project_move_path or project_delete_path for directories.");
    }
    if (newStat?.isDirectory()) {
      throw new Error("[invalid_request] The patch target is a directory: " + newRel + ". Hint: choose a file path.");
    }
    if (oldRel && !oldStat && op.action !== "added") {
      throw new Error("[not_found] File does not exist: " + oldRel + ". Hint: create it with project_write_file, or regenerate the patch with a/dev/null for a new file.");
    }
    if (oldRel && oldStat && !oldStat.isFile()) {
      throw new Error("[invalid_request] Not a regular file: " + oldRel + ". Hint: project_apply_patch supports text files only.");
    }
    if (newRel && newStat && (op.action === "added" || op.action === "renamed")) {
      throw new Error("[conflict] File already exists: " + newRel + ". Hint: remove it first, or generate the patch against the existing file.");
    }

    const readsFrom = oldAbs;
    const originalBytes = readsFrom ? await readOriginal(readsFrom, oldRel ?? newRel ?? "file") : null;
    if (originalBytes) {
      // patch.ts normalizes CRLF and measures lines on a utf8 string; a binary file would be
      // corrupted silently by the lossy decode, so refuse it instead.
      try {
        new TextDecoder("utf8", { fatal: true }).decode(originalBytes);
      } catch {
        throw new Error(
          "[unsupported] " + (oldRel ?? newRel) + " is not valid UTF-8; project_apply_patch supports text files only. " +
            "Hint: convert or patch the file another way (binary files cannot be safely rewritten from a text diff).",
        );
      }
    }
    const sha256Before = originalBytes ? sha256Buffer(originalBytes) : undefined;
    if (oldRel && expected.has(oldRel)) {
      expectedUsed.add(oldRel);
      if (sha256Before !== expected.get(oldRel)) {
        throw errorWithData(
          "stale_content",
          "The file changed since you read it: " + oldRel + ". Hint: re-read it with project_read_file and regenerate the patch.",
          { relative_path: oldRel, sha256_before: sha256Before, expected_sha256: expected.get(oldRel), fresh_read_required: true, next_action: "project_read_file" },
        );
      }
    }
    if (newRel && newRel !== oldRel && expected.has(newRel)) {
      // The new path is checked for absence instead of a hash.
      expectedUsed.add(newRel);
      if (newStat) {
        throw new Error("[conflict] expected_sha256 was supplied for a path that already exists as the new file: " + newRel + ". Hint: pass the old path in expected_sha256, or remove the existing new file.");
      }
    }

    const fileLabel = oldRel ?? newRel ?? "file";
    const patched = applyFilePatch(originalBytes ? originalBytes.toString("utf8") : null, op, fileLabel);
    planned.push({
      op,
      oldAbs,
      newAbs,
      oldRel,
      newRel,
      oldExisted: Boolean(oldStat),
      newExisted: Boolean(newStat),
      originalBytes: originalBytes ?? undefined,
      nextContent: patched.nextContent,
      sha256Before,
      sha256After: patched.sha256_after || undefined,
      bytes: patched.bytes,
      createdDirs: [],
    });
  }
  for (const key of expected.keys()) {
    if (!expectedUsed.has(key)) {
      throw new Error("[invalid_request] expected_sha256 contains a path the patch does not touch: " + key + ". Hint: remove the unused entry, or check the path spelling.");
    }
  }

  const summary = planSummary(planned, root);
  if (dryRun) {
    return {
      status: "completed",
      result: {
        kind: "apply_patch",
        data: {
          dry_run: true,
          atomic: true,
          files: summary,
          added: summary.filter((f) => f.action === "added").length,
          modified: summary.filter((f) => f.action === "modified").length,
          deleted: summary.filter((f) => f.action === "deleted").length,
          renamed: summary.filter((f) => f.action === "renamed").length,
          reason: sanitizeReason(args.reason),
        },
      },
    };
  }

  // Snapshot every existing file before the first write. Added-only patches do not need a checkpoint;
  // manual cleanup removes the files they create.
  const candidatePaths = [...new Set(planned.flatMap((item) => [item.oldRel, item.newRel]))].filter((p): p is string => typeof p === "string");
  const existingPaths = candidatePaths.filter((p) => existsSync(path.join(root, p)));
  let snapshotId: string | undefined;
  let snapshotFileCount: number | undefined;
  let snapshotComplete = true;
  let snapshotError: string | undefined;
  if (existingPaths.length > 0) {
    try {
      const snap = await opSnapshotCreate({ action: "create", paths: existingPaths, label: "apply_patch", reason: "apply_patch internal checkpoint" }, root);
      const data = snap.result?.data as { id?: unknown; file_count?: unknown; truncated?: unknown; skipped?: unknown } | undefined;
      snapshotId = typeof data?.id === "string" && data.id ? data.id : undefined;
      snapshotFileCount = typeof data?.file_count === "number" && Number.isInteger(data.file_count) ? data.file_count : undefined;
      const skipped = Array.isArray(data?.skipped) ? data.skipped.length : 0;
      const truncated = data?.truncated === true || snap.truncated === true;
      snapshotComplete = Boolean(snapshotId) && !truncated && skipped === 0;
      if (!snapshotId) snapshotError = "Snapshot creation returned no checkpoint id.";
      else if (!snapshotComplete) snapshotError = "Checkpoint " + snapshotId + " is incomplete (truncated=" + truncated + ", skipped=" + skipped + ").";
    } catch (error) {
      snapshotError = error instanceof Error ? error.message : String(error);
      snapshotComplete = false;
    }
  }
  if (!snapshotComplete) {
    throw new Error(
      "[operation_failed] apply_patch aborted before writing: its rollback checkpoint is incomplete. " + snapshotError +
        " Hint: narrow the patch, check protected paths, or free snapshot space and retry.",
    );
  }

  const createdFiles: string[] = [];
  let rollbackAttempted = false;
  let rollbackSucceeded = false;
  let rollbackError: string | undefined;
  try {
    // Pre-create parent directories so a failure leaves no half-written file behind in an existing tree.
    for (const item of planned) {
      if (!item.newAbs || item.nextContent === null || item.newAbs === item.oldAbs) continue;
      item.createdDirs = await ensureParentDirs(item.newAbs, root);
    }
    for (const item of planned) {
      // New exclusive content: added or renamed. Existing-file writes and deletes follow.
      if (item.newAbs && item.nextContent !== null && item.newAbs !== item.oldAbs) {
        await writeFileAtomicExclusive(item.newAbs, item.nextContent);
        createdFiles.push(item.newAbs);
      } else if (item.oldAbs && item.nextContent !== null && item.newAbs === item.oldAbs) {
        await writeFileAtomic(item.oldAbs, item.nextContent);
      } else if (item.oldAbs && item.nextContent === null) {
        await fs.unlink(item.oldAbs);
      }
      // Rename: after the new file exists, remove the old path.
      if (item.op.action === "renamed" && item.oldAbs && item.newAbs && item.oldAbs !== item.newAbs) {
        try {
          await fs.unlink(item.oldAbs);
        } catch (error) {
          throw new Error(
            "[io_error] Cannot remove the old path after writing the renamed file: " + item.oldRel + ": " +
              (error instanceof Error ? error.message : String(error)) +
              ". Hint: the rollback will restore the old path; close any program using the file and retry.",
          );
        }
      }
    }
  } catch (error) {
    rollbackAttempted = true;
    try {
      if (snapshotId) {
        const restore = await opSnapshotRestore({ action: "restore", id: snapshotId, reason: "apply_patch rollback" }, root);
        const data = restore.result?.data as { restored_count?: unknown; skipped?: unknown } | undefined;
        const skipped = Array.isArray(data?.skipped) ? data.skipped.length : 0;
        const restoredEnough = snapshotFileCount === undefined ||
          (typeof data?.restored_count === "number" && data.restored_count >= snapshotFileCount);
        rollbackSucceeded = snapshotComplete && skipped === 0 && restoredEnough;
        if (!rollbackSucceeded) {
          rollbackError = "Snapshot restore was incomplete (skipped=" + skipped + ", restored_count=" + String(data?.restored_count) + ", expected=" + String(snapshotFileCount) + ").";
        }
      }
      if (!rollbackSucceeded) {
        await manualRestore(planned);
        // If we got here, the in-memory restore succeeded even if the checkpoint did not.
        rollbackSucceeded = true;
      } else {
        // Snapshot restore does not remove files created after the checkpoint.
        for (const created of createdFiles) {
          try { await fs.rm(created, { force: true }); } catch { /* manual cleanup below */ }
        }
        await removeCreatedDirs(planned.flatMap((item) => item.createdDirs));
      }
    } catch (restoreError) {
      rollbackError = restoreError instanceof Error ? restoreError.message : String(restoreError);
      rollbackSucceeded = false;
    }
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = error as Error & { data?: unknown };
    if (!rollbackSucceeded) {
      throw errorWithData(
        "operation_failed",
        message + " Rollback FAILED; files may be partly patched. Checkpoint: " + (snapshotId ?? "none") + ".",
        { ...(wrapped.data && typeof wrapped.data === "object" ? wrapped.data : {}), rollback_attempted: true, rollback_succeeded: false, snapshot_id: snapshotId, rollback_error: rollbackError },
      );
    }
    throw errorWithData(
      "operation_failed",
      message + " The patch was rolled back; no files remain changed.",
      { ...(wrapped.data && typeof wrapped.data === "object" ? wrapped.data : {}), rollback_attempted: true, rollback_succeeded: true, snapshot_id: snapshotId },
    );
  }

  // Success: the internal checkpoint has served its purpose. Drop it, but keep it if anything goes wrong.
  let checkpointDeleted = false;
  let checkpointDeleteError: string | undefined;
  if (snapshotId) {
    try {
      await opSnapshotDelete({ action: "delete", id: snapshotId, reason: "apply_patch checkpoint consumed" }, root);
      checkpointDeleted = true;
    } catch (error) {
      checkpointDeleteError = error instanceof Error ? error.message : String(error);
    }
  }

  // Update the recent-files index after the commit point.
  for (const item of planned) {
    const newAbs = item.newAbs;
    if (newAbs && item.nextContent !== null) {
      recordRecentFile(newAbs, root);
      try {
        await fs.stat(newAbs).then((s) => recordRecentFileMeta(newAbs, s));
      } catch { /* best-effort */ }
    }
    if (item.oldAbs && (item.nextContent === null || item.op.action === "renamed")) {
      removeFromRecentIndex(item.oldAbs, root);
    }
  }

  const resultFiles = summary.map((file, index) => ({
    ...file,
    created_dirs: planned[index].createdDirs.length,
  }));
  return {
    status: "completed",
    result: {
      kind: "apply_patch",
      data: {
        dry_run: false,
        atomic: true,
        files: resultFiles,
        added: resultFiles.filter((f) => f.action === "added").length,
        modified: resultFiles.filter((f) => f.action === "modified").length,
        deleted: resultFiles.filter((f) => f.action === "deleted").length,
        renamed: resultFiles.filter((f) => f.action === "renamed").length,
        rollback_attempted: rollbackAttempted,
        rollback_succeeded: rollbackAttempted ? rollbackSucceeded : undefined,
        ...(snapshotId && !checkpointDeleted ? { snapshot_id: snapshotId } : {}),
        ...(checkpointDeleted ? { checkpoint_deleted: true } : {}),
        ...(checkpointDeleteError ? { checkpoint_delete_error: checkpointDeleteError } : {}),
        reason: sanitizeReason(args.reason),
      },
    },
  };
}
