/**
 * Shell policy — redact secret + bộ đếm runtime (health).
 * Tách khỏi shell-policy.ts (re-export ở đó nên API công khai không đổi).
 */
import type { Decision } from "./shell-policy.js";

// ---------------------------------------------------------------------------
// Secret redaction (audit + error messages)
// ---------------------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  [/(--?(?:password|passwd|pass|token|secret|api[-_]?key|apikey|access[-_]?key)[=\s]+)(["']?)[^\s"']+\2/gi, "$1[REDACTED]"],
  [/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s]+@/g, "$1[REDACTED]@"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\b((?:export\s+)?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/g, "$1[REDACTED]"],
  // ENV-style secret vars in Rust / cargo log output (DATABASE_URL=..., GITHUB_TOKEN=..., ...)
  [/\b((?:export\s+)?[A-Z][A-Z0-9_]*(?:_URL|SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/g, "$1[REDACTED]"],
  // Rust/cargo logs that read secrets through env::var("GITHUB_TOKEN", ...) / env::var("DATABASE_URL", ...)
  [/\benv::var(?:_with_default|_with_current)?\(\s*["'](?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|DATABASE_URL)[A-Z0-9_]*)["']/g, "[REDACTED]"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

// ---------------------------------------------------------------------------
// Runtime counters (surfaced by health)
// ---------------------------------------------------------------------------

const stats = {
  evaluated: 0,
  allowed: 0,
  asked: 0,
  denied: 0,
  approved: 0,
  timed_out: 0,
  timeout_warn: 0,
  killed_tree: 0,
  output_capped: 0,
};

export function recordDecision(decision: Decision): void {
  stats.evaluated += 1;
  if (decision.tier === "allow") stats.allowed += 1;
  else if (decision.tier === "ask") stats.asked += 1;
  else stats.denied += 1;
}

export function recordApproval(kind: "approved" | "timed_out" | "timeout_warn" | "killed_tree" | "output_capped"): void {
  stats[kind] += 1;
}

export function shellStats(): typeof stats {
  return { ...stats };
}
