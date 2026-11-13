/**
 * Ask-rule ids whose effects cannot be statically cleared.
 *
 * Shared by `config-posture` (session-grant risk) and `project-shell`
 * (elicitation in `permissive` mode: prompt only when a command the policy
 * cannot clear is in this set; ordinary ask-rule commands still run free).
 */
export const RISKY_SESSION_RULES = new Set([
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

/** Normalise an `ask.*` / `deny.*` rule id to the bare id, lower-cased. */
export function normalizeAskRule(rule: string): string {
  return rule.trim().replace(/^(ask|deny)\./, "").toLowerCase();
}

/** True for ask-rule ids in the risky set (tolerant of the `ask.` prefix). */
export function isHighRiskAskRule(rule: string | undefined | null): boolean {
  if (!rule) return false;
  return RISKY_SESSION_RULES.has(normalizeAskRule(rule));
}
