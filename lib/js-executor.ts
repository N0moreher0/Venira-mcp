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
 * Best-effort network guard prepended to the user's snippet (single line, so
 * error line numbers stay aligned with the submitted code). Node's permission
 * model has no network permission, so without this `fetch`/`require("node:http")`
 * would give the snippet unrestricted egress. This is containment, not a
 * sandbox: a determined snippet can still dynamic-import a net module.
 */
const NETWORK_GUARD =
  'try{if(typeof require==="function"){const M=require("node:module");const L=M._load;' +
  'const B=new Set(["node:net","net","node:tls","tls","node:http","http","node:https","https","node:http2","http2","node:dgram","dgram","node:dns","dns"]);' +
  'M._load=function(r,...a){if(B.has(String(r))){const e=new Error("ERR_ACCESS_DENIED: network modules are blocked in project_execute_js");e.code="ERR_ACCESS_DENIED";throw e;}return L.call(this,r,...a);};}}catch{}' +
  'for(const k of ["fetch","WebSocket","EventSource","XMLHttpRequest"]){try{delete globalThis[k];}catch{}}';

/**
 * ESM preamble (roadmap item 15, P2).
 *
 * A snippet with a top-level `await` makes Node run it as an ES module, and
 * there `require` does not exist - the description promised `require` and the
 * snippet failed with "require is not defined". The shim gives the snippet the
 * same `require` it has in CommonJS mode, and it is created *after* the guard
 * patched `Module._load`, so a required network module is still blocked.
 */
const ESM_PREAMBLE =
  'import{createRequire as __veniraCreateRequire}from"node:module";' +
  'const require=__veniraCreateRequire(process.cwd()+"/__venira__.js");';

/** The network modules the guard blocks; also the ones a static import may not name. */
const NETWORK_MODULES = [
  "node:net",
  "net",
  "node:tls",
  "tls",
  "node:http",
  "http",
  "node:https",
  "https",
  "node:http2",
  "http2",
  "node:dgram",
  "dgram",
  "node:dns",
  "dns",
];

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
 * A static `import` of a network module bypasses the guard (the guard patches
 * CommonJS `require`). In the contained modes the snippet is refused with a
 * clear message; in `auto` (uncontained) the operator opted out, so it runs.
 *
 * Only `import` counts: a `require` of a network module is blocked at runtime
 * by the guard, and a snippet that mentions one inside a try/catch (to prove
 * that it is blocked) must still run.
 */
export function networkImportIn(code: string): string | null {
  const names = NETWORK_MODULES.map((name) => name.replace(":", "\\:")).join("|");
  const pattern = new RegExp(
    `(?:import\\s+[^;\\n]*?\\bfrom\\s*|import\\s*\\(\\s*|import\\s+)["'](${names})["']`,
    "g",
  );
  const match = pattern.exec(code);
  return match ? match[1] : null;
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
    if (line.startsWith(NETWORK_GUARD) || line.startsWith(ESM_PREAMBLE)) {
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
 * described below is dropped: no network guard, no permission model, inherited environment.
 * Runs `node` in the workspace, reading code from stdin, capturing stdout/stderr.
 * Node's permission model limits filesystem access to the workspace and does not
 * grant child-process or worker permissions. Protected files inside the workspace
 * are still readable, and network blocking is best-effort: this is containment,
 * not a sandbox.
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
  // `require`; it comes *before* the guard, so the guard still patches
  // Module._load and a required network module stays blocked.
  const esm = looksLikeEsm(code);
  const prefix = !contained ? "" : esm ? `${ESM_PREAMBLE};${NETWORK_GUARD}` : NETWORK_GUARD;
  const input = contained ? `${prefix};${code}` : code;
  const inputType = esm ? ["--input-type=module"] : [];
  // Roadmap item 15 (P2): a static import of a network module bypasses the
  // guard (it only patches CommonJS `require`). In the contained modes the
  // snippet is refused with a clear reason.
  if (contained) {
    const netImport = networkImportIn(code);
    if (netImport) {
      return {
        ok: false,
        exit_code: null,
        timed_out: false,
        stdout_tail: "",
        stderr_tail: "",
        error:
          `[unsupported] The snippet imports the network module "${netImport}". ` +
          "Hint: project_execute_js blocks network access in the contained modes (ask, semi-auto); " +
          "use project_shell_run for network work, or set VENIRA_JS_EXEC_MODE=auto in a trusted environment.",
      };
    }
  }
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
    const stderr = (contained ? stripGuardEcho(r.stderr ?? "", prefix.length) : (r.stderr ?? "")).slice(-MAX_BUFFER);
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