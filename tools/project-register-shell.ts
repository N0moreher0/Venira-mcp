import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APPROVAL_WAIT_MAX_S } from "../lib/approval-gate.js";
import type { ToolResult } from "../lib/output.js";
import { WORKSPACE } from "../lib/workspace.js";
import type { Args } from "./project-cache.js";
import { runShell, type ShellDeps } from "./project-shell.js";
import { backgroundFlag, config, flag01 } from "./project-schema.js";
import { getToolMode } from "./project-tool-mode.js";

// Shell tool registrations: shell_run, shell_status, shell_cancel.
// Extracted from registerProjectTools in tools/project.ts (roadmap item 6, step 5k). Schemas, descriptions
// and registration order are unchanged. shell_cancel_session is registered later in the list
// (after read_audit), so it moves with the ops/diagnostics group to keep the order identical.
// The shell run registry (shellRuns/trackShell) stays in project.ts and reaches runShell via ShellDeps.
//
// Mode `minimal` (ROADMAP_MINIMAL_MODE.md): `shell_cancel` is not advertised (allowlist of 2 tools),
// so its action is folded into `shell_status` as `action="cancel"` + `kill_key`. The other modes keep
// the two tools apart, so their schema and budget do not move.

export type ShellToolsDeps = {
  runOne: (operation: string, args: Args) => Promise<ToolResult>;
  shellDeps: ShellDeps;
};

export function registerShellTools(server: McpServer, deps: ShellToolsDeps): void {
  const { runOne, shellDeps } = deps;
  // Read once per registration, like the mode checks in project-register-files.ts.
  const minimal = getToolMode() === "minimal";
  server.registerTool(
    "shell_run",
    {
      ...config(
        "Shell run",
        {
          speed_profile:
            "background=true returns in ~5 ms, run time is up to the command; " +
            "background=false blocks for the whole run (bounded by timeout_s, default 10 min).",
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
            "Stored secret names (secret) injected as env vars, e.g. [\"GITHUB_TOKEN\"]. Values never appear in the command, audit log or output.",
          ),
        timeout_s: z
          .number()
          .min(0)
          .optional()
          .describe("Kill the process tree after this many seconds (0/unset = 10 min; fractional ok; capped by VENIRA_SHELL_MAX_TIMEOUT_MS)."),
        // Removed from the schema in item 16 (approval_token: "Removed", approval_scope:
        // "Ignored"). Handlers still tolerate both when an older client sends them.
        approval_id: z
          .string()
          .optional()
          .describe("Id from approval_required, granted by a human (`data.approval.approve_command` or client elicitation). Retry once."),
        approval_wait_s: z
          .number()
          .min(0)
          .max(APPROVAL_WAIT_MAX_S)
          .optional()
          .describe("If approval is needed, wait up to this many seconds (max 45; fractional ok) for the human, then run in the same call."),
        dry_run: flag01
          .optional()
          .describe("true = evaluate policy only; nothing runs, no approval is created (default false)."),
        retry_failed: flag01
          .optional()
          .describe(
            "true = rerun an identical invocation that already failed (default false: refused with repeated_failure and the previous stderr tail).",
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

  const statusConfig = config(
    "Shell status",
    {
      speed_profile: "fast; not queued so it never blocks other tools.",
      batch_safe: false,
    },
    { readOnlyHint: true, openWorldHint: false },
  );
  const statusBase = {
    run_id: z.string().describe("Run id from shell_run."),
    wait_seconds: z.number().int().min(0).max(300).optional().describe("Wait up to this many seconds for the run to finish (default 0, max 300). Observation window only, not a timeout."),
  };
  if (minimal) {
    // Mode `minimal`: `shell_cancel` is not advertised, so its action is folded in.
    // `kill_key` stays mandatory for a cancel -- it proves this caller started the
    // run (same guarantee as the standalone `shell_cancel`).
    server.registerTool(
      "shell_status",
      {
        ...statusConfig,
        inputSchema: {
          ...statusBase,
          action: z
            .enum(["status", "cancel"])
            .optional()
            .describe(
              "status (default) reads the run; cancel kills it and needs kill_key. Only in VENIRA_TOOL_MODE=minimal, where shell_cancel is not advertised.",
            ),
          kill_key: z
            .string()
            .optional()
            .describe("Kill key from shell_run; required when action=cancel. Proves this caller started the run."),
        },
      },
      (args) =>
        args.action === "cancel"
          ? // The `cancel` op refuses a missing or wrong kill_key (lib/corehost-shell.ts).
            runOne("cancel", { run_id: args.run_id, kill_key: args.kill_key })
          : runOne("shell_status", args),
    );
  } else {
    server.registerTool(
      "shell_status",
      {
        ...statusConfig,
        inputSchema: statusBase,
      },
      (args) => runOne("shell_status", args),
    );
  }

  server.registerTool(
    "shell_cancel",
    {
      ...config("Shell cancel", {
        speed_profile: "fast; kills the whole process tree so grandchildren do not keep running.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      inputSchema: { run_id: z.string().describe("Run id from shell_run."), kill_key: z.string().describe("Kill key from shell_run; proves this caller started the run.") },
    },
    (args) => runOne("cancel", args),
  );
}
