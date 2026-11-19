import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import type { Args } from "./project-cache.js";
import { config, flag01, reason_ } from "./project-schema.js";

// Local git: ONE tool `git` (exposed as `venira_git` in client plugins) with
// `action` = status | diff | log | branch | commit | stash, plus `sub` for the
// branch/stash sub-actions. The corehost operations stay `git_status`..`git_stash`;
// this file only merges the schema surface and maps argv for the runners.
//
//   git action=status {paths?}
//   git action=diff   {staged?, paths?, context_lines?, include_patch?, max_bytes?}
//   git action=log    {ref?, limit?, paths?, author?, grep?, blame?, path?, max_lines?}
//   git action=branch {sub?, name?, from?, include_remote?, force?}   sub: list|current|create|switch|delete
//   git action=commit {message, paths?, allow_empty?, amend?}
//   git action=stash  {sub?, selector?, paths?, message?, include_untracked?}  sub: push|list|apply|pop|drop|show
//
// message (commit body, stash push note) is capped at 1000 chars.

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

const branch_sub_ = z
  .enum(["list", "current", "create", "switch", "delete"])
  .optional()
  .describe("Branch sub-action (action=branch): list (default; local branches, include_remote=true for origin), current (checked-out branch), create/switch/delete (name required; create uses from=start ref, default HEAD; delete uses force=true to keep an unmerged branch).");

const stash_sub_ = z
  .enum(["push", "list", "apply", "pop", "drop", "show"])
  .optional()
  .describe("Stash sub-action (action=stash): push (staged+unstaged tracked changes; include_untracked=true adds -u), list (default), show, apply/pop/drop (selector stash@{N}).");

export function registerGitTools(server: McpServer, deps: GitToolsDeps): void {
  const { runOne } = deps;
  // -------------------------------------------------------------------------
  // Local git: merged into ONE tool (`git`). Read-only sub-actions run free;
  // mutations need an audited `reason`; this tool never pushes.
  // -------------------------------------------------------------------------

  server.registerTool(
    "git",
    {
      ...config("Local git", {
        speed_profile: "one git call per action; output is parsed and locale-independent.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
      inputSchema: {
        action: z
          .enum(["status", "diff", "log", "branch", "commit", "stash"])
          .default("status")
          .describe("Which git operation to run: status | diff | log | branch | commit | stash."),
        // shared options
        paths: paths_.describe("Optional workspace-relative paths. status/diff/log/stash: limits what the command looks at. commit: paths to stage first (git add); omit to commit the already-staged set. Not used by action=branch."),
        reason: reason_,
        // diff
        staged: flag01.optional().describe("action=diff: true compares the index to HEAD (git diff --cached); false compares worktree to HEAD/index."),
        context_lines: context_lines_,
        include_patch: flag01.optional().describe("action=diff: true includes the unified diff text (truncated to max_bytes)."),
        max_bytes: z.number().int().min(1024).max(1_048_576).optional().describe("Patch text budget when include_patch=true (default 65536)."),
        // log
        ref: ref_,
        limit: limit_,
        author: z.string().max(300).optional().describe("action=log: filter commits by author name or email."),
        grep: z.string().max(300).optional().describe("action=log: filter commit messages by substring."),
        blame: flag01.optional().describe("action=log: true switches to blame mode for path (optionally ref)."),
        path: z.string().min(1).max(4096).optional().describe("action=log + blame: the file to blame."),
        max_lines: z.number().int().min(1).max(5_000).optional().describe("Blame entries to return (default 1000)."),
        // branch / stash
        sub: z.union([branch_sub_, stash_sub_]).optional().describe("Branch sub-action when action=branch (list|current|create|switch|delete); stash sub-action when action=stash (push|list|apply|pop|drop|show). Default: list."),
        name: z.string().max(250).optional().describe("action=branch sub=create|switch|delete: branch name (required)."),
        from: z.string().max(300).optional().describe("action=branch sub=create: start ref (default: HEAD)."),
        include_remote: flag01.optional().describe("action=branch sub=list: true includes remote-tracking branches in the list."),
        force: flag01.optional().describe("action=branch sub=delete: true allows deleting an unmerged branch (git branch -D); false uses -d."),
        selector: z.string().max(30).optional().describe("action=stash sub=apply|pop|drop: stash selector (default stash@{0}); format stash@{N}."),
        // commit / stash push
        message: z.string().max(1000).optional().describe("action=commit: commit message (first line is the subject, required). action=stash sub=push: optional note stored in the stash entry."),
        allow_empty: flag01.optional().describe("action=commit: true allows an empty commit (git commit --allow-empty)."),
        amend: flag01.optional().describe("action=commit: true amends HEAD instead of creating a new commit."),
        include_untracked: flag01.optional().describe("action=stash sub=push: true includes untracked files when pushing."),
      },
    },
    (args) => {
      const { action, sub, ...rest } = args as Record<string, unknown>;
      const payload: Record<string, unknown> = { ...rest };
      if (action === "branch" || action === "stash") {
        payload.action = typeof sub === "string" && sub.trim() ? sub : "list";
      }
      return runOne(`git_${String(action)}`, payload as Args);
    },
  );
}
