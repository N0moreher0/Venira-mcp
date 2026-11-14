import { envFlag } from "../lib/env.js";
import { explainErrorText } from "../lib/diagnostics.js";
import { detectAllHarnesses, installSelf, type HarnessName, type InstallResult } from "../lib/self-install.js";
import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { recordMetric } from "../lib/metrics.js";
import type { Args } from "./project-cache.js";

export type WorkflowRunnerDeps = {
  runOne: (operation: string, args: Args) => Promise<ToolResult>;
};

export function createWorkflowRunners({ runOne }: WorkflowRunnerDeps) {
  async function runSnapshot(args: Args): Promise<ToolResult> {
    const started = performance.now();
    const action = typeof args.action === "string" ? args.action : "create";
    const operation =
      action === "list"
        ? "snapshot_list"
        : action === "restore"
          ? "snapshot_restore"
          : action === "delete"
            ? "snapshot_delete"
            : action === "mirror"
              ? "snapshot_mirror"
              : action === "create"
                ? "snapshot_create"
                : null;
    if (!operation) {
      const requestId = newRequestId();
      const elapsedMs = performance.now() - started;
      recordMetric("snapshot", elapsedMs, false);
      return toolResult(
        errorEnvelope(
          "snapshot",
          new Error(`[invalid_request] action must be create|list|restore|delete|mirror. Received: ${JSON.stringify(action)}.`),
          { requestId, elapsedMs },
        ),
        true,
      );
    }
    // Keep one audit row per explicit snapshot action.
    const payload: Args = {};
    for (const [key, value] of Object.entries(args)) {
      if (key !== "action" && value !== undefined) payload[key] = value;
    }
    return runOne(operation, payload);
  }

  async function runExplainError(args: Args): Promise<ToolResult> {
    const started = performance.now();
    const requestId = newRequestId();
    const errorText = typeof args.error_text === "string" ? args.error_text : "";
    const logTail = typeof args.log_tail === "string" ? args.log_tail : "";
    if (!errorText.trim() && !logTail.trim()) {
      const elapsedMs = performance.now() - started;
      return toolResult(
        errorEnvelope(
          "explain_error",
          new Error(
            "[invalid_request] Pass error_text (the error block) or log_tail (the last lines of output). " +
              "Hint: ci_logs and shell_status already return a tail.",
          ),
          { requestId, elapsedMs },
        ),
        true,
      );
    }
    const result = explainErrorText({ error_text: errorText, log_tail: logTail });
    const language =
      result.language ?? (typeof args.language === "string" && args.language.trim() ? args.language.trim() : null);
    const response: RustResponse = {
      status: "completed",
      result: { kind: "explain_error", data: { ...result, language } },
      ...(result.matched
        ? {}
        : {
            hint:
              "No known signature matched. Hint: read the failing file:line with read_file, then narrow the loop " +
              "(one test / one command) before changing code.",
          }),
    };
    const elapsedMs = performance.now() - started;
    recordMetric("explain_error", elapsedMs, true);
    return toolResult(buildEnvelope("explain_error", response, { requestId, elapsedMs, cached: false }));
  }

  async function runDetectHarnesses(_args: Args): Promise<ToolResult> {
    const started = performance.now();
    const requestId = newRequestId();
    const detections = detectAllHarnesses();
    const response: RustResponse = {
      status: "completed",
      result: {
        kind: "harness_detect",
        data: {
          detected: detections.filter((d) => d.detected).map((d) => d.harness),
          harnesses: detections,
        },
      },
      truncated: false,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("detect_harnesses", elapsedMs, true);
    return toolResult(buildEnvelope("detect_harnesses", response, { requestId, elapsedMs, cached: false }));
  }

  async function runInstallSelf(args: Args): Promise<ToolResult> {
    const started = performance.now();
    const requestId = newRequestId();
    if (!envFlag("VENIRA_ALLOW_SELF_INSTALL", false)) {
      return toolResult(
        errorEnvelope(
          "install_self",
          new Error(
            "[feature_disabled] Self-install is disabled on this host (operator flag, not a per-call approval: no approval_id will be issued). Ask the user to run it manually, or the operator to set VENIRA_ALLOW_SELF_INSTALL=1. " +
              "Hint: this writes to another client's config file outside the workspace.",
          ),
          { requestId, elapsedMs: 0 },
        ),
        true,
      );
    }
    const harness = String(args.harness ?? "") as HarnessName;
    const valid: HarnessName[] = ["opencode", "claude_desktop", "cursor", "codex", "kimi", "deepseek", "antigravity"];
    if (!valid.includes(harness)) {
      const elapsedMs = performance.now() - started;
      return toolResult(
        errorEnvelope(
          "install_self",
          new Error(`[invalid_request] harness must be one of: ${valid.join(", ")}. Got: ${harness || "(empty)"}`),
          { requestId, elapsedMs },
        ),
        true,
      );
    }
    const result: InstallResult = await installSelf({
      harness,
      workspace: typeof args.workspace === "string" ? args.workspace : undefined,
      dataDir: typeof args.data_dir === "string" ? args.data_dir : undefined,
      dryRun: args.dry_run !== false,
    });
    const response: RustResponse = {
      status: "completed",
      result: { kind: "install_self", data: result },
      truncated: false,
    };
    const elapsedMs = performance.now() - started;
    recordMetric("install_self", elapsedMs, result.status !== "error");
    return toolResult(buildEnvelope("install_self", response, { requestId, elapsedMs, cached: false }));
  }

  return { runSnapshot, runExplainError, runDetectHarnesses, runInstallSelf };
}
