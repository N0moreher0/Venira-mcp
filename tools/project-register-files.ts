import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import { editFuzzyEnabled } from "../lib/env.js";
import type { Args } from "./project-cache.js";
import {
  checkItemBytes,
  READ_ITEM_BYTES_MAX,
  READ_ITEM_BYTES_MIN,
  runEditBatch,
  runReadFileBatch,
  type BatchDeps,
} from "./project-batch.js";
import { runHybridSearch, type HybridDeps } from "./project-hybrid.js";
import { runRecentFiles, type RecentFilesDeps } from "./project-recent.js";
import {
  config,
  editFuzzyShape,
  editOp,
  flag01,
  lineNo,
  path_,
  readFileRequestArgs,
  reason_,
} from "./project-schema.js";

// File tool registrations: list/read/info/search/recent (read side) and
// write/edit/delete (write side). read_file is single OR multi (requests[]); edit_file is single OR
// multi (edits[] with per-item relative_path, all-or-nothing). Extracted from registerProjectTools in
// tools/project.ts (roadmap item 6, step 5j).

export type FileToolsDeps = {
  runOne: (operation: string, args: Args, options?: { line_numbers?: boolean }) => Promise<ToolResult>;
  hybridDeps: HybridDeps;
  recentFilesDeps: RecentFilesDeps;
  batchDeps: BatchDeps;
  maxBatchItemBytes: number;
  /** Multi-query AND/NOT/weighted search behind search's `queries` param. */
  runSearchSelective: (args: Args) => Promise<ToolResult>;
};

export function registerFileTools(server: McpServer, deps: FileToolsDeps): void {
  const { runOne, hybridDeps, recentFilesDeps, batchDeps, maxBatchItemBytes, runSearchSelective } = deps;
  // VENIRA_EDIT_FUZZY decides whether the fuzzy options are advertised (ROADMAP_TOOL_SCHEMA.md, phase 3).
  // Read once per registration, like VENIRA_JS_EXEC_MODE for execute_js.
  const fuzzy = editFuzzyEnabled();
  server.registerTool(
    "list_files",
    {
      ...config(
        "List files",
        {
          speed_profile: "fast; TTL cache 1.5s, auto-wiped on write/edit/delete.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_.optional(),
        include_ignored: flag01.optional().describe("true also lists ignored folders (default false)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max entries (default 200, max 200)."),
        depth: z.number().int().min(1).max(3).optional().describe("Tree depth (default 1, max 3)."),
      },
    },
    (args) => runOne("list_files", args),
  );

  server.registerTool(
    "read_file",
    {
      ...config(
        "Read file",
        {
          speed_profile: "very fast on repeat; cache validated by mtime+size.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      // Loose on purpose, like edit_file: `max_response_bytes_per_item` is accepted but not advertised (phase 7);
      // the SDK validates with a strip-object for raw shapes, so the hidden key would be dropped before the handler
      // saw it. A loose object keeps it reachable, and the handler range-checks it itself.
      inputSchema: z.looseObject({
        relative_path: path_.optional().describe("Workspace-relative file to read. Omit when sending requests[] (multi-file call)."),
        start_line: lineNo.optional().describe("First line (1-based)."),
        end_line: z.number().int().min(1).optional().describe("Last line (1-based, inclusive)."),
        line_numbers: flag01.optional().describe("true prefixes each line with its line number (default false)."),
        max_bytes: z.number().int().min(1).max(1048576).optional().describe("Max bytes returned (default and max 1 MiB)."),
        ranges: z
          .array(
            z.object({
              start_line: lineNo.describe("First line (1-based)."),
              end_line: z.number().int().min(1).optional().describe("Last line (1-based, inclusive)."),
              max_bytes: z.number().int().min(1).optional().describe("Max text bytes for this range (default: the top-level max_bytes)."),
            })
          )
          .min(1)
          .max(16)
          .optional()
          .describe("Multiple disjoint ranges of the SAME file (max 16); use instead of several read_file calls on ONE file."),
        requests: z
          .array(readFileRequestArgs)
          .min(1)
          .max(8)
          .optional()
          .describe("Multiple files in ONE call: each item takes read_file's own arguments (relative_path required per item, plus start_line/end_line/ranges/max_bytes/line_numbers). Omit for a single-file read using the top-level parameters. Max 8 items; each item behaves exactly like its own read_file call."),
      }),
    },
    (args) => {
      const a = args as Args;
      if (Array.isArray(a.requests)) {
        const badBytes = checkItemBytes("read_file", a.max_response_bytes_per_item, READ_ITEM_BYTES_MIN, READ_ITEM_BYTES_MAX);
        if (badBytes) return badBytes;
        return runReadFileBatch(a.requests as Args[], (a.max_response_bytes_per_item as number | undefined) ?? maxBatchItemBytes, batchDeps);
      }
      const wantNumbers = Boolean(a.line_numbers);
      return runOne("read_file", args, wantNumbers ? { line_numbers: true } : undefined);
    },
  );

  server.registerTool(
    "get_file_info",
    {
      ...config(
        "Get file info",
        {
          speed_profile: "very fast; cache validated by mtime+size.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        missing_ok: flag01.optional().describe("true = answer ok with exists:false for a missing path instead of not_found (default false)."),
      },
    },
    (args) => runOne("get_file_info", args),
  );

  server.registerTool(
    "search",
    {
      ...config(
        "Search workspace",
        {
          speed_profile: "rg → grep → JS walker; TTL cache 3s.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        // ~99% of calls need only `query` (+ optionally relative_path). Everything below is fine-tuning.
        query: z.string().optional().describe("What to find (plain substring; regex=true for regex). The only parameter most calls need."),
        relative_path: path_.optional().describe("Directory (or one file) to scan. Default: workspace root; narrow it for speed."),
        kind: z.enum(["file_name", "directory_name", "literal_content", "definition"]).optional().describe("literal_content (default): lines containing the match. definition: symbol declarations only. file_name/directory_name: name substring."),
        glob: z.string().optional().describe("rg glob filter ('*.ts' = any depth, 'tools/*.ts' = that folder)."),
        exclude_glob: z.string().optional().describe("rg glob exclusion (same syntax as glob)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max hits (default/max 200; ignored when count_only=true)."),
        regex: flag01.optional().describe("true = query is a regex (default false = plain substring)."),
        case_sensitive: flag01.optional().describe("true (default) = case-sensitive match for literal_content/definition."),
        whole_word: flag01.optional().describe("true = whole-word match only (rg -w)."),
        include_hidden: flag01.optional().describe("default true; false = skip dotfiles. Secrets always excluded."),
        invert: flag01.optional().describe("true = lines WITHOUT a match (grep -v)."),
        files_only: flag01.optional().describe("true = only files with a match (grep -l), no lines/content."),
        context_lines: z.number().int().min(0).max(20).optional().describe("Context lines around each hit (default 0)."),
        count_only: flag01.optional().describe("true = only counts; limit is ignored."),
        hybrid: flag01.optional().describe("Advanced: tag hits with source/confidence. literal_content only."),
        queries: z
          .array(
            z.object({
              pattern: z.string().min(1).describe("Substring matched against each line."),
              must: flag01.optional().describe("true (default false): line must contain this pattern too."),
              weight: z.number().int().optional().describe("Points per matching line (default 1)."),
            }),
          )
          .min(1)
          .max(8)
          .optional()
          .describe("Advanced (rarely needed): weighted multi-pattern ranking (overrides kind/query). Hits carry score/matched. Pair with files_hint."),
        files_hint: z
          .array(z.string().max(300))
          .max(20)
          .optional()
          .describe("Advanced (rarely needed): paths to scan when queries[] is set (first 20 used)."),
      },
    },
    (args) => {
      if (Array.isArray((args as Args).queries) && ((args as Args).queries as unknown[]).length > 0) {
        return runSearchSelective(args as Args);
      }
      return args.hybrid === true && args.kind === "literal_content"
        ? runHybridSearch(args as Args, hybridDeps)
        : runOne("search", args);
    },
  );

  server.registerTool(
    "recent_files",
    {
      ...config(
        "Recent files",
        {
          speed_profile: "medium (filesystem walk); TTL cache 2s, bounded to 4000 files / 300 directories.",
          batch_safe: false,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_.optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Max entries (default 20, max 100)."),
        depth: z.number().int().min(1).max(6).optional().describe("Directory recursion cap (default 2, max 6)."),
        include_ignored: flag01.optional().describe("true also lists ignored folders (default false)."),
      },
    },
    (args) => runRecentFiles(args as Args, recentFilesDeps),
  );

  server.registerTool(
    "write_file",
    {
      ...config(
        "Write file",
        {
          speed_profile: "fast; clears the read/list/search cache for the affected path.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        content: z.string().describe("Full file content to write."),
        mode: z.enum(["create", "overwrite", "append"]).optional().describe("Default overwrite. create makes the parent folders and the file (fails if the path already exists); append adds to the end."),
        create_dirs: flag01.optional().describe("true creates missing parent directories (implied by mode=create)."),
        expected_sha256: z.string().optional().describe("Hex SHA-256 of the file's current full content. The write is refused if the file on disk differs. Use sha256_after from your last write/edit of this file; read_file's sha256 only matches when the whole file was returned."),
        reason: reason_,
      },
    },
    (args) => runOne("write_file", args),
  );

  server.registerTool(
    "edit_file",
    {
      ...config(
        "Edit file",
        {
          speed_profile: "fast; clears the read/list/search cache for the affected path.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ),
      // Loose on purpose: the fuzzy options are only advertised when VENIRA_EDIT_FUZZY=1, but a client with a
      // cached tool list may still send them. A plain object would strip them silently; loose lets the handler
      // answer with an error that names the variable. Same for the removed `guard` flag: it reaches the handler,
      // which refuses it with `[unsupported]` instead of silently skipping verification.
      inputSchema: z.looseObject({
        relative_path: path_.optional().describe("Workspace-relative file to edit. Omit when every edit carries its own relative_path (multi-file call)."),
        old_text: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Exact text to replace. Must match exactly once unless replace_all=true." +
              (fuzzy ? " With no exact match a near-match is used (fuzzy options below)." : "") +
              " Ignored when edits[] is given.",
          ),
        new_text: z.string().optional().describe("Replacement text (paired with old_text; ignored when edits[] is given)."),
        replace_all: flag01.optional().describe("true replaces every match; false (default) requires exactly one match."),
        edits: z
          .array(
            z.looseObject({
              ...editOp.shape,
              // `replace_all` is required in editOp (single nested edit), optional per item here.
              replace_all: flag01.optional().describe("true replaces every match; false (default) requires exactly one match."),
              ...editFuzzyShape(fuzzy),
              relative_path: path_.optional().describe("Per-item file: the item edits this file instead of the top-level one, and the whole call becomes multi-file and atomic (all-or-nothing with automatic rollback), like the former edit_batch."),
            })
          )
          .max(64)
          .optional()
          .describe(
            "Multiple section replacements in this file (or across files, with per-item relative_path); takes precedence over old_text/new_text. " +
              "Any item may carry its own relative_path; the whole call then edits every touched file all-or-nothing.",
          ),
        expected_sha256: z.string().optional().describe("Hex SHA-256 of the file's current full content. The edit is refused if the file on disk differs. Use sha256_after from your last write/edit of this file; read_file's sha256 only matches when the whole file was returned. When given, the result is re-read after the write and reports verified."),
        ...editFuzzyShape(fuzzy),
        reason: reason_,
      }),
    },
    (args) => {
      const a = args as Args;
      const multi =
        Array.isArray(a.edits) &&
        (a.edits as Args[]).some(
          (item) => item && typeof item.relative_path === "string" && (item.relative_path as string).trim().length > 0,
        );
      // Any edit item with its own relative_path => multi-file, all-or-nothing with rollback.
      if (multi) return runEditBatch(a, batchDeps, "edit_file");
      return runOne("edit_file", a);
    },
  );

  server.registerTool(
    "delete_path",
    {
      ...config("Delete path", {
        speed_profile: "fast; clears the read/list/search cache.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      inputSchema: {
        relative_path: path_.describe("Exact workspace path to delete."),
        recursive: flag01.optional().describe("true = delete a directory recursively (required for directories); snapshot it first."),
        reason: reason_,
      },
    },
    (args) => runOne("delete_path", args),
  );

  server.registerTool(
    "move_path",
    {
      ...config("Move path", {
        speed_profile: "fast; clears the read/list/search cache for both paths.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }),
      inputSchema: {
        from: path_.describe("Existing workspace path to move or rename."),
        to: path_.describe("New workspace path: the final name, not a parent directory."),
        overwrite: flag01.optional().describe("true replaces an existing target file (default false). A directory is never replaced."),
        create_dirs: flag01.optional().describe("true creates missing parent directories of `to` (default true)."),
        reason: reason_,
      },
    },
    (args) => runOne("move_path", args),
  );

  server.registerTool(
    "copy_path",
    {
      ...config("Copy path", {
        speed_profile: "fast for files; directory copies scale with size. Clears the read/list/search cache.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
      inputSchema: {
        from: path_.describe("Existing workspace path to copy."),
        to: path_.describe("New workspace path: the final name, not a parent directory."),
        recursive: flag01.optional().describe("true is required to copy a directory (default false)."),
        overwrite: flag01.optional().describe("true replaces an existing target file (default false). A directory is never replaced."),
        create_dirs: flag01.optional().describe("true creates missing parent directories of `to` (default true)."),
        reason: reason_,
      },
    },
    (args) => runOne("copy_path", args),
  );

  server.registerTool(
    "apply_patch",
    {
      ...config("Apply patch", {
        speed_profile: "scales with patch size; validates every file before writing and rolls back the whole patch on failure.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }),
      inputSchema: {
        patch: z.string().min(1).describe("Unified diff. Multiple files supported: each section starts with 'diff --git a/old b/new' or '--- a/old' + '+++ b/new' ('/dev/null' for created/deleted files)."),
        dry_run: flag01.optional().describe("true validates the patch against the current files and reports what would change, writing nothing (default false)."),
        expected_sha256: z.record(z.string(), z.string()).optional().describe("Optional map of workspace-relative path -> hex SHA-256; the patch is refused if a file changed since it was read. Keys must be paths the patch touches."),
        reason: reason_,
      },
    },
    (args) => runOne("apply_patch", args),
  );
}
