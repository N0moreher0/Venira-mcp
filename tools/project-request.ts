import { parseBackgroundFlag } from "../lib/env.js";
import { SHELL_MAX_TIMEOUT_MS } from "../lib/corehost.js";
import { toHostPath } from "../lib/workspace.js";
import type { Args } from "./project-cache.js";

/**
 * Operations that talk to GitHub/CI or to the secret store. They take no
 * workspace path, so request preparation must not invent one for them.
 */
const EXTERNAL_OPS = new Set([
  "pr_create",
  "pr_comment",
  "pr_merge",
  "pr_list",
  "pr_close",
  "pr_reopen",
  "ci_status",
  "ci_control",
  "ci_trigger",
  "ci_logs",
  "ci_wait",
  "secret",
  "github_connect",
]);

/** Convert path fields to absolute workspace paths; drop undefined values. */
export function prepareRequest(operation: string, args: Args): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value;
  }
  if (EXTERNAL_OPS.has(operation)) {
    // No path fields: repo/PR/run ids are remote identifiers.
    return out;
  }
  if (operation === "shell_run") {
    out.relative_cwd = toHostPath(out.relative_cwd as string | undefined);
  } else if (operation.startsWith("snapshot_")) {
    // Checkpoints accept `paths[]`; absolute paths are still validated downstream.
    if (Array.isArray(out.paths)) {
      out.paths = (out.paths as unknown[]).map((entry) => toHostPath(String(entry)));
    }
  } else if (operation === "change_impact") {
    // Impact seeds: file paths and the optional `{name, file}` symbol form.
    if (Array.isArray(out.files)) {
      out.files = (out.files as unknown[]).map((entry) => toHostPath(String(entry)));
    }
    if (Array.isArray(out.symbols)) {
      out.symbols = (out.symbols as unknown[]).map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const rawFile =
            typeof record.relative_path === "string"
              ? record.relative_path
              : typeof record.file === "string"
                ? record.file
                : undefined;
          return rawFile === undefined ? record : { ...record, relative_path: toHostPath(rawFile) };
        }
        return entry;
      });
    }
  } else if (operation !== "shell_status" && operation !== "cancel") {
    out.relative_path = toHostPath(out.relative_path as string | undefined);
  }
  return out;
}

function isForegroundShell(args: Args): boolean {
  return !parseBackgroundFlag(args.background);
}

export function requestTimeout(operation: string, args: Args): number {
  if (operation === "shell_status") {
    const wait = Number(args.wait_seconds ?? 0);
    return Math.min(30, Math.max(0, Number.isFinite(wait) ? wait : 0)) * 1000 + 15_000;
  }
  // A foreground shell_run blocks until the command exits, so the host-call
  // budget must cover the shell timeout (not the 30 s default).
  if (operation === "shell_run") {
    if (isForegroundShell(args)) {
      const raw = Number(args.timeout_ms ?? 0);
      const requested = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 600_000;
      return Math.min(requested, SHELL_MAX_TIMEOUT_MS) + 15_000;
    }
    return 30_000;
  }
  if (operation === "snapshot_create" || operation === "snapshot_restore") return 120_000;
  if (operation === "ci_logs") return 90_000;
  if (operation === "ci_wait") {
    const wait = Number(args.timeout_ms ?? 45_000);
    const bounded = Math.min(110_000, Math.max(1_000, Number.isFinite(wait) ? wait : 45_000));
    return bounded + 10_000;
  }
  if (operation === "dependency_graph" || operation === "change_impact") return 60_000;
  if (EXTERNAL_OPS.has(operation)) return 60_000;
  return 30_000;
}

/** Long polls are not queued: they must never block other tools. */
export const UNQUEUED_OPERATIONS = new Set(["shell_status", "cancel", "ci_wait"]);
