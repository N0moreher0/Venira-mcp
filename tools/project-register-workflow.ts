import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import type { Args } from "./project-cache.js";
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

  server.registerTool(
    "project_detect_harnesses",
    {
      ...config(
        "Detect which MCP-client harnesses (OpenCode/Claude/Cursor/Codex/Kimi/DeepSeek/Antigravity) have a config on this machine.",
        "Detect MCP harnesses",
        {
          use_when: "before installing venira, to know which client configs exist and can be updated.",
          avoid_when: "you already know the config path (skip straight to project_install_self).",
          speed_profile: "fast; filesystem checks, no writes.",
          output_kind: "harness_detect: detected[] (found harnesses), harnesses[] {harness, detected, config_path, format, note}.",
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
        "Add the venira MCP entry to a target client's config (OpenCode/Claude/Cursor/Codex/Kimi/DeepSeek/Antigravity). Atomic + backup.",
        "Self-install venira MCP",
        {
          use_when: "a user asks to 'install venira into <client>' — add the MCP server block to that client's config file.",
          avoid_when: "the config path is unknown (run project_detect_harnesses first), or the user wants a dry-run (set dry_run=1).",
          speed_profile: "fast; one atomic write per config. Always backs up the original to <file>.venira-bak.",
          output_kind: "install_self: {harness, config_path, status (installed|already_present|config_missing|error), needs_restart, error?}.",
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
        ]),
        workspace: z.string().optional().describe("VENIRA_WORKSPACE value to write (default: process.cwd())."),
        data_dir: z.string().optional().describe("VENIRA_DATA_DIR value to write (default: the per-user Venira data directory)."),
        dry_run: flag01.optional().describe("1 reports what would happen without writing; 0 performs the action."),
      },
    },
    (args) => runInstallSelf(args as Args),
  );

  // -------------------------------------------------------------------------
  // Diagnostics + read planning (deterministic, no model call)
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_explain_error",
    {
      ...config(
        "Diagnose a failure from its error text / log tail: known signatures (errno, TypeScript, Python, git, npm, GitHub, venira codes) → likely cause + ready-to-send next tool calls. Rule-based, offline, instant.",
        "Explain an error",
        {
          use_when:
            "a command, test, build or provider call failed and you want the fastest route to the fix (feed it the stderr tail or the CI log tail).",
          avoid_when:
            "you already know the cause and only need the file contents (use project_read_file, which also accepts ranges).",
          speed_profile: "pure local rules, < 1 ms; no network and no model call.",
          output_kind:
            "explain_error: matched, summary, error_line, language, diagnoses[] {rule_id, title, likely_cause, suggested_fix[], retry_hint?, next_actions[]}, next_actions[].",
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
          .describe("Tail of the failing output (e.g. project_ci_logs / project_shell_status text)."),
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
        "Plan a read: extract keywords from the task, run bounded content + file-name searches (+recent files), rank candidate source files by hits, path/name match and prose weight (build output, DB/log artifacts excluded), and return a ready project_read_batch call with a calibrated estimate. Deterministic planner, no model call.",
        "Plan reads from a task",
        {
          use_when:
            "starting a task in an unfamiliar area and you do not know which files matter yet (one call instead of guess-read-repeat).",
          avoid_when:
            "you already know the exact files (call project_read_batch directly), or the task is a one-line lookup (project_search).",
          speed_profile: "1-3 bounded content searches (~20 ms each) + local ranking; no file contents are returned.",
          output_kind:
            "plan_read_batch: task, keywords[], searched, candidates[] {relative_path, reason, hits}, steps[] {tool, arguments, why}, estimated_ms, notes.",
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
        "Checkpoint/rollback for the workspace: create a labeled, scoped snapshot before multi-file or hard-to-reverse edits; keep its returned id. For rollback, preview with restore dry_run=1 (size-based preview only; it cannot detect same-size content changes), inspect newer user edits, then restore that exact id with verify=1 and delete_extra=0. Content-addressed and deduplicated.",
        "Workspace checkpoint",
        {
          use_when:
            "before multi-file, cross-file, refactor/rename or hard-to-reverse edits: create with a descriptive label, scope paths to the affected area, retain the exact returned id, and confirm required files were captured. For rollback, run restore dry_run=1 to preview path/size changes (same-size content differences are not detected); inspect files with newer user edits, then restore the exact id with verify=1 and delete_extra=0. Example: checkpoint → edit 3 files → tests fail → inspect scope → restore.",
          avoid_when: "a tiny, easily recreated single-file edit, generated build output, or a commit already provides the needed recovery point; do not restore over newer user changes without inspecting them.",
          speed_profile:
            "create walks/hashes the captured files (skips .git/node_modules/dist, symlinks, huge files); repeats only store new blobs. restore is atomic per file, concurrency 4, SHA-256 verified by default; dry_run previews path/size only, not same-size content changes.",
          output_kind:
            "snapshot_create: id, label, file_count, total_bytes, new_blob_bytes, skipped[], truncated; " +
            "snapshot_list: checkpoints[]; snapshot_restore: restored_count/restored[], deleted_count, skipped[]; snapshot_delete: deleted, bytes_freed; " +
            "snapshot_mirror: status, copied_blobs, copied_indexes, bytes, failed[] (needs VENIRA_SNAPSHOT_MIRROR_DIR); snapshot_create adds mirror{} when configured.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        action: z.enum(["create", "list", "restore", "delete", "mirror"]).default("create"),
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
          .describe("Capture affected paths (default ['.'] only when scope is unclear); restore accepts a subset to filter files."),
        scope: z
          .array(z.string())
          .max(64)
          .optional()
          .describe("Deprecated alias for paths; supplied scope is honored and missing paths return not_found."),
        exclude: z.array(z.string()).max(64).optional().describe("Extra directory/file names to skip."),
        respect_default_excludes: flag01
          .optional()
          .describe("1 skips standard generated/cache directories (default); 0 disables those exclusions."),
        max_files: z.number().int().min(1).max(20000).optional(),
        max_total_bytes: z.number().int().min(1).max(512 * 1024 * 1024).optional(),
        dry_run: flag01.optional().describe("restore only: 1 previews path/size changes without writing (same-size content changes are not detected); inspect current user edits before applying."),
        verify: flag01
          .optional()
          .describe("restore: 1 verifies each blob before writing (default); 0 disables verification. mirror: 1 re-hashes every blob already at the mirror and re-copies bad ones (default 0 trusts existing files)."),
        delete_extra: flag01
          .optional()
          .describe("restore only: 1 also deletes files inside captured dirs not in the checkpoint (capped at 500); default/0 keeps them. Use 1 only when deletion is explicitly intended."),
        limit: z.number().int().min(1).max(100).optional().describe("list only: max checkpoints to return (default 20)."),
        reason: reason_,
      },
    },
    (args) => runSnapshot(args as Args),
  );
}
