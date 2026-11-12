/**
 * Repeated-failure guard for shell runs (roadmap item 17).
 *
 * An agent that runs the same failing command again and again burns time and
 * hides the real cause. Every shell invocation is fingerprinted (normalized
 * command, shell, resolved cwd and the non-secret inputs) and the fingerprint
 * is compared with the recent failures of the same session. A repeat is
 * refused with the previous evidence instead of spawning the command again.
 *
 * Privacy: only the sha256 of the invocation is stored - never the command
 * text and never a secret value. `secret_env` contributes its *names* to the
 * fingerprint, so a repeat is reported as "same command and inputs" and never
 * as an exact match of the secret values.
 */
import crypto from "node:crypto";

export type ShellRepeatInput = {
  command: string;
  shell: string;
  cwd: string;
  secretNames: string[];
  timeoutMs: number;
  background: boolean;
};

export type ShellRepeatRecord = {
  fingerprint: string;
  failed_at: number;
  exit_code: number | null;
  timed_out: boolean;
  stderr_tail: string;
  /** How often this exact invocation failed in the session. */
  failures: number;
  /** Names only - never values. */
  secret_env: string[];
};

/** How long a failure is remembered (same window as the shell-run pruning). */
export const REPEAT_WINDOW_MS = 30 * 60 * 1000;
/** How many distinct failed invocations one session remembers. */
export const REPEAT_MAX_PER_SESSION = 16;
/** Upper bound for the remembered stderr tail. */
export const REPEAT_STDERR_LIMIT = 2000;

const sessions = new Map<string, Map<string, ShellRepeatRecord>>();

/**
 * Normalization is deliberately conservative: only the line endings and the
 * outer whitespace are folded. Inner spacing is kept, because `echo "a  b"`
 * and `echo "a b"` are different commands and one must not block the other.
 */
export function normalizeShellCommand(command: string): string {
  return command.replace(/\r\n/g, "\n").trim();
}

export function fingerprintShellInvocation(input: ShellRepeatInput): string {
  const payload = JSON.stringify({
    command: normalizeShellCommand(input.command),
    shell: input.shell,
    cwd: input.cwd,
    secret_env: [...input.secretNames].sort(),
    timeout_ms: input.timeoutMs,
    background: input.background ? 1 : 0,
  });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function sessionMap(sessionId: string): Map<string, ShellRepeatRecord> {
  let map = sessions.get(sessionId);
  if (!map) {
    map = new Map();
    sessions.set(sessionId, map);
  }
  return map;
}

/** Drop entries outside the window and keep the map inside its size cap. */
function prune(map: Map<string, ShellRepeatRecord>, now: number): void {
  for (const [key, record] of map) {
    if (now - record.failed_at > REPEAT_WINDOW_MS) map.delete(key);
  }
  while (map.size > REPEAT_MAX_PER_SESSION) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function recordShellFailure(
  sessionId: string,
  fingerprint: string,
  info: {
    exit_code: number | null;
    timed_out: boolean;
    stderr_tail: string;
    secretNames?: string[];
  },
  now = Date.now(),
): ShellRepeatRecord {
  const map = sessionMap(sessionId);
  prune(map, now);
  const previous = map.get(fingerprint);
  const record: ShellRepeatRecord = {
    fingerprint,
    failed_at: now,
    exit_code: info.exit_code,
    timed_out: info.timed_out,
    stderr_tail: info.stderr_tail.slice(-REPEAT_STDERR_LIMIT),
    failures: (previous?.failures ?? 0) + 1,
    secret_env: [...(info.secretNames ?? previous?.secret_env ?? [])].sort(),
  };
  // Re-insert so the map order is "oldest first" and the cap evicts the
  // least recently failed invocation.
  map.delete(fingerprint);
  map.set(fingerprint, record);
  prune(map, now);
  return record;
}

/** A successful run clears the memory: the next failure is a new one. */
export function clearShellFailure(sessionId: string, fingerprint: string): void {
  sessions.get(sessionId)?.delete(fingerprint);
}

export function findShellRepeat(
  sessionId: string,
  fingerprint: string,
  now = Date.now(),
): ShellRepeatRecord | undefined {
  const map = sessions.get(sessionId);
  if (!map) return undefined;
  prune(map, now);
  return map.get(fingerprint);
}

export function shellRepeatStats(sessionId: string): { tracked: number } {
  return { tracked: sessions.get(sessionId)?.size ?? 0 };
}

/** Drop every remembered failure (session end, tests). */
export function clearShellRepeats(sessionId?: string): void {
  if (sessionId === undefined) sessions.clear();
  else sessions.delete(sessionId);
}
