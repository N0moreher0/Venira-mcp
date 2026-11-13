/**
 * corehost shell run state + helpers: tracked runs, output caps, scrubbed env,
 * secret_env validation, process-tree kill, and the policy snapshot used by
 * project_health. Extracted from corehost.ts; behaviour is unchanged.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { PLATFORM } from "./workspace.js";
import { assertSecretName } from "./secrets.js";
import { describeShellPolicy, loadShellPolicy, recordApproval, shellStats } from "./shell-policy.js";


export type ShellRun = {
  run_id: string;
  kill_key: string;
  command: string;
  shell: string;
  cwd: string;
  process: ChildProcess | null;
  stdout_tail: string;
  stderr_tail: string;
  stdout_full: string;
  stderr_full: string;
  running: boolean;
  exit_code: number | null;
  cancelled: boolean;
  started_at: number;
  finished_at?: number;
  /** Resolves once stdout/stderr are fully flushed ('close' or 'error'). */
  closedPromise: Promise<void>;
  /** Policy decision that authorised this run (audit + status output). */
  decision: { tier: string; rule: string; reason: string; approver: string | null };
  /** Requested timeout (0 = none). */
  timeout_ms: number;
  timed_out: boolean;
  /** Bytes dropped because of the output cap. */
  dropped_bytes: number;
  /** setTimeout handle, cleared on exit. */
  timer: NodeJS.Timeout | null;
};

// R4: prune finished shellRuns older than 30 min, keep at most 64 finished.
export function pruneShellRuns(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  const finished: string[] = [];
  for (const [id, run] of shellRuns) {
    if (!run.running && run.started_at < cutoff) finished.push(id);
  }
  for (const id of finished) shellRuns.delete(id);
  // cap finished
  const finishedAll = [...shellRuns.entries()].filter(([, r]) => !r.running);
  if (finishedAll.length > 64) {
    finishedAll.sort((a, b) => (a[1].finished_at ?? 0) - (b[1].finished_at ?? 0));
    const excess = finishedAll.length - 64;
    for (let i = 0; i < excess; i++) shellRuns.delete(finishedAll[i][0]);
  }
}

export const shellRuns = new Map<string, ShellRun>();
export const TAIL_LIMIT = (() => {
  const value = Number(process.env.VENIRA_SHELL_TAIL_MAX);
  return Number.isFinite(value) && value >= 256 ? Math.floor(value) : 2000;
})();
/** Effective tail length; `project_health` reports this so it cannot drift from the real default. */
export const SHELL_TAIL_LIMIT = TAIL_LIMIT;
/** Pollers return immediately when the exit code is already known, without
 * waiting out the full wait_seconds window. (VENIRA_SHELL_EXIT_EARLY removed; always on.) */
export const SHELL_EXIT_EARLY = true;
/** An expired command kills the whole process tree at the timeout.
 * (VENIRA_SHELL_TIMEOUT_POLICY removed; always `hard` — `soft` is gone.) */
export const SHELL_TIMEOUT_POLICY: "hard" = "hard";

/** Hard cap per stream; keeps a runaway build from exhausting server memory. */
export const MAX_OUTPUT_BYTES = (() => {
  const value = Number(process.env.VENIRA_SHELL_MAX_OUTPUT_BYTES);
  return Number.isFinite(value) && value > 0 ? value : 256 * 1024;
})();

/** Upper bound for a caller-supplied timeout_ms; shell runs default to 10 minutes. */
export const SHELL_MAX_TIMEOUT_MS = (() => {
  const value = Number(process.env.VENIRA_SHELL_MAX_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30 * 60 * 1000;
})();

export function trimTail(buffer: string): string {
  if (buffer.length <= TAIL_LIMIT) return buffer;
  return buffer.slice(-TAIL_LIMIT);
}

/** Append with a byte cap; returns true when bytes were dropped. */
export function appendCapped(current: string, chunk: string, limit: number): { text: string; dropped: number } {
  const remaining = limit - current.length;
  if (remaining <= 0) return { text: current, dropped: chunk.length };
  if (chunk.length <= remaining) return { text: current + chunk, dropped: 0 };
  return { text: current + chunk.slice(0, remaining), dropped: chunk.length - remaining };
}

/**
 * Environment allow list. The shell inherits only what toolchains actually
 * need; agent secrets (API keys, registry tokens) are not passed through.
 * The full host environment is passed through only in the trusting modes
 * (`off` and `permissive`, same as secret reveal); extend with
 * VENIRA_SHELL_ENV_ALLOW="VAR1,VAR2".
 */
const BASE_ENV_ALLOW = [
  "PATH", "Path", "PATHEXT", "COMSPEC", "ComSpec", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
  "USERNAME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "PWD",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "JAVA_HOME", "DOTNET_ROOT", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME",
  "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "NVM_HOME", "NVM_SYMLINK",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CI",
  // Windows session basics. Without these (notably PSModulePath) a scrubbed
  // powershell.exe spawn takes 24-30s on CI runners instead of ~1.7s because it
  // re-discovers module paths from scratch. None of them carry secrets.
  "PSModulePath", "SystemDrive", "ALLUSERSPROFILE", "PUBLIC", "DriverData",
  "ProgramW6432", "CommonProgramFiles(x86)", "CommonProgramW6432",
  "COMPUTERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "LOGONSERVER",
  "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
];

/**
 * Defaults that make git and Git Credential Manager fail fast instead of waiting
 * for a prompt nobody can answer (stdin is closed and windows are hidden), which
 * would otherwise hang a foreground run. An explicit host or secret_env value wins.
 */
const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
};

export function buildShellEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // VENIRA_SHELL_ENV_PASS_ALL was removed; the full environment is passed in
  // `off` and `permissive` (the trusting modes), scrubbed otherwise.
  const { mode } = loadShellPolicy();
  if (mode === "off" || mode === "permissive") {
    return { ...NON_INTERACTIVE_ENV, ...process.env, ...overrides };
  }
  const extra = (process.env.VENIRA_SHELL_ENV_ALLOW ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  // Windows env names are case-insensitive (the OS reports `ProgramFiles`, not
  // `PROGRAMFILES`), so match case-insensitively there; keep exact match on POSIX.
  const caseInsensitive = process.platform === "win32";
  const norm = (name: string): string => (caseInsensitive ? name.toLowerCase() : name);
  const allow = new Set([...BASE_ENV_ALLOW, ...extra].map(norm));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allow.has(norm(key))) env[key] = value;
  }
  // Keep PATH resolvable even if the host named it unusually.
  if (!env.PATH && !env.Path && process.env.PATH) env.PATH = process.env.PATH;
  // Explicit `secret_env` injections are added last so they win over inherited
  // values of the same name; they never come from the audit-visible args.
  return { ...NON_INTERACTIVE_ENV, ...env, ...overrides };
}

/**
 * `secret_env` names are validated up front (cheap) but their values are only
 * decrypted at spawn time — after the policy gate approved the command.
 */
export function normalizeSecretEnv(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("[invalid_request] `secret_env` must be an array of secret names.");
  }
  if (value.length > 16) {
    throw new Error("[invalid_request] At most 16 `secret_env` names per shell run.");
  }
  const names: string[] = [];
  for (const entry of value) {
    const name = assertSecretName(entry);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Kill the whole process tree, not just the direct child: `npm test` spawns
 * node which spawns the test runner, and `process.kill(pid)` leaves those
 * grandchildren running (and holding ports/files).
 */
export function killTree(child: ChildProcess | null): void {
  if (!child || child.pid === undefined) return;
  recordApproval("killed_tree");
  if (PLATFORM === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* fall through to child.kill */
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
}

/** Snapshot of policy + runtime counters for project_health. */
export function shellPolicySnapshot() {
  return {
    policy: describeShellPolicy(),
    stats: shellStats(),
    limits: { max_output_bytes: MAX_OUTPUT_BYTES, max_timeout_ms: SHELL_MAX_TIMEOUT_MS, tail_chars: TAIL_LIMIT },
    tracked_runs: shellRuns.size,
  };
}
