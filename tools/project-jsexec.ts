import * as approvals from "../lib/approvals.js";
import {
  awaitApprovalGrant,
  buildApprovalPayload,
  parseApprovalWaitSeconds,
  redeemApproval,
  requestApproval,
} from "../lib/approval-gate.js";
import { executeJs } from "../lib/js-executor.js";
import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { SESSION_ID } from "../lib/session.js";
import { redactSecrets } from "../lib/shell-policy.js";
import { ALLOW_JS_EXEC, JS_EXEC_APPROVAL, JS_EXEC_CONTAINED, WORKSPACE } from "../lib/workspace.js";

// execute_js handler and its per-call approval binding. Extracted verbatim
// from tools/project.ts (P1 #6, step 5b); behavior is unchanged.

type Args = Record<string, unknown>;

const JS_EXEC_RULE = "ask.js_exec";

/**
 * The whole call is the approval scope: the script plus its argv. Hashing both
 * (instead of trusting a stored copy) means a grant cannot be replayed for a
 * different snippet or different `process.argv` values.
 *
 * This exact string is also what the pending record stores as `command`, so
 * `readPendingApproval` can recompute the binding from the fields a human
 * reviewed and reject a record whose display copy was swapped. The CLI decodes
 * it back into readable code + argv (`formatPendingCommand`).
 */
function jsExecCommand(code: string, argv: string[] | undefined): string {
  return `${code}\u0000${JSON.stringify(argv ?? [])}`;
}

function jsExecBinding(code: string, argv: string[] | undefined): string {
  return approvals.bindingHash({
    command: jsExecCommand(code, argv),
    shell: "node",
    cwd: WORKSPACE,
    secret_env: [],
    rule: JS_EXEC_RULE,
  });
}

export async function runExecuteJs(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  if (!ALLOW_JS_EXEC) {
    const elapsedMs = performance.now() - started;
    return toolResult(
      errorEnvelope("execute_js", new Error("[unsupported] execute_js is disabled. Set VENIRA_JS_EXEC_MODE=ask, semi-auto or auto to enable."), { requestId, elapsedMs }),
      true,
    );
  }
  const code = typeof args.code === "string" ? args.code : "";
  const timeoutMs = typeof args.timeout_s === "number" && Number.isFinite(args.timeout_s) && args.timeout_s > 0
    ? Math.min(Math.floor(args.timeout_s * 1000), 600_000)
    : 30_000;
  const cliArgs = Array.isArray(args.argv) ? (args.argv as string[]).map(String) : undefined;

  // Per-call human approval. Enabling the tool only says the operator accepts
  // the risk in general; it does not say they have read this snippet, which can
  // still read protected files and (best-effort) reach the network.
  if (JS_EXEC_APPROVAL) {
    const binding = jsExecBinding(code, cliArgs);
    const approvalId = typeof args.approval_id === "string" ? args.approval_id.trim() : "";
    if (!approvalId) {
      const reason =
        "execute_js runs arbitrary JavaScript outside shell policy and the protected-path guard.";
      const pending = requestApproval("js", SESSION_ID, {
        tool: "execute_js",
        // The approver must see exactly what they are approving, so the code is
        // stored as written (the data dir is per-user, 0700). Redaction belongs
        // in the tool response/transcript, not in the human's review copy.
        // Must equal the hashed form, or the pending record fails its binding
        // recomputation and can never be granted.
        command: jsExecCommand(code, cliArgs),
        shell: "node",
        cwd: WORKSPACE,
        secretEnv: [],
        rule: JS_EXEC_RULE,
        reason,
        binding,
      });
      const pendingId = pending.approval_id;
      const waitMs = parseApprovalWaitSeconds(args.approval_wait_s);
      if (waitMs > 0 && (await awaitApprovalGrant(SESSION_ID, pendingId, binding, waitMs))) {
        // Granted by a human while waiting: redeem through the normal path (single use).
        return runExecuteJs({ ...args, approval_id: pendingId, approval_wait_s: 0 });
      }
      const expiresAt = pending.expires_at;
      const elapsedMs = performance.now() - started;
      return toolResult(
        errorEnvelope("execute_js", new Error(`[approval_required] ${reason} (rule: ${JS_EXEC_RULE})`), {
          requestId,
          elapsedMs,
          data: {
            approval_required: true,
            approval_id: pendingId,
            rule: JS_EXEC_RULE,
            reason,
            cwd: WORKSPACE,
            code_preview: redactSecrets(code).slice(0, 2000),
            ...(cliArgs ? { argv: cliArgs } : {}),
            approval: buildApprovalPayload(
              "js",
              pending,
              { tool: "execute_js", rule: JS_EXEC_RULE, reason },
              redactSecrets(code),
              {
                code,
                ...(cliArgs ? { argv: cliArgs } : {}),
                ...(typeof args.timeout_s === "number" ? { timeout_s: args.timeout_s } : {}),
              },
            ),
            expires_at: expiresAt,
            // The retry call lives in `approval.retry_with` (the same shape
            // every gated tool uses); a second copy here only made it
            // ambiguous which one was canonical (roadmap item 15, P1).
            note: `A human must run: ${pending.approve_command} (then retry with approval_id).`,
          },
          hint: `Ask the user to run \`${pending.approve_command}\` in an interactive terminal, then retry execute_js with approval_id="${pendingId}".`,
        }),
        true,
      );
    }
    const verdict = redeemApproval("js", SESSION_ID, approvalId, binding, "execute_js");
    if (!verdict.ok) {
      const elapsedMs = performance.now() - started;
      return toolResult(
        errorEnvelope("execute_js", new Error(`[approval_invalid] Approval ${approvalId} ${verdict.reason}. Hint: ${verdict.hint}`), {
          requestId,
          elapsedMs,
        }),
        true,
      );
    }
  }

  try {
    const r = executeJs(code, { cwd: WORKSPACE, timeout: timeoutMs, args: cliArgs, contained: JS_EXEC_CONTAINED });
    const response: RustResponse = {
      status: "completed",
      result: {
        kind: "js_execute",
        data: {
          ok: r.ok,
          // execute_js is not covered by the protected-path guard, so at least
          // keep obvious secret assignments out of the transcript.
          stdout_tail: redactSecrets(r.stdout_tail),
          stderr_tail: redactSecrets(r.stderr_tail),
          exit_code: r.exit_code,
          timed_out: r.timed_out,
          ...(r.error ? { error: redactSecrets(r.error) } : {}),
        },
      },
      truncated: false,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("execute_js", elapsedMs, r.ok);
    const envelope = buildEnvelope("execute_js", response, { requestId, elapsedMs, cached: false });
    // Roadmap item 15 (P2): a failed snippet is a failed command. Say so in
    // the hint instead of leaving the agent to compare `ok` with `data.ok`.
    if (!r.ok) {
      const reason = typeof r.error === "string" ? r.error : `the snippet exited with code ${String(r.exit_code)}`;
      envelope.hint = `The snippet did not succeed: ${reason}`;
    }
    return toolResult(envelope);
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("execute_js", elapsedMs, false);
    return toolResult(errorEnvelope("execute_js", error, { requestId, elapsedMs }), true);
  }
}
