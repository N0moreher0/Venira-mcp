import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import type { Args } from "./project-cache.js";
import { config, flag01, reason_ } from "./project-schema.js";

// Local git tools: project_git_status, project_git_diff, project_git_log,
// project_git_branch, project_git_commit, project_git_stash.

export type GitToolsDeps = {
  runOne: (operation: string, args: Args) => Promise<ToolResult>;
};

const paths_ = z
  .array(z.string().min(1).max(4096))
  .max(256)
  .optional()
  .describe("Optional workspace-relative paths to limit the operation.");

const ref_ = z.string().max(300).optional().describe("Optional ref (branch, tag or commit sha). Default: HEAD.");

const limit_ = z.number().int().min(1).max(200).optional().describe("Max commits to return (default 20, max 200).");

const context_lines_ = z
  .number()
  .int()
  .min(0)
  .max(20)
  .optional()
  .describe("Unified-diff context lines (default 3).");

export function registerGitTools(server: McpServer, deps: GitToolsDeps): void {
  const { runOne } = deps;
  // -------------------------------------------------------------------------
  // Local git: read-only queries run free; commit/branch/stash mutations need
  // an audit reason and never push (routine git is allowed; force/delete/URL pushes need approval).
  // -------------------------------------------------------------------------

  server.registerTool(
    "project_git_status",
    {
      ...config("Git status", {
        speed_profile: "fast; one git status call, output parsed.",
        batch_safe: true,
      }, { readOnlyHint: true, openWorldHint: false }),
      inputSchema: {
        paths: paths_.describe("Optional workspace-relative paths to limit the status."),
        reason: reason_,
      },
    },
    (args) => runOne("git_status", args as Args),
  );

  server.registerTool(
    "project_git_diff",
    {
      ...config("Git diff", {
        speed_profile: "scales with the diff; hunk metadata is parsed, patch text is opt-in.",
        batch_safe: true,
      }, { readOnlyHint: true, openWorldHint: false }),
      inputSchema: {
        staged: flag01.optional().describe("1 compares the index to HEAD (git diff --cached); 0 compares worktree to HEAD/index."),
        paths: paths_.describe("Optional workspace-relative paths to limit the diff."),
        context_lines: context_lines_,
        include_patch: flag01.optional().describe("1 includes the unified diff text (truncated to max_bytes)."),
        max_bytes: z.number().int().min(1024).max(1_048_576).optional().describe("Patch text budget when include_patch=1 (default 65536)."),
        reason: reason_,
      },
    },
    (args) => runOne("git_diff", args as Args),
  );

  server.registerTool(
    "project_git_log",
    {
      ...config("Git log", {
        speed_profile: "bounded by limit; blame mode scales with file size and max_lines.",
        batch_safe: true,
      }, { readOnlyHint: true, openWorldHint: false }),
      inputSchema: {
        ref: ref_,
        limit: limit_,
        paths: paths_.describe("Optional workspace-relative paths to limit the log."),
        author: z.string().max(300).optional().describe("Filter commits by author name or email."),
        grep: z.string().max(300).optional().describe("Filter commit messages by substring."),
        blame: flag01.optional().describe("1 switches to blame mode for path (optionally ref)."),
        path: z.string().min(1).max(4096).optional().describe("Required when blame=1: the file to blame."),
        max_lines: z.number().int().min(1).max(5_000).optional().describe("Blame entries to return (default 1000)."),
        reason: reason_,
      },
    },
    (args) => runOne("git_log", args as Args),
  );

  server.registerTool(
    "project_git_branch",
    {
      ...config("Git branch", {
        speed_profile: "fast; one branch call, remote branches optional.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
      inputSchema: {
        action: z.enum(["list", "current", "create", "switch", "delete"]).default("list").describe("list: local branches (add include_remote=1 for origin); current: just the checked-out branch; create/switch/delete: local branch."),
        name: z.string().max(250).optional().describe("Branch name (required for create/switch/delete)."),
        from: z.string().max(300).optional().describe("Optional start ref for action=create (default: HEAD)."),
        include_remote: flag01.optional().describe("1 includes remote-tracking branches in action=list."),
        force: flag01.optional().describe("1 allows deleting an unmerged branch (git branch -D); 0 uses -d."),
        reason: reason_,
      },
    },
    (args) => runOne("git_branch", args as Args),
  );

  server.registerTool(
    "project_git_commit",
    {
      ...config("Git commit", {
        speed_profile: "one git add (only when paths given) plus one git commit; output is the new HEAD plus file count.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
      inputSchema: {
        message: z.string().min(1).max(500).describe("Commit message (first line is the subject)."),
        paths: paths_.describe("Optional workspace-relative paths to stage. Omit to commit what is already staged."),
        allow_empty: flag01.optional().describe("1 allows an empty commit (git commit --allow-empty)."),
        amend: flag01.optional().describe("1 amends HEAD instead of creating a new commit."),
        reason: reason_,
      },
    },
    (args) => runOne("git_commit", args as Args),
  );

  server.registerTool(
    "project_git_stash",
    {
      ...config("Git stash", {
        speed_profile: "fast; list is read-only, push/apply/pop/drop touch the worktree.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
      inputSchema: {
        action: z.enum(["push", "list", "apply", "pop", "drop", "show"]).default("list").describe("push: stash changes; list: list stashes; apply/pop/drop: apply/pop/drop a stash; show: list files in a stash."),
        selector: z.string().max(30).optional().describe("Stash selector (default stash@{0}); format stash@{N}."),
        paths: paths_.describe("Optional workspace-relative paths to limit what gets stashed."),
        message: z.string().max(500).optional().describe("Optional message for action=push."),
        include_untracked: flag01.optional().describe("1 includes untracked files when pushing."),
        reason: reason_,
      },
    },
    (args) => runOne("git_stash", args as Args),
  );
}
