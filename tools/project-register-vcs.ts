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
        "Open a pull request for the current branch (or an explicit head/base). Works with GitHub, GitLab and Bitbucket; repo/token/provider are resolved per call.",
        "Create pull request",
        {
          use_when:
            "the change is committed and pushed, and the user asks to open a PR/MR. Default base is the repo's default branch.",
          avoid_when: "the branch is not pushed yet (push first), or a PR for this branch already exists (use project_pr_comment).",
          speed_profile: "one provider API call (~1 network round trip, 2 if the default branch is not cached).",
          output_kind: "pr_create: repo, provider, number, url, title, state, draft, head, base, created.",
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
        "Post a comment on a pull request: a general thread comment, or an inline review note pinned to a file/line (pass path + line). Accepts a PR number or a full PR URL.",
        "Comment on PR",
        {
          use_when:
            "reporting status into the PR thread, answering a review comment, or leaving a file/line review note (path + line).",
          avoid_when: "the PR is not open yet (create it first), or you want to change code (use project_edit_file).",
          speed_profile: "one provider API call (issue-comments, or review-comments for inline notes).",
          output_kind:
            "pr_comment: repo, provider, pr, inline, comment_id, url, created_at, body_chars (+ path/line/side for inline notes).",
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
        "Merge a pull request (merge/squash/rebase) and optionally delete the head branch. Refuses cleanly when the PR is closed or conflicting.",
        "Merge pull request",
        {
          use_when: "CI is green and the user asked to land the PR. Use method=squash for a single commit.",
          avoid_when: "checks are still running (project_ci_status first), or the user only wants a review comment.",
          speed_profile: "2-3 API calls (state check, merge, optional branch delete).",
          output_kind: "pr_merge: repo, provider, pr, merged, method, sha, head, base, branch_deleted, note?.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      ),
      inputSchema: {
        pr: z.union([z.number().int().positive(), z.string().max(300)]).describe("PR number or PR URL."),
        method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge strategy (default: merge)."),
        commit_title: z.string().max(256).optional().describe("Title for the merge commit (squash/merge)."),
        commit_message: z.string().max(65_536).optional().describe("Body for the merge commit."),
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
        "List pull/merge requests for a repo, optionally filtered by state, head or base branch.",
        "List pull requests",
        {
          use_when: "you need the PR number for a branch (before commenting/merging) or a quick open/closed overview.",
          avoid_when: "you already know the PR number (use project_pr_comment / project_pr_merge directly).",
          speed_profile: "one API call; read-only and batch-safe.",
          output_kind: "pr_list: repo, provider, state, total, prs[] {number, title, state, draft, head, base, author, url}.",
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
        "Close (decline) an open pull/merge request without merging it.",
        "Close pull request",
        {
          use_when: "a PR is superseded, opened by mistake, or the user asked to abandon it.",
          avoid_when: "the change should land (use project_pr_merge instead).",
          speed_profile: "one API call; idempotent (closing a closed PR is a no-op).",
          output_kind: "pr_close: repo, provider, pr, state, closed, url.",
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
        "Reopen a closed pull/merge request (GitHub, GitLab). Bitbucket returns `unsupported`.",
        "Reopen pull request",
        {
          use_when: "a PR was closed by mistake and the same branch should be reviewed again.",
          avoid_when: "the branch was deleted or force-pushed away (open a new PR with project_pr_create).",
          speed_profile: "one API call; idempotent.",
          output_kind: "pr_reopen: repo, provider, pr, state, reopened, url.",
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
        "Read CI status: recent runs for a branch/workflow, one run with its jobs, or branch-protection check-runs for a ref/PR (GitHub). GitHub Actions, GitLab pipelines and Bitbucket Pipelines are supported.",
        "CI status",
        {
          use_when:
            "after pushing or triggering a pipeline, to see whether checks passed before merging; pass pr=<number> (or ref=<sha>) for branch-protection check-runs (GitHub).",
          avoid_when: "you need the failure detail (use project_ci_logs with the run_id/job_id).",
          speed_profile: "1-2 API calls; newest runs first. pr= adds one call to resolve the head sha.",
          output_kind:
            "ci_status: overall (success|failure|in_progress|no_runs|no_checks) + runs[] {id, name, status, conclusion, branch, sha, url}; " +
            "run_id → run + jobs[]; ref/pr → check_runs[] (GitHub) or the newest pipeline (GitLab/Bitbucket).",
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
        "Cancel one CI run, or retry failed jobs when the provider supports it. Requires an explicit run_id and audit reason; Bitbucket Cloud supports cancel but not retry.",
        "Control CI run",
        {
          use_when: "you explicitly want to stop a run or retry only its failed jobs; read project_ci_status first to confirm the target run.",
          avoid_when: "the run id is ambiguous, the user has not requested a remote CI write, or you need a new run on a different ref (use project_ci_trigger).",
          speed_profile: "one provider API call; POST is never automatically retried.",
          output_kind: "ci_control: repo, provider, action, run_id, request_submitted; check project_ci_status to confirm the asynchronous result.",
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
        "Trigger a pipeline: GitHub Actions workflow_dispatch, a GitLab pipeline, or a Bitbucket custom pipeline. Ref defaults to the current branch.",
        "Trigger CI workflow",
        {
          use_when: "re-running a pipeline for a branch without a new commit, or dispatching a workflow with inputs/variables.",
          avoid_when: "the workflow has no workflow_dispatch trigger (GitHub rejects it), or a push would do it anyway.",
          speed_profile: "one API call; the new run appears in project_ci_status within ~10s.",
          output_kind: "ci_trigger: repo, provider, workflow, ref, inputs, triggered, dispatched_at.",
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
        "Read CI logs: a whole run (GitHub ZIP or up to 3 failing GitLab/Bitbucket jobs) or a single job/step. Returns the tail, not the whole log.",
        "CI logs",
        {
          use_when: "a run failed and you need the error. Pass job_id to isolate the failing job; tail_lines/max_bytes keep it small.",
          avoid_when: "you only need pass/fail (use project_ci_status).",
          speed_profile: "1 download; run archives are parsed in memory with per-entry caps.",
          output_kind:
            "ci_logs: repo, provider, run_id|job_id, source, entries[] {name, bytes, skipped?}, lines, text (tail), truncated, dropped_lines, dropped_bytes.",
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
        "Long-poll one CI run/ref/PR/branch until it reaches a terminal state (success|failure|cancelled|skipped), changes (until=any_change), or timeout_ms elapses. On failure it includes the same bounded log tail as project_ci_logs. This does not wake the model: it is one bounded call, not a push notification.",
        "Wait for CI",
        {
          use_when:
            "after project_ci_trigger or a push you want the result plus the failure tail in one call instead of a polling loop.",
          avoid_when:
            "you want a snapshot right now (project_ci_status) or the full log of a specific job (project_ci_logs with job_id).",
          speed_profile:
            "blocks up to timeout_ms (default 45 s, max 110 s) with 2–15 s backoff polling; unqueued, so other tools keep working.",
          output_kind:
            "ci_wait: overall, previous, changed, terminal, waited_ms, polls, run, selector, ci_status, failure_tail? {text, lines, truncated}; terminal=false means chain another call.",
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
        "Connect GitHub through its Device Flow. The user authorizes at github.com; access and refresh tokens are saved in the encrypted local vault and are never returned.",
        "Connect GitHub",
        {
          use_when:
            "the user wants to connect or replace the local GitHub credential without pasting a token into chat.",
          avoid_when:
            "the user only needs GitHub public read access or has already configured a token.",
          speed_profile:
            "start returns a short-lived verification code; poll only at the interval GitHub specifies.",
          output_kind:
            "github_connect: start returns verification_uri, user_code, pending_id and expiry; poll returns pending, denied, expired or connected (never a token).",
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
        "Manage API tokens/credentials without leaking them: values are encrypted at rest and never returned by default. " +
          "Inject them into commands with project_shell_run secret_env=[\"NAME\"] instead of pasting them into a command line. " +
          "Rotation metadata (expiry, last use, use count) is tracked by default and expired secrets are refused.",
        "Manage secrets",
        {
          use_when:
            "storing a non-GitHub token (action=set), checking whether one exists or is due for rotation (action=get / action=list), " +
            "removing one (action=delete). Then use secret_env on project_shell_run or the built-in GitHub tools.",
          avoid_when:
            "the value is a normal, non-secret config (put it in .env or the config file); or you need the plaintext " +
            "printed (only with reveal=1 + VENIRA_SECRET_ALLOW_REVEAL=1).",
          speed_profile:
            "fast; encrypted AES-256-GCM store, atomic writes, values decrypted only when injected. Expiry/use fields are metadata only.",
          output_kind:
            "secret_set: name, length, sha256_12, updated_at, expires_at, days_left, created, rotated; " +
            "secret_get/list: metadata only (expires_at, expired, days_left, last_used_at, use_count, rotated_at); " +
            "secret_delete: deleted.",
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
