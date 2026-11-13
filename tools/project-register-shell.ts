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
        "Shell run",
        {
          speed_profile:
            "background=1 returns in ~5 ms, run time is up to the command; " +
            "background=0 blocks for the whole run (bounded by timeout_ms, default 10 min).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        shell: z.enum(["powershell", "pwsh", "cmd", "bash"]).optional().describe("Default: VENIRA_DEFAULT_SHELL, else the host default. pwsh = PowerShell 7+, powershell = 5.1."),
        command: z.string().describe("Command line to run."),
        relative_cwd: z.string().optional().describe("Working directory inside the workspace (default: workspace root)."),
        background: backgroundFlag.optional(),
        secret_env: z
          .array(z.string())
          .max(16)
          .optional()
          .describe(
            "Stored secret names (project_secret) injected as env vars, e.g. [\"GITHUB_TOKEN\"]. Values never appear in the command, audit log or output.",
          ),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Kill the process tree after this many ms (0/unset = 10 min; capped by VENIRA_SHELL_MAX_TIMEOUT_MS)."),
        // Removed from the schema in item 16 (approval_token: "Removed", approval_scope:
        // "Ignored"). Handlers still tolerate both when an older client sends them.
        approval_id: z
          .string()
          .optional()
          .describe("Id from approval_required, granted by a human (`data.approval.approve_command` or client elicitation). Retry once."),
        approval_wait_ms: z
          .number()
          .int()
          .min(0)
          .max(APPROVAL_WAIT_MAX_MS)
          .optional()
          .describe("If approval is needed, wait up to this many ms (max 45000) for the human, then run in the same call."),
        dry_run: z
          .number()
          .int()
          .min(0)
          .max(1)
          .optional()
          .describe("1 = evaluate policy only; nothing runs, no approval is created (default 0)."),
        retry_failed: z
          .number()
          .int()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "1 = rerun an identical invocation that already failed (default 0: refused with repeated_failure and the previous stderr tail).",
          ),
        override: z
          .enum(["ALLOW_ENV_READ"])
          .optional()
          .describe("Named exception; only works when the operator enabled this exact name in VENIRA_SHELL_OVERRIDES."),
        reason: z
          .string()
          .min(1)
          .max(400)
          .optional()
          .describe("Required with override: one-line intent (audit-logged)."),
        // (approval_scope removed with approval_token; see above.)
      },
    },
    (args) => runShell(args, server, shellDeps),
  );

  server.registerTool(
    "project_shell_status",
    {
      ...config(
        "Shell status",
        {
          speed_profile: "fast; not queued so it never blocks other tools.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        run_id: z.string().describe("Run id from project_shell_run."),
        wait_seconds: z.number().int().min(0).max(30).optional().describe("Wait up to this many seconds for the run to finish (default 0, max 30). Observation window only, not a timeout."),
      },
    },
    (args) => runOne("shell_status", args),
  );

  server.registerTool(
    "project_shell_cancel",
    {
      ...config("Shell cancel", {
        speed_profile: "fast; kills the whole process tree so grandchildren do not keep running.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      inputSchema: { run_id: z.string().describe("Run id from project_shell_run."), kill_key: z.string().describe("Kill key from project_shell_run; proves this caller started the run.") },
    },
    (args) => runOne("cancel", args),
  );
}
