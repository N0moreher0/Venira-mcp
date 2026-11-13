import { spawnSync } from "node:child_process";
import path from "node:path";

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
    return `The snippet did not finish within ${timeout} ms and was stopped. Hint: raise timeout_ms (max 600000) or make the snippet faster.`;
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
 * Workspace-scoped synchronous JS evaluation. With `contained: false` (mode `auto`) every restriction
 * described below is dropped: no permission model, inherited environment.
 * Runs `node` in the workspace, reading code from stdin, capturing stdout/stderr.
 * Node's permission model limits filesystem access to the workspace and does not
 * grant child-process or worker permissions. Protected files inside the workspace
 * are still readable; network access is always open in every mode (the egress guard was removed).
 * This is containment, not a sandbox.
 */
export function executeJs(
  code: string,
  options: { cwd?: string; timeout?: number; args?: string[]; contained?: boolean } = {},
): JsResult {
  const cwd = options.cwd ?? process.cwd();
  const timeout = Math.max(100, Math.min(options.timeout ?? DEFAULT_TIMEOUT, 600_000));
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const contained = options.contained !== false;
  const permissionArgs: string[] = !contained ? [] : [
    nodeMajor >= 23 ? "--permission" : "--experimental-permission",
    `--allow-fs-read=${cwd}`,
    `--allow-fs-write=${cwd}`,
  ];
  // Roadmap item 15 (P2): a snippet with a top-level await runs as an ES
  // module, where `require` does not exist. The preamble gives it the same
  // `require`; Node reports it as line 1, so the echo is stripped below.
  const esm = looksLikeEsm(code);
  const prefix = contained && esm ? ESM_PREAMBLE : "";
  const input = contained ? `${prefix}${code}` : code;
  const inputType = esm ? ["--input-type=module"] : [];
  try {
    const r = spawnSync(process.execPath, [...permissionArgs, ...inputType, "-", ...((options.args ?? []) as string[])], {
      input,
      encoding: "utf8",
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
      env: !contained ? process.env : {
        PATH: process.env.PATH,
        TERM: process.env.TERM ?? "",
        HOME: "",
        USERPROFILE: "",
        NODE_PATH: path.join(cwd, "node_modules"),
      },
    });
    const timed = Boolean(r.signal === "SIGTERM" || r.signal === "SIGKILL");
    const stdout = (r.stdout ?? "").slice(-MAX_BUFFER);
    const stderrRaw = r.stderr ?? "";
    const stderr = (contained && prefix ? stripGuardEcho(stderrRaw, prefix.length) : stderrRaw).slice(-MAX_BUFFER);
    if (r.error) {
      return {
        ok: false,
        exit_code: r.status ?? null,
        timed_out: timed,
        stdout_tail: stdout,
        stderr_tail: stderr,
        // Roadmap item 15 (P2): the raw "spawnSync ... ETIMEDOUT" leak is
        // replaced by a reason the agent can act on.
        error: snippetError(r.error.message, stderr, timed, timeout),
      };
    }
    const failed = (r.status ?? 0) !== 0;
    return {
      ok: !failed,
      exit_code: r.status ?? null,
      timed_out: timed,
      stdout_tail: stdout,
      stderr_tail: stderr,
      ...(failed
        ? {
            error: snippetError(
              // The reason a snippet failed is in its stderr; keep the raw text
              // there and put the actionable reason in `error`.
              stderr,
              stderr,
              timed,
              timeout,
            ),
          }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      exit_code: null,
      timed_out: false,
      stdout_tail: "",
      stderr_tail: "",
      error: snippetError(error instanceof Error ? error.message : String(error), "", false, timeout),
    };
  }
}