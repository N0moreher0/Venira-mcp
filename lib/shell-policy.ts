/**
 * Shell command policy for `project_shell_run`.
 *
 * Why this exists
 * ---------------
 * The workspace lock protects the *file* tools, but a shell can do anything the
 * user can: `rm -rf ~`, `curl … | sh`, `git push --force`. A blacklist alone is
 * not a security boundary (there are unbounded ways to spell the same command),
 * so this module combines three layers:
 *
 *   1. A small, high-confidence DENY set for unambiguous catastrophes.
 *   2. An ASK set for commands whose blast radius is real but sometimes wanted
 *      (writes outside the workspace, network fetches, package publishing,
 *      history rewriting, privilege escalation).
 *   3. A strict ALLOW list (opt-in via VENIRA_SHELL_MODE=strict) for
 *      read-only / workspace-local commands, so "everything else" requires an
 *      explicit approval instead of being allowed by default. Git history
 *      rewrites remain an approval gate even in permissive mode.
 *
 * Decisions are deterministic and auditable: every result carries the rule id
 * that produced it.
 *
 * Approval model
 * --------------
 * `ask` never runs the command. The caller receives an `approval_required`
 * error with a pending `approval_id` bound to the exact command, shell, cwd,
 * secret_env and rule. Only a human can grant it (the exact `data.approval.approve_command`
 * in a TTY, or MCP elicitation in the client UI); the agent then retries once with
 * `approval_id`. The grant's scope (`once` or `session`) is chosen by the human,
 * never by the model. A `session` grant only covers rules in
 * VENIRA_SESSION_GRANT_RULES, for the same rule + command head (e.g. `git push`).
 *
 * Policy file
 * -----------
 * Optional JSON at `VENIRA_SHELL_POLICY_FILE` (explicit path only). Policy is
 * deliberately NOT read from the workspace by default: a cloned repository must
 * not be able to ship a permissive policy for itself.
 */
import crypto from "node:crypto";
import path from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolveWithin } from "./workspace.js";
import { parseShellCommand, type ParsedCommand, type Segment } from "./shell-parser.js";
import { READ_COMMANDS, STRICT_ALLOW } from "./shell-policy-rules.js";
import { evaluateParsedShellCommand, type AskRule, type HardDenyRule } from "./shell-policy-evaluate.js";
import { resolveSecurityProfile, securityProfileIsExplicit, securityProfileSettings } from "./security-profile.js";

export { tokenize } from "./shell-tokenizer.js";
import { HARD_DENY, ASK_RULES, isSafeSegment, isOutsideWorkspace } from "./shell-policy-tables.js";
import { balancedAllow } from "./shell-policy-balanced.js";
export { isOutsideWorkspace } from "./shell-policy-tables.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShellMode = "strict" | "balanced" | "permissive" | "off";
export type ShellOverride = "ALLOW_GIT_PUSH" | "ALLOW_ENV_READ";
export type Tier = "allow" | "ask" | "deny";

export type ShellRule = {
  id: string;
  tier: Tier;
  command?: string;
  subcommand?: string;
  /** Regex matched against the joined arguments of a segment. */
  args_regex?: string;
  reason?: string;
};

export type ShellPolicy = {
  mode: ShellMode;
  allow: ShellRule[];
  ask: ShellRule[];
  deny: ShellRule[];
  source: string;
};

export type { ParsedCommand, Segment };

export type Decision = {
  tier: Tier;
  rule: string;
  reason: string;
  mode: ShellMode;
  command_hash: string;
  /** Human-readable hint shown to the user, e.g. suggesting a safer alternative tool. */
  hint?: string;
};

export { parseShellCommand } from "./shell-parser.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function readRules(value: unknown, tier: Tier): ShellRule[] {
  if (!Array.isArray(value)) return [];
  const rules: ShellRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.command !== "string" || !candidate.command) continue;
    rules.push({
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : `${tier}_${candidate.command}`,
      tier,
      command: candidate.command.toLowerCase(),
      ...(typeof candidate.subcommand === "string" ? { subcommand: candidate.subcommand.toLowerCase() } : {}),
      ...(typeof candidate.args_regex === "string" ? { args_regex: candidate.args_regex } : {}),
      ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
    });
  }
  return rules;
}

function normaliseMode(value: string | undefined): ShellMode | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "strict" || v === "balanced" || v === "permissive" || v === "off") return v;
  return null;
}

const SHELL_OVERRIDE_NAMES = new Set<ShellOverride>(["ALLOW_GIT_PUSH", "ALLOW_ENV_READ"]);

export function isShellOverride(value: unknown): value is ShellOverride {
  return typeof value === "string" && SHELL_OVERRIDE_NAMES.has(value as ShellOverride);
}

export function enabledShellOverrides(): Set<ShellOverride> {
  const raw = process.env.VENIRA_SHELL_OVERRIDES;
  if (raw === undefined || raw.trim() === "") return new Set();
  const enabled = new Set<ShellOverride>();
  for (const token of raw.split(",")) {
    const name = token.trim();
    if (!isShellOverride(name)) {
      throw new Error(
        `[config_invalid] VENIRA_SHELL_OVERRIDES accepts only: ${[...SHELL_OVERRIDE_NAMES].join(", ")}.`,
      );
    }
    enabled.add(name);
  }
  return enabled;
}

/**
 * Flags a fast-forward publish needs. Anything else (force, delete, mirror, prune, --no-verify, --exec,
 * --receive-pack, --repo, config injection) is not covered by the override and goes through the normal verdict.
 */
const PUSH_SAFE_FLAGS = new Set([
  "-u", "--set-upstream", "--follow-tags", "--tags", "--atomic", "-n", "--dry-run",
  "-v", "--verbose", "-q", "--quiet", "--progress", "--porcelain", "--no-progress",
]);
/** Remote names and branch/tag refs: no leading `-`/`+`/`:` (option, force, delete), no URLs or shell characters. */
const PUSH_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/@-]{0,199}$/;

/** `git push [safe flags] [<remote> [<ref>[:<ref>]]]`: never a force, a delete, a URL or an option that runs code. */
function isPlainPush(args: string[]): boolean {
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!PUSH_SAFE_FLAGS.has(arg)) return false;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 2) return false;
  for (const item of positional) {
    const parts = item.split(":");
    if (parts.length > 2) return false;
    // `src:dst` needs both sides (an empty src deletes the remote ref); `+src` is a force, rejected by the regex.
    if (!parts.every((part) => PUSH_REF_RE.test(part) && !part.includes("..") && !part.endsWith(".lock"))) return false;
  }
  // The remote is a name, not a URL: `git push <url>` could publish to an unreviewed destination.
  if (positional[0] && /[:@]/.test(positional[0])) return false;
  return true;
}

/**
 * The unattended override covers one plain push only. Staging and committing can
 * publish arbitrary repository contents, so those actions stay behind normal policy.
 */
function matchesGitPushOverride(parsed: ParsedCommand): boolean {
  if (parsed.segments.length !== 1) return false;
  if (parsed.has_pipe || parsed.has_redirect || parsed.has_background || parsed.has_substitution) return false;
  const last = parsed.segments[parsed.segments.length - 1];
  const pushOk =
    last.command === "git" && last.subcommand === "push" && last.argv[1]?.toLowerCase() === "push" && isPlainPush(last.argv.slice(2));
  return pushOk;
}

function matchesOverride(parsed: ParsedCommand, cwd: string, name: ShellOverride): boolean {
  if (name === "ALLOW_GIT_PUSH") return matchesGitPushOverride(parsed);
  if (
    parsed.segments.length !== 1 ||
    parsed.has_pipe ||
    parsed.has_redirect ||
    parsed.has_background ||
    parsed.has_substitution
  ) {
    return false;
  }
  const segment = parsed.segments[0];
  if (!READ_COMMANDS.has(segment.command)) return false;
  const paths = segment.argv.slice(1).filter((arg) => arg !== "--" && !arg.startsWith("-"));
  if (paths.length !== 1) return false;
  const target = paths[0];
  if (!target || /[*?\[\]$%`]/.test(target) || isOutsideWorkspace(target, cwd)) return false;
  if (!/^\.env(?:\.[a-z0-9._-]+)?$/i.test(path.basename(target.replace(/\\/g, "/")))) return false;
  try {
    const absolute = path.resolve(cwd, target);
    const entry = lstatSync(absolute);
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    resolveWithin(cwd, realpathSync(absolute));
    return true;
  } catch {
    return false;
  }
}

export function shellOverrideMatches(name: ShellOverride, command: string, cwd: string, shell?: string): boolean {
  return matchesOverride(parseShellCommand(command, { shell }), cwd, name);
}

let cachedPolicy: ShellPolicy | null = null;

export function loadShellPolicy(): ShellPolicy {
  if (cachedPolicy) return cachedPolicy;

  const policy: ShellPolicy = { mode: "balanced", allow: [], ask: [], deny: [], source: "builtin" };
  const rawEnvMode = process.env.VENIRA_SHELL_MODE;
  const envMode = normaliseMode(rawEnvMode);
  if (rawEnvMode !== undefined && !envMode) {
    throw new Error("[config_invalid] VENIRA_SHELL_MODE must be balanced, strict, permissive, or off.");
  }
  // VENIRA_SECURITY_PROFILE sets the baseline; VENIRA_SHELL_MODE (and a policy file mode) override it.
  const profile = resolveSecurityProfile();
  const profileExplicit = securityProfileIsExplicit();
  if (profileExplicit) policy.mode = securityProfileSettings(profile).shellMode;
  if (envMode) policy.mode = envMode;

  const file = process.env.VENIRA_SHELL_POLICY_FILE;
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const rawFileMode = typeof parsed.mode === "string" ? parsed.mode : undefined;
      const fileMode = normaliseMode(rawFileMode);
      if (rawFileMode !== undefined && !fileMode) {
        throw new Error("[config_invalid] shell policy mode must be balanced, strict, permissive, or off.");
      }
      if (fileMode && !envMode) policy.mode = fileMode;
      policy.allow = readRules(parsed.allow, "allow");
      policy.ask = readRules(parsed.ask, "ask");
      policy.deny = readRules(parsed.deny, "deny");
      policy.source = file;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("[config_invalid]")) throw error;
      console.error(
        `[shell-policy] ignoring ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      policy.source = "builtin (policy file unreadable)";
    }
  } else if (file) {
    console.error(`[shell-policy] policy file not found: ${file} (using built-in rules)`);
    policy.source = "builtin (policy file missing)";
  }

  if (policy.mode === "off") {
    console.error(
      "[shell-policy] WARNING: shell mode off (VENIRA_SECURITY_PROFILE=off or VENIRA_SHELL_MODE=off) disables ALL shell policy checks (hard-deny included). " +
        "Use only in a trusted environment. secret_env still requires approval.",
    );
  }

  if (/^(1|true|yes|on)$/i.test((process.env.VENIRA_SHELL_AUTO_APPROVE_TOKEN ?? "").trim())) {
    console.error(
      "[shell-policy] WARNING: VENIRA_SHELL_AUTO_APPROVE_TOKEN was removed in v1.15 and is ignored. " +
        "Approvals now always use approval_id granted by a human (the exact data.approval.approve_command or client elicitation).",
    );
  }

  cachedPolicy = policy;
  return policy;
}

/** Test hook: drop the cache so a new env/policy file is picked up. */
export function resetShellPolicyCache(): void {
  cachedPolicy = null;
}

export function describeShellPolicy(): { mode: ShellMode; source: string; rules: { allow: number; ask: number; deny: number }; builtin: { deny: number; ask: number } } {
  const policy = loadShellPolicy();
  return {
    mode: policy.mode,
    source: policy.source,
    rules: { allow: policy.allow.length, ask: policy.ask.length, deny: policy.deny.length },
    builtin: { deny: HARD_DENY.length, ask: ASK_RULES.length },
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function commandHash(command: string): string {
  return crypto.createHash("sha256").update(command.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 32);
}

/** The narrow key used for session-scoped approvals, e.g. "git push". */
export function commandKey(parsed: ParsedCommand): string {
  const first = parsed.segments[0];
  if (!first) return "empty";
  return `${first.command}${first.subcommand ? " " + first.subcommand : ""}`;
}

export function evaluateShellCommand(
  command: string,
  cwd: string,
  options: { mode?: ShellMode; override?: ShellOverride; overrideReason?: string; shell?: string } = {},
): Decision {
  const policy = loadShellPolicy();
  const mode = options.mode ?? policy.mode;
  const parsed = parseShellCommand(command, { shell: options.shell });
  const enabled = enabledShellOverrides();
  const override = options.override
    ? {
        name: options.override,
        reason: options.overrideReason ?? "",
        enabled: enabled.has(options.override),
        matches: (candidate: ParsedCommand, currentCwd: string) =>
          matchesOverride(candidate, currentCwd, options.override!),
      }
    : undefined;
  return evaluateParsedShellCommand(
    command,
    cwd,
    parsed,
    policy,
    mode,
    HARD_DENY,
    ASK_RULES,
    STRICT_ALLOW,
    isSafeSegment,
    override,
    balancedAllow,
  );
}

// Session grants, redaction và counters nằm ở module riêng; re-export để API không đổi.
export { grantSessionApproval, hasSessionApproval, clearApprovals } from "./shell-policy-session.js";
export { redactSecrets, recordDecision, recordApproval, shellStats } from "./shell-policy-stats.js";
