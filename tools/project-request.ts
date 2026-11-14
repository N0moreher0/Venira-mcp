import { parseBackgroundFlag } from "../lib/env.js";
import { SHELL_MAX_TIMEOUT_MS } from "../lib/corehost.js";
import { resolveSecurityProfile } from "../lib/security-profile.js";
import { toHostPath } from "../lib/workspace.js";
import type { Args } from "./project-cache.js";

/**
 * The file-writing tools (the MUTATING set in project-executor.ts plus the
 * `create_directory` op behind create). These are the ops that need a
 * reason for the audit trail. Everything read-only or external-identifier
 * passes through untouched.
 */
const REASON_REQUIRED_OPS = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "delete_path",
  "move_path",
  "copy_path",
  "apply_patch",
  "git_commit",
  "git_branch",
  "git_stash",
  "snapshot_create",
  "snapshot_restore",
  "snapshot_delete",
]);

/** Auto-generate a short audit reason when the caller did not pass one. */
function autoReason(operation: string, out: Args): string {
  const target =
    (typeof out.relative_path === "string" && out.relative_path) ||
    (Array.isArray(out.paths) && out.paths.length > 0 ? String(out.paths[0]) : undefined) ||
    (typeof out.name === "string" && out.name) ||
    (typeof out.message === "string" && out.message.slice(0, 120)) ||
    (typeof out.action === "string" && out.action) ||
    (typeof out.command === "string" ? out.command.slice(0, 120) : undefined) ||
    (typeof out.id === "string" ? out.id : "");
  return `auto: ${operation} ${target}`.trim().slice(0, 400);
}

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
  // --- reason: optional everywhere; auto-generated for mutating ops when absent;
  // required outright when VENIRA_SECURITY_PROFILE=strict.
  const reason = typeof out.reason === "string" ? out.reason.trim() : "";
  const dryRun = out.dry_run === true || out.dry_run === 1 || out.dry_run === "1" || out.dry_run === "true";
  const gitReadOnly =
    (operation === "git_branch" && ["list", "current"].includes(String(out.action ?? "list").trim().toLowerCase())) ||
    (operation === "git_stash" && ["list", "show"].includes(String(out.action ?? "list").trim().toLowerCase()));
  if (!reason && REASON_REQUIRED_OPS.has(operation) && !(operation === "apply_patch" && dryRun) && !gitReadOnly) {
    if (resolveSecurityProfile() === "strict") {
      throw new Error(
        `[invalid_request] reason is required when VENIRA_SECURITY_PROFILE=strict (operation: ${operation}). ` +
          "Hint: pass a short why, e.g. \"reason\": \"fix the stale-lock retry in the checkpointer\" (max 400 chars).",
      );
    }
    out.reason = autoReason(operation, out);
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
    // Keep as workspace-relative; corehost resolves them internally.
  }
  // Most file operations expect a workspace-relative path in args.relative_path
  // (they call resolveInWorkspace internally). Converting to absolute here would
  // leak absolute paths in error messages. Only convert for operations that
  // explicitly need absolute paths (shell_run cwd, snapshot paths).
  // No transformation needed for relative_path here.
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
  if (operation === "snapshot_create" || operation === "snapshot_restore" || operation === "snapshot_mirror") return 120_000;
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
