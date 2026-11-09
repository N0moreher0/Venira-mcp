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
 * On an uncaught error Node echoes the offending source line (our guard + the caller's line 1) and a caret
 * line. Drop the guard from that echo, and shift line-1 columns back, so stderr shows only the caller's code.
 */
function stripGuardEcho(stderr: string): string {
  const shift = NETWORK_GUARD.length + 1;
  const lines = stderr.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith(NETWORK_GUARD)) {
      out.push(line.slice(shift));
      if (/^\s*\^+\s*$/.test(lines[i + 1] ?? "")) i += 1;
      continue;
    }
    out.push(line.replace(/\[stdin\]:1:(\d+)/g, (_m, col: string) => `[stdin]:1:${Math.max(1, Number(col) - shift)}`));
  }
  return out.join("\n");
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
  try {
    const r = spawnSync(process.execPath, [...permissionArgs, "-", ...((options.args ?? []) as string[])], {
      input: contained ? `${NETWORK_GUARD};${code}` : code,
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
    const stderr = (contained ? stripGuardEcho(r.stderr ?? "") : (r.stderr ?? "")).slice(-MAX_BUFFER);
    if (r.error) {
      return {
        ok: false,
        exit_code: r.status ?? null,
        timed_out: timed,
        stdout_tail: stdout,
        stderr_tail: stderr,
        error: r.error.message,
      };
    }
    return {
      ok: (r.status ?? 0) === 0,
      exit_code: r.status ?? null,
      timed_out: timed,
      stdout_tail: stdout,
      stderr_tail: stderr,
    };
  } catch (error) {
    return {
      ok: false,
      exit_code: null,
      timed_out: false,
      stdout_tail: "",
      stderr_tail: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}