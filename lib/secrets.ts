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
 * - **Encrypted at rest.** AES-256-GCM with a random per-install key. New
 *   Windows installs use Credential Manager through the optional `keytar`
 *   package; existing `secrets.key` stores and unsupported platforms use the
 *   file fallback.
 * - **Atomic writes**, no partial files: temp file + rename in the data dir.
 *
 * The store lives in `VENIRA_DATA_DIR` (default: the per-user OS data dir), never in
 * the workspace tree, and is excluded from checkpoints/audit scans.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { activeDataDir } from "./workspace.js";

async function renameWithRetry(from: string, to: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.rename(from, to);
    return;
  }
  const delays = [20, 40, 80, 160, 200];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < delays.length - 1) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err;
    }
  }
}

const STORE_FILE = "secrets.json";
const KEY_FILE = "secrets.key";
const MAX_VALUE_BYTES = 16 * 1024;
const KEYCHAIN_SERVICE = "venira-mcp";

type KeytarApi = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
};

let keytar: KeytarApi | null = null;
let keychainKey: Buffer | null = null;
let keyStorage: "os_keychain" | "file" = "file";

function keychainMode(): "auto" | "off" | "required" {
  const value = (process.env.VENIRA_SECRET_KEYCHAIN ?? "auto").trim().toLowerCase();
  if (value === "off" || value === "0" || value === "false") return "off";
  if (value === "required" || value === "1" || value === "true") return "required";
  return "auto";
}

function keychainAccount(): string {
  return crypto.createHash("sha256").update(path.resolve(secretsDir())).digest("hex");
}

async function loadKeychain(): Promise<void> {
  if (process.platform !== "win32" || keychainMode() === "off") return;
  try {
    // keytar is an optional dependency (win32 only). Import it through a variable so `tsc` does not need its
    // types installed: npm drops the package when its native install fails (e.g. on Linux CI), which broke the build.
    const keytarSpecifier = "keytar";
    const module = (await import(keytarSpecifier)) as { default: KeytarApi };
    keytar = module.default;
    const stored = await keytar.getPassword(KEYCHAIN_SERVICE, keychainAccount());
    if (stored) {
      const key = Buffer.from(stored, "base64");
      if (key.length !== 32) throw new Error("stored Credential Manager key is not 32 bytes");
      keychainKey = key;
      keyStorage = "os_keychain";
    }
  } catch (error) {
    keytar = null;
    if (keychainMode() === "required") {
      throw new Error(
        `[secret_store_locked] Windows Credential Manager is required but unavailable: ${error instanceof Error ? error.message : String(error)}. Hint: install the optional keytar dependency or set VENIRA_SECRET_KEYCHAIN=auto.`,
      );
    }
    console.error(`[venira-secrets] Credential Manager unavailable; using secrets.key fallback: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await loadKeychain();

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
  /** First 12 chars of the value fingerprint (keyed HMAC for new entries). */
  sha256_12: string;
  /** "hmac-sha256" for entries written by 1.8.2+, "sha256-legacy" for older files. */
  fingerprint_scheme: "hmac-sha256" | "sha256-legacy";
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
  /** 1 = AES-GCM without AAD (legacy); 2 = AES-GCM with the secret name as AAD. */
  v: 1 | 2;
  iv: string;
  tag: string;
  data: string;
  /**
   * Keyed fingerprint: HMAC-SHA256(store key, "secret|<name>|<value>").
   * `sha256` is the legacy unkeyed digest, read-only and removed on the next
   * write; an unkeyed digest of a low-entropy password is offline-guessable by
   * anyone who can read the store file.
   */
  fingerprint?: string;
  sha256?: string;
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
  return activeDataDir();
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
  if (keychainKey) return keychainKey;
  const file = keyPath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(
      `[secret_store_locked] Cannot read the encryption key ${file}. Hint: the key file decrypts stored secrets; restore it, or delete secrets.json and secrets.key to start fresh.`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`[secret_store_locked] ${file} is not a valid 32-byte key.`);
  }
  return key;
}

async function ensureKey(): Promise<Buffer> {
  if (keychainKey) return keychainKey;
  const file = keyPath();
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`[secret_store_locked] ${file} is not a valid 32-byte key.`);
    keyStorage = "file";
    return key;
  }
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  if (keytar) {
    try {
      await keytar.setPassword(KEYCHAIN_SERVICE, keychainAccount(), key.toString("base64"));
      keychainKey = key;
      keyStorage = "os_keychain";
      return key;
    } catch (error) {
      if (keychainMode() === "required") {
        throw new Error(
          `[secret_store_locked] Cannot store the encryption key in Windows Credential Manager: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      console.error(`[venira-secrets] Credential Manager write failed; using secrets.key fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const tmp = `${file}.tmp-${crypto.randomBytes(3).toString("hex")}`;
  await fs.writeFile(tmp, key.toString("base64"), { mode: 0o600 });
  await renameWithRetry(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* Windows may ignore chmod */
  }
  return key;
}

const AAD_PREFIX = "venira-secret-v2:";

function fingerprintFor(name: string, value: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(`secret|${name}|${value}`, "utf8").digest("hex");
}

function decrypt(name: string, entry: StoredEntry, key: Buffer): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
  if (entry.v === 2) {
    // The name is authenticated but not stored in the ciphertext, so swapping
    // two entries' iv/tag/data makes decryption fail instead of returning the
    // other secret's value.
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}${name}`, "utf8"));
  }
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
}

function encrypt(name: string, value: string, key: Buffer): Pick<StoredEntry, "iv" | "tag" | "data"> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}${name}`, "utf8"));
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
      map.set(name, decrypt(name, entry, key));
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
      const legacy = !entry.fingerprint;
      return {
        name,
        length: typeof entry.length === "number" ? entry.length : 0,
        sha256_12: (entry.fingerprint ?? entry.sha256 ?? "").slice(0, 12),
        fingerprint_scheme: legacy ? ("sha256-legacy" as const) : ("hmac-sha256" as const),
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
        `Hint: rotate with project_secret action=set name=${name} (add expires_in_days to track expiry).`,
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

async function acquireStoreLock(file: string): Promise<() => Promise<void>> {
  const lock = `${file}.lock`;
  // R3: lockfile (wx) with stale timeout.
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await fs.writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return async () => {
        try { await fs.unlink(lock); } catch { /* ignore */ }
      };
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "EEXIST") {
        try {
          const stat = await fs.stat(lock);
          if (Date.now() - stat.mtimeMs > 10_000) {
            await fs.unlink(lock).catch(() => {});
            continue;
          }
        } catch { /* ignore */ }
        if (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        throw new Error(`[lock_timeout] could not acquire secrets lock at ${lock}`);
      }
      throw e;
    }
  }
}

/**
 * Run a read-modify-write under the cross-process lock. Earlier versions only
 * locked the write, so two concurrent `set` calls could both read the same
 * snapshot and the second would silently drop the first one's secret.
 */
async function withStoreLock<T>(fn: (fresh: () => StoreFile) => Promise<T>): Promise<T> {
  const release = await acquireStoreLock(storePath());
  cache = null; // never modify a snapshot another process has already replaced
  try {
    return await fn(readStoreSync);
  } finally {
    await release();
  }
}

async function writeStoreUnlocked(store: StoreFile): Promise<void> {
  const dir = secretsDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = storePath();
  const payload = JSON.stringify({ version: 1, secrets: store.secrets });
  const tmp = `${file}.tmp-${crypto.randomBytes(3).toString("hex")}`;
  try {
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await renameWithRetry(tmp, file);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* Windows may ignore chmod */
  }
  cache = null;
}

/**
 * Replace legacy plaintext digests with keyed fingerprints. Called while the
 * store lock is held and the key is available; a corrupt entry loses its
 * (unusable) legacy digest rather than keeping an offline-guessable one.
 */
function migrateLegacyFingerprints(store: StoreFile, key: Buffer): void {
  for (const [name, entry] of Object.entries(store.secrets)) {
    if (!entry || typeof entry !== "object" || !entry.sha256) continue;
    try {
      const value = decrypt(name, entry, key);
      entry.fingerprint = fingerprintFor(name, value, key);
    } catch {
      /* corrupted entry: drop the digest below */
    }
    delete entry.sha256;
  }
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
  // Read + encrypt + write under one lock: a concurrent writer must not be
  // able to replace the file between our read and our write.
  return withStoreLock(async (fresh) => {
    const store = fresh();
    const key = await ensureKey();
    migrateLegacyFingerprints(store, key);
    const now = Date.now();
    const previous = store.secrets[cleanName];
    const created = !previous;
    // A re-set is a rotation: keep the old expiry unless a new one is given, drop
    // the use counter (it belongs to the previous value) and mark the write time.
    const expiresAt =
      options.expiresAt === undefined ? (previous?.expires_at ?? null) : options.expiresAt;
    const fingerprint = fingerprintFor(cleanName, value, key);
    store.secrets[cleanName] = {
      v: 2,
      ...encrypt(cleanName, value, key),
      fingerprint,
      length: bytes,
      updated_at: now,
      expires_at: expiresAt,
      last_used_at: null,
      use_count: 0,
      rotated_at: now,
    };
    await writeStoreUnlocked(store);
    return {
      name: cleanName,
      length: bytes,
      sha256_12: fingerprint.slice(0, 12),
      fingerprint_scheme: "hmac-sha256" as const,
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
  });
}

/**
 * Record a successful use (injection into a shell, provider token read).
 * Best-effort: a failed metadata write must never break the call that used the
 * secret, so callers can ignore rejections. Writes are debounced to at most one
 * per second per name to keep tight shell loops cheap.
 */
export async function markSecretUsed(name: string, source: SetSecretOptions["source"] = "tool"): Promise<void> {
  void source;
  try {
    await withStoreLock(async (fresh) => {
      const store = fresh();
      const entry = store.secrets[name];
      if (!entry || typeof entry !== "object") return;
      const now = Date.now();
      const last = typeof entry.last_used_at === "number" ? entry.last_used_at : 0;
      if (now - last < 1_000) return; // debounce
      entry.last_used_at = now;
      entry.use_count = (typeof entry.use_count === "number" ? entry.use_count : 0) + 1;
      await writeStoreUnlocked(store);
    });
  } catch {
    /* best-effort */
  }
}

export async function deleteSecret(name: string): Promise<{ name: string; deleted: boolean }> {
  const cleanName = assertSecretName(name);
  return withStoreLock(async (fresh) => {
    const store = fresh();
    if (!store.secrets[cleanName]) return { name: cleanName, deleted: false };
    delete store.secrets[cleanName];
    await writeStoreUnlocked(store);
    return { name: cleanName, deleted: true };
  });
}

/**
 * Replace every stored secret value (>= 8 chars) in `text` with [REDACTED].
 * Used for shell tails, audit reasons and legacy audit rows.
 */
export function redactSecretValues(text: string): string {
  if (!text) return text;
  let values: string[];
  try {
    values = [...valuesSync().values()]; // include short secrets (redact_always not tracked; redact all present)
  } catch {
    return text;
  }
  if (values.length === 0) return text;
  // sort by length desc, include variants
  const variants: string[] = [];
  for (const v of values) {
    if (v.length < 4) continue; // skip trivial
    variants.push(v);
    try { variants.push(Buffer.from(v).toString("base64")); } catch {}
    try { variants.push(encodeURIComponent(v)); } catch {}
  }
  variants.sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of variants) {
    if (value && value.length >= 4) out = out.split(value).join("[REDACTED]");
  }
  return out;
}

export function secretsHealth(): {
  store: string;
  count: number;
  encryption: string;
  key_storage: "os_keychain" | "file";
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
  return { store: secretsDir(), count, encryption: "aes-256-gcm", key_storage: keyStorage, expired, with_expiry: withExpiry };
}
