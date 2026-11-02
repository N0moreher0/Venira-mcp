/**
 * Small, defensive helpers for the per-install key files and for atomic writes.
 *
 * Threat model note: the data dir is protected from the file tools, but a local
 * user with OS-level access can still read these files. They stop the *agent*
 * (and anything that only gets the SQLite store or a backup) from forging
 * signatures, not a local root account.
 */
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const KEY_BYTES = 32;
const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;

function keyHint(file: string): string {
  return `Hint: delete ${file} to rotate the key (outstanding grants/tokens signed with it become invalid).`;
}

/**
 * Read a 32-byte key stored as hex. A short or malformed file is a hard error:
 * using it as an HMAC key would silently weaken every signature (an empty key
 * is still a valid HMAC key), so failing closed is the safe choice.
 */
export function readHexKey(file: string, label: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new Error(
      `[${label}_key_missing] cannot read ${file}: ${error instanceof Error ? error.message : String(error)}. ${keyHint(file)}`,
    );
  }
  if (!HEX_KEY_RE.test(raw)) {
    throw new Error(
      `[${label}_key_invalid] ${file} is not a 64-character hex key (found ${raw.length} characters). ${keyHint(file)}`,
    );
  }
  return Buffer.from(raw, "hex");
}

/**
 * Return the existing key or create one without ever exposing a partially
 * written file. Creation goes through a fully written temp file plus an atomic
 * primitive (`link`, then `copyFile` with COPYFILE_EXCL), so concurrent
 * processes agree on a single key instead of racing to overwrite each other.
 */
export function readOrCreateHexKey(file: string, label: string): Buffer {
  if (existsSync(file)) return readHexKey(file, label);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(KEY_BYTES);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, key.toString("hex"), { mode: 0o600, flag: "wx" });
  try {
    try {
      linkSync(tmp, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        /* another process created it first: read theirs below */
      } else if (code === "EPERM" || code === "ENOTSUP" || code === "EACCES" || code === "EXDEV") {
        // Filesystems without hard links (FAT/exFAT, some network shares).
        try {
          copyFileSync(tmp, file, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") throw copyError;
        }
      } else {
        throw error;
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
  }
  // Whoever won the race, every process reads back the same on-disk key.
  return readHexKey(file, label);
}

/**
 * Write a small file atomically (temp file + rename). Used for approval grants
 * and pending records so a crash cannot leave half-written JSON that would be
 * unreadable and unrevokable.
 */
export function writeFileAtomicSync(file: string, data: string, mode = 0o600): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, data, { mode, flag: "wx" });
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw error;
  }
}
