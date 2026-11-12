import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import type { Args } from "./project-cache.js";
import { config, flag01, reason_ } from "./project-schema.js";

// Git provider (PR / CI), GitHub device-flow connect and secret store tool registrations.
// Extracted from registerProjectTools in tools/project.ts (roadmap item 6, step 5i). Schemas, descriptions
// and registration order are unchanged; the runners stay in project.ts and arrive through VcsDeps.

export type VcsDeps = {
  runOne: (operation: string, args: Args) => Promise<ToolResult>;
  runSecret: (args: Args) => Promise<ToolResult>;
};

export function registerVcsTools(server: McpServer, deps: VcsDeps): void {
  const { runOne, runSecret } = deps;
  // -------------------------------------------------------------------------
  // Git provider: pull requests / CI. Dialect + endpoint + token are resolved
  // per call (see lib/git-config.ts), so the same tools drive GitHub, GitLab
  // and Bitbucket.
  // -------------------------------------------------------------------------

  const repoArg = z
    .string()
    .max(200)
    .optional()
    .describe('"owner/name" or PR URL. Default: configured repo or git origin.');

  const providerArg = z
    .enum(["github", "gitlab", "bitbucket"])
    .optional()
    .describe("Default: configured, else from git origin.");

  server.registerTool(
    "project_pr_create",
    {
      ...config(
        "Create pull request",
        {
          speed_profile: "one provider API call (~1 network round trip, 2 if the default branch is not cached).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        title: z.string().min(1).max(256).describe("PR title (imperative, one line)."),
        head: z.string().max(200).optional().describe("Source branch (default: the current branch)."),
        base: z.string().max(200).optional().describe("Target branch (default: the repository default branch)."),
        body: z.string().max(65_536).optional().describe("PR description (markdown); usually a summary + test plan."),
        draft: flag01.optional().describe("1 opens as a draft PR; 0 opens as ready for review."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_create", args as Args),
  );

  server.registerTool(
    "project_pr_comment",
    {
      ...config(
        "Comment on PR",
        {
          speed_profile: "one provider API call (issue-comments, or review-comments for inline notes).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        pr: z.union([z.number().int().positive(), z.string().max(300)]).describe("PR number or PR URL."),
        body: z.string().min(1).max(65_536).describe("Comment body (markdown)."),
        path: z
          .string()
          .max(300)
          .optional()
          .describe("Workspace/repo file path for an inline review comment (requires `line`); omit for a general comment."),
        line: z.number().int().positive().optional().describe("Line number to anchor the inline note (new side by default)."),
        start_line: z.number().int().positive().optional().describe("First line of a multi-line inline note (must be <= line; GitHub/GitLab)."),
        side: z.enum(["RIGHT", "LEFT"]).optional().describe("RIGHT = new code (default), LEFT = deleted code."),
        commit_id: z.string().max(64).optional().describe("Commit sha the note is anchored to (default: the PR head)."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_comment", args as Args),
  );

  server.registerTool(
    "project_pr_merge",
    {
      ...config(
        "Merge pull request",
        {
          speed_profile: "2-3 API calls (state check, merge, optional branch delete).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        pr: z.union([z.number().int().positive(), z.string().max(300)]).describe("PR number or PR URL."),
        method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge strategy (default: merge)."),
        commit_title: z.string().max(256).optional().describe("Title for the merge commit (squash/merge)."),
        commit_message: z.string().max(65_536).optional().describe("Merge commit body (title goes in commit_title)."),
        delete_branch: flag01.optional().describe("1 deletes the head branch after a successful merge (same-repo only); 0 keeps it."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_merge", args as Args),
  );

  server.registerTool(
    "project_pr_list",
    {
      ...config(
        "List pull requests",
        {
          speed_profile: "one API call; read-only and batch-safe.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        state: z.enum(["open", "closed", "all"]).optional().describe("Filter by state (default: open)."),
        head: z.string().max(200).optional().describe("Filter by source/head branch."),
        base: z.string().max(200).optional().describe("Filter by target/base branch."),
        limit: z.number().int().min(1).max(100).optional().describe("Max PRs to return (default 20, cap 100)."),
        repo: repoArg,
        provider: providerArg,
      },
    },
    (args) => runOne("pr_list", args as Args),
  );

  server.registerTool(
    "project_pr_close",
    {
      ...config(
        "Close pull request",
        {
          speed_profile: "one API call; idempotent (closing a closed PR is a no-op).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        pr: z.union([z.number().int().positive(), z.string().max(300)]).describe("PR number or PR URL."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_close", args as Args),
  );

  server.registerTool(
    "project_pr_reopen",
    {
      ...config(
        "Reopen pull request",
        {
          speed_profile: "one API call; idempotent.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        pr: z.union([z.number().int().positive(), z.string().max(300)]).describe("PR number or PR URL."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("pr_reopen", args as Args),
  );

  // -------------------------------------------------------------------------
  // CI provider: GitHub Actions status / control / trigger / logs
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_ci_status",
    {
      ...config(
        "CI status",
        {
          speed_profile: "1-2 API calls; newest runs first. pr= adds one call to resolve the head sha.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        run_id: z
          .union([z.number().int().positive(), z.string().max(80)])
          .optional()
          .describe("Inspect one run: GitHub/GitLab numeric id, or a Bitbucket pipeline UUID. Ignored when ref or pr is given."),
        ref: z
          .string()
          .max(200)
          .optional()
          .describe("Commit sha or branch: read check-runs (GitHub) or the newest pipeline for that ref. Wins over pr and run_id."),
        pr: z
          .union([z.number().int().positive(), z.string().max(300)])
          .optional()
          .describe("PR number or PR URL: read check-runs for the PR head commit. Ignored when ref is given; wins over run_id."),
        branch: z.string().max(200).optional().describe("Filter runs by branch. Used only when no ref/pr/run_id is given."),
        workflow: z.string().max(200).optional().describe("Workflow file name (ci.yml) or numeric id. Narrows the runs list with branch."),
        limit: z.number().int().min(1).max(50).optional().describe("Max runs (or check-runs) to list (default 10 / 20)."),
        repo: repoArg,
        provider: providerArg,
      },
    },
    (args) => runOne("ci_status", args as Args),
  );

  server.registerTool(
    "project_ci_control",
    {
      ...config(
        "Control CI run",
        {
          speed_profile: "one provider API call; POST is never automatically retried.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        action: z.enum(["cancel", "retry_failed"]).describe("Cancel the selected run, or retry only failed/canceled jobs if supported."),
        run_id: z
          .union([z.number().int().positive(), z.string().trim().min(1).max(80)])
          .describe("Exact provider run ID from project_ci_status; Bitbucket uses a pipeline UUID."),
        repo: repoArg,
        provider: providerArg,
        reason: z.string().trim().min(1).max(400).describe("Why this CI action is needed; recorded in the audit trail, secrets redacted."),
      },
    },
    (args) => runOne("ci_control", args as Args),
  );

  server.registerTool(
    "project_ci_trigger",
    {
      ...config(
        "Trigger CI workflow",
        {
          speed_profile: "one API call; the new run appears in project_ci_status within ~10s.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        workflow: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("GitHub: workflow file name (ci.yml) or id (required). GitLab: optional label. Bitbucket: custom pipeline pattern (default: default)."),
        ref: z.string().max(200).optional().describe("Branch/tag to run on (default: current branch, else default branch)."),
        inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Workflow inputs/variables to pass (GitHub workflow_dispatch / GitLab variables)."),
        repo: repoArg,
        provider: providerArg,
        reason: reason_,
      },
    },
    (args) => runOne("ci_trigger", args as Args),
  );

  server.registerTool(
    "project_ci_logs",
    {
      ...config(
        "CI logs",
        {
          speed_profile: "1 download; run archives are parsed in memory with per-entry caps.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        run_id: z
          .union([z.number().int().positive(), z.string().max(80)])
          .optional()
          .describe("Whole run: GitHub/GitLab id, or a Bitbucket pipeline UUID. At least one of run_id/job_id is required; when both are given, job_id wins."),
        job_id: z
          .union([z.number().int().positive(), z.string().max(161)])
          .optional()
          .describe('Single job: GitHub/GitLab job id, or a Bitbucket step UUID (or "pipelineUuid:stepUuid"). At least one of run_id/job_id is required; job_id wins.'),
        tail_lines: z.number().int().min(1).max(5000).optional().describe("Keep only the last N lines (default 500)."),
        max_bytes: z.number().int().min(1).max(4 * 1024 * 1024).optional().describe("Max text bytes returned (default 512KB, cap 4MB)."),
        repo: repoArg,
        provider: providerArg,
      },
    },
    (args) => runOne("ci_logs", args as Args),
  );

  server.registerTool(
    "project_ci_wait",
    {
      ...config(
        "Wait for CI",
        {
          speed_profile:
            "blocks up to timeout_ms (default 45 s, max 110 s) with 2–15 s backoff polling; unqueued, so other tools keep working.",
          batch_safe: false,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        run_id: z
          .union([z.number().int().positive(), z.string().max(80)])
          .optional()
          .describe("Wait on one run: GitHub/GitLab numeric id, or a Bitbucket pipeline UUID. Wins over ref, pr and branch."),
        ref: z.string().max(200).optional().describe("Commit sha or branch: wait on check-runs (GitHub) or the newest pipeline. Wins over pr and branch; loses to run_id."),
        pr: z.union([z.number().int().positive(), z.string().max(300)]).optional().describe("PR number or URL: wait on its head-sha check-runs. Wins over branch; loses to run_id and ref."),
        branch: z.string().max(200).optional().describe("Wait on the newest run/pipeline for this branch (optionally narrow with workflow). Used only when no run_id/ref/pr is given."),
        workflow: z.string().max(200).optional().describe("Workflow file name (ci.yml) or numeric id; narrows a branch selector."),
        until: z.enum(["terminal", "any_change"]).optional().describe("Stop at a terminal state (default) or on the first state change."),
        timeout_ms: z.number().int().min(1000).max(110_000).optional().describe("Max wait in ms (default 45_000, max 110_000). Values > ~55 s need a client request timeout > 60 s."),
        interval_ms: z.number().int().min(2000).max(15_000).optional().describe("Poll interval in ms (default 5000; min 2000, max 15000)."),
        include_failure_tail: flag01.optional().describe("1 fetches the failing job/run log tail on failure (default); 0 skips it."),
        tail_lines: z.number().int().min(1).max(1000).optional().describe("Failure tail lines (default 80)."),
        repo: repoArg,
        provider: providerArg,
      },
    },
    (args) => runOne("ci_wait", args as Args),
  );

  // -------------------------------------------------------------------------
  // Secrets: safe env-var storage for tokens and other credentials
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_github_connect",
    {
      ...config(
        "Connect GitHub",
        {
          speed_profile:
            "start returns a short-lived verification code; poll only at the interval GitHub specifies.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ),
      inputSchema: {
        action: z.enum(["start", "poll"]).describe("start: begin the device flow (returns verification_uri + user_code). poll: check with pending_id whether the user authorized."),
        replace_existing: flag01
          .optional()
          .describe("action=start: 1 explicitly authorizes replacing an existing GitHub credential; 0 does not."),
        pending_id: z
          .string()
          .max(64)
          .optional()
          .describe("action=poll: opaque id returned by action=start; it does not contain the device code or token."),
      },
    },
    (args) => runOne("github_connect", args as Args),
  );

  server.registerTool(
    "project_secret",
    {
      ...config(
        "Manage secrets",
        {
          speed_profile:
            "fast; encrypted AES-256-GCM store, atomic writes, values decrypted only when injected. Expiry/use fields are metadata only.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        action: z.enum(["get", "set", "list", "delete"]).default("list").describe("set stores a secret; get returns metadata only (plaintext needs reveal=1); list shows all stored secrets; delete removes one."),
        name: z
          .string()
          .max(64)
          .optional()
          .describe("Env-var style name, e.g. GITHUB_TOKEN (required for get/set/delete)."),
        value: z
          .string()
          .max(16 * 1024)
          .optional()
          .describe("Secret value for action=set. Prefer value_env so it never appears in the transcript."),
        value_env: z
          .string()
          .max(64)
          .optional()
          .describe("Read the value from this host environment variable instead of `value` (never logged)."),
        expires_in_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe("action=set: expiry in days (e.g. 90 for quarterly rotation). Expired secrets are not injected."),
        expires_at: z
          .union([z.number().int(), z.string().max(60)])
          .optional()
          .describe("action=set: absolute expiry (epoch ms or ISO-8601), instead of expires_in_days."),
        reveal: flag01
          .optional()
          .describe("action=get: 1 returns the plaintext value and requires VENIRA_SECRET_ALLOW_REVEAL=1 on the host; prefer secret_env injection."),
        reason: reason_,
      },
    },
    (args) => runSecret(args as Args),
  );
}
