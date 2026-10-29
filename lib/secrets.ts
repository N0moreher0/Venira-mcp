/**
 * Workspace secret store for `project_secret` + `project_shell_run secret_env`.
 *
 * Design goals
 * ------------
 * - **Values never reach a log.** `project_secret get` returns metadata by
 *   default (length + sha256 fingerprint), `list` returns names only, and every
 *   shell output/audit row is scrubbed for stored values before it is returned.
 * - **Values are never passed on a command line.** `project_shell_run
 *   secret_env: ["GITHUB_TOKEN"]` injects the decrypted value into the child
 *   process environment, so the command string (which *is* audited) never
 *   contains it.
 * - **Encrypted at rest.** AES-256-GCM with a random per-install key stored in
 *   `<data>/secrets.key` (mode 0600 next to `secrets.json`, mode 0600). This
 *   protects against copying/pasting the JSON by accident; it is not a
 *   substitute for OS-level disk encryption (a full data-dir read still gets
 *   the key).
 * - **Atomic writes**, no partial files: temp file + rename in the data dir.
 *
 * The store lives in `VENIRA_DATA_DIR` (default `<workspace>/data`), never in
 * the workspace tree, and is excluded from checkpoints/audit scans.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WORKSPACE } from "./workspace.js";

const STORE_FILE = "secrets.json";
const KEY_FILE = "secrets.key";
const MAX_VALUE_BYTES = 16 * 1024;

/** Env-var compatible names only (injected into child processes). */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Names that turn "set an env var" into code execution. Injected secrets are
 * chosen by the agent, but a compromised agent should not be able to abuse the
 * store as a loader for arbitrary code.
 */
const DENY_NAMES = new Set([
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "GIT_SSH_COMMAND",
]);

export type SecretMeta = {
  name: string;
  length: number;
  sha256_12: string;
  updated_at: number;
  /** Absolute expiry (epoch ms), or null when the secret never expires. */
  expires_at: number | null;
  /** True when `expires_at` is in the past: the value is kept (rotation), never injected. */
  expired: boolean;
  /** Whole days until `expires_at` (negative when overdue), null when no expiry is set. */
  days_left: number | null;
  /** Last time the value was injected into a shell (or used by the provider), null if never. */
  last_used_at: number | null;
  /** Number of successful uses since the current value was written. */
  use_count: number;
  /** When the current value was written (a re-set counts as a rotation). */
  rotated_at: number;
};

type StoredEntry = {
  v: 1;
  iv: string;
  tag: string;
  data: string;
  sha256: string;
  length: number;
  updated_at: number;
  /** Optional rotation metadata; absent in stores written before v1.5.0. */
  expires_at?: number | null;
  last_used_at?: number | null;
  use_count?: number;
  rotated_at?: number;
};

/** Rotation bookkeeping lives next to the ciphertext, never in the plaintext. */
type SetSecretOptions = { expiresAt?: number | null; source?: "tool" | "provider" };

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_EXPIRY_DAYS = 3650;

type StoreFile = { version: 1; secrets: Record<string, StoredEntry> };

type Cache = { stamp: string; store: StoreFile; values: Map<string, string> | null };

let cache: Cache | null = null;

export function secretsDir(): string {
  return process.env.VENIRA_DATA_DIR
    ? path.resolve(process.env.VENIRA_DATA_DIR)
    : path.join(WORKSPACE, "data");
}

function storePath(): string {
  return path.join(secretsDir(), STORE_FILE);
}

function keyPath(): string {
  return path.join(secretsDir(), KEY_FILE);
}

export function isValidSecretName(value: unknown): value is string {
  return typeof value === "string" && NAME_RE.test(value) && !DENY_NAMES.has(value.toUpperCase());
}

export function assertSecretName(value: unknown): string {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    throw new Error(
      "[invalid_request] Secret name must match [A-Za-z_][A-Za-z0-9_]{0,63}. Hint: use an env-var style name, e.g. GITHUB_TOKEN.",
    );
  }
  if (DENY_NAMES.has(value.toUpperCase())) {
    throw new Error(
      `[invalid_request] '${value}' is reserved: it can inject code into child processes. Hint: store it under a normal env name (e.g. GITHUB_TOKEN).`,
    );
  }
  return value;
}

function stampOf(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function emptyStore(): StoreFile {
  return { version: 1, secrets: {} };
}

function readStoreSync(): StoreFile {
  const file = storePath();
  const stamp = stampOf(file);
  if (cache && cache.stamp === stamp) return cache.store;
  let store: StoreFile = emptyStore();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && (parsed as StoreFile).secrets) {
        const candidate = parsed as StoreFile;
        if (candidate.version === 1 || candidate.version === undefined) {
          store = { version: 1, secrets: candidate.secrets ?? {} };
        }
      }
    } catch (error) {
      throw new Error(
        `[secret_store_corrupt] Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}. Hint: restore the file from backup or delete it to start fresh (secrets will be lost).`,
      );
    }
  }
  cache = { stamp, store, values: null };
  return store;
}

function readKeySync(): Buffer {
  const file = keyPath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(
      `[secret_store_locked] Cannot read the encryption key ${file}. Hint: the key file is required to decrypt stored secrets; restore it or delete both secrets.json and secrets.key to start fresh.`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`[secret_store_locked] ${file} is not a valid 32-byte key.`);
  }
  return key;
}

async function ensureKey(): Promise<Buffer> {
  const file = keyPath();
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`[secret_store_locked] ${file} is not a valid 32-byte key.`);
    return key;
  }
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  const tmp = `${file}.tmp-${crypto.randomBytes(3).toString("hex")}`;
  await fs.writeFile(tmp, key.toString("base64"), { mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* Windows may ignore chmod */
  }
  return key;
}

function decrypt(entry: StoredEntry, key: Buffer): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
}

function encrypt(value: string, key: Buffer): Pick<StoredEntry, "iv" | "tag" | "data"> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: enc.toString("base64"),
  };
}

function valuesSync(): Map<string, string> {
  const store = readStoreSync();
  if (cache && cache.values) return cache.values;
  const key = readKeySync();
  const map = new Map<string, string>();
  for (const [name, entry] of Object.entries(store.secrets)) {
    try {
      if (!entry || typeof entry !== "object" || typeof entry.data !== "string") continue;
      map.set(name, decrypt(entry, key));
    } catch {
      /* a single corrupted entry must not take down redaction/injection */
    }
  }
  if (cache) cache.values = map;
  return map;
}

/** Metadata only: no decryption, no values. */
export function listSecrets(): SecretMeta[] {
  const store = readStoreSync();
  const now = Date.now();
  return Object.entries(store.secrets)
    .filter(([, entry]) => entry && typeof entry === "object")
    .map(([name, entry]) => {
      const expiresAt = typeof entry.expires_at === "number" ? entry.expires_at : null;
      return {
        name,
        length: typeof entry.length === "number" ? entry.length : 0,
        sha256_12: typeof entry.sha256 === "string" ? entry.sha256.slice(0, 12) : "",
        updated_at: typeof entry.updated_at === "number" ? entry.updated_at : 0,
        expires_at: expiresAt,
        expired: expiresAt !== null && expiresAt <= now,
        days_left: expiresAt === null ? null : Math.floor((expiresAt - now) / DAY_MS),
        last_used_at: typeof entry.last_used_at === "number" ? entry.last_used_at : null,
        use_count: typeof entry.use_count === "number" ? entry.use_count : 0,
        rotated_at: typeof entry.rotated_at === "number" ? entry.rotated_at : typeof entry.updated_at === "number" ? entry.updated_at : 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Metadata for one name (undefined when it is not stored). Never decrypts. */
export function getSecretMeta(name: string): SecretMeta | undefined {
  return listSecrets().find((entry) => entry.name === name);
}

export function isSecretExpired(name: string): boolean {
  const meta = getSecretMeta(name);
  return Boolean(meta?.expired);
}

/**
 * Guard used by every injection point (`secret_env`, provider tokens): a
 * missing or expired secret fails with an action-shaped error instead of
 * handing an unusable credential to a child process.
 */
export function assertSecretUsable(name: string): void {
  const meta = getSecretMeta(name);
  if (!meta) {
    throw new Error(
      `[secret_missing] secret_env refers to "${name}" but it is not in the secret store. ` +
        `Hint: run project_secret action=list, or action=set name=${name}.`,
    );
  }
  if (meta.expired) {
    const at = meta.expires_at === null ? "unknown" : new Date(meta.expires_at).toISOString();
    throw new Error(
      `[secret_expired] Secret "${name}" expired at ${at}. ` +
        `Hint: rotate it with project_secret action=set name=${name} value=<new value> (add expires_in_days to track the next rotation).`,
    );
  }
}

export function hasSecret(name: string): boolean {
  const store = readStoreSync();
  return Object.prototype.hasOwnProperty.call(store.secrets, name);
}

/** Decrypted value for explicit injection; never returned by a tool verbatim. */
export function getSecretValueSync(name: string): string | undefined {
  if (!hasSecret(name)) return undefined;
  return valuesSync().get(name);
}

async function writeStore(store: StoreFile): Promise<void> {
  const dir = secretsDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = storePath();
  const payload = JSON.stringify({ version: 1, secrets: store.secrets });
  const tmp = `${file}.tmp-${crypto.randomBytes(3).toString("hex")}`;
  await fs.writeFile(tmp, payload, { mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* Windows may ignore chmod */
  }
  cache = null;
}

export async function setSecret(
  name: string,
  value: string,
  options: SetSecretOptions = {},
): Promise<SecretMeta & { created: boolean; rotated: boolean }> {
  const cleanName = assertSecretName(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("[invalid_request] `value` must be a non-empty string.");
  }
  if (value.includes("\u0000")) {
    throw new Error("[invalid_request] Secret values cannot contain NUL bytes (child env would be truncated).");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_VALUE_BYTES) {
    throw new Error(
      `[resource_limit] Secret value is ${bytes} bytes; the limit is ${MAX_VALUE_BYTES}. Hint: store a shorter token or reference a file path instead.`,
    );
  }
  if (options.expiresAt !== undefined && options.expiresAt !== null) {
    const expiresAt = options.expiresAt;
    if (!Number.isFinite(expiresAt)) {
      throw new Error("[invalid_request] `expires_at` must be epoch milliseconds or an ISO timestamp.");
    }
    if (expiresAt > Date.now() + MAX_EXPIRY_DAYS * DAY_MS) {
      throw new Error(
        `[invalid_request] Expiry is more than ${MAX_EXPIRY_DAYS} days away. Hint: pass expires_in_days (1-${MAX_EXPIRY_DAYS}).`,
      );
    }
  }
  const store = readStoreSync();
  const key = await ensureKey();
  const now = Date.now();
  const previous = store.secrets[cleanName];
  const created = !previous;
  // A re-set is a rotation: keep the old expiry unless a new one is given, drop
  // the use counter (it belongs to the previous value) and mark the write time.
  const expiresAt =
    options.expiresAt === undefined ? (previous?.expires_at ?? null) : options.expiresAt;
  const sha256 = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  store.secrets[cleanName] = {
    v: 1,
    ...encrypt(value, key),
    sha256,
    length: bytes,
    updated_at: now,
    expires_at: expiresAt,
    last_used_at: null,
    use_count: 0,
    rotated_at: now,
  };
  await writeStore(store);
  return {
    name: cleanName,
    length: bytes,
    sha256_12: sha256.slice(0, 12),
    updated_at: now,
    expires_at: expiresAt,
    expired: expiresAt !== null && expiresAt <= now,
    days_left: expiresAt === null ? null : Math.floor((expiresAt - now) / DAY_MS),
    last_used_at: null,
    use_count: 0,
    rotated_at: now,
    created,
    rotated: !created,
  };
}

/**
 * Record a successful use (injection into a shell, provider token read).
 * Best-effort: a failed metadata write must never break the call that used the
 * secret, so callers can ignore rejections. Writes are debounced to at most one
 * per second per name to keep tight shell loops cheap.
 */
export async function markSecretUsed(name: string, source: SetSecretOptions["source"] = "tool"): Promise<void> {
  const store = readStoreSync();
  const entry = store.secrets[name];
  if (!entry || typeof entry !== "object") return;
  const now = Date.now();
  const last = typeof entry.last_used_at === "number" ? entry.last_used_at : 0;
  if (now - last < 1_000) return; // debounce
  entry.last_used_at = now;
  entry.use_count = (typeof entry.use_count === "number" ? entry.use_count : 0) + 1;
  void source;
  await writeStore(store);
}

export async function deleteSecret(name: string): Promise<{ name: string; deleted: boolean }> {
  const cleanName = assertSecretName(name);
  const store = readStoreSync();
  if (!store.secrets[cleanName]) return { name: cleanName, deleted: false };
  delete store.secrets[cleanName];
  await writeStore(store);
  return { name: cleanName, deleted: true };
}

/**
 * Replace every stored secret value (>= 8 chars) in `text` with [REDACTED].
 * Used for shell tails, audit reasons and legacy audit rows.
 */
export function redactSecretValues(text: string): string {
  if (!text) return text;
  let values: string[];
  try {
    values = [...valuesSync().values()].filter((value) => value.length >= 8);
  } catch {
    return text; // store locked/corrupt: never fail a shell call because of redaction
  }
  if (values.length === 0) return text;
  values.sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) out = out.split(value).join("[REDACTED]");
  return out;
}

export function secretsHealth(): {
  store: string;
  count: number;
  encryption: string;
  expired: number;
  with_expiry: number;
} {
  let count = 0;
  let expired = 0;
  let withExpiry = 0;
  try {
    const all = listSecrets();
    count = all.length;
    expired = all.filter((entry) => entry.expired).length;
    withExpiry = all.filter((entry) => entry.expires_at !== null).length;
  } catch {
    /* health must not fail because of a corrupt store */
  }
  return { store: secretsDir(), count, encryption: "aes-256-gcm", expired, with_expiry: withExpiry };
}
