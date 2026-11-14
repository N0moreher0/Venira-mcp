/**
 * corehost write-side file ops: write_file, edit_file (with fuzzy matching),
 * create_directory, delete_path. Extracted from corehost.ts; behaviour is
 * unchanged.
 */
import { constants as fsConstants, existsSync, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveInWorkspace, errorWithData, type RustResponse } from "./corehost-common.js";
import { isProtectedPath, PLATFORM, WORKSPACE } from "./workspace.js";
import { editFuzzyEnabled } from "./env.js";
import { fuzzyEditArgsUsed } from "./arg-hints.js";
import { buildEditContext, detectIndentation, detectLineEndings, editMatchLocations, findEditMismatch, levenshtein, normalizeForFuzzy } from "./file-ops-helpers.js";
import { sanitizeReason } from "./snapshots.js";
import { recordRecentFile, recordRecentFileMeta, removeFromRecentIndex } from "./recent-index.js";


export async function opWriteFile(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  if (isProtectedPath(absPath)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not write protected files.`);
  }
  // Enforce expected_sha256 (anti-overwrite guard): compare against current
  // file content before mutating.
  const expectedSha = args.expected_sha256;
  if (typeof expectedSha === "string" && expectedSha) {
    let current = "";
    try {
      const buf = await fs.readFile(absPath);
      current = crypto.createHash("sha256").update(buf).digest("hex");
    } catch {
      /* file may not exist: treat as empty hash */
    }
    if (current !== String(expectedSha).toLowerCase()) {
      throw errorWithData(
        "stale_content",
        `The file changed since you read it (current sha256 ${current.slice(0, 12)}..., expected ${String(expectedSha).toLowerCase().slice(0, 12)}...).`,
        {
          sha256: current || null,
          expected_sha256: String(expectedSha).toLowerCase(),
          fresh_read_required: true,
          next_action: "read_file",
        },
      );
    }
  }

  const content = args.content as string;
  const mode = (args.mode as string | undefined) ?? "overwrite";
  const createDirs = args.create_dirs === true;
  const parentDir = path.dirname(absPath);

  if (createDirs) {
    await fs.mkdir(parentDir, { recursive: true });
  } else if (mode !== "append") {
    // Roadmap item 15 (P1): writing into a missing parent directory used to
    // surface as io_error ("file may be locked, retry once") and leaked the
    // temporary file name. It is an argument problem, not a transient one.
    try {
      const parent = await fs.stat(parentDir);
      if (!parent.isDirectory()) {
        throw new Error(
          `[invalid_request] The parent path is not a directory: ${path.relative(root, parentDir) || "."}. ` +
            "Hint: pass a file path whose parent is a directory, or create the directory with create.",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("[invalid_request]")) throw error;
      throw new Error(
        `[invalid_request] The parent directory does not exist: ${path.relative(root, parentDir) || "."}. ` +
          "Hint: pass create_dirs=1, or create the directory with create.",
      );
    }
  }

  const action = mode === "create" ? "created" : mode === "append" ? "appended" : "overwritten";
  let bytesWritten = Buffer.byteLength(content, "utf8");

  if (mode === "create" && existsSync(absPath)) {
    throw new Error(
      `[conflict] File already exists: ${args.relative_path} (mode=create). Hint: use mode=overwrite to replace.`,
    );
  }

  if (mode === "append") {
    try {
      await fs.appendFile(absPath, content, "utf8");
    } catch (error) {
      throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
    }
    // R11: update recent-files index on append
    recordRecentFile(absPath, root);
    try {
      await fs.stat(absPath).then((s) => recordRecentFileMeta(absPath, s));
    } catch { /* best-effort */ }
  } else {
    // R1: atomic write (temp + fsync + rename); mode:"create" guarded by existsSync check above.
    const dir = path.dirname(absPath);
    const tmp = path.join(dir, `.venira-tmp-${process.pid}-${Date.now()}`);
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
      // The temporary name stays out of the message (roadmap item 15, P1).
      throw new Error(
        `[io_error] Cannot write ${args.relative_path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // P2: Update recent-files index
    recordRecentFile(absPath, root);
    try {
      await fs.stat(absPath).then((s) => recordRecentFileMeta(absPath, s));
    } catch { /* best-effort */ }
  }

  let sha256After = "";
  try {
    const written = await fs.readFile(absPath);
    sha256After = crypto.createHash("sha256").update(written).digest("hex");
  } catch {
    /* sha256 is best-effort */
  }

  return {
    status: "completed",
    result: {
      kind: "file_written",
      data: {
        relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
        action,
        bytes_written: bytesWritten,
        sha256_after: sha256After || undefined,
        reason: sanitizeReason(args.reason),
      },
    },
  };
}

export async function opEditFile(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  if (isProtectedPath(absPath)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not edit protected files.`);
  }
  // The workspace-relative path of the file, for the recovery payload: the
  // agent can paste it into any tool, and it does not depend on parsing the
  // message (the message carries the diagnosis now).
  const relFile = path.relative(root, absPath).replace(/\\/g, "/") || String(args.relative_path);
  const edits = args.edits as
    | Array<{ old_text: string; new_text: string; replace_all?: boolean }>
    | undefined;
  const oldText = args.old_text as string | undefined;
  const newText = args.new_text as string | undefined;
  const replaceAll = args.replace_all === true;
  
  // P2: Fuzzy edit support
  const fuzzyEnabled = editFuzzyEnabled();
  const fuzzyDistance = Number(args.fuzzy_distance ?? 3);
  const ignoreIndentation = args.ignore_indentation === true;
  const caseInsensitive = args.case_insensitive === true;
  // The fuzzy options are only advertised in the schema when VENIRA_EDIT_FUZZY=1 (ROADMAP_TOOL_SCHEMA.md,
  // phase 3). A client with a cached tool list may still send them: say what to change instead of
  // silently running an exact-match edit.
  if (!fuzzyEnabled) {
    const asked = fuzzyEditArgsUsed(args);
    if (asked.length > 0) {
      throw new Error(
        `[unsupported] ${asked.join(", ")} need fuzzy matching, which is off. Set VENIRA_EDIT_FUZZY=1 on the host to enable it, or drop these arguments and send the exact old_text.`,
      );
    }
  }

  // Phase 5: the legacy `guard` flag is gone. A cached client that still sends it must not silently
  // skip verification, so say what replaced it instead of ignoring it.
  if (args.guard !== undefined) {
    throw new Error(
      "[unsupported] guard was removed. Hint: send expected_sha256 instead (sha256_after from your last write/edit, or read_file's sha256 when the whole file was returned).",
    );
  }

  // Verify mode (read fresh, check expected_sha256, apply edits, write, re-read and verify) is derived
  // from expected_sha256 only (ROADMAP_TOOL_SCHEMA.md, phases 1 and 5).
  const verifyMode = typeof args.expected_sha256 === "string" && args.expected_sha256.length > 0;

  const editList = edits ?? (oldText !== undefined ? [{ old_text: oldText, new_text: newText ?? "", replace_all: replaceAll }] : []);
  if (editList.length === 0) {
    throw new Error(
      `[invalid_request] No edits provided. Pass old_text/new_text or edits[].`,
    );
  }

  let fileBytes: Buffer;
  try {
    fileBytes = await fs.readFile(absPath);
  } catch {
    throw new Error(`[not_found] File does not exist: ${args.relative_path}. Hint: create it with write_file first.`);
  }
  let content: string = fileBytes.toString("utf8");

  // R2: detect BOM + EOL style of the file.
  const hadBom = content.startsWith("\ufeff");
  const body = hadBom ? content.slice(1) : content;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const eolLabel = eol === "\r\n" ? "crlf" : "lf";
  // work on body without BOM; normalize line endings internally (keep original eol in body)
  content = body;

  // helper to normalize incoming text line endings to the file's EOL
  const normalizeEol = (s: string) => s.replace(/\r\n|\r|\n/g, eol);

  // Roadmap item 17: the guard hash is the hash of the file's raw bytes, so it
  // matches read_file's `sha256` (whole file) and write_file's
  // check. The BOM is part of the file and therefore part of the hash.
  let sha256Before = "";
  try {
    sha256Before = crypto.createHash("sha256").update(fileBytes).digest("hex");
  } catch {
    /* best-effort */
  }

  // Enforce expected_sha256 (anti-overwrite guard).
  const expectedSha2 = args.expected_sha256;
  if (typeof expectedSha2 === "string" && expectedSha2) {
    if (sha256Before !== String(expectedSha2).toLowerCase()) {
      throw errorWithData(
        "stale_content",
        `The file changed since you read it (current sha256 ${sha256Before.slice(0, 12)}..., expected ${String(expectedSha2).toLowerCase().slice(0, 12)}...).`,
        {
          sha256: sha256Before || null,
          expected_sha256: String(expectedSha2).toLowerCase(),
          fresh_read_required: true,
          next_action: "read_file",
          ...(await fs.stat(absPath).then((s) => ({ mtime_ms: s.mtimeMs })).catch(() => ({}))),
        },
      );
    }
  }

  let replacements = 0;
  let usedFuzzy = false;
  // Roadmap item 15 (P2): with several edits[] the error did not say which
  // edit failed, nor that the file was left untouched.
  for (const [editIndex, edit] of editList.entries()) {
    const old_text = normalizeEol(edit.old_text as string);
    const new_text = normalizeEol((edit.new_text ?? "") as string);
    const replace_all = edit.replace_all;
    if (typeof old_text !== "string" || old_text.length === 0) {
      throw errorWithData(
        "invalid_request",
        `old_text must be a non-empty string (field: ${args.relative_path}).`,
        { edit_index: editIndex, suggestion: "pass the exact text to replace" },
      );
    }
    if (old_text === new_text) continue;
    if (!(replace_all || replaceAll)) {
      const occurrences = (content.split(old_text).length - 1);
      if (occurrences > 1) {
        throw errorWithData(
          "old_text_ambiguous",
          `old_text matches ${occurrences} locations in ${args.relative_path}. Extend old_text to include more context or set replace_all=true.`,
          {
            occurrences,
            matches: editMatchLocations(content, old_text),
            edit_index: editIndex,
            edit_count: editList.length,
            file_unchanged: true,
            // The file, so the recovery does not have to parse it out of the
            // message (the message carries the diagnosis now).
            file: relFile,
            // Roadmap item 15 (P2): the whitespace facts the agent cannot
            // see in plain text.
            indentation: detectIndentation(content),
            line_endings: detectLineEndings(content),
            suggestion: "extend old_text with surrounding context or set replace_all=true",
          },
        );
      }
    }
    let idx = content.indexOf(old_text);

    // P2: Fuzzy match fallback
    if (idx === -1 && fuzzyEnabled) {
      const fuzzyResult = findFuzzyMatch(content, old_text, fuzzyDistance, ignoreIndentation, caseInsensitive);
      if (fuzzyResult !== -1) {
        idx = fuzzyResult;
        usedFuzzy = true;
        console.error(`[corehost] fuzzy match found at offset ${idx} (distance ${fuzzyDistance})`);
      }
    }

    if (idx === -1) {
      // Roadmap item 15 (P2): the error must be small. A long edit that does
      // not apply used to answer with a long error; now it answers with a
      // diagnosis (file, line, how far off) and three lines of context on
      // each side of the wrong spot.
      const mismatch = findEditMismatch(content, old_text);
      const context = buildEditContext(content, mismatch?.line ?? 1, String(args.relative_path));
      throw errorWithData(
        "old_text_not_found",
        `old_text not found in ${args.relative_path}` +
          (mismatch
            ? `: line ${mismatch.line}, character ${mismatch.char_offset}, ${mismatch.chars_off} character(s) off`
            : "") +
          `. Hint: fix the line the context points at and copy it from context.text (no line numbers).`,
        {
          occurrences: 0,
          edit_index: editIndex,
          edit_count: editList.length,
          file_unchanged: true,
          // The file, so the recovery does not have to parse it out of the
          // message (the message carries the diagnosis now).
          file: relFile,
          ...(mismatch ? { mismatch } : {}),
          context,
          indentation: detectIndentation(content),
          line_endings: detectLineEndings(content),
          suggestion: "copy context.text into old_text (it has no line numbers)",
        },
      );
    }
    if (replace_all || replaceAll) {
      const parts = content.split(old_text);
      content = parts.join(new_text);
      replacements += parts.length - 1;
    } else {
      content = content.slice(0, idx) + new_text + content.slice(idx + old_text.length);
      replacements += 1;
    }
  }

  // Prepend BOM if original had it
  const finalContent = hadBom ? "\ufeff" + content : content;

  // R1: atomic write
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.venira-tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, finalContent, "utf8");
    try {
      const fh = await fs.open(tmp, "r+");
      await fh.sync();
      await fh.close();
    } catch { /* best-effort */ }
    await fs.rename(tmp, absPath);
  } catch (error) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
  }

  // Compute sha256 after write (before verification uses it). The hash covers
  // the bytes that were written, so it can be fed back as expected_sha256.
  let sha256After = "";
  try {
    sha256After = crypto.createHash("sha256").update(Buffer.from(finalContent, "utf8")).digest("hex");
  } catch {
    /* best-effort */
  }

  // Verify: re-read and check the content matches what we wrote
  let verified = false;
  let verifiedSha = "";
  if (verifyMode) {
    try {
      const verifyBytes = await fs.readFile(absPath);
      const verifySha = crypto.createHash("sha256").update(verifyBytes).digest("hex");
      verified = verifySha === sha256After;
      verifiedSha = verifySha;
    } catch {
      verified = false;
    }
  }

  // P2: Update recent-files index
  recordRecentFile(absPath, root);
  try {
    await fs.stat(absPath).then((s) => {
      recordRecentFileMeta(absPath, s);
    });
  } catch { /* best-effort */ }

  return {
    status: "completed",
    result: {
      kind: "file_written",
      data: {
        relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
        action: "edited",
        replacements,
        sha256_before: sha256Before || undefined,
        sha256_after: sha256After || undefined,
        verified: verifyMode ? verified : undefined,
        verified_sha256: verifyMode && verifiedSha ? verifiedSha : undefined,
        fuzzy_used: usedFuzzy || undefined,
        reason: sanitizeReason(args.reason),
      },
    },
  };
}


/**
 * P2: Find the best fuzzy match of `needle` in `haystack` (Levenshtein distance <= maxDist).
 * Returns the start offset of the best match, or -1 if none found.
 */
function findFuzzyMatch(
  haystack: string,
  needle: string,
  maxDistance: number,
  ignoreIndentation: boolean,
  caseInsensitive: boolean,
): number {
  const hNorm = normalizeForFuzzy(haystack, ignoreIndentation, caseInsensitive);
  const nNorm = normalizeForFuzzy(needle, ignoreIndentation, caseInsensitive);
  if (!hNorm || !nNorm) return -1;
  
  let bestOffset = -1;
  let bestDistance = Infinity;
  
  // Sliding window: try matching nNorm at every position in hNorm
  const nLen = nNorm.length;
  for (let i = 0; i < hNorm.length && i + nLen <= hNorm.length; i++) {
    const window = hNorm.slice(i, i + nLen);
    const dist = levenshtein(window, nNorm);
    if (dist <= maxDistance && dist < bestDistance) {
      bestDistance = dist;
      bestOffset = i;
    }
  }
  return bestOffset;
}

/** Normalize for fuzzy matching: collapse whitespace, optionally lowercase. */
export async function opCreateDirectory(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  const createParents = args.create_parents !== false;
  try {
    await fs.mkdir(absPath, { recursive: createParents });
  } catch (error) {
    throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    status: "completed",
    result: {
      kind: "directory_created",
      data: {
        relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
        reason: sanitizeReason(args.reason),
      },
    },
  };
}

export async function opDeletePath(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const absPath = resolveInWorkspace(args.relative_path as string, root);
  // Refuse to delete the workspace root (or an ancestor of it). One call with
  // `relative_path: "."` and recursive=1 used to wipe the whole tree, and this
  // op is explicitly not undoable.
  const caseFold = (value: string) => (PLATFORM === "win32" ? value.toLowerCase() : value);
  const rootTarget = caseFold(path.resolve(root));
  const deleteTarget = caseFold(path.resolve(absPath));
  const rootInsideTarget = path.relative(deleteTarget, rootTarget);
  const targetCoversRoot =
    rootInsideTarget === "" ||
    (!rootInsideTarget.startsWith("..") && !path.isAbsolute(rootInsideTarget));
  if (targetCoversRoot) {
    throw new Error(
      `[invalid_request] Refusing to delete the workspace root: ${args.relative_path}. ` +
        "Hint: pass the path of a file or subdirectory inside the workspace.",
    );
  }
  if (isProtectedPath(absPath)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not delete protected files.`);
  }
  const recursive = args.recursive === true;
  let entriesDeleted = 0;
  let bytesDeleted = 0;

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new Error(
      `[not_found] Path does not exist: ${args.relative_path}. Hint: check with list_files.`,
    );
  }

  if (stat.isDirectory() && !recursive) {
    throw new Error(
      `[invalid_request] Directory requires recursive=1: ${args.relative_path}.`,
    );
  }

  async function countFiles(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await countFiles(abs);
      } else if (entry.isFile()) {
        try {
          const s = await fs.stat(abs);
          bytesDeleted += s.size;
        } catch { /* ignore */ }
        entriesDeleted += 1;
      }
    }
  }

  if (stat.isDirectory()) {
    await countFiles(absPath);
    entriesDeleted += 1; // the directory itself
  } else {
    bytesDeleted = stat.size;
    entriesDeleted = 1;
  }

  try {
    await fs.rm(absPath, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
  }

  // P2: Remove from recent-files index
  removeFromRecentIndex(absPath, root);

  return {
    status: "completed",
    result: {
      kind: "path_deleted",
      data: {
        relative_path: path.relative(root, absPath).replace(/\\/g, "/"),
        kind: stat.isDirectory() ? "directory" : "file",
        entries_deleted: entriesDeleted,
        bytes_deleted: bytesDeleted,
        reason: sanitizeReason(args.reason),
      },
    },
  };
}


// ---------------------------------------------------------------------------
// move_path / copy_path (ROADMAP_TOOLS.md, phase 1)
// ---------------------------------------------------------------------------

const caseFoldPath = (value: string): string => (PLATFORM === "win32" ? value.toLowerCase() : value);

/** True when `child` is `parent` itself or lies inside it (case-insensitive on Windows). */
function isInsidePath(parent: string, child: string): boolean {
  const rel = path.relative(caseFoldPath(path.resolve(parent)), caseFoldPath(path.resolve(child)));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function relativeOf(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, "/") || ".";
}

async function countTree(dir: string): Promise<{ files: number; dirs: number; bytes: number }> {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await countTree(abs);
      files += sub.files;
      dirs += sub.dirs + 1;
      bytes += sub.bytes;
    } else {
      try {
        bytes += (await fs.lstat(abs)).size;
      } catch { /* best-effort */ }
      files += 1;
    }
  }
  return { files, dirs, bytes };
}

type TransferPlan = {
  absFrom: string;
  absTo: string;
  srcStat: Stats;
  /** Source and target differ only by letter case on a case-insensitive file system. */
  caseOnly: boolean;
  /** The target is an existing file that overwrite=1 allows replacing. */
  overwrites: boolean;
  createDirs: boolean;
};

/** Shared validation for move_path and copy_path. Nothing on disk changes here. */
async function planTransfer(
  verb: "move" | "copy",
  args: Record<string, unknown>,
  root: string,
): Promise<TransferPlan> {
  const from = args.from;
  const to = args.to;
  if (typeof from !== "string" || from.trim() === "" || typeof to !== "string" || to.trim() === "") {
    throw new Error(`[invalid_request] ${verb}_path needs non-empty from and to. Hint: pass workspace-relative paths.`);
  }
  const absFrom = resolveInWorkspace(from, root);
  const absTo = resolveInWorkspace(to, root);
  for (const [label, abs, rel] of [["source", absFrom, from], ["target", absTo, to]] as const) {
    if (isProtectedPath(abs)) {
      throw new Error(`[sensitive_result] The ${label} path is protected by policy: ${rel}. Hint: do not ${verb} protected files.`);
    }
  }
  if (isInsidePath(absFrom, root)) {
    throw new Error(
      `[invalid_request] Refusing to ${verb} the workspace root: ${from}. Hint: pass a file or subdirectory inside the workspace.`,
    );
  }
  const sameFolded = caseFoldPath(path.resolve(absFrom)) === caseFoldPath(path.resolve(absTo));
  if (path.resolve(absFrom) === path.resolve(absTo)) {
    throw new Error(`[invalid_request] from and to are the same path: ${from}. Hint: pass a different target path.`);
  }
  const caseOnly = sameFolded; // distinct strings, same folded path: only possible on win32
  if (caseOnly && verb === "copy") {
    throw new Error(
      `[invalid_request] from and to differ only by letter case, which is the same file on this file system: ${from} -> ${to}. Hint: use move_path to rename it, or pick a different name.`,
    );
  }

  let srcStat: Stats;
  try {
    srcStat = await fs.lstat(absFrom);
  } catch {
    throw new Error(`[not_found] Source does not exist: ${from}. Hint: check it with list_files.`);
  }
  if (srcStat.isDirectory() && !caseOnly && isInsidePath(absFrom, absTo)) {
    throw new Error(`[invalid_request] Cannot ${verb} a directory into itself: ${from} -> ${to}. Hint: choose a target outside ${from}.`);
  }

  let overwrites = false;
  if (!caseOnly) {
    const dstStat = await fs.lstat(absTo).catch(() => null);
    if (dstStat) {
      if (args.overwrite !== true) {
        throw new Error(`[conflict] Target already exists: ${to}. Hint: pass overwrite=1 to replace a file, or choose another target.`);
      }
      if (dstStat.isDirectory() || srcStat.isDirectory()) {
        throw new Error(
          `[conflict] overwrite=1 only replaces a file with a file; ${to} or ${from} is a directory. ` +
            "Hint: delete the target with delete_path first, or choose another target.",
        );
      }
      overwrites = true;
    }
  }
  return { absFrom, absTo, srcStat, caseOnly, overwrites, createDirs: args.create_dirs !== false };
}

async function ensureTargetParent(plan: TransferPlan, root: string): Promise<void> {
  const parent = path.dirname(plan.absTo);
  if (plan.createDirs) {
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch (error) {
      throw new Error(`[io_error] Cannot create ${relativeOf(root, parent)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  const stat = await fs.stat(parent).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(
      `[invalid_request] The target's parent directory does not exist: ${relativeOf(root, parent)}. Hint: pass create_dirs=1 (the default) or create it with create.`,
    );
  }
}

export async function opMovePath(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const plan = await planTransfer("move", args, root);
  await ensureTargetParent(plan, root);
  try {
    await fs.rename(plan.absFrom, plan.absTo);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      // Different volume: copy, then remove the source.
      try {
        if (plan.srcStat.isDirectory()) {
          await fs.cp(plan.absFrom, plan.absTo, { recursive: true, errorOnExist: true, force: false });
        } else {
          await fs.copyFile(plan.absFrom, plan.absTo, plan.overwrites ? 0 : fsConstants.COPYFILE_EXCL);
        }
        await fs.rm(plan.absFrom, { recursive: true, force: true });
      } catch (inner) {
        throw new Error(`[io_error] Cannot move ${args.from} to ${args.to}: ${inner instanceof Error ? inner.message : String(inner)}`);
      }
    } else {
      throw new Error(`[io_error] Cannot move ${args.from} to ${args.to}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  removeFromRecentIndex(plan.absFrom, root);
  let entries = 1;
  let bytes = plan.srcStat.size;
  if (plan.srcStat.isDirectory()) {
    try {
      const counted = await countTree(plan.absTo);
      entries = counted.files + counted.dirs + 1;
      bytes = counted.bytes;
    } catch { /* best-effort */ }
  } else {
    recordRecentFile(plan.absTo, root);
    try {
      await fs.stat(plan.absTo).then((s) => recordRecentFileMeta(plan.absTo, s));
    } catch { /* best-effort */ }
  }

  return {
    status: "completed",
    result: {
      kind: "path_moved",
      data: {
        from: relativeOf(root, plan.absFrom),
        to: relativeOf(root, plan.absTo),
        kind: plan.srcStat.isDirectory() ? "directory" : "file",
        overwritten: plan.overwrites,
        entries,
        bytes,
        reason: sanitizeReason(args.reason),
      },
    },
  };
}

export async function opCopyPath(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const plan = await planTransfer("copy", args, root);
  if (plan.srcStat.isSymbolicLink()) {
    throw new Error(`[unsupported] Symbolic links are not copied: ${args.from}. Hint: copy the file it points to.`);
  }
  const isDir = plan.srcStat.isDirectory();
  if (isDir && args.recursive !== true) {
    throw new Error(`[invalid_request] ${args.from} is a directory. Hint: pass recursive=1 to copy it.`);
  }
  await ensureTargetParent(plan, root);

  let skippedSymlinks = 0;
  let skippedProtected = 0;
  try {
    if (isDir) {
      await fs.cp(plan.absFrom, plan.absTo, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: async (src: string) => {
          if (path.resolve(src) === path.resolve(plan.absFrom)) return true;
          if (isProtectedPath(src)) {
            skippedProtected += 1;
            return false;
          }
          try {
            if ((await fs.lstat(src)).isSymbolicLink()) {
              skippedSymlinks += 1;
              return false;
            }
          } catch { /* let fs.cp report it */ }
          return true;
        },
      });
    } else {
      await fs.copyFile(plan.absFrom, plan.absTo, plan.overwrites ? 0 : fsConstants.COPYFILE_EXCL);
    }
  } catch (error) {
    throw new Error(`[io_error] Cannot copy ${args.from} to ${args.to}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let entries = 1;
  let bytes = plan.srcStat.size;
  if (isDir) {
    try {
      const counted = await countTree(plan.absTo);
      entries = counted.files + counted.dirs + 1;
      bytes = counted.bytes;
    } catch { /* best-effort */ }
  } else {
    recordRecentFile(plan.absTo, root);
    try {
      await fs.stat(plan.absTo).then((s) => recordRecentFileMeta(plan.absTo, s));
    } catch { /* best-effort */ }
  }

  return {
    status: "completed",
    result: {
      kind: "path_copied",
      data: {
        from: relativeOf(root, plan.absFrom),
        to: relativeOf(root, plan.absTo),
        kind: isDir ? "directory" : "file",
        overwritten: plan.overwrites,
        entries,
        bytes,
        ...(skippedSymlinks > 0 ? { skipped_symlinks: skippedSymlinks } : {}),
        ...(skippedProtected > 0 ? { skipped_protected: skippedProtected } : {}),
        reason: sanitizeReason(args.reason),
      },
    },
  };
}
