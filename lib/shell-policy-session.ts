/**
 * Shell policy — session grants (chỉ nhận grant đã xác thực từ người dùng).
 * Tách khỏi shell-policy.ts (re-export ở đó nên API công khai không đổi).
 */
import type { Decision } from "./shell-policy.js";

// ---------------------------------------------------------------------------
// Session grants (fed only by verified human grants: CLI or elicitation)
// ---------------------------------------------------------------------------

const TTL_MS = (() => {
  const value = Number(process.env.VENIRA_SHELL_APPROVAL_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
})();

const sessionGrants = new Map<string, number>();

function prune(map: Map<string, number>): void {
  const now = Date.now();
  for (const [key, expires] of map) {
    if (expires <= now) map.delete(key);
  }
}

export function grantSessionApproval(sessionId: string, decision: Decision, key: string, ttlMs = TTL_MS): number {
  const expiresAt = Date.now() + ttlMs;
  sessionGrants.set(`${sessionId}|${decision.rule}|${key}`, expiresAt);
  prune(sessionGrants);
  return expiresAt;
}

export function hasSessionApproval(sessionId: string, decision: Decision, key: string): boolean {
  const expires = sessionGrants.get(`${sessionId}|${decision.rule}|${key}`);
  if (!expires) return false;
  if (expires <= Date.now()) {
    sessionGrants.delete(`${sessionId}|${decision.rule}|${key}`);
    return false;
  }
  return true;
}

/** Test hook. */
export function clearApprovals(): void {
  sessionGrants.clear();
}
