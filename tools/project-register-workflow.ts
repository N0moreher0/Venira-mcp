import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import type { Args } from "./project-cache.js";
import { setupToolsEnabled } from "../lib/env.js";
import { config, flag01, reason_ } from "./project-schema.js";

// Self-install (detect_harnesses, install_self), diagnostics + read planning (explain_error,
// plan_read_batch) and checkpoint (snapshot) tool registrations. Extracted from registerProjectTools in
// tools/project.ts (roadmap item 6, step 5n). Schemas, descriptions and registration order are unchanged;
// the handlers stay in project.ts and arrive through WorkflowToolsDeps.

type Handler = (args: Args) => Promise<ToolResult>;

export type WorkflowToolsDeps = {
  runDetectHarnesses: Handler;
  runInstallSelf: Handler;
  runExplainError: Handler;
  runPlanReadBatch: Handler;
  runSnapshot: Handler;
};

export function registerWorkflowTools(server: McpServer, deps: WorkflowToolsDeps): void {
  const { runDetectHarnesses, runInstallSelf, runExplainError, runPlanReadBatch, runSnapshot } = deps;
  // -------------------------------------------------------------------------
  // P2.5: Self-install (detect harnesses + install venira MCP config)
  // -------------------------------------------------------------------------

  // Only advertised with VENIRA_SETUP_TOOLS=1: setup-time tools, and `venira-mcp --install` covers them.
  if (setupToolsEnabled()) {
  server.registerTool(
    "project_detect_harnesses",
    {
      ...config(
        "Detect MCP harnesses",
        {
          speed_profile: "fast; filesystem checks, no writes.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {},
    },
    (args) => runDetectHarnesses(args as Args),
  );

  server.registerTool(
    "project_install_self",
    {
      ...config(
        "Self-install venira MCP",
        {
          speed_profile: "fast; one atomic write per config. Always backs up the original to <file>.venira-bak.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        harness: z.enum([
          "opencode",
          "claude_desktop",
          "cursor",
          "codex",
          "kimi",
          "deepseek",
          "antigravity",
        ]).describe("Which client's config to update (see project_detect_harnesses)."),
        workspace: z.string().optional().describe("VENIRA_WORKSPACE value to write (default: process.cwd())."),
        data_dir: z.string().optional().describe("VENIRA_DATA_DIR value to write (default: the per-user Venira data directory)."),
        dry_run: flag01.optional().describe("1 reports what would happen without writing; 0 performs the action."),
      },
    },
    (args) => runInstallSelf(args as Args),
  );
  }

  // -------------------------------------------------------------------------
  // Diagnostics + read planning (deterministic, no model call)
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_explain_error",
    {
      ...config(
        "Explain an error",
        {
          speed_profile: "pure local rules, < 1 ms; no network and no model call.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        error_text: z
          .string()
          .max(32 * 1024)
          .optional()
          .describe("The error block (stderr, exception, compiler output). One of error_text/log_tail is required."),
        log_tail: z
          .string()
          .max(32 * 1024)
          .optional()
          .describe("Tail of the failing output (e.g. project_ci_logs / project_shell_status text). One of error_text/log_tail is required."),

        language: z
          .string()
          .max(40)
          .optional()
          .describe("Optional language hint (typescript|python|rust|go|...) when the text does not show a file extension."),
      },
    },
    (args) => runExplainError(args as Args),
  );

  server.registerTool(
    "project_plan_read_batch",
    {
      ...config(
        "Plan reads from a task",
        {
          speed_profile: "1-3 bounded content searches (~20 ms each) + local ranking; no file contents are returned.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        task_description: z
          .string()
          .min(1)
          .max(2_000)
          .describe('What you are about to do, in one line, e.g. "add retry handling to the GitHub client".'),
        files_hint: z
          .array(z.string().max(300))
          .max(16)
          .optional()
          .describe("Files you already suspect (ranked first, no search needed for them)."),
        max_files: z.number().int().min(1).max(8).optional().describe("Max candidates to plan (default 6; batch accepts 8)."),
        include_search: flag01
          .optional()
          .describe("1 runs keyword searches (default); 0 plans only from files_hint/recent files."),
      },
    },
    (args) => runPlanReadBatch(args as Args),
  );

  // -------------------------------------------------------------------------
  // Checkpoints: snapshot + rollback without git
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_snapshot",
    {
      ...config(
        "Workspace checkpoint",
        {
          speed_profile:
            "create walks/hashes the captured files (skips .git/node_modules/dist, symlinks, huge files); repeats only store new blobs. restore is atomic per file, concurrency 4, SHA-256 verified by default; dry_run previews path/size only, not same-size content changes.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      ),
      // Loose on purpose: `scope` is the removed alias for `paths` (ROADMAP_TOOL_SCHEMA.md, phase 5).
      // A plain object would strip it, and a cached client that sent only `scope` would silently capture
      // the whole workspace. Loose lets the handler refuse it with `[unsupported]` instead.
      inputSchema: z.looseObject({
        action: z.enum(["create", "list", "restore", "delete", "mirror"]).default("create").describe("create (default) captures paths; list; restore rolls back an id; delete removes an id; mirror copies the store to VENIRA_SNAPSHOT_MIRROR_DIR."),
        id: z.string().optional().describe("Checkpoint id (required for restore/delete; returned by create/list)."),
        label: z
          .string()
          .max(400)
          .optional()
          .describe("Human label for the checkpoint, e.g. \"before refactor auth\"."),
        paths: z
          .array(z.string())
          .max(64)
          .optional()
          .describe("Workspace-relative paths to capture (default ['.'] = whole workspace; scope narrowly). For restore: subset to restore."),
        exclude: z.array(z.string()).max(64).optional().describe("Extra directory/file names to skip."),
        respect_default_excludes: flag01
          .optional()
          .describe("1 skips standard generated/cache directories (default); 0 disables those exclusions."),
        max_files: z.number().int().min(1).max(20000).optional().describe("Max files captured (default 20000, max 20000)."),
        max_total_bytes: z.number().int().min(1).max(512 * 1024 * 1024).optional().describe("Max total bytes captured (default and max 512 MiB)."),
        dry_run: flag01.optional().describe("restore only: 1 previews path/size changes without writing."),
        verify: flag01
          .optional()
          .describe("restore: 1 verifies each blob before writing (default). mirror: 1 re-hashes blobs already at the mirror and re-copies bad ones (default 0)."),
        delete_extra: flag01
          .optional()
          .describe("restore only: 1 also deletes files in captured dirs that are not in the checkpoint (max 500). Default 0; use only when intended."),
        limit: z.number().int().min(1).max(100).optional().describe("list only: max checkpoints to return (default 20)."),
        reason: reason_,
      }),
    },
    (args) => runSnapshot(args as Args),
  );
}
