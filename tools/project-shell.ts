import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { approveCommand } from "../lib/approval-gate.js";
import * as approvals from "../lib/approvals.js";
import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { SESSION_ID } from "../lib/session.js";
import { loadShellPolicy } from "../lib/shell-policy.js";
import { isHighRiskAskRule } from "../lib/shell-risk.js";

// shell_run (approval flow + optional MCP elicitation) and shell_cancel_session.
// Extracted from tools/project.ts (P1 #6, step 5g); behavior is unchanged. The cached backend
// executor and the corehost call are owned by project.ts and reach this module through ShellDeps,
// so it never imports project.ts. The shell run registry lives separately in
// project-shell-registry.ts and is shared with the health snapshot through injected state.

type Args = Record<string, unknown>;

export type ShellDeps = {
  /** Run one backend operation through project.ts `executeCached`. */
  execute: (operation: string, args: Args) => Promise<{ response: RustResponse; cached: boolean }>;
  /** Raw corehost call (project.ts `host.call`). */
  callHost: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Shell approval flow
// ---------------------------------------------------------------------------

// Elicitation is part of the shell mode (VENIRA_SHELL_ELICIT removed):
//   strict    - no prompt, the caller gets `approval_required` for the CLI grant;
//   balanced  - ask-rule commands prompt through the client's elicitation UI;
//   permissive - prompts only for ask-rule ids in the high-risk set (config-posture's RISKY_SESSION_RULES);
//   off       - bypass: no prompts, everything runs.
const SHELL_MODE = loadShellPolicy().mode;
/** True when this mode may prompt at all (balanced always; permissive for high risk). */
export const SHELL_ELICIT = SHELL_MODE === "balanced" || SHELL_MODE === "permissive";
const ELICIT_TIMEOUT_MS = 5 * 60 * 1000;

/** Pure elicitation decision, shared with the tests: balanced asks always;
 * permissive asks only the high-risk rules; strict and off never prompt. */
export function shellElicitForMode(mode: "strict" | "balanced" | "permissive" | "off", rule?: string | null): boolean {
  if (mode === "balanced") return true;
  if (mode === "permissive") return isHighRiskAskRule(rule ?? undefined);
  return false;
}

/** Whether to elicit for this specific ask (balanced: always; permissive: high risk only). */
const elicitForAsk = (data: ShellApprovalData | undefined): boolean =>
  shellElicitForMode(SHELL_MODE, typeof data?.rule === "string" ? data.rule : undefined);

type ShellApprovalData = {
  approval_id?: unknown;
  approval?: { approve_command?: unknown };
  command?: unknown;
  rule?: unknown;
  reason?: unknown;
  mode?: unknown;
  expires_at?: unknown;
};

function approvalFailure(
  operation: string,
  data: ShellApprovalData,
  requestId: string,
  elapsedMs: number,
): ToolResult {
  const approvalId = typeof data.approval_id === "string" ? data.approval_id : "";
  const reason = typeof data.reason === "string" ? data.reason : "This command requires approval.";
  const rule = typeof data.rule === "string" ? data.rule : "policy";
  const command =
    typeof data.approval?.approve_command === "string"
      ? data.approval.approve_command
      : approveCommand(approvalId);
  const hint = approvalId
    ? `Stop and tell the user: run \`${command}\` in an interactive terminal. Do not loop. After they confirm, retry shell_run once with approval_id="${approvalId}".`
    : undefined;
  return toolResult(
    errorEnvelope(operation, new Error(`[approval_required] ${reason} (rule: ${rule})`), {
      requestId,
      elapsedMs,
      data,
      hint,
    }),
    true,
  );
}

/**
 * Optional MCP elicitation (part of `VENIRA_SHELL_MODE`). Clients that do not
 * advertise the `elicitation` capability are skipped, so the caller still gets
 * the `approval_required` envelope with an `approval_id` for the CLI flow.
 */
async function elicitShellApproval(
  server: McpServer,
  data: ShellApprovalData,
): Promise<{ approved: boolean; remember: boolean }> {
  const capabilities = server.server.getClientCapabilities() as
    | { elicitation?: unknown }
    | undefined;
  if (!capabilities?.elicitation) return { approved: false, remember: false };
  try {
    const result = await server.server.elicitInput(
      {
        message: `Run this shell command?\n\n${String(data.command ?? "").slice(0, 2000)}\n\nWhy approval is needed: ${String(data.reason ?? "policy")}`,
        requestedSchema: {
          type: "object" as const,
          properties: {
            approve: {
              type: "boolean" as const,
              title: "Run the command",
              description: "Approve this exact command once.",
              default: false,
            },
            remember: {
              type: "boolean" as const,
              title: "Remember for this session",
              description: "Approve the same command group (e.g. `git push`) until the approval TTL ends.",
              default: false,
            },
          },
          required: ["approve"],
        },
      },
      { timeout: ELICIT_TIMEOUT_MS },
    );
    if (result.action !== "accept") return { approved: false, remember: false };
    const content = (result.content ?? {}) as { approve?: unknown; remember?: unknown };
    return { approved: content.approve === true, remember: content.remember === true };
  } catch (error) {
    console.error(
      `[venira-coding] elicitation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { approved: false, remember: false };
  }
}

export async function runShell(args: Args, server: McpServer, deps: ShellDeps): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  try {
    let { response, cached } = await deps.execute("shell_run", args);
    let data = response.result?.data as ShellApprovalData | undefined;

    if (response.result?.kind === "shell_approval" && elicitForAsk(data)) {
      const verdict = await elicitShellApproval(server, data ?? {});
      if (verdict.approved) {
        // The person accepted in their own client UI: record the grant on their
        // behalf, with the scope they chose (session only where it is allowed).
        const pendingId = typeof data?.approval_id === "string" ? data.approval_id : "";
        if (pendingId) {
          try {
            approvals.writeApprovalGrant(pendingId, "elicitation", verdict.remember ? "session" : "once");
          } catch {
            try {
              approvals.writeApprovalGrant(pendingId, "elicitation", "once");
            } catch (error) {
              console.error(`[venira-coding] could not record approval: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        const retry: Args = { ...args, approval_id: data?.approval_id };
        delete (retry as Record<string, unknown>).approval_token;
        delete (retry as Record<string, unknown>).approval_scope;
        ({ response } = await deps.execute("shell_run", retry));
        data = response.result?.data as ShellApprovalData | undefined;
        cached = false;
      }
    }

    const elapsedMs = performance.now() - started;
    if (response.result?.kind === "shell_approval") {
      recordMetric("shell_run", elapsedMs, false);
      return approvalFailure("shell_run", data ?? {}, requestId, elapsedMs);
    }
    recordMetric("shell_run", elapsedMs, true);
    return toolResult(buildEnvelope("shell_run", response, { requestId, elapsedMs, cached }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("shell_run", elapsedMs, false);
    return toolResult(errorEnvelope("shell_run", error, { requestId, elapsedMs }), true);
  }
}

export async function runCancelShellSession(deps: ShellDeps): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  try {
    // Reuse the session-level cancel exposed by the corehost.
    const result = (await deps.callHost(
      "project_tool.shell.cancel_session",
      { session_id: SESSION_ID },
      5_000,
    )) as { cancelled?: unknown } | undefined;
    const response: RustResponse = {
      status: "completed",
      result: {
        kind: "shell_cancel_session",
        data: {
          cancelled: result?.cancelled === true,
          session_id: SESSION_ID,
        },
      },
      truncated: false,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("shell_cancel_session", elapsedMs, true);
    return toolResult(buildEnvelope("shell_cancel_session", response, { requestId, elapsedMs, cached: false }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    recordMetric("shell_cancel_session", elapsedMs, false);
    return toolResult(errorEnvelope("shell_cancel_session", error, { requestId, elapsedMs }), true);
  }
}
