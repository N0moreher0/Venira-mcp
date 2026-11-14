import path from "node:path";
import { APPROVAL_PENDING_TTL_MS, APPROVAL_WAIT_MAX_S } from "../lib/approval-gate.js";
import * as approvals from "../lib/approvals.js";
import { computeConfigPosture } from "../lib/config-posture.js";
import { SHELL_TAIL_LIMIT, shellPolicySnapshot } from "../lib/corehost.js";
import { envFlag } from "../lib/env.js";
import { checkEnvironment } from "../lib/env-registry.js";
import { githubHealth } from "../lib/git-provider.js";
import { metricsSnapshot, recordMetric } from "../lib/metrics.js";
import { OUTPUT_MODE, buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { ToolResult } from "../lib/output.js";
import { secretsHealth } from "../lib/secrets.js";
import { resolveSecurityProfile, securityProfileIsExplicit } from "../lib/security-profile.js";
import { SESSION_ID } from "../lib/session.js";
import { snapshotHealth } from "../lib/snapshots.js";
import { mirrorHealth } from "../lib/snapshot-mirror.js";
import { traceSnapshot } from "../lib/tracer.js";
import type { HostSnapshot } from "../lib/types.js";
import { VERSION } from "../lib/version.js";
import {
  ALLOW_JS_EXEC,
  CACHE_ALL_ENABLED,
  CACHE_LIST_ONLY_ENABLED,
  CACHE_SEARCH_ONLY_ENABLED,
  JS_EXEC_APPROVAL,
  JS_EXEC_MODE,
  UNRESTRICTED,
  WORKSPACE,
  activeDataDir,
  allowedWorkspaceRoots,
  dynamicWorkspaceEnabled,
} from "../lib/workspace.js";
import { auditHealth } from "./project-audit.js";

// health handler. Extracted from tools/project.ts (P1 #6, step 5d); the report
// shape is unchanged. State owned by project.ts is read through HealthDeps.

type Args = Record<string, unknown>;

/** Approval config as the agent should see it, plus the shared posture report. */
function approvalsHealth(shellElicit: boolean): {
  approvals: Record<string, unknown>;
  warnings: string[];
  posture: ReturnType<typeof computeConfigPosture>;
} {
  const policy = shellPolicySnapshot().policy;
  const securityProfile = resolveSecurityProfile();
  const sessionGrantRules = approvals.sessionGrantRules();
  const posture = computeConfigPosture({
    shellMode: policy.mode,
    jsExecEnabled: ALLOW_JS_EXEC,
    jsExecApproval: JS_EXEC_APPROVAL,
    sessionGrantRules,
  });
  return {
    approvals: {
      security_profile: securityProfile,
      security_profile_explicit: securityProfileIsExplicit(),
      shell_mode: policy.mode,
      // Roadmap item 15 (P2): `security_profile: balanced` next to
      // `shell_mode: off` reads like a contradiction. Say what is actually
      // enforced: the mode decides, and "off" means no checks run at all.
      shell_checks: policy.mode === "off" ? "disabled" : "enforced",
      shell_mode_decides: true,
      policy_source: policy.source,
      js_exec_mode: JS_EXEC_MODE,
      js_exec_enabled: ALLOW_JS_EXEC,
      js_exec_approval: JS_EXEC_APPROVAL,
      elicitation: shellElicit,
      session_grant_rules: sessionGrantRules,
      pending_ttl_ms: APPROVAL_PENDING_TTL_MS,
      max_wait_ms: APPROVAL_WAIT_MAX_S * 1000,
    },
    // Kept for clients that already read the flat list; posture carries the
    // same findings with stable ids and severities.
    warnings: posture.findings
      .filter((finding) => finding.severity !== "info")
      .map((finding) => `${finding.id}: ${finding.summary}`),
    posture,
  };
}

export function dataDirFor(exe: string | null): string {
  // `exe` is always null in the standalone (pure-Node, no Rust binary) build — kept as a
  // parameter for call-site compatibility. Must match corehost.ts's ensureAuditDb(), which
  // resolves VENIRA_DATA_DIR else the per-user default (lib/workspace.ts#defaultDataDir);
  // falling back to WORKSPACE/data here would silently point at a DB nothing ever writes to.
  void exe;
  return activeDataDir();
}

/**
 * Snapshot providers for state owned by tools/project.ts (queue, capability, caches)
 * and the shell-run registry. Injected so this module never touches those mutable variables and
 * never imports back from project.ts.
 */
export type HealthDeps = {
  hostSnapshot: () => HostSnapshot;
  /** Refresh the scope capability so a long-lived process never reports a stale one. */
  refreshCapability: () => Promise<unknown>;
  capability: () => Record<string, unknown>;
  queue: () => Record<string, unknown>;
  caches: () => Record<string, unknown>;
  shells: () => { active: Array<{ run_id: string; exit_code: number | null }>; tracked: number };
  startedAt: number;
  permissionMode: string;
  shellElicit: boolean;
};

export async function runHealth(args: Args, deps: HealthDeps): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  // Refresh transparently so a long-lived process never reports an expired/stale scope.
  try {
    await deps.refreshCapability();
  } catch {
    /* health still reports what it can (state "closed" below) */
  }
  const hostInfo = deps.hostSnapshot();
  const dataDir = dataDirFor(hostInfo.exe);
  const includeAudit = args.include_audit !== false;
  // Roadmap item 15 (P1): the full health payload does not fit in a compact
  // response. `sections` lets the agent ask for the parts it needs instead of
  // getting a slice of JSON it cannot read.
  const wanted = Array.isArray(args.sections)
    ? args.sections.filter((name): name is string => typeof name === "string" && name.length > 0)
    : null;
  try {
    const dbPath = path.join(dataDir, "venira.db");
    const data = {
      notice: "Venira is a guard rail with an audit trail, not a sandbox. It runs with the OS user’s privileges. The workspace lock limits file-tool paths, not shell effects; prompt injection can still steer commands allowed by the active profile. Same-user processes can read keys in VENIRA_DATA_DIR. Use a container or VM for real isolation. See SECURITY.md.",
      server: {
        name: "venira-coding",
        version: VERSION,
        pid: process.pid,
        session_id: SESSION_ID,
        uptime_ms: Date.now() - deps.startedAt,
        workspace: WORKSPACE,
        // Roadmap item 15 (P2): `allowed_roots` listed "/" (the unrestricted
        // mode) next to `enabled: false`, which reads as "you may switch
        // anywhere". While switching is off, only the current workspace is in
        // play; unrestricted is reported on its own.
        workspace_switching: {
          enabled: dynamicWorkspaceEnabled(),
          allowed_roots: dynamicWorkspaceEnabled() ? allowedWorkspaceRoots() : [WORKSPACE],
          unrestricted: UNRESTRICTED,
        },
        unrestricted: UNRESTRICTED,
        permission_mode: deps.permissionMode,
        output_mode: OUTPUT_MODE,
        pretty: envFlag("VENIRA_PRETTY", false),
        node: process.version,
      },
      corehost: {
        ...hostInfo,
        exe: hostInfo.exe,
        data_dir: dataDir,
        // Roadmap item 15 (P2): the data dir holds the audit DB and the
        // secrets; the checkpoint store lives elsewhere (see snapshots.store).
        data_dir_kind: "audit_and_secrets",
        audit_fast: true,
      },
      capability: deps.capability(),
      queue: deps.queue(),
      caches: deps.caches(),
      shells: { ...deps.shells(), policy: shellPolicySnapshot() },
      ...approvalsHealth(deps.shellElicit),
      // Checkpoints: manifest-level only (no blob walk, so health stays fast). `mirror` is the optional
      // append-only copy: configured flag plus the outcome of the last run in this process.
      snapshots: {
        ...(await snapshotHealth().catch(() => ({ store: "", checkpoints: 0, logical_bytes: 0 }))),
        mirror: mirrorHealth(),
      },
      // Secrets: counts + encryption only; the store path is reported, never values.
      secrets: secretsHealth(),
      // GitHub/CI: repo detection, api base, auth presence (never the token).
      network: {
        github: githubHealth(),
      },
      metrics: metricsSnapshot(),
      // P1: config + observability surfaces
      cache: {
        all_enabled: CACHE_ALL_ENABLED,
        list_enabled: CACHE_LIST_ONLY_ENABLED,
        search_enabled: CACHE_SEARCH_ONLY_ENABLED,
      },
      trace: traceSnapshot(),
      shell: {
        tail_max: SHELL_TAIL_LIMIT,
        exit_early: true,
        timeout_policy: "hard",
      },
      // Typos, removed variables and lenient values the registry can detect (warnings only).
      environment: { issues: checkEnvironment() },
      audit: includeAudit ? await auditHealth(dbPath) : { skipped: true },
    };
    const payload = wanted
      ? (() => {
          const picked: Record<string, unknown> = {};
          const unknown: string[] = [];
          for (const name of wanted) {
            if (name in data) picked[name] = (data as Record<string, unknown>)[name];
            else unknown.push(name);
          }
          return {
            ...picked,
            sections_requested: wanted,
            ...(unknown.length > 0 ? { sections_unknown: unknown } : {}),
          };
        })()
      : data;
    const elapsedMs = performance.now() - started;
    recordMetric("health", elapsedMs, true);
    return toolResult(buildEnvelope("health", { status: "completed", result: { kind: "health", data: payload } }, {
      requestId,
      elapsedMs,
    }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("health", elapsedMs, false);
    return toolResult(errorEnvelope("health", error, { requestId, elapsedMs }), true);
  }
}
