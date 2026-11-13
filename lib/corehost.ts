/**
 * Standalone corehost: pure Node implementation of the `project_tool.*`
 * operations. Replaces the Rust `venira_corehost_rs.exe` — no external
 * binary needed.
 *
 * Implements:
 *   - file I/O (read_file, get_file_info, write_file, edit_file,
 *     create_directory, delete_path)
 *   - directory listing (list_files)
 *   - content search (search: literal_content, file_name, directory_name,
 *     definition — via simple line scan)
 *   - async shell (shell_run, shell_status, cancel)
 *   - scope open/close (long-lived capability token, TTL 2h)
 *   - audit trail via SQLite (better-sqlite3, WAL mode)
 *
 * The audit DB defaults to the per-user OS data directory unless
 * VENIRA_DATA_DIR is set.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { HostSnapshot } from "./types.js";
import { redactSecrets, type Decision } from "./shell-policy.js";
import { WORKSPACE, dynamicWorkspaceEnabled, switchWorkspaceRoot, allowedWorkspaceRoots } from "./workspace.js";
import { opSnapshotCreate, opSnapshotDelete, opSnapshotList, opSnapshotRestore, sanitizeReason } from "./snapshots.js";
import { opSnapshotMirror } from "./snapshot-mirror.js";
import { opCiControl, opCiLogs, opCiStatus, opCiTrigger, opPrClose, opPrComment, opPrCreate, opPrList, opPrMerge, opPrReopen } from "./git-provider.js";
import { assertSecretName, deleteSecret, getSecretValueSync, listSecrets, MAX_EXPIRY_DAYS, redactSecretValues, secretsDir, setSecret } from "./secrets.js";
import { GithubDeviceFlow } from "./github-device-flow.js";
import { envFlag } from "./env.js";
import { buildChangeImpact, buildDependencyGraph } from "./dependency-graph.js";
import { opCiWait } from "./ci-wait.js";
import { auditDecision, auditDetailInsert, auditFinish, auditStart, closeAuditDb } from "./audit-store.js";
import { buildAuditDetail } from "./audit-detail.js";
import { type RustResponse } from "./corehost-common.js";
import { opReadFile, opGetFileInfo, opListFiles, clearListFilesCache } from "./corehost-fileread.js";
import { opSearch } from "./corehost-search.js";
import { queryRecentFiles } from "./recent-index.js";
import { shellRuns, killTree, SHELL_EXIT_EARLY, SHELL_MAX_TIMEOUT_MS } from "./corehost-shell-state.js";
export { SHELL_TAIL_LIMIT, SHELL_EXIT_EARLY, SHELL_MAX_TIMEOUT_MS, shellPolicySnapshot } from "./corehost-shell-state.js";
import { opWriteFile, opEditFile, opCreateDirectory, opDeletePath } from "./corehost-filewrite.js";
import { opShellRun, opShellStatus, opShellCancel } from "./corehost-shell.js";
export { queryRecentFiles } from "./recent-index.js";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Capability / scope
// ---------------------------------------------------------------------------
type Scope = {
  capability_id: string;
  project_id: string;
  session_id: string;
  opened_at: number;
  expires_at: number;
};

export const SCOPE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const openScopes = new Map<string, Scope>();

function openScope(
  sessionId: string,
  projectId: string | null,
  permissionMode: string,
): Scope {
  const capabilityId = crypto.randomUUID();
  const projectIdResolved = projectId ?? "chat-terminal";
  const now = Date.now();
  const scope: Scope = {
    capability_id: capabilityId,
    project_id: projectIdResolved,
    session_id: sessionId,
    opened_at: now,
    expires_at: now + SCOPE_TTL_MS,
  };
  openScopes.set(capabilityId, scope);
  console.error(
    `[corehost] scope opened (${permissionMode}): ${capabilityId} → ${projectIdResolved}`,
  );
  return scope;
}

function closeScope(capabilityId: string): void {
  const scope = openScopes.get(capabilityId);
  if (!scope) return;
  openScopes.delete(capabilityId);
  console.error(`[corehost] scope closed: ${capabilityId}`);
}

function isScopeValid(capabilityId: string): boolean {
  const scope = openScopes.get(capabilityId);
  return !!scope && scope.expires_at > Date.now();
}


// ---------------------------------------------------------------------------
// CoreHost class (drop-in replacement for the Rust CoreHost)
// ---------------------------------------------------------------------------

// Secrets (`project_secret`)
//
// Values are never returned by default: `get`/`list` expose only metadata
// (length + sha256 prefix + update time) so an agent can confirm a key exists
// without ever putting it in a transcript. `reveal=1` is an explicit opt-in
// *and* needs VENIRA_SECRET_ALLOW_REVEAL=1 on the host, so a compromised agent
// cannot exfiltrate keys from a normal install.
// ---------------------------------------------------------------------------

const MAX_REVEAL_VALUE_CHARS = 16 * 1024;
const githubDeviceFlow = new GithubDeviceFlow();

/**
 * Expiry arguments for `project_secret action=set`:
 * `expires_in_days` (1..3650) or `expires_at` (epoch ms / ISO-8601), not both.
 * Returns undefined when the caller did not set an expiry (keep the previous one).
 */
function parseExpiryArgs(args: Record<string, unknown>): number | null | undefined {
  const rawDays = args.expires_in_days;
  const rawAt = args.expires_at;
  if (rawDays !== undefined && rawAt !== undefined) {
    throw new Error("[invalid_request] Pass either expires_in_days or expires_at, not both.");
  }
  if (rawDays !== undefined) {
    const days = Number(rawDays);
    if (!Number.isFinite(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
      throw new Error(
        `[invalid_request] \`expires_in_days\` must be between 1 and ${MAX_EXPIRY_DAYS}. Hint: 90 for quarterly rotation.`,
      );
    }
    return Date.now() + Math.round(days * 24 * 60 * 60 * 1000);
  }
  if (rawAt === undefined || rawAt === null) return undefined;
  if (typeof rawAt === "number" && Number.isFinite(rawAt)) return rawAt;
  if (typeof rawAt === "string") {
    const parsed = Date.parse(rawAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(
    "[invalid_request] `expires_at` must be epoch milliseconds or ISO-8601 (e.g. \"2027-01-31T00:00:00Z\").",
  );
}

async function opSecret(args: Record<string, unknown>): Promise<RustResponse> {
  const action = String(args.action ?? "").trim().toLowerCase();
  const rawName = typeof args.name === "string" ? args.name.trim() : "";

  if (action === "list") {
    const secrets = listSecrets();
    return {
      status: "completed",
      result: {
        kind: "secret",
        data: {
          action: "list",
          count: secrets.length,
          secrets,
          // Roadmap item 15 (P2): the store was reported as the *name* of
          // the environment variable; report the path and where it comes from.
          store: secretsDir(),
          store_location: process.env.VENIRA_DATA_DIR?.trim() ? "VENIRA_DATA_DIR" : "default_data_dir",
        },
      },
      ...(secrets.length === 0
        ? { hint: "No secrets stored. Hint: project_secret action=set name=GITHUB_TOKEN value=<token>." }
        : {}),
    };
  }

  if (!rawName) {
    throw new Error(
      "[invalid_request] `name` is required for this action. Hint: use an env-var style name, e.g. GITHUB_TOKEN.",
    );
  }
  const name = assertSecretName(rawName);

  switch (action) {
    case "get": {
      const meta = listSecrets().find((entry) => entry.name === name);
      if (!meta) {
        throw new Error(
          `[not_found] Secret "${name}" is not stored. Hint: run project_secret action=list to see available names.`,
        );
      }
      const reveal = args.reveal === true;
      const base = {
        action: "get",
        name: meta.name,
        length: meta.length,
        sha256_12: meta.sha256_12,
        fingerprint_scheme: meta.fingerprint_scheme,
        updated_at: meta.updated_at,
        expires_at: meta.expires_at,
        expired: meta.expired,
        days_left: meta.days_left,
        last_used_at: meta.last_used_at,
        use_count: meta.use_count,
        rotated_at: meta.rotated_at,
        revealed: false,
      };
      if (meta.expired) {
        return {
          status: "completed",
          result: { kind: "secret", data: base },
          hint:
            `"${name}" expired at ${meta.expires_at === null ? "unknown" : new Date(meta.expires_at).toISOString()} and will not be injected. ` +
            `Hint: rotate it with action=set name=${name} value=<new value> expires_in_days=<n>.`,
        };
      }
      if (!reveal) {
        return {
          status: "completed",
          result: { kind: "secret", data: base },
          hint:
            "Metadata only (the value stays out of the transcript). Hint: inject it with project_shell_run secret_env=[\"" +
            name +
            '"], or set VENIRA_SECRET_ALLOW_REVEAL=1 and pass reveal=1.',
        };
      }
      if (!envFlag("VENIRA_SECRET_ALLOW_REVEAL", false)) {
        throw new Error(
          "[feature_disabled] Plaintext reveal is disabled on this host (operator flag, not a per-call approval). " +
            "Hint: use project_shell_run secret_env; set VENIRA_SECRET_ALLOW_REVEAL=1 only if the user wants it printed.",
        );
      }
      const value = getSecretValueSync(name);
      if (value === undefined) {
        throw new Error(
          `[secret_store_locked] Secret "${name}" could not be decrypted. Hint: the key file may be missing; restore data/secrets.key or re-set the secret.`,
        );
      }
      return {
        status: "completed",
        result: {
          kind: "secret",
          data: {
            ...base,
            revealed: true,
            value: value.slice(0, MAX_REVEAL_VALUE_CHARS),
          },
        },
        hint: "Revealed because reveal=1 and VENIRA_SECRET_ALLOW_REVEAL=1. The value is now in this transcript.",
      };
    }

    case "set": {
      let value: string | undefined;
      if (typeof args.value === "string") {
        value = args.value;
      } else if (typeof args.value_env === "string" && args.value_env.trim()) {
        // Preferred path: take the value from the host env so it never appears
        // in the tool arguments (and therefore never in a transcript/log).
        const envName = args.value_env.trim();
        value = process.env[envName];
        if (value === undefined) {
          throw new Error(
            `[invalid_request] value_env "${envName}" is not set in the host environment. ` +
              `Hint: pass value=<secret> directly, or export ${envName} before starting the server.`,
          );
        }
      }
      if (value === undefined) {
        throw new Error(
          "[invalid_request] `value` is required. Hint: pass value=<secret>, or value_env=<HOST_ENV_VAR> to avoid writing it in the tool call.",
        );
      }
      const result = await setSecret(name, value, { expiresAt: parseExpiryArgs(args) });
      const expiryNote =
        result.expires_at === null
          ? ""
          : ` Expires ${new Date(result.expires_at).toISOString()} (${result.days_left} day(s)).`;
      return {
        status: "completed",
        result: {
          kind: "secret",
          data: { action: "set", ...result },
        },
        hint: result.created
          ? `Stored "${name}" (encrypted).${expiryNote} Hint: use project_shell_run secret_env=["${name}"] to inject it.`
          : `Rotated "${name}" (encrypted).${expiryNote} The previous value is overwritten and the use counter is reset.`,
      };
    }

    case "delete": {
      const result = await deleteSecret(name);
      return {
        status: "completed",
        result: { kind: "secret", data: { action: "delete", ...result } },
        ...(result.deleted ? {} : { hint: `"${name}" was not stored; nothing to delete.` }),
      };
    }

    default:
      throw new Error(
        `[invalid_request] Unknown secret action "${action}". Hint: use get | set | list | delete.`,
      );
  }
}

async function opGithubConnect(args: Record<string, unknown>): Promise<RustResponse> {
  const action = String(args.action ?? "").trim().toLowerCase();
  if (action === "start") {
    const data = await githubDeviceFlow.start(args.replace_existing === true);
    return {
      status: "completed",
      result: { kind: "github_connect", data },
      hint:
        `Open ${data.verification_uri}, sign in to GitHub, and enter code ${data.user_code}. ` +
        `After approving, call project_github_connect action=poll with pending_id; wait at least ${data.poll_interval_seconds}s between polls. ` +
        "Never ask the user to paste a token into chat.",
    };
  }
  if (action === "poll") {
    const pendingId = typeof args.pending_id === "string" ? args.pending_id.trim() : "";
    if (!pendingId) {
      throw new Error(`[invalid_request] \`pending_id\` ${typeof args.pending_id === "string" ? "cannot be empty" : "is required"} for action=poll.`);
    }
    const data = await githubDeviceFlow.poll(pendingId);
    return {
      status: "completed",
      result: { kind: "github_connect", data },
      ...(data.status === "pending"
        ? { hint: `Authorization is not complete. Wait ${String(data.wait_seconds)}s, then poll again.` }
        : {}),
    };
  }
  throw new Error('[invalid_request] action must be "start" or "poll".');
}

async function opDependencyGraph(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const built = await buildDependencyGraph(args, root);
  return {
    status: "completed",
    result: { kind: "dependency_graph", data: built.data },
    ...(built.truncated ? { truncated: true } : {}),
    ...(built.hint ? { hint: built.hint } : {}),
  };
}

async function opChangeImpact(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  const built = await buildChangeImpact(args, root);
  return {
    status: "completed",
    result: { kind: "change_impact", data: built.data },
    ...(built.truncated ? { truncated: true } : {}),
    ...(built.hint ? { hint: built.hint } : {}),
  };
}

type OperationHandler = (args: Record<string, unknown>, root: string, sessionId: string) => Promise<RustResponse>;

const operations: Record<string, OperationHandler> = {
  read_file: opReadFile,
  get_file_info: opGetFileInfo,
  list_files: opListFiles,
  search: opSearch,
  write_file: opWriteFile,
  edit_file: opEditFile,
  create_directory: opCreateDirectory,
  delete_path: opDeletePath,
  recent_files: async (args: Record<string, unknown>) => opRecentFiles(args),
  snapshot_create: opSnapshotCreate,
  snapshot_list: (args: Record<string, unknown>) => opSnapshotList(args),
  snapshot_restore: opSnapshotRestore,
  snapshot_delete: opSnapshotDelete,
  snapshot_mirror: opSnapshotMirror,
  // Git provider / CI provider / secrets
  pr_create: opPrCreate,
  pr_comment: opPrComment,
  pr_merge: opPrMerge,
  pr_list: opPrList,
  pr_close: opPrClose,
  pr_reopen: opPrReopen,
  ci_status: opCiStatus,
  ci_control: opCiControl,
  ci_trigger: opCiTrigger,
  ci_logs: opCiLogs,
  ci_wait: opCiWait,
  dependency_graph: opDependencyGraph,
  change_impact: opChangeImpact,
  secret: opSecret,
  github_connect: opGithubConnect,
};

/**
 * A short, secret-free description of an outbound/secret operation for the
 * audit `command` column. Names and ids only — never tokens or message bodies.
 */
function describeExternalOp(operation: string, args: Record<string, unknown>): string | undefined {
  const repo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : "(resolved)";
  const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string).slice(0, 80) : "");
  let summary: string;
  switch (operation) {
    case "pr_create":
      summary = `POST /pulls repo=${repo} head=${str("head") || "(current)"} base=${str("base") || "(default)"} title="${str("title")}"`;
      break;
    case "pr_comment": {
      const inline =
        typeof args.path === "string" && args.path
          ? ` inline path=${str("path")} line=${String(args.line ?? "?")}`
          : " (general)";
      summary = `POST /issues/${String(args.pr ?? "?")}/comments repo=${repo}${inline}`;
      break;
    }
    case "pr_merge":
      summary = `PUT /pulls/${String(args.pr ?? "?")}/merge repo=${repo} method=${str("method") || "merge"} delete_branch=${args.delete_branch === true}`;
      break;
    case "pr_list":
      summary = `GET /pulls repo=${repo} state=${str("state") || "open"} head=${str("head") || "(any)"}`;
      break;
    case "pr_close":
      summary = `PATCH /pulls/${String(args.pr ?? "?")} repo=${repo} state=closed`;
      break;
    case "pr_reopen":
      summary = `PATCH /pulls/${String(args.pr ?? "?")} repo=${repo} state=open`;
      break;
    case "ci_status":
      summary =
        typeof args.ref === "string" || args.pr !== undefined
          ? `GET /commits/${str("ref") || `pr:${String(args.pr ?? "?")}`}/check-runs repo=${repo}`
          : `GET /actions/runs repo=${repo} run=${String(args.run_id ?? "(recent)")} branch=${str("branch") || "(any)"}`;
      break;
    case "ci_trigger":
      summary = `POST /actions/workflows/${str("workflow")}/dispatches repo=${repo} ref=${str("ref") || "(current)"}`;
      break;
    case "ci_control":
      summary = `POST /ci/${str("action")} repo=${repo} run=${String(args.run_id ?? "?")}`;
      break;
    case "ci_logs":
      summary = `GET /actions/logs repo=${repo} run=${String(args.run_id ?? "-")} job=${String(args.job_id ?? "-")}`;
      break;
    case "ci_wait": {
      const selector =
        args.run_id !== undefined
          ? `run=${String(args.run_id)}`
          : args.ref !== undefined
            ? `ref=${str("ref")}`
            : args.pr !== undefined
              ? `pr=${String(args.pr)}`
              : `branch=${str("branch")}`;
      summary = `WAIT ci repo=${repo} ${selector} until=${str("until") || "terminal"} timeout=${String(args.timeout_ms ?? 45000)}`;
      break;
    }
    case "secret": {
      const action = String(args.action ?? "").toLowerCase();
      const name = typeof args.name === "string" ? args.name : "";
      summary = `secret_${action || "?"} name=${name}${args.reveal === true ? " reveal=1" : ""}`;
      break;
    }
    case "github_connect":
      summary = `github_device_${String(args.action ?? "?").toLowerCase()}`;
      break;
    default:
      return undefined;
  }
  return redactSecretValues(summary).slice(0, 400);
}


/** P2: opRecentFiles — index-backed recent files (falls back to Node-side bounded scan). */

async function opRecentFiles(args: Record<string, unknown>): Promise<RustResponse> {
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 10)));
  const includeDirs = args.include_ignored === true;

  // P2: Query the SQLite index first; if empty or unavailable, fall back to a bounded scan.
  const indexed = queryRecentFiles(limit, includeDirs);
  if (indexed.length > 0) {
    return {
      status: "completed",
      result: {
        kind: "recent_files",
        data: {
          source: "index",
          entries: indexed,
        },
      },
    };
  }

  // Node-side fallback: bounded filesystem scan (skip node_modules/target/.git)
  const SKIP_DIRS = new Set(["node_modules", "target", "build", "dist", ".git", ".venv", "venv", "__pycache__"]);
  const entries: Array<{ relative_path: string; mtime_ms: number; size: number; kind: string }> = [];

  async function walk(dir: string, rel: string): Promise<void> {
    let items: string[];
    try {
      items = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of items) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const relPath = rel ? path.posix.join(rel, name) : name;
      try {
        const s = await fs.stat(abs);
        if (s.isDirectory()) {
          await walk(abs, relPath);
        } else if (s.isFile()) {
          entries.push({
            relative_path: relPath,
            mtime_ms: s.mtimeMs,
            size: s.size,
            kind: "file",
          });
        }
      } catch {
        /* ignore */
      }
    }
  }

  await walk(WORKSPACE, "");
  entries.sort((a, b) => b.mtime_ms - a.mtime_ms);
  const result = entries.slice(0, limit);

  return {
    status: "completed",
    result: {
      kind: "recent_files",
      data: {
        source: "fallback_scan",
        entries: result,
      },
    },
  };
}



export class CoreHost {
  private started = false;

  snapshot(): HostSnapshot {
    return {
      running: true,
      pid: process.pid,
      pending_requests: 0,
      exe: null, // standalone — no external binary
      exe_error: null,
      started_at: this.started ? Date.now() : null,
      restarts: 0,
    };
  }

  async call<T = unknown>(method: string, params: unknown, _timeoutMs?: number): Promise<T> {
    this.started = true;
    const p = params as Record<string, any>;

    switch (method) {
      case "ping":
        return { ok: true, pong: true } as T;

      case "project_tool.scope.open": {
        const scope = openScope(
          p.session_id,
          p.project_id ?? null,
          p.permission_mode ?? "allow_all",
        );
        return { capability_id: scope.capability_id, project_id: scope.project_id } as T;
      }

      case "project_tool.scope.close": {
        closeScope(p.capability_id);
        return { closed: true } as T;
      }

      case "project_tool.shell.cancel_session": {
        for (const [, run] of shellRuns) {
          if (run.running) {
            killTree(run.process);
            run.cancelled = true;
            run.running = false;
            if (run.timer) {
              clearTimeout(run.timer);
              run.timer = null;
            }
          }
        }
        return { cancelled: true } as T;
      }

      case "project_tool.workspace.switch": {
        if (!dynamicWorkspaceEnabled() && !envFlag("VENIRA_UNRESTRICTED", false)) {
          throw new Error('[workspace_switch_denied] dynamic workspace disabled; set VENIRA_DYNAMIC_WORKSPACE=1 plus VENIRA_WORKSPACE_ROOTS.');
        }
        const target = String((p as any).root ?? (p as any).relative_path ?? (p as any).absolute_path ?? "");
        if (!target.trim()) throw new Error("[invalid_request] root/relative_path required.");
        const next = switchWorkspaceRoot(target);
        clearListFilesCache();
        return { workspace_root: next, allowed_roots: allowedWorkspaceRoots() } as T;
      }

      case "project_tool.execute": {
        const operation = p.operation.name as string;
        const args = p.operation.arguments as Record<string, unknown>;
        const requestId = p.request_id as string;
        const sessionId = p.session_id as string;
        const capabilityId = p.capability_id as string;

        if (!isScopeValid(capabilityId)) {
          throw new Error("[capability_expired] Capability is expired or revoked. Hint: the scope re-opens automatically on the next call.");
        }

        const reasonText = sanitizeReason(
          redactSecretValues(redactSecrets(typeof p.reason === "string" ? p.reason : "")),
        );
        // Read-only observation windows are not audited: creating a row and then
        // deleting it would cut the hash chain (the next row's prev_hash would
        // point at a row that no longer exists).
        if (operation === "shell_status") {
          const response = await opShellStatus(args);
          return response as T;
        }
        const externalSummary = describeExternalOp(operation, args);
        const argsHash = crypto
          .createHash("sha256")
          .update(JSON.stringify(args, Object.keys(args).sort()))
          .digest("hex");
        const startedAt = auditStart(sessionId, p.project_id ?? "chat-terminal", operation, requestId, {
          reason: reasonText,
          args_hash: argsHash,
          ...(externalSummary ? { command: externalSummary } : {}),
        });

        // Every path below returns or throws; the wrapper records what the job was asked and what it
        // returned next to its audit row (lib/audit-detail.ts), then passes the result or error through.
        const runAudited = async (): Promise<unknown> => {
        if (operation === "shell_run") {
          const projectId = p.project_id ?? "chat-terminal";
          const commandText =
            typeof args.command === "string"
              ? redactSecretValues(redactSecrets(args.command)).slice(0, 4000)
              : null;
          try {
            const response = await opShellRun(args, WORKSPACE, sessionId);
            const data = response.result?.data as Record<string, any> | undefined;
            const approval = response.result?.kind === "shell_approval";
            const policy = (data?.policy ?? {}) as Record<string, any>;
            auditDecision(sessionId, requestId, {
              decision: approval ? "ask" : (policy.decision as string | undefined),
              policy_rule: approval ? (data?.rule as string | undefined) : (policy.rule as string | undefined),
              command: commandText ?? undefined,
              approver: approval ? "pending" : (policy.approver as string | undefined),
            });
            // `ask` did not execute anything: record why the call stopped.
            if (approval) {
              auditFinish(sessionId, projectId, operation, requestId, startedAt, "failed", "approval_required");
            } else {
              auditFinish(sessionId, projectId, operation, requestId, startedAt, "succeeded");
            }
            return response as T;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const codeMatch = /^\[([a-z0-9_]+)\]/i.exec(message);
            const reasonCode = codeMatch ? codeMatch[1] : "operation_failed";
            const ruleMatch =
              /Blocked by ([A-Za-z0-9_.]+)/.exec(message) ?? /\(rule: ([A-Za-z0-9_.]+)\)/.exec(message);
            auditDecision(sessionId, requestId, {
              decision:
                reasonCode === "command_denied"
                  ? "deny"
                  : reasonCode.startsWith("override_")
                    ? "deny"
                  : reasonCode === "approval_invalid" || reasonCode === "approval_required"
                    ? "ask"
                    : undefined,
              policy_rule: ruleMatch ? ruleMatch[1] : undefined,
              command: commandText ?? undefined,
            });
            auditFinish(sessionId, projectId, operation, requestId, startedAt, "failed", reasonCode);
            throw error;
          }
        }
        if (operation === "cancel") {
          const response = opShellCancel(args);
          auditFinish(sessionId, p.project_id ?? "chat-terminal", "cancel", requestId, startedAt, "succeeded");
          return response as T;
        }

        const handler = operations[operation];
        if (!handler) {
          auditFinish(sessionId, p.project_id ?? "chat-terminal", operation, requestId, startedAt, "failed", "unsupported");
          throw new Error(`[unsupported] Unknown operation: ${operation}`);
        }

        try {
          const response = await handler(args, WORKSPACE, sessionId);
          auditFinish(sessionId, p.project_id ?? "chat-terminal", operation, requestId, startedAt, "succeeded");
          return response as T;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const codeMatch = /^\[([a-z0-9_]+)\]/i.exec(message);
          const reasonCode = codeMatch ? codeMatch[1] : "operation_failed";
          auditFinish(sessionId, p.project_id ?? "chat-terminal", operation, requestId, startedAt, "failed", reasonCode);
          throw error;
        }
        };
        try {
          const out = await runAudited();
          const detail = buildAuditDetail(args, { ok: true, response: out });
          if (detail) auditDetailInsert(sessionId, requestId, operation, detail);
          return out as T;
        } catch (error) {
          const detail = buildAuditDetail(args, { ok: false, error });
          if (detail) auditDetailInsert(sessionId, requestId, operation, detail);
          throw error;
        }
      }

      default:
        throw new Error(`[invalid_request] Unknown method: ${method}`);
    }
  }

  close(): void {
    for (const run of shellRuns.values()) {
      if (run.running) {
        killTree(run.process);
        run.cancelled = true;
        run.running = false;
        if (run.timer) {
          clearTimeout(run.timer);
          run.timer = null;
        }
      }
    }
    shellRuns.clear();
    for (const capId of openScopes.keys()) closeScope(capId);
    closeAuditDb();
  }
}
