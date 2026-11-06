/**
 * One approval core shared by every gated tool (shell, JS exec).
 *
 * Model: Gate -> Request -> Grant -> Redeem.
 *   - Gate:    the caller decides a call needs a human (policy `ask`, JS exec).
 *   - Request: `requestApproval` stores a pending record bound to the exact call.
 *   - Grant:   only a human writes it (CLI `--approve` in a TTY, or client
 *              elicitation). Nothing in this module can grant.
 *   - Redeem:  `redeemApproval` verifies the HMAC grant against the same binding,
 *              and consumes it (single use).
 *
 * Storage, HMAC and TTL checks stay in `approvals.ts`; this module only removes
 * the duplicated request/redeem/hint logic from the shell and JS call sites.
 * Gate-specific parts (what the binding covers, what the human sees) are passed
 * in by the caller.
 */
import { randomUUID } from "node:crypto";
import * as approvals from "./approvals.js";

export type ApprovalGateName = "shell" | "js";

/** How long a pending approval stays valid. */
export const APPROVAL_PENDING_TTL_MS = 5 * 60 * 1000;

export interface ApprovalSubject {
  /** Tool the agent retries after the human grants (e.g. `project_shell_run`). */
  tool: string;
  /** What the human reviews: the command, or the JS source. */
  command: string;
  shell: string;
  cwd: string;
  secretEnv: string[];
  rule: string;
  reason: string;
  /** `approvals.bindingHash(...)` of the real call this approval covers. */
  binding: string;
}

export interface ApprovalRequest {
  approval_id: string;
  created_at: number;
  expires_at: number;
  approve_command: string;
}

/** Upper bound for `approval_wait_ms`; stays under typical MCP client call timeouts. */
export const APPROVAL_WAIT_MAX_MS = 45_000;
const APPROVAL_POLL_MS = 500;

/** Clamp the agent-supplied wait to [0, APPROVAL_WAIT_MAX_MS]; junk means no wait. */
export function parseApprovalWaitMs(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), APPROVAL_WAIT_MAX_MS);
}

export function approveCommand(approvalId: string): string {
  return `npx venira-mcp --approve ${approvalId}`;
}

/** Create the pending record. The caller shapes the response around the result. */
export function requestApproval(_gate: ApprovalGateName, sessionId: string, subject: ApprovalSubject): ApprovalRequest {
  const approvalId = randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + APPROVAL_PENDING_TTL_MS;
  approvals.createPendingApproval({
    approval_id: approvalId,
    session_id: sessionId,
    command: subject.command,
    shell: subject.shell,
    cwd: subject.cwd,
    secret_env: subject.secretEnv.slice(),
    rule: subject.rule,
    reason: subject.reason,
    tool: subject.tool,
    binding: subject.binding,
    expires_at: expiresAt,
    status: "pending",
    created_at: createdAt,
  });
  return { approval_id: approvalId, created_at: createdAt, expires_at: expiresAt, approve_command: approveCommand(approvalId) };
}

/** Canonical `data.approval` shape every `[approval_required]` response carries. */
export interface ApprovalPayload {
  approval_id: string;
  gate: ApprovalGateName;
  rule: string;
  reason: string;
  /** Redacted, truncated view of what is being approved (command or JS source). */
  subject_preview: string;
  expires_at: number;
  approve_command: string;
  retry_with: { tool: string; arguments: Record<string, unknown> };
}

const SUBJECT_PREVIEW_MAX = 2000;

/**
 * Build the one payload shape agents learn. `preview` must already be redacted;
 * `retryArguments` are the original call arguments (without approval_id).
 */
export function buildApprovalPayload(
  gate: ApprovalGateName,
  request: ApprovalRequest,
  subject: Pick<ApprovalSubject, "tool" | "rule" | "reason">,
  preview: string,
  retryArguments: Record<string, unknown>,
): ApprovalPayload {
  return {
    approval_id: request.approval_id,
    gate,
    rule: subject.rule,
    reason: subject.reason,
    subject_preview: preview.slice(0, SUBJECT_PREVIEW_MAX),
    expires_at: request.expires_at,
    approve_command: request.approve_command,
    retry_with: {
      tool: subject.tool,
      arguments: { ...retryArguments, approval_id: request.approval_id },
    },
  };
}

export type RedeemResult =
  | { ok: true; scope: approvals.ApprovalScope }
  | { ok: false; reason: string; hint: string };

const MISMATCH_HINT: Record<ApprovalGateName, (tool: string) => string> = {
  shell: (tool) =>
    `This approval was granted for a different command, shell, cwd or secret_env. Call ${tool} again without approval_id to get a new approval_id for this exact command.`,
  js: (tool) =>
    `This approval was granted for different code or argv. Call ${tool} again without approval_id to get a new approval_id for this exact snippet.`,
};

/**
 * Verify the grant for `approvalId` against `binding` and consume it.
 * The scope comes from the human's grant, never from the model's arguments;
 * the caller decides whether a `session` scope feeds a session-allow.
 */
export function redeemApproval(
  gate: ApprovalGateName,
  sessionId: string,
  approvalId: string,
  binding: string,
  tool: string,
): RedeemResult {
  const verdict = approvals.verifyApprovalGrant(approvalId, sessionId, binding);
  if (!verdict.ok) {
    const reason = verdict.reason ?? "rejected";
    const hint =
      reason === "binding_mismatch" || reason === "bad_signature"
        ? MISMATCH_HINT[gate](tool)
        : `Run \`${approveCommand(approvalId)}\` in a terminal first, then retry with approval_id="${approvalId}".`;
    return { ok: false, reason, hint };
  }
  approvals.consumeApproval(approvalId);
  return { ok: true, scope: verdict.scope ?? "once" };
}

/**
 * Poll up to `waitMs` for a human to grant `approvalId`. Returns true only when
 * a verified grant for this exact binding exists; it never grants and never
 * consumes anything. The caller then redeems normally (single use). On timeout
 * or any non-"not_granted" failure (denied, expired, mismatch) it returns false
 * and the pending approval stays valid for a later retry with approval_id.
 */
export async function awaitApprovalGrant(
  sessionId: string,
  approvalId: string,
  binding: string,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), APPROVAL_WAIT_MAX_MS);
  for (;;) {
    const verdict = approvals.verifyApprovalGrant(approvalId, sessionId, binding);
    if (verdict.ok) return true;
    if (verdict.reason !== "not_granted") return false;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(APPROVAL_POLL_MS, left)));
  }
}
