/**
 * corehost write-side file ops: write_file, edit_file (with fuzzy matching),
 * create_directory, delete_path. Extracted from corehost.ts; behaviour is
 * unchanged.
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveInWorkspace, errorWithData, type RustResponse } from "./corehost-common.js";
import { isProtectedPath, PLATFORM, WORKSPACE } from "./workspace.js";
import { envFlag } from "./env.js";
import { editMatchLocations, levenshtein, normalizeForFuzzy } from "./file-ops-helpers.js";
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
        `sha256 hiện tại (${current.slice(0, 12)}…) khác expected_sha256. Hint: đọc lại file rồi thử lại.`,
        { sha256: current || null, expected_sha256: String(expectedSha).toLowerCase() },
      );
    }
  }

  const content = args.content as string;
  const mode = (args.mode as string | undefined) ?? "overwrite";
  const createDirs = args.create_dirs === true;

  if (createDirs) {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
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
      throw new Error(`[io_error] ${error instanceof Error ? error.message : String(error)}`);
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
  const edits = args.edits as
    | Array<{ old_text: string; new_text: string; replace_all?: boolean }>
    | undefined;
  const oldText = args.old_text as string | undefined;
  const newText = args.new_text as string | undefined;
  const replaceAll = args.replace_all === true;
  
  // P2: Fuzzy edit support
  const fuzzyEnabled = envFlag("VENIRA_EDIT_FUZZY", false);
  const fuzzyDistance = Number(args.fuzzy_distance ?? 3);
  const ignoreIndentation = args.ignore_indentation === true;
  const caseInsensitive = args.case_insensitive === true;
  
  // TOCTOU guard: "sha256" = read fresh, verify expected_sha256, apply edits, write, re-read and verify
  const guard = args.guard === "sha256";

  const editList = edits ?? (oldText !== undefined ? [{ old_text: oldText, new_text: newText ?? "", replace_all: replaceAll }] : []);
  if (editList.length === 0) {
    throw new Error(
      `[invalid_request] No edits provided. Pass old_text/new_text or edits[].`,
    );
  }

  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch {
    throw new Error(`[not_found] File does not exist: ${args.relative_path}. Hint: create it with project_write_file first.`);
  }

  // R2: detect BOM + EOL style of the file.
  const hadBom = content.startsWith("\ufeff");
  const body = hadBom ? content.slice(1) : content;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const eolLabel = eol === "\r\n" ? "crlf" : "lf";
  // work on body without BOM; normalize line endings internally (keep original eol in body)
  content = body;

  // helper to normalize incoming text line endings to the file's EOL
  const normalizeEol = (s: string) => s.replace(/\r\n|\r|\n/g, eol);

  let sha256Before = "";
  try {
    sha256Before = crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  } catch {
    /* best-effort */
  }

  // Enforce expected_sha256 (anti-overwrite guard).
  const expectedSha2 = args.expected_sha256;
  if (typeof expectedSha2 === "string" && expectedSha2) {
    if (sha256Before !== String(expectedSha2).toLowerCase()) {
      throw errorWithData(
        "stale_content",
        `sha256 hiện tại (${sha256Before.slice(0, 12)}…) khác expected_sha256. Hint: đọc lại file rồi thử lại.`,
        {
          sha256: sha256Before || null,
          expected_sha256: String(expectedSha2).toLowerCase(),
          mtime_ms: (await fs.stat(absPath)).mtimeMs,
        },
      );
    }
  }

  let replacements = 0;
  let usedFuzzy = false;
  for (const edit of editList) {
    const old_text = normalizeEol(edit.old_text as string);
    const new_text = normalizeEol((edit.new_text ?? "") as string);
    const replace_all = edit.replace_all;
    if (typeof old_text !== "string" || old_text.length === 0) {
      throw new Error(`[invalid_request] old_text must be a non-empty string (field: ${args.relative_path}).`);
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
      throw errorWithData(
        "old_text_not_found",
        `old_text not found in ${args.relative_path}. Hint: re-read the file to confirm the exact text.${fuzzyEnabled ? " (Fuzzy edit enabled with distance " + fuzzyDistance + ")" : ""}`,
        { occurrences: 0, suggestion: "re-read file and copy exact old_text" },
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

  // Compute sha256 after write (before guard uses it)
  let sha256After = "";
  try {
    sha256After = crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  } catch {
    /* best-effort */
  }

  // TOCTOU guard: re-read and verify content matches what we wrote
  let verified = false;
  let verifiedSha = "";
  if (guard) {
    try {
      const verifyContent = await fs.readFile(absPath, "utf8");
      const verifySha = crypto.createHash("sha256").update(Buffer.from(verifyContent, "utf8")).digest("hex");
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
        verified: guard ? verified : undefined,
        verified_sha256: guard && verifiedSha ? verifiedSha : undefined,
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
    throw new Error(`[not_found] Path does not exist: ${args.relative_path}.`);
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
