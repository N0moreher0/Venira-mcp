/**
 * Pure unified-diff parsing and application helpers for project_apply_patch.
 * No filesystem access lives here; lib/corehost-patch.ts owns I/O, snapshots and audit.
 */
import crypto from "node:crypto";

export type PatchHunkLine = {
  kind: "context" | "removed" | "added";
  text: string;
  noNewline?: boolean;
};

export type PatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string;
  lines: PatchHunkLine[];
};

export type PatchFileOperation = {
  action: "added" | "modified" | "deleted" | "renamed";
  /** Workspace-relative, posix-separated. Null when the file is added. */
  oldPath: string | null;
  /** Workspace-relative, posix-separated. Null when the file is deleted. */
  newPath: string | null;
  hunks: PatchHunk[];
};

export type ParsedPatch = {
  files: PatchFileOperation[];
};

export type PatchMismatch = {
  relative_path: string;
  hunk_index: number;
  expected_start_line: number;
  actual_start_line: number;
  nearest_context: string[];
};

export type PatchApplyResult = {
  content: string;
  sha256_after: string;
  bytes: number;
};

const MAX_FILES = 200;
const MAX_HUNKS = 10_000;

function normalizePatchNewlines(input: string): string[] {
  const lines = input.split(/\r?\n/);
  // A trailing newline at the end of the patch is not content.
  return lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

function unquotePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function normalizePatchPath(raw: string): string | null {
  const unquoted = unquotePath(raw).replace(/\\/g, "/").replace(/^\.\//, "");
  if (unquoted === "/dev/null") return null;
  let path = unquoted;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  if (/^[A-Za-z]:/.test(path) || path.startsWith("/")) {
    throw new Error("[invalid_request] Patch paths must be workspace-relative, not absolute. Hint: use paths like src/file.ts.");
  }
  if (path === "" || path === "." || path.split("/").includes("..")) {
    throw new Error("[invalid_request] Patch paths must stay inside the workspace. Hint: use workspace-relative paths like src/file.ts.");
  }
  return path;
}

function parseDiffGitPaths(line: string): [string, string] | null {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (!match) return null;
  return [normalizePatchPath(match[1])!, normalizePatchPath(match[2])!];
}

function parseHunkHeader(line: string): PatchHunk | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    section: match[5]?.trim() || undefined,
    lines: [],
  };
}

function hunkConsumes(h: PatchHunk): { oldUsed: number; newUsed: number } {
  let oldUsed = 0;
  let newUsed = 0;
  for (const line of h.lines) {
    if (line.kind === "context") {
      oldUsed += 1;
      newUsed += 1;
    } else if (line.kind === "removed") {
      oldUsed += 1;
    } else if (line.kind === "added") {
      newUsed += 1;
    }
  }
  return { oldUsed, newUsed };
}

function isHunkComplete(h: PatchHunk): boolean {
  const used = hunkConsumes(h);
  return used.oldUsed >= h.oldLines && used.newUsed >= h.newLines;
}

function cloneHunk(h: PatchHunk): PatchHunk {
  return { ...h, lines: [...h.lines] };
}

export function parseUnifiedDiff(patch: string): ParsedPatch {
  if (typeof patch !== "string" || patch.trim().length === 0) {
    throw new Error("[invalid_request] patch must be a non-empty unified diff. Hint: pass the full 'diff --git ...' output.");
  }
  const lines = normalizePatchNewlines(patch);
  const sections: Array<{ lines: string[] }> = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ") || (current && current.some((l) => l.startsWith("--- ")) && line.startsWith("--- "))) {
      if (current) sections.push({ lines: current });
      current = [line];
      continue;
    }
    if (!current && (line.startsWith("--- ") || line.startsWith("*** "))) current = [line];
    else if (current) current.push(line);
    else if (line.trim() !== "") {
      throw new Error("[invalid_request] The patch does not start with a file header. Hint: include 'diff --git a/path b/path' or '--- a/path' and '+++ b/path'.");
    }
  }
  if (current) sections.push({ lines: current });
  if (sections.length === 0) {
    throw new Error("[invalid_request] The patch contains no file headers. Hint: include 'diff --git', '---' and '+++' lines.");
  }
  if (sections.length > MAX_FILES) {
    throw new Error("[resource_limit] The patch touches too many files (" + sections.length + "). Hint: split it into smaller patches (max " + MAX_FILES + " files).");
  }

  const files: PatchFileOperation[] = [];
  let hunkCount = 0;
  for (const section of sections) {
    let oldHeader: string | null | undefined;
    let newHeader: string | null | undefined;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let gitPaths: [string, string] | null = null;
    const hunks: PatchHunk[] = [];
    let activeHunk: PatchHunk | null = null;
    for (const rawLine of section.lines) {
      if (rawLine.startsWith("diff --git ")) {
        gitPaths = parseDiffGitPaths(rawLine);
        continue;
      }
      if (rawLine.startsWith("rename from ")) {
        renameFrom = normalizePatchPath(rawLine.slice("rename from ".length));
        continue;
      }
      if (rawLine.startsWith("rename to ")) {
        renameTo = normalizePatchPath(rawLine.slice("rename to ".length));
        continue;
      }
      if (rawLine.startsWith("--- ")) {
        if (activeHunk && !isHunkComplete(activeHunk)) {
          throw new Error("[invalid_request] A hunk ended before its declared line counts were satisfied. Hint: check the '@@ -old,count +new,count @@' header.");
        }
        activeHunk = null;
        oldHeader = normalizePatchPath(rawLine.slice(4));
        continue;
      }
      if (rawLine.startsWith("+++ ")) {
        newHeader = normalizePatchPath(rawLine.slice(4));
        continue;
      }
      const maybeHunk = parseHunkHeader(rawLine);
      if (maybeHunk) {
        if (activeHunk && !isHunkComplete(activeHunk)) {
          throw new Error("[invalid_request] A hunk ended early. Hint: each '-' and ' ' line counts toward the old count, each '+' and ' ' line counts toward the new count.");
        }
        activeHunk = maybeHunk;
        hunks.push(activeHunk);
        hunkCount += 1;
        if (hunkCount > MAX_HUNKS) {
          throw new Error("[resource_limit] The patch contains too many hunks. Hint: split it into smaller patches.");
        }
        continue;
      }
      if (activeHunk) {
        const line = rawLine;
        if (isHunkComplete(activeHunk)) {
          if (line === "") continue; // trailing-newline artifact at end of the patch
          throw new Error("[invalid_request] Unexpected content after a complete hunk: " + JSON.stringify(line) + ". Hint: remove everything between the hunk body and the next '@@'/'diff --git' header.");
        }
        if (line.startsWith("\\ No newline at end of file")) {
          const last = activeHunk.lines[activeHunk.lines.length - 1];
          if (last) last.noNewline = true;
          continue;
        }
        if (line.startsWith("+")) activeHunk.lines.push({ kind: "added", text: line.slice(1) });
        else if (line.startsWith("-")) activeHunk.lines.push({ kind: "removed", text: line.slice(1) });
        else if (line.startsWith(" ")) activeHunk.lines.push({ kind: "context", text: line.slice(1) });
        else if (line === "") activeHunk.lines.push({ kind: "context", text: "" });
        else {
          throw new Error("[invalid_request] Invalid hunk line: " + JSON.stringify(line) + ". Hint: hunk lines start with ' ', '-' or '+'.");
        }
        if (isHunkComplete(activeHunk)) {
          // Keep activeHunk so a following \ No newline marker can annotate the last line.
        }
        continue;
      }
    }
    if (activeHunk && !isHunkComplete(activeHunk)) {
      throw new Error("[invalid_request] The final hunk ended before its declared line counts were satisfied. Hint: check the '@@' header counts.");
    }

    let oldPath = renameFrom ?? oldHeader ?? gitPaths?.[0] ?? null;
    let newPath = renameTo ?? newHeader ?? gitPaths?.[1] ?? null;
    if (oldHeader === null) oldPath = null;
    if (newHeader === null) newPath = null;
    if (renameFrom !== null) oldPath = renameFrom;
    if (renameTo !== null) newPath = renameTo;
    if (oldPath === undefined) oldPath = null;
    if (newPath === undefined) newPath = null;
    if (oldPath === null && newPath === null) {
      throw new Error("[invalid_request] A file section has neither an old nor a new path. Hint: include '--- a/path' and '+++ b/path'.");
    }
    if (oldPath && newPath && oldPath === newPath && !renameFrom && !renameTo) {
      // Same-path modification is valid; leave as-is.
    } else if (oldPath && newPath && oldPath === newPath) {
      throw new Error("[invalid_request] A rename cannot keep the same path. Hint: use a different new path.");
    }
    const renamed = Boolean(renameFrom && renameTo && renameFrom !== renameTo) || Boolean(oldPath && newPath && oldPath !== newPath);
    const action: PatchFileOperation["action"] = oldPath === null ? "added" : newPath === null ? "deleted" : renamed ? "renamed" : "modified";
    files.push({ action, oldPath, newPath, hunks: hunks.map(cloneHunk) });
  }

  const seen = new Set<string>();
  for (const file of files) {
    // A single section may legitimately touch the same path twice (a/b/a.txt -> b/a.txt modifies it): only cross-section collisions matter.
    for (const p of new Set([file.oldPath, file.newPath].filter((p): p is string => Boolean(p)))) {
      if (!p) continue;
      if (seen.has(p)) {
        throw new Error("[invalid_request] The patch touches the same path more than once (" + p + "). Hint: combine the hunks for that file into one section.");
      }
      seen.add(p);
    }
  }
  return { files };
}

type SourceLine = { text: string; index: number; noNewline: boolean };

function splitContent(body: string): { lines: SourceLine[]; eol: string; hadTrailingNewline: boolean } {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const normalized = body.replace(/\r\n/g, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");
  if (normalized === "") return { lines: [], eol, hadTrailingNewline };
  const parts = normalized.split("\n");
  if (hadTrailingNewline) parts.pop();
  return {
    lines: parts.map((text, index) => ({
      text,
      index,
      noNewline: index === parts.length - 1 && !hadTrailingNewline,
    })),
    eol,
    hadTrailingNewline,
  };
}

function oldSequence(h: PatchHunk): string[] {
  return h.lines.filter((l) => l.kind !== "added").map((l) => l.text);
}

function findHunkPosition(source: SourceLine[], hunk: PatchHunk, expectedIndex: number): number {
  const seq = oldSequence(hunk);
  if (seq.length === 0) return Math.max(0, Math.min(source.length, expectedIndex));
  const candidates: Array<{ index: number; distance: number }> = [];
  for (let i = 0; i <= source.length - seq.length; i += 1) {
    let ok = true;
    for (let j = 0; j < seq.length; j += 1) {
      if (source[i + j].text !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) candidates.push({ index: i, distance: Math.abs(i - expectedIndex) });
  }
  if (candidates.length === 0) return -1;
  candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
  return candidates[0].index;
}

function nearestContext(source: SourceLine[], expectedIndex: number): string[] {
  const start = Math.max(0, Math.min(source.length - 1, expectedIndex) - 2);
  const out: string[] = [];
  for (let i = start; i < Math.min(source.length, start + 5); i += 1) out.push(source[i].text);
  return out;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function applyFilePatch(
  currentContent: string | null,
  file: PatchFileOperation,
  fileLabel: string,
): PatchApplyResult & { nextContent: string | null } {
  const bom = currentContent?.startsWith("\ufeff") ? "\ufeff" : "";
  const body = bom ? currentContent!.slice(1) : (currentContent ?? "");
  const { lines: source, eol } = splitContent(body);
  const out: Array<{ text: string; noNewline?: boolean }> = [];
  let cursor = 0;
  let delta = 0;

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    const expectedIndex = Math.max(0, (hunk.oldStart === 0 ? 0 : hunk.oldStart - 1) + delta);
    const pos = findHunkPosition(source, hunk, expectedIndex);
    if (pos < 0) {
      const err = new Error(
        "[stale_content] Patch hunk " + (hunkIndex + 1) + " does not match " + fileLabel + ". Hint: re-read the file or regenerate the patch; nearest lines are in data.nearest_context.",
      ) as Error & { data?: PatchMismatch };
      err.data = {
        relative_path: fileLabel,
        hunk_index: hunkIndex + 1,
        expected_start_line: hunk.oldStart,
        actual_start_line: expectedIndex + 1,
        nearest_context: nearestContext(source, expectedIndex),
      };
      throw err;
    }
    for (const line of source.slice(cursor, pos)) out.push({ text: line.text, noNewline: line.noNewline });
    for (const line of hunk.lines) {
      if (line.kind === "added" || line.kind === "context") out.push({ text: line.text, noNewline: line.noNewline });
    }
    const oldUsed = hunk.lines.filter((l) => l.kind !== "added").length;
    const newUsed = hunk.lines.filter((l) => l.kind !== "removed").length;
    cursor = pos + oldUsed;
    delta += newUsed - oldUsed;
  }
  for (const line of source.slice(cursor)) out.push({ text: line.text, noNewline: line.noNewline });

  if (file.action === "deleted") {
    return { content: "", nextContent: null, sha256_after: "", bytes: 0 };
  }
  const ending = out.length > 0 && out[out.length - 1].noNewline ? "" : eol;
  const nextContent = bom + out.map((l) => l.text).join(eol) + ending;
  return {
    content: nextContent,
    nextContent,
    sha256_after: sha256(nextContent),
    bytes: Buffer.byteLength(nextContent, "utf8"),
  };
}
