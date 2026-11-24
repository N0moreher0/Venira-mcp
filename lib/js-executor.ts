import { spawn } from "node:child_process";
import path from "node:path";
import type { SdkBridge } from "./sdk-bridge.js";
import { SDK_CHILD_PREAMBLE } from "./sdk-child-runtime.js";

export type JsResult = {
  ok: boolean;
  exit_code: number | null;
  timed_out: boolean;
  stdout_tail: string;
  stderr_tail: string;
  error?: string;
};

const DEFAULT_TIMEOUT = 30_000;
const MAX_BUFFER = 1_048_576; // 1 MiB
const KILL_GRACE_MS = 1_000;

/**
 * ESM preamble (roadmap item 15, P2).
 *
 * A snippet with a top-level `await` makes Node run it as an ES module, and
 * there `require` does not exist - the description promised `require` and the
 * snippet failed with "require is not defined". The shim gives the snippet the
 * same `require` it has in CommonJS mode.
 */
const ESM_PREAMBLE =
  'import{createRequire as __veniraCreateRequire}from"node:module";' +
  'const require=__veniraCreateRequire(process.cwd()+"/__venira__.js");';

/**
 * Does the snippet look like an ES module? Node decides the same way (it
 * detects module syntax and re-runs the input as ESM), and the agent then
 * loses `require` unless the preamble is prepended.
 *
 * An `await` anywhere counts: Node refuses a program that mixes `require`
 * with a top-level await ("cannot determine the intended module format"), so
 * the snippet has to run as ESM to work at all.
 */
export function looksLikeEsm(code: string): boolean {
  if (/(^|\n)\s*(import[\s{*'"]|export[\s{*])/.test(code)) return true;
  return /(^|[^.\w$])await[\s(]/.test(code);
}

/**
 * On an uncaught error Node echoes the offending source line (our prefix + the caller's line 1) and a caret
 * line. Drop the prefix from that echo, and shift line-1 columns back, so stderr shows only the caller's code.
 */
function stripGuardEcho(stderr: string, prefixLength: number): string {
  const shift = prefixLength + 1;
  const lines = stderr.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith(ESM_PREAMBLE)) {
      out.push(line.slice(shift));
      if (/^\s*\^+\s*$/.test(lines[i + 1] ?? "")) i += 1;
      continue;
    }
    out.push(line.replace(/\[stdin\]:1:(\d+)/g, (_m, col: string) => `[stdin]:1:${Math.max(1, Number(col) - shift)}`));
  }
  return out.join("\n");
}

/** The message a failed snippet gets: a plain reason, not a raw spawn error. */
function snippetError(error: string, stderr: string, timedOut: boolean, timeout: number): string {
  if (timedOut || /ETIMEDOUT/.test(error)) {
    return `The snippet did not finish within ${timeout} ms and was stopped. Hint: raise timeout_s (max 600) or make the snippet faster.`;
  }
  const haystack = `${stderr}\n${error}`;
  if (/Illegal return statement|Return statement is not allowed here/i.test(haystack)) {
    return (
      "A top-level `return` is not allowed in a snippet. " +
      "Hint: assign the value to a variable and console.log it, or wrap the code in an async IIFE `(async () => { ... })()`."
    );
  }
  if (/require is not defined/i.test(haystack)) {
    return (
      "`require` is not defined in this snippet. Hint: use `import` statements, or drop the top-level await " +
      "(a snippet with top-level await runs as an ES module)."
    );
  }
  if (/cannot determine the intended module format/i.test(haystack)) {
    return (
      "The snippet mixes a top-level `await` with `require()`, and Node cannot tell whether it is CommonJS or an ES module. " +
      "Hint: use `import` statements, or move the `await` into an async function."
    );
  }
  // The reason a snippet failed is on its own line in stderr ("SyntaxError: ...").
  const errorLine = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[A-Za-z]*(Error|Exception)\b/.test(line));
  return errorLine ?? error;
}

/**
 * Workspace-scoped asynchronous JS evaluation (ROADMAP_MINIMAL_MODE.md Phase 0:
 * the child gets a `venira` proxy over the Node IPC channel when a bridge is
 * passed, so SDK calls land on the parent's real tool pipeline -- policy,
 * cache, audit). The IPC channel is the second choice after an fd-3 pipe was
 * measured to deadlock the child's exit on Windows (pending overlapped reads
 * on the pipe survive even `process.exit(0)`).
 *
 * With `contained: false` (mode `auto`) every restriction described below is
 * dropped: no permission model, inherited environment. Runs `node` in the
 * workspace, reading code from stdin, capturing stdout/stderr tails. Node's
 * permission model limits filesystem access to the workspace and does not
 * grant child-process or worker permissions. Protected files inside the
 * workspace are still readable; network access is always open in every mode
 * (the egress guard was removed). This is containment, not a sandbox.
 */
export async function executeJs(
  code: string,
  options: {
    cwd?: string;
    timeout?: number;
    args?: string[];
    contained?: boolean;
    /** Present = the `venira` SDK global is injected and served by the parent. */
    bridge?: SdkBridge;
  } = {},
): Promise<JsResult> {
  const cwd = options.cwd ?? process.cwd();
  const timeout = Math.max(100, Math.min(options.timeout ?? DEFAULT_TIMEOUT, 600_000));
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const contained = options.contained !== false;
  const bridge = options.bridge;
  const permissionArgs: string[] = !contained ? [] : [
    nodeMajor >= 23 ? "--permission" : "--experimental-permission",
    `--allow-fs-read=${cwd}`,
    `--allow-fs-write=${cwd}`,
  ];
  // The SDK preamble defines `venira` from fd 3; it uses the `require` shim the
  // ESM preamble installs, so a bridged snippet always runs as an ES module.
  // Roadmap item 15 (P2): without a bridge a top-level await still flips the
  // snippet to ESM and the preamble restores `require`.
  const esm = bridge !== undefined ? true : looksLikeEsm(code);
  const prefix = esm ? ESM_PREAMBLE + (bridge ? SDK_CHILD_PREAMBLE : "") : "";
  const input = `${prefix}${code}`;
  const inputType = esm ? ["--input-type=module"] : [];
  return await new Promise<JsResult>((resolve) => {
    let spawnError: Error | null = null;
    let timedOut = false;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [...permissionArgs, ...inputType, "-", ...((options.args ?? []) as string[])],
      {
        cwd,
        // The last entry is the Node IPC channel the SDK bridge serves; with no
        // bridge there is nothing to serve (plain pipe trio, unchanged).
        stdio: bridge ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
        env: !contained
          ? process.env
          : {
              PATH: process.env.PATH,
              TERM: process.env.TERM ?? "",
              HOME: "",
              USERPROFILE: "",
              NODE_PATH: path.join(cwd, "node_modules"),
            },
      },
    );
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS).unref();
    }, timeout);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_BUFFER) stderr = stderr.slice(-MAX_BUFFER);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    // Serve SDK calls while the snippet runs. The bridge is closed after close
    // so late messages cannot reach a dead child.
    if (bridge) bridge.attach(child);
    child.stdin?.write(input);
    child.stdin?.end();
    child.on("close", (exit, sig) => {
      clearTimeout(killTimer);
      exitCode = exit;
      signal = sig ?? null;
      const stderrClean = contained && prefix ? stripGuardEcho(stderr, prefix.length) : stderr;
      const timed = timedOut || sig === "SIGTERM" || sig === "SIGKILL";
      const failed = Boolean(spawnError) || timed || (exitCode ?? 0) !== 0;
      try {
        bridge?.close();
      } catch {
        /* idempotent */
      }
      resolve({
        ok: !failed,
        exit_code: exitCode,
        timed_out: timed,
        stdout_tail: stdout.slice(-MAX_BUFFER),
        stderr_tail: stderrClean.slice(-MAX_BUFFER),
        ...(failed
          ? {
              error: spawnError
                ? snippetError(spawnError.message, stderrClean, timed, timeout)
                : snippetError(stderrClean, stderrClean, timed, timeout),
            }
          : {}),
      });
    });
  });
}
