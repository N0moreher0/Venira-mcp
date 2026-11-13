import crypto from "node:crypto";
import type {
  Decision,
  ParsedCommand,
  Segment,
  ShellMode,
  ShellPolicy,
  ShellRule,
} from "./shell-policy.js";

export type HardDenyRule = {
  id: string;
  test: (parsed: ParsedCommand, raw: string, cwd: string) => boolean;
  reason: string;
};

export type AskRule = {
  id: string;
  reason: string;
  test: (parsed: ParsedCommand, cwd: string) => boolean;
  alwaysAsk?: boolean;
};

type StrictAllowRule = { command: string; subcommands?: string[] };
type OverrideDecision = {
  name: "ALLOW_ENV_READ";
  reason: string;
  enabled: boolean;
  matches: (parsed: ParsedCommand, cwd: string) => boolean;
};

function matchCustomRule(parsed: ParsedCommand, rule: ShellRule): boolean {
  if (!rule.command) return false;
  return parsed.segments.some((segment) => {
    if (segment.command !== rule.command) return false;
    if (rule.subcommand && segment.subcommand !== rule.subcommand) return false;
    if (rule.args_regex) {
      try {
        if (!new RegExp(rule.args_regex, "i").test(segment.argv.slice(1).join(" "))) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
}

function strictAllow(parsed: ParsedCommand, rules: StrictAllowRule[]): boolean {
  return parsed.segments.every((segment) => {
    // The dynamic_execution ask rule exempts `python -m pytest|mypy` for the balanced tiers only; strict keeps
    // asking for any python run that names a module or script.
    if (["python", "python3", "py"].includes(segment.command) && segment.argv.slice(1).some((arg) => !arg.startsWith("-"))) {
      return false;
    }
    const entry = rules.find((rule) => rule.command === segment.command);
    if (!entry) return false;
    if (!entry.subcommands || entry.subcommands.length === 0) return true;
    if (!segment.subcommand) return true;
    return entry.subcommands.includes(segment.subcommand);
  });
}

export function evaluateParsedShellCommand(
  command: string,
  cwd: string,
  parsed: ParsedCommand,
  policy: ShellPolicy,
  mode: ShellMode,
  hardDeny: HardDenyRule[],
  askRules: AskRule[],
  strictAllowRules: StrictAllowRule[],
  isSafeSegment: (segment: Segment) => boolean,
  override?: OverrideDecision,
  balancedAllow?: (parsed: ParsedCommand, cwd: string) => { rule: string; reason: string } | null,
): Decision {
  const hash = crypto.createHash("sha256").update(command.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 32);

  if (parsed.empty) {
    return { tier: "allow", rule: "empty", reason: "Nothing to execute.", mode, command_hash: hash };
  }
  // Off mode: explicit, audited, trusted-environment-only bypass (ROADMAP_APPROVAL I3).
  // `permissive` is NOT a bypass: hard-deny degrades to ask below.
  if (mode === "off") {
    return { tier: "allow", rule: "off.pass", reason: "Off mode: shell policy checks are bypassed (operator opt-in).", mode, command_hash: hash };
  }
  const overrideApplies =
    override?.enabled === true &&
    override.reason.trim().length > 0 &&
    override.matches(parsed, cwd);

  const deleteHint =
    parsed.segments.some((s) => ["rm", "rd", "rmdir", "del", "erase", "remove-item", "ri"].includes(s.command))
      ? "Use project_delete_path instead for controlled, auditable file deletion."
      : undefined;

  for (const rule of hardDeny) {
    if (rule.test(parsed, command, cwd)) {
      if (rule.id === "protected_file_access" && overrideApplies && override?.name === "ALLOW_ENV_READ") {
        continue;
      }
      // In permissive / allow_all mode, hard-deny degrades to ask: the
      // command is not run silently, but the operator can approve it.
      // Deny still takes priority over ask (this block runs before askRules).
      if (mode === "permissive") {
        return {
          tier: "ask",
          rule: `ask.deny.${rule.id}`,
          reason: `${rule.reason} (hard-denied by default; approval required in permissive mode).`,
          mode,
          command_hash: hash,
          ...(deleteHint ? { hint: deleteHint } : {}),
        };
      }
      return {
        tier: "deny",
        rule: `deny.${rule.id}`,
        reason: rule.reason,
        mode,
        command_hash: hash,
        ...(deleteHint ? { hint: deleteHint } : {}),
      };
    }
  }
  for (const rule of policy.deny) {
    if (matchCustomRule(parsed, rule)) {
      // Operator-declared deny also degrades to ask in permissive mode.
      if (mode === "permissive") {
        return {
          tier: "ask",
          rule: `ask.deny.${rule.id}`,
          reason: `${rule.reason ?? "Denied by policy file."} (approval required in permissive mode).`,
          mode,
          command_hash: hash,
          ...(deleteHint ? { hint: deleteHint } : {}),
        };
      }
      return {
        tier: "deny",
        rule: rule.id,
        reason: rule.reason ?? "Denied by policy file.",
        mode,
        command_hash: hash,
        ...(deleteHint ? { hint: deleteHint } : {}),
      };
    }
  }
  for (const rule of policy.ask) {
    if (matchCustomRule(parsed, rule)) {
      return {
        tier: "ask",
        rule: rule.id,
        reason: rule.reason ?? "Requires approval (policy file).",
        mode,
        command_hash: hash,
        ...(deleteHint ? { hint: deleteHint } : {}),
      };
    }
  }

  for (const rule of askRules) {
    if (rule.alwaysAsk && rule.test(parsed, cwd)) {
      return {
        tier: "ask",
        rule: `ask.${rule.id}`,
        reason: rule.reason,
        mode,
        command_hash: hash,
        ...(deleteHint ? { hint: deleteHint } : {}),
      };
    }
  }

  if (overrideApplies && override) {
    return {
      tier: "allow",
      rule: `override.${override.name}`,
      reason: `Operator-enabled ${override.name} override. Reason recorded in audit.`,
      mode,
      command_hash: hash,
    };
  }

  for (const rule of askRules) {
    if (!rule.alwaysAsk && mode !== "permissive" && rule.test(parsed, cwd)) {
      return {
        tier: "ask",
        rule: `ask.${rule.id}`,
        reason: rule.reason,
        mode,
        command_hash: hash,
        ...(deleteHint ? { hint: deleteHint } : {}),
      };
    }
  }
  if (mode !== "permissive") {
    const allSafe =
      !parsed.has_pipe &&
      !parsed.has_redirect &&
      !parsed.has_background &&
      parsed.segments.every((segment) => isSafeSegment(segment));
    if (allSafe) {
      return { tier: "allow", rule: "safe_command", reason: "Routine dev-workspace command.", mode, command_hash: hash };
    }
  }
  if (mode === "strict") {
    if (strictAllow(parsed, strictAllowRules)) {
      return { tier: "allow", rule: "strict.allowlist", reason: "Read-only or workspace-local command.", mode, command_hash: hash };
    }
    return {
      tier: "ask",
      rule: "strict.default_ask",
      reason: "Not on the strict allow list; approval required by VENIRA_SHELL_MODE=strict.",
      mode,
      command_hash: hash,
      ...(deleteHint ? { hint: deleteHint } : {}),
    };
  }
  if (mode === "balanced") {
    for (const rule of policy.allow) {
      if (matchCustomRule(parsed, rule)) {
        return { tier: "allow", rule: rule.id, reason: rule.reason ?? "Allowed by policy file.", mode, command_hash: hash };
      }
    }
    const balanced = balancedAllow?.(parsed, cwd);
    if (balanced) {
      return { tier: "allow", rule: balanced.rule, reason: balanced.reason, mode, command_hash: hash };
    }
  }
  // In balanced mode, default to ask (not allow) for unclassified commands
  if (mode === "balanced") {
    return { tier: "ask", rule: "balanced.default_ask", reason: "Not classified as safe or explicitly allowed; approval required in balanced mode.", mode, command_hash: hash };
  }
  return { tier: "allow", rule: "default_allow", reason: "No deny/ask rule matched.", mode, command_hash: hash };
}
