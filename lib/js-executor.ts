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
 * Workspace-scoped synchronous JS evaluation.
 * Runs `node` in the workspace, reading code from stdin, capturing stdout/stderr.
 * No imports beyond Node stdlib without the user's node_modules; code executes under
 * the Node security posture (inherits env whitelist from project-shell).
 */
export function executeJs(
  code: string,
  options: { cwd?: string; timeout?: number; args?: string[] } = {},
): JsResult {
  const cwd = options.cwd ?? process.cwd();
  const timeout = Math.max(100, Math.min(options.timeout ?? DEFAULT_TIMEOUT, 600_000));
  try {
    const r = spawnSync(process.execPath, ["-", ...((options.args ?? []) as string[])], {
      input: code,
      encoding: "utf8",
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME ?? process.env.USERPROFILE,
        TERM: process.env.TERM ?? "",
        NODE_PATH: path.join(cwd, "node_modules"),
      },
    });
    const timed = Boolean(r.signal === "SIGTERM" || r.signal === "SIGKILL");
    const stdout = (r.stdout ?? "").slice(-MAX_BUFFER);
    const stderr = (r.stderr ?? "").slice(-MAX_BUFFER);
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