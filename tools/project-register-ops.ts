import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APPROVAL_WAIT_MAX_MS } from "../lib/approval-gate.js";
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

// Ops/diagnostics tool registrations: project_create, project_health, project_cache_clear,
// project_execute_js (only when ALLOW_JS_EXEC), project_trace_status, project_read_audit,
// project_shell_cancel_session. Extracted from registerProjectTools in tools/project.ts (roadmap item 6,
// step 5l). They are contiguous in the original list, so schemas, descriptions and registration order are
// unchanged. Runners/state owned by project.ts arrive through OpsToolsDeps.

export type OpsToolsDeps = {
  runOne: (operation: string, args: Args) => Promise<ToolResult>;
  runCreate: (args: Args) => Promise<ToolResult>;
  healthDeps: HealthDeps;
  auditDbPath: () => string;
  shellDeps: ShellDeps;
};

export function registerOpsTools(server: McpServer, deps: OpsToolsDeps): void {
  const { runOne, runCreate, healthDeps, auditDbPath, shellDeps } = deps;
  server.registerTool(
    "project_create",
    {
      ...config(
        "Create a directory OR a file in ONE call. For an existing file, mode=overwrite replaces its contents: create and verify a scoped project_snapshot first.",
        "Create file or directory",
        {
          use_when: "create a directory or new file; if replacing an existing file, first create a scoped project_snapshot, confirm it captured the target, and keep its id.",
          avoid_when: "editing an existing file (project_edit_file/project_write_file); never use mode=overwrite unless a pre-write project_snapshot covers the existing contents.",
          speed_profile: "fast; triggers cache invalidation on write / new directory.",
          output_kind: "directory_created or file_written (data kind depends on the op).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        kind: z.enum(["file", "directory"]),
        content: z.string().optional(),
        mode: z.enum(["create", "overwrite", "append"]).optional().describe("overwrite replaces existing contents; create and verify a scoped project_snapshot first. create fails if the path exists; append adds to the end."),
        create_dirs: flag01.optional(),
        expected_sha256: z.string().optional(),
        reason: reason_,
      },
    },
    (args) => runCreate(args as Args),
  );

  server.registerTool(
    "project_health",
    {
      ...config(
        "Server diagnostics: corehost/data dir/audit DB, capability, queue depth, cache hit-rate, running shells, p50/p95 metrics, plus a security-limit notice (guard rail, not sandbox).",
        "Health & metrics",
        {
          use_when: "debugging slowness/errors, checking the backend/DB/audit before reporting, or inspecting this session's cache/metrics.",
          avoid_when: "you just need to read/write files normally.",
          speed_profile: "fast (~a few ms + 1 audit DB query); set include_audit=0 to skip the DB query.",
          output_kind: "health: notice, server, corehost, capability, queue, caches, shells, metrics, audit.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: { include_audit: flag01.optional() },
    },
    (args) => runHealth(args as Args, healthDeps),

  );

  server.registerTool(
    "project_cache_clear",
    {
      ...config(
        "Clear in-process read/search/list/recent/search/shell/graph caches. Use after a toolchain generates files outside normal write flow, or to force fresh reads.",
        "Clear caches",
        {
          use_when: "force-fresh reads after external tooling mutated files, or the cache stats show high hit/miss pressure.",
          avoid_when: "normal flow (cache invalidates on write/edit/delete).",
          speed_profile: "instant; clears LRU/TTL maps only (no backend call).",
          output_kind: "cache_clear: type, cleared per-cache entry counts.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        type: z.enum(["all", "shell", "read", "info", "list", "search", "recent", "negative", "graph"]).default("all").describe("Which cache to clear."),
      },
    },
    (args) => runOne("cache_clear", args as Args),
  );

  if (ALLOW_JS_EXEC) {
    server.registerTool(
      "project_execute_js",
      {
        ...config(
          "Evaluate JavaScript code. Runs `node` in the workspace, capturing stdout/stderr; supports top-level await and `require`. For hard-to-reverse workspace file changes, create and verify a scoped project_snapshot first; prefer project file tools for targeted edits. Each call needs human approval by default (`VENIRA_JS_EXEC_APPROVAL=1`): call without `approval_id` to receive one, then retry after the user grants it.",
          "Execute JS",
          {
            use_when: "you need a small JS computation or prototype. Before hard-to-reverse workspace file I/O, create and verify a scoped project_snapshot; prefer project_write_file/project_edit_file for targeted changes.",
            avoid_when: "you need a full shell pipeline (project_shell_run) or a persistent process.",
            speed_profile: "synchronous node exec with timeout (default 30s, cap 10min); output capped at 1 MiB.",
            output_kind: "execute_js: stdout_tail, stderr_tail, exit_code, timed_out, ok. Without approval_id: approval_required + approval_id.",
            batch_safe: false,
          },
          { destructiveHint: true, openWorldHint: false },
        ),
        inputSchema: {
          code: z.string().min(1).describe("JavaScript to evaluate. If it modifies/deletes existing workspace files in a hard-to-reverse way, create and verify a scoped project_snapshot first."),
          timeout_ms: z.number().int().min(1).max(600_000).optional(),
          argv: z.array(z.string()).optional(),
          approval_id: z
            .string()
            .optional()
            .describe("Approval id from a previous project_execute_js approval_required response, granted by running `data.approval.approve_command`."),
          approval_wait_ms: z
            .number()
            .int()
            .min(0)
            .max(APPROVAL_WAIT_MAX_MS)
            .optional()
            .describe("Wait up to this many ms (max 45000) for the human to grant the approval and run in the same call."),
        },
      },
      (args) => runExecuteJs(args as Args),
    );
  }

  // -------------------------------------------------------------------------
  // P1: observability + audit + shell session tools
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_trace_status",
    {
      ...config(
        "Show the most recent traced tool calls from the in-memory buffer (last N) plus the trace configuration.",
        "Trace status",
        {
          use_when: "VENIRA_TRACE=1 and you want to see what ran recently without reading the log file.",
          avoid_when: "tracing is disabled (returns an empty buffer) or you need the full on-disk log (read VENIRA_TRACE_FILE instead).",
          speed_profile: "instant; in-memory buffer only, no I/O.",
          output_kind: "trace_status: enabled, file, buffered, recent[] (newest last).",
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
    "project_read_audit",
    {
      ...config(
        "Read recent rows from the SQLite audit log (WAL). Filter by session/operation/outcome; bounded by limit.",
        "Read audit log",
        {
          use_when: "you need to inspect what operations were recorded (audit trail) — e.g. compliance or debugging a prior action.",
          avoid_when: "you only need the live cache/metric report (project_health include_audit=1) — that one is faster.",
          speed_profile: "fast; one bounded SQLite read (readonly, WAL-safe).",
          output_kind: "audit_read: rows[] (newest first), count, truncated, db_path.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        session_id: z.string().optional(),
        operation: z.string().optional(),
        outcome: z.enum(["success", "failure", "running"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        since_unix: z.number().int().min(0).optional(),
        verify: flag01.optional().describe("1 verifies the audit hash chain and returns chain_ok; 0 disables verification."),
      },
    },
    (args) => runReadAudit(args as Args, auditDbPath()),
  );

  server.registerTool(
    "project_shell_cancel_session",
    {
      ...config(
        "Cancel ALL shell runs tracked in this session (kills every process tree). Use to cleanly tear down a session.",
        "Shell cancel session",
        {
          use_when: "a session is ending or a stuck session has many running commands and they must all be stopped.",
          avoid_when: "only one run needs cancelling (project_shell_cancel by run_id). Destructive: running commands are killed.",
          speed_profile: "fast; iterates the in-process shell run table and kills each tree.",
          output_kind: "shell_cancel_session: cancelled_run_ids[], count.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {},
    },
    () => runCancelShellSession(shellDeps),
  );
}
