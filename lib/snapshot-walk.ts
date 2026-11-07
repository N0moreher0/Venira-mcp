/**
 * Snapshots — duyệt workspace + lưu blob.
 * Tách khỏi snapshots.ts (re-export ở đó nên API công khai không đổi); hành vi giữ nguyên.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MAX_FILE_BYTES, SNAPSHOT_FILE_EXCLUDE_PATTERNS, ensureStoreMeta, blobPath, protectedPrefixes, isProtected, isAuditDbFile, hashBuffer, normalizeRel } from "./snapshot-store.js";

type WalkResult = {
  files: string[];
  dirs: string[];
  skipped: Array<{ path: string; reason: string }>;
  truncated: boolean;
};

export async function walkForSnapshot(options: {
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
    const fileExclude = SNAPSHOT_FILE_EXCLUDE_PATTERNS.find((entry) => entry.re.test(rel));
    if (fileExclude) {
      pushSkip(rel, fileExclude.reason);
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

export async function storeBlob(absPath: string): Promise<{ sha256: string; size: number; newBytes: number } | null> {
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
  ensureStoreMeta();
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${crypto.randomBytes(3).toString("hex")}`;
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, dest);
  return { sha256, size: buffer.length, newBytes: buffer.length };
}
