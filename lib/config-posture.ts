/**
 * Shared configuration-posture calculation.
 *
 * One deterministic place decides which operator-selected settings deserve a
 * warning, so `project_health`, `doctor` and future surfaces never disagree.
 * The inputs are data (not env directly) which keeps the evaluator pure and
 * table-testable; `configPostureInput()` is the thin env-reading adapter.
 *
 * Policy decision: findings are warnings only (`fail_closed: false`).
 * Invalid values already fail closed at startup (`config_invalid` for a bad
 * profile/mode/boolean), so every combination reported here is a valid choice
 * an operator made on purpose. Turning these into refusals would break existing
 * trusted/off deployments and there is no measured demand for an acknowledgement
 * gate; revisit only with usage evidence.
 */
import { envFlag } from "./env.js";
import {
  resolveSecurityProfile,
  securityProfileIsExplicit,
  type SecurityProfile,
} from "./security-profile.js";

export type ConfigShellMode = "strict" | "balanced" | "permissive" | "off";
export type PostureSeverity = "ok" | "info" | "warning" | "critical";

export interface PostureFinding {
  /** Stable case id (safe to assert on; wording may change). */
  id: string;
  severity: Exclude<PostureSeverity, "ok">;
  summary: string;
  detail: string;
  recommendation: string;
}

export interface ConfigPostureInput {
  securityProfile: SecurityProfile;
  securityProfileExplicit: boolean;
  /** Effective shell mode after profile + VENIRA_SHELL_MODE + policy file. */
  shellMode: ConfigShellMode;
  jsExecEnabled: boolean;
  jsExecApproval: boolean;
  unrestricted: boolean;
  allowSelfInstall: boolean;
  secretAllowReveal: boolean;
  /** True when either Git HTTP override is enabled (tokens may travel in clear text). */
  gitAllowHttp: boolean;
  legacyAutoApproveToken: boolean;
  sessionGrantRules: string[];
}

export interface ConfigPosture {
  level: PostureSeverity;
  findings: PostureFinding[];
  summary: string;
  /** Warnings only; no call is refused because of a posture finding. */
  fail_closed: false;
  notes: string;
}

/** Ask-rule ids whose effects are too broad for a session-wide grant. */
const RISKY_SESSION_RULES = new Set([
  "network_access",
  "git_history_rewrite",
  "dynamic_execution",
  "writes_outside_workspace",
  "read_outside_workspace",
  "command_substitution",
  "process_control",
  "container_control",
  "secret_dump",
  "unresolved_file_argument",
]);

const SEVERITY_RANK: Record<PostureSeverity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };

function normalizeRule(rule: string): string {
  return rule.trim().replace(/^(ask|deny)\./, "").toLowerCase();
}

function worst(findings: PostureFinding[]): PostureSeverity {
  let level: PostureSeverity = "ok";
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[level]) level = finding.severity;
  }
  return level;
}

function riskySessionRules(rules: string[]): string[] {
  return [...new Set(rules.map(normalizeRule).filter((rule) => RISKY_SESSION_RULES.has(rule)))].sort();
}

/**
 * Pure evaluator. Ordering is stable: the most consequential findings come
 * first, then informational ones, so summaries stay deterministic.
 */
export function evaluateConfigPosture(input: ConfigPostureInput): ConfigPosture {
  const findings: PostureFinding[] = [];
  const add = (finding: PostureFinding) => findings.push(finding);

  if (input.unrestricted) {
    add({
      id: "workspace.unrestricted",
      severity: "critical",
      summary: "The workspace lock is disabled (VENIRA_UNRESTRICTED=1).",
      detail: "File tools accept absolute paths outside the workspace, so the project boundary no longer protects other files.",
      recommendation: "Unset VENIRA_UNRESTRICTED outside a disposable container or a dedicated test account.",
    });
  }

  if (input.securityProfile === "off") {
    add({
      id: "profile.off",
      severity: "critical",
      summary: "The security profile is off.",
      detail: "Shell policy checks (hard-deny included) and the per-call JavaScript approval gate are disabled.",
      recommendation: "Use `strict` or `balanced`; keep `off` only for a trusted, isolated environment.",
    });
  } else if (input.shellMode === "off") {
    add({
      id: "shell.mode_off",
      severity: "critical",
      summary: "The shell policy is off while the security profile is not.",
      detail: "VENIRA_SHELL_MODE=off overrides the profile and bypasses every shell check, hard-deny included.",
      recommendation: "Remove the override, or set the profile to `off` as well if this is intentional.",
    });
  }

  if (input.shellMode === "permissive") {
    add({
      id: "shell.mode_permissive",
      severity: "warning",
      summary: "The shell policy is permissive.",
      detail: "Hard-deny commands ask instead of being refused, and ask-rule commands run without approval.",
      recommendation: "Prefer `balanced`; use `permissive` only on a personal machine with disposable data.",
    });
  }

  if (input.jsExecEnabled && !input.jsExecApproval) {
    add({
      id: "js.exec_without_approval",
      severity: "warning",
      summary: "`project_execute_js` runs without per-call approval (mode `auto`).",
      detail: "Arbitrary JavaScript executes outside the shell policy and protected-path guard with no human step.",
      recommendation: "Set VENIRA_JS_EXEC_MODE=ask unless the server only serves fully trusted automation.",
    });
  }

  if (input.unrestricted && (input.shellMode === "off" || input.shellMode === "permissive")) {
    add({
      id: "combo.unrestricted_open_shell",
      severity: "critical",
      summary: "No workspace lock combined with an open shell policy.",
      detail: "A single command can read or modify anything the OS user can reach, and the file tools no longer stop it either.",
      recommendation: "Remove at least one of VENIRA_UNRESTRICTED or the open shell mode; isolate the server instead.",
    });
  }

  if (input.unrestricted && input.jsExecEnabled && !input.jsExecApproval) {
    add({
      id: "combo.unrestricted_unapproved_js",
      severity: "critical",
      summary: "No workspace lock combined with unapproved JavaScript execution.",
      detail: "Unreviewed code can read and write any path the OS user can reach.",
      recommendation: "Remove VENIRA_UNRESTRICTED or re-enable the JS approval gate.",
    });
  }

  const riskyRules = riskySessionRules(input.sessionGrantRules);
  if (riskyRules.length > 0) {
    add({
      id: "approval.session_grant_risky_rule",
      severity: "warning",
      summary: `Session-wide approval is enabled for sensitive rule(s): ${riskyRules.join(", ")}.`,
      detail: "One human approval then covers that rule group for the whole session, not one exact call.",
      recommendation: "Keep VENIRA_SESSION_GRANT_RULES to narrow rules such as `cd_outside_workspace`.",
    });
  }

  if (input.allowSelfInstall) {
    add({
      id: "self_install.enabled",
      severity: "warning",
      summary: "`project_install_self` may write other clients' config files.",
      detail: "The server can modify MCP client configuration outside the workspace (VENIRA_ALLOW_SELF_INSTALL=1).",
      recommendation: "Enable it only for the install run, then unset it.",
    });
  }

  if (input.secretAllowReveal) {
    add({
      id: "secret.reveal_enabled",
      severity: "warning",
      summary: "Secret plaintext reveal is enabled.",
      detail: "`project_secret reveal=1` can print a stored secret value into the transcript (VENIRA_SECRET_ALLOW_REVEAL=1).",
      recommendation: "Keep reveal off and inject secrets through `secret_env` instead.",
    });
  }

  if (input.gitAllowHttp) {
    add({
      id: "git.plain_http_allowed",
      severity: "warning",
      summary: "Git/GitHub HTTP URLs are allowed.",
      detail: "Provider tokens may be sent over plain HTTP instead of HTTPS.",
      recommendation: "Disable the HTTP overrides; use HTTPS or SSH remotes.",
    });
  }

  if (input.legacyAutoApproveToken) {
    add({
      id: "approval.legacy_token_ignored",
      severity: "info",
      summary: "The removed approval-token setting is present but ignored.",
      detail: "VENIRA_SHELL_AUTO_APPROVE_TOKEN was removed in v1.15 and cannot approve anything.",
      recommendation: "Remove it and use human-granted `approval_id` (or a session grant).",
    });
  }

  const level = worst(findings);
  const actionable = findings.filter((finding) => finding.severity !== "info").length;
  const summary =
    level === "ok"
      ? "Configuration posture is within the recommended defaults."
      : `${findings.length} configuration finding(s), ${actionable} actionable; highest severity: ${level}.`;

  return {
    level,
    findings,
    summary,
    fail_closed: false,
    notes: "Warnings only. Invalid values already fail closed at startup; these findings never refuse a call.",
  };
}

/** Thin env adapter for the effective modes the caller has already resolved. */
export function configPostureInput(overrides: {
  shellMode: ConfigShellMode;
  jsExecEnabled?: boolean;
  jsExecApproval?: boolean;
  sessionGrantRules?: string[];
}): ConfigPostureInput {
  const securityProfile = resolveSecurityProfile();
  const readFlag = (name: string, fallback: boolean): boolean => {
    try {
      return envFlag(name, fallback);
    } catch {
      return fallback; // validateBooleanEnvironment() reports the bad value at startup
    }
  };
  // Same resolution as lib/workspace.ts `resolveJsExecMode`, but defensive:
  // an invalid mode would already have failed closed at startup, so posture
  // only needs to reflect the effective mode, never to throw.
  const rawMode = (process.env.VENIRA_JS_EXEC_MODE ?? "").trim().toLowerCase();
  const modeKnown = rawMode === "off" || rawMode === "ask" || rawMode === "auto";
  return {
    securityProfile,
    securityProfileExplicit: securityProfileIsExplicit(),
    shellMode: overrides.shellMode,
    jsExecEnabled: overrides.jsExecEnabled ?? (modeKnown ? rawMode !== "off" : false),
    jsExecApproval: overrides.jsExecApproval ?? (modeKnown ? rawMode === "ask" : true),
    unrestricted: readFlag("VENIRA_UNRESTRICTED", false),
    allowSelfInstall: readFlag("VENIRA_ALLOW_SELF_INSTALL", false),
    secretAllowReveal: readFlag("VENIRA_SECRET_ALLOW_REVEAL", false),
    gitAllowHttp: readFlag("VENIRA_GIT_ALLOW_HTTP", false) || readFlag("VENIRA_GITHUB_ALLOW_HTTP", false),
    legacyAutoApproveToken: readFlag("VENIRA_SHELL_AUTO_APPROVE_TOKEN", false),
    sessionGrantRules: overrides.sessionGrantRules ?? [],
  };
}

export function computeConfigPosture(overrides: Parameters<typeof configPostureInput>[0]): ConfigPosture {
  return evaluateConfigPosture(configPostureInput(overrides));
}
