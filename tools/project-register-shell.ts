import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APPROVAL_WAIT_MAX_MS } from "../lib/approval-gate.js";
import type { ToolResult } from "../lib/output.js";
import { WORKSPACE } from "../lib/workspace.js";
import type { Args } from "./project-cache.js";
import { runShell, type ShellDeps } from "./project-shell.js";
import { backgroundFlag, config } from "./project-schema.js";

// Shell tool registrations: project_shell_run, project_shell_status, project_shell_cancel.
// Extracted from registerProjectTools in tools/project.ts (roadmap item 6, step 5k). Schemas, descriptions
// and registration order are unchanged. project_shell_cancel_session is registered later in the list
// (after project_read_audit), so it moves with the ops/diagnostics group to keep the order identical.
// The shell run registry (shellRuns/trackShell) stays in project.ts and reaches runShell via ShellDeps.

export type ShellToolsDeps = {
  runOne: (operation: string, args: Args) => Promise<ToolResult>;
  shellDeps: ShellDeps;
};

export function registerShellTools(server: McpServer, deps: ShellToolsDeps): void {
  const { runOne, shellDeps } = deps;
  server.registerTool(
    "project_shell_run",
    {
      ...config(
        `Run a shell command (cwd defaults to ${WORKSPACE}). ` +
          "Asynchronous by default: returns run_id immediately, so poll project_shell_status for the output. " +
          "Pass background=0 (or false) for a foreground run: the call blocks until the command exits and returns the final stdout/stderr. " +
          "For commands that overwrite/delete existing workspace source files, create and verify a scoped project_snapshot first; prefer project file tools for targeted edits. " +
          "Commands pass a policy gate: risky ones return an approval_required error with a pending approval_id; " +
          "catastrophic ones are denied outright. Named overrides require operator allowlisting and a per-call reason.",
        "Shell run",
        {
          use_when:
            "build/test/lint/long-running commands. For hard-to-reverse workspace file changes, checkpoint first. Default (background=1) returns run_id immediately so it never blocks other tools; " +
            "set background=0 when you need the final output in this call — it blocks until the command exits, and you must not start other work while waiting. " +
            "After approval_required, ask the user to approve the approval_id in an interactive terminal, then retry.",
          avoid_when: "a command that may never finish: use the async default plus project_shell_status/project_shell_cancel.",
          speed_profile:
            "background=1 returns in ~5 ms, run time is up to the command; " +
            "background=0 blocks for the whole run (bounded by timeout_ms, default 10 min).",
          output_kind:
            "shell_run: run_id/shell_id, running, exit_code, background/foreground, stdout_tail/stderr_tail, timed_out, policy; " +
            "background=0 also returns bounded stdout/stderr. " +
            "approval_required: rule, reason, approval_id, retry_with.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        shell: z.enum(["powershell", "pwsh", "cmd", "bash"]).optional(),
        command: z.string().describe("Command line to run. Use the file tools for file changes; project_snapshot first if it overwrites or deletes files git does not hold."),
        relative_cwd: z.string().optional().describe("Working directory inside the workspace (default: workspace root)."),
        background: backgroundFlag.optional(),
        secret_env: z
          .array(z.string())
          .max(16)
          .optional()
          .describe(
            "Names of stored secrets (project_secret) to inject as environment variables for this command, " +
              "e.g. [\"GITHUB_TOKEN\"]. The value never appears in the command, the audit log or the output.",
          ),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Kill the whole process tree after this many milliseconds. Unset or 0 uses the default 10-minute timeout; capped by VENIRA_SHELL_MAX_TIMEOUT_MS."),
        approval_token: z
          .string()
          .optional()
          .describe("Removed; use approval_id."),
        approval_id: z
          .string()
          .optional()
          .describe("Approval ID from the approval_required envelope, granted by a human running `data.approval.approve_command` or using client elicitation. Retry once after they confirm."),
        approval_wait_ms: z
          .number()
          .int()
          .min(0)
          .max(APPROVAL_WAIT_MAX_MS)
          .optional()
          .describe("If the command needs approval, wait up to this many ms (max 45000) for the human to grant it and run in the same call. On timeout you get the normal approval_required response."),
        dry_run: z
          .number()
          .int()
          .min(0)
          .max(1)
          .optional()
          .describe("1 = evaluate policy only: returns tier, rule and whether approval would be needed. Nothing runs and no approval is created."),
        override: z
          .enum(["ALLOW_GIT_PUSH", "ALLOW_ENV_READ"])
          .optional()
          .describe("Named exception; only works when the operator enabled this exact name in VENIRA_SHELL_OVERRIDES."),
        reason: z
          .string()
          .min(1)
          .max(400)
          .optional()
          .describe("Required with override: one-line intent (audit-logged)."),
        approval_scope: z
          .enum(["once", "session"])
          .optional()
          .describe("Ignored; the human picks the approval scope."),
      },
    },
    (args) => runShell(args, server, shellDeps),
  );

  server.registerTool(
    "project_shell_status",
    {
      ...config(
        "Check status + output of a running command. wait_seconds (0..30) is an observation window, not a timeout.",
        "Shell status",
        {
          use_when: "after project_shell_run; poll until running=false.",
          avoid_when: "no run_id available yet.",
          speed_profile: "fast; not queued so it never blocks other tools.",
          output_kind: "shell_run: running, exit_code, stdout_tail/stderr_tail.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        run_id: z.string(),
        wait_seconds: z.number().int().min(0).max(30).optional(),
      },
    },
    (args) => runOne("shell_status", args),
  );

  server.registerTool(
    "project_shell_cancel",
    {
      ...config("Cancel a running shell command by run_id.", "Shell cancel", {
        use_when: "the command is running too long or its result is no longer needed.",
        avoid_when: "the command already finished (check with project_shell_status).",
        speed_profile: "fast; kills the whole process tree so grandchildren do not keep running.",
        output_kind: "cancellation: accepted, cleanup_complete.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      inputSchema: { run_id: z.string(), kill_key: z.string() },
    },
    (args) => runOne("cancel", args),
  );
}
