import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APPROVAL_WAIT_MAX_S } from "../lib/approval-gate.js";
import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { recentTraces, traceSnapshot } from "../lib/tracer.js";
import { ALLOW_JS_EXEC } from "../lib/workspace.js";
import { runReadAudit } from "./project-audit.js";
import type { Args } from "./project-cache.js";
import { runHealth, type HealthDeps } from "./project-health.js";
import { runExecuteJs } from "./project-jsexec.js";
import { config, flag01, path_, reason_ } from "./project-schema.js";
import { runCancelShellSession, type ShellDeps } from "./project-shell.js";

// Ops/diagnostics tool registrations: create, health, cache_clear,
// execute_js (only when ALLOW_JS_EXEC), trace_status, read_audit,
// shell_cancel_session. Extracted from registerProjectTools in tools/project.ts (roadmap item 6,
// step 5l). They are contiguous in the original list, so schemas, descriptions and registration order are
// unchanged. Runners/state owned by project.ts arrive through OpsToolsDeps.

export type OpsToolsDeps = {
  runOne: (operation: string, args: Args) => Promise<ToolResult>;
  runCreate: (args: Args) => Promise<ToolResult>;
  healthDeps: HealthDeps;
  auditDbPath: () => string;
  shellDeps: ShellDeps;
  /** Drops the tools-layer read/list/search caches; called after a successful workspace switch. */
  clearCaches: () => void;
};

export function registerOpsTools(server: McpServer, deps: OpsToolsDeps): void {
  const { runOne, runCreate, healthDeps, auditDbPath, shellDeps, clearCaches } = deps;
  server.registerTool(
    "create",
    {
      ...config(
        "Create directory",
        {
          speed_profile: "fast; triggers cache invalidation for the new directory.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ),
      // Loose on purpose: `kind=file`, `content`, `mode` and `expected_sha256` are the removed file-writing
      // arguments (ROADMAP_TOOL_SCHEMA.md, phase 5). A plain object would strip them, so a cached client that
      // sent `kind=file` would silently get an empty directory; loose lets the handler refuse it with
      // `[unsupported]` and point at write_file.
      inputSchema: z.looseObject({
        relative_path: path_,
        create_dirs: flag01
          .optional()
          .describe("1 creates missing parent directories (default 1); 0 fails when a parent is missing."),
        reason: reason_,
      }),
    },
    (args) => runCreate(args as Args),
  );

  server.registerTool(
    "health",
    {
      ...config(
        "Health & metrics",
        {
          speed_profile: "fast (~a few ms + 1 audit DB query); set include_audit=0 to skip the DB query.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        include_audit: flag01.optional().describe("1 includes the audit-log summary in the result (default 1); 0 skips the audit DB query."),
        sections: z
          .array(z.string())
          .max(24)
          .optional()
          .describe(
            "Report sections to return: notice, server, corehost, capability, queue, caches, shells, approvals, warnings, posture, snapshots, secrets, network, metrics, cache, trace, shell, environment, audit. caches/shells are live state; cache/shell are configuration. " +
              "Omit for everything; use it when the full payload does not fit the response.",
          ),
      },
    },
    (args) => runHealth(args as Args, healthDeps),

  );

  server.registerTool(
    "cache_clear",
    {
      ...config(
        "Clear caches",
        {
          speed_profile: "instant; clears LRU/TTL maps only (no backend call).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        type: z.enum(["all", "shell", "read", "info", "list", "search", "recent", "negative", "graph"]).default("all").describe("Cache to clear (default all). negative = cached not_found paths; graph = import graph."),
      },
    },
    (args) => runOne("cache_clear", args as Args),
  );

  if (ALLOW_JS_EXEC) {
    server.registerTool(
      "execute_js",
      {
        ...config(
          "Execute JS",
          {
            speed_profile: "synchronous node exec with timeout (default 30s, cap 10min); output capped at 1 MiB.",
            batch_safe: false,
          },
          { destructiveHint: true, openWorldHint: false },
        ),
        inputSchema: {
          code: z.string().min(1).describe("JavaScript to evaluate."),
          timeout_s: z.number().min(1).max(600).optional().describe("Kill the node process after this many seconds (default 30, max 600; fractional ok)."),
          argv: z.array(z.string()).optional().describe("Extra string arguments exposed to the script as process.argv values; part of what the human approves."),
          approval_id: z
            .string()
            .optional()
            .describe("Approval id from a previous execute_js approval_required response, granted by running `data.approval.approve_command`."),
          approval_wait_s: z
            .number()
            .min(0)
            .max(APPROVAL_WAIT_MAX_S)
            .optional()
            .describe("Wait up to this many seconds (max 45; fractional ok) for the human to grant the approval and run in the same call."),
        },
      },
      (args) => runExecuteJs(args as Args),
    );
  }

  // -------------------------------------------------------------------------
  // P1: observability + audit + shell session tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "trace_status",
    {
      ...config(
        "Trace status",
        {
          speed_profile: "instant; in-memory buffer only, no I/O.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("How many recent traces to return (default 20, max 100)."),
      },
    },
    (args) => {
      const started = performance.now();
      const requestId = newRequestId();
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const recent = recentTraces(limit);
      const response: RustResponse = {
        status: "completed",
        result: {
          kind: "trace_status",
          data: {
            ...traceSnapshot(),
            recent,
          },
        },
        truncated: false,
      };
      const elapsedMs = performance.now() - started;
      recordMetric("trace_status", elapsedMs, true);
      return toolResult(buildEnvelope("trace_status", response, { requestId, elapsedMs, cached: false }));
    },
  );

  server.registerTool(
    "read_audit",
    {
      ...config(
        "Read audit log",
        {
          speed_profile: "fast; one bounded SQLite read (readonly, WAL-safe).",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        session_id: z.string().optional().describe("Only rows from this session."),
        operation: z.string().optional().describe("Only rows for this operation (e.g. edit_file, shell_run)."),
        outcome: z.enum(["succeeded", "failed", "running", "success", "failure"]).optional().describe("Only rows with this outcome."),
        request_id: z.string().optional().describe("One job by request_id: its args and result."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows, newest first (default 50; 15 in VENIRA_OUTPUT_MODE=compact; max 200)."),
        since_unix: z.number().int().min(0).optional().describe("Only rows at or after this Unix timestamp (seconds)."),
        verify: flag01.optional().describe("1 verifies the audit hash chain and returns chain_ok; 0 disables verification."),
      },
    },
    (args) => runReadAudit(args as Args, auditDbPath()),
  );

  server.registerTool(
    "switch_workspace",
    {
      ...config(
        "Switch workspace",
        {
          speed_profile: "instant; runtime re-root of every path the tools resolve.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        root: z
          .string()
          .min(1)
          .describe(
            "Absolute path of the directory to make the workspace. Enabled by default; when VENIRA_WORKSPACE_ROOTS is set the target must be inside it, otherwise any existing directory may be chosen; VENIRA_DYNAMIC_WORKSPACE=0 opts out.",
          ),
        reason: reason_,
      },
    },
    async (args) => {
      const result = await runOne("workspace_switch", args as Args);
      if (!result.isError) clearCaches();
      return result;
    },
  );

  server.registerTool(
    "shell_cancel_session",
    {
      ...config(
        "Shell cancel session",
        {
          speed_profile: "fast; iterates the in-process shell run table and kills each tree.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {},
    },
    () => runCancelShellSession(shellDeps),
  );
}
