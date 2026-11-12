import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import { editFuzzyEnabled } from "../lib/env.js";
import type { Args } from "./project-cache.js";
import {
  checkItemBytes,
  EDIT_ITEM_BYTES_MAX,
  EDIT_ITEM_BYTES_MIN,
  READ_ITEM_BYTES_MAX,
  READ_ITEM_BYTES_MIN,
  runEditBatch,
  runReadBatch,
  type BatchDeps,
} from "./project-batch.js";
import { runHybridSearch, type HybridDeps } from "./project-hybrid.js";
import { runRecentFiles, type RecentFilesDeps } from "./project-recent.js";
import {
  config,
  editBatchItemFor,
  editFuzzyShape,
  editOp,
  flag01,
  lineNo,
  path_,
  readBatchGetFileInfoArgs,
  readBatchListFilesArgs,
  readBatchReadFileArgs,
  readBatchSearchArgs,
  reason_,
} from "./project-schema.js";

// File tool registrations: list/read/info/search/recent/read_batch (read side) and
// write/edit/edit_batch/delete (write side). Extracted from registerProjectTools in tools/project.ts
// (roadmap item 6, step 5j). Schemas, descriptions and registration order are unchanged; the runners
// and their state stay in project.ts and arrive through FileToolsDeps.

export type FileToolsDeps = {
  runOne: (operation: string, args: Args, options?: { line_numbers?: boolean }) => Promise<ToolResult>;
  hybridDeps: HybridDeps;
  recentFilesDeps: RecentFilesDeps;
  batchDeps: BatchDeps;
  maxBatchItemBytes: number;
  /** Multi-query AND/NOT/weighted search behind project_search's `queries` param. */
  runSearchSelective: (args: Args) => Promise<ToolResult>;
};

export function registerFileTools(server: McpServer, deps: FileToolsDeps): void {
  const { runOne, hybridDeps, recentFilesDeps, batchDeps, maxBatchItemBytes, runSearchSelective } = deps;
  // VENIRA_EDIT_FUZZY decides whether the fuzzy options are advertised (ROADMAP_TOOL_SCHEMA.md, phase 3).
  // Read once per registration, like VENIRA_JS_EXEC_MODE for project_execute_js.
  const fuzzy = editFuzzyEnabled();
  server.registerTool(
    "project_list_files",
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
        include_ignored: flag01.optional().describe("1 also lists ignored folders (default 0)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max entries (default 200, max 200)."),
        depth: z.number().int().min(1).max(3).optional().describe("Tree depth (default 1, max 3)."),
      },
    },
    (args) => runOne("list_files", args),
  );

  server.registerTool(
    "project_read_file",
    {
      ...config(
        "Read file",
        {
          speed_profile: "very fast on repeat; cache validated by mtime+size.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        start_line: lineNo.optional().describe("First line (1-based)."),
        end_line: z.number().int().min(1).optional().describe("Last line (1-based, inclusive)."),
        line_numbers: flag01.optional().describe("1 prefixes each line with its line number (default 0)."),
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
          .describe("Multiple disjoint ranges of the SAME file (max 16). Use instead of multiple read_file calls."),
      },
    },
    (args) => {
      const wantNumbers = Boolean((args as Args).line_numbers);
      return runOne("read_file", args, wantNumbers ? { line_numbers: true } : undefined);
    },
  );

  server.registerTool(
    "project_get_file_info",
    {
      ...config(
        "Get file info",
        {
          speed_profile: "very fast; cache validated by mtime+size.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: { relative_path: path_ },
    },
    (args) => runOne("get_file_info", args),
  );

  server.registerTool(
    "project_search",
    {
      ...config(
        "Search workspace",
        {
          speed_profile: "medium (file scan); TTL cache 3s for the same query.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        query: z.string().optional().describe("What to find (meaning depends on kind). Required unless `queries`/`files_hint` is set."),
        queries: z
          .array(
            z.object({
              pattern: z.string().min(1).describe("Case-insensitive substring matched against each line."),
              must: flag01.optional().describe("1 = only lines containing this pattern count as hits (default 0)."),
              weight: z.number().int().optional().describe("Points added to a line's score when it matches this pattern (default 1)."),
            }),
          )
          .min(1)
          .max(8)
          .optional()
          .describe("Rank matching lines by several patterns: each matching pattern adds its weight to the line's score, and `must` patterns have to match. When set, `kind` and `query` are ignored and hits carry `score`/`matched`. Combine with `files_hint` to scan specific files."),
        files_hint: z
          .array(z.string().max(300))
          .max(20)
          .optional()
          .describe("Workspace paths to search when `queries` is set (first 20 are used). Omit to scan a shallow listing of `relative_path` instead."),
        kind: z.enum(["file_name", "directory_name", "literal_content", "definition"]).optional().describe("name substring | content (substring, or regex when regex=1) | declaration lines. Required unless `queries`/`files_hint` is set."),
        relative_path: path_.optional(),
        glob: z.string().optional().describe("rg glob filter ('*.ts' = any depth, 'tools/*.ts' = that dir)."),
        exclude_glob: z.string().optional().describe("rg glob exclusion (same dialect as glob)."),
        regex: flag01.optional().describe("1 treats query as a regular expression for literal_content/definition (default 0 = plain substring)."),
        case_sensitive: flag01.optional().describe("1 makes literal_content/definition matching case-sensitive (default 0)."),
        whole_word: flag01.optional().describe("1 = whole-word match only (rg -w / JS word boundaries) for literal_content and definition."),
        include_hidden: flag01.optional().describe("1 = include hidden files (default); 0 = skip dotfiles. Secrets always excluded."),
        context_lines: z.number().int().min(0).max(20).optional().describe("Context lines around each hit (default 0)."),
        count_only: flag01.optional().describe("1 returns only match counts; limit is then ignored. 0 (default) returns hits."),
        limit: z.number().int().min(1).max(200).optional().describe("Max hits returned (default and max 200; ignored when count_only=1)."),
        hybrid: flag01.optional().describe("1 = tag hits with source/confidence; literal_content only."),
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
    "project_recent_files",
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
        include_ignored: flag01.optional().describe("1 also lists ignored folders (default 0)."),
      },
    },
    (args) => runRecentFiles(args as Args, recentFilesDeps),
  );

  server.registerTool(
    "project_read_batch",
    {
      ...config(
        "Batch read",
        {
          speed_profile: "fastest for read-heavy work; sequential + cached, with a response budget.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      // Loose on purpose: `max_response_bytes_per_item` is accepted but not advertised (phase 7); a plain object
      // would strip it, so the handler reads and range-checks it itself.
      inputSchema: z.looseObject({
        requests: z
          .array(
            z.union([
              z.object({
                operation: z.literal("list_files").describe("Short op name for project_list_files."),
                arguments: readBatchListFilesArgs.describe("Same as project_list_files."),
              }),
              z.object({
                operation: z.literal("read_file").describe("Short op name for project_read_file."),
                arguments: readBatchReadFileArgs.describe("Same as project_read_file."),
              }),
              z.object({
                operation: z.literal("get_file_info").describe("Short op name for project_get_file_info."),
                arguments: readBatchGetFileInfoArgs.describe("Same as project_get_file_info."),
              }),
              z.object({
                operation: z.literal("search").describe("Short op name for project_search."),
                arguments: readBatchSearchArgs.describe("Same as project_search."),
              }),
            ]),
          )
          .min(1)
          .max(8)
          .describe("1-8 read items; one failing item does not stop the rest."),
      }),
    },
    (args) => {
      const itemBytes = (args as Args).max_response_bytes_per_item;
      const badBytes = checkItemBytes("read_batch", itemBytes, READ_ITEM_BYTES_MIN, READ_ITEM_BYTES_MAX);
      if (badBytes) return badBytes;
      return runReadBatch(args.requests, (itemBytes as number | undefined) ?? maxBatchItemBytes, batchDeps);
    },
  );

  server.registerTool(
    "project_write_file",
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
        mode: z.enum(["create", "overwrite", "append"]).optional().describe("Default overwrite. create fails if the path exists; append adds to the end."),
        create_dirs: flag01.optional().describe("1 creates missing parent directories (default 0)."),
        expected_sha256: z.string().optional().describe("Hex SHA-256 of the file's current full content. The write is refused if the file on disk differs. Use sha256_after from your last write/edit of this file; read_file's sha256 only matches when the whole file was returned."),
        reason: reason_,
      },
    },
    (args) => runOne("write_file", args),
  );

  server.registerTool(
    "project_edit_file",
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
        relative_path: path_,
        old_text: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Exact text to replace. Must match exactly once unless replace_all=1." +
              (fuzzy ? " With no exact match a near-match is used (fuzzy options below)." : "") +
              " Ignored when edits[] is given.",
          ),
        new_text: z.string().optional().describe("Replacement text (paired with old_text; ignored when edits[] is given)."),
        replace_all: flag01.optional().describe("1 replaces every match; 0 (default) requires exactly one match."),
        edits: z.array(editOp).max(64).optional().describe("Multiple section replacements in this file; takes precedence over old_text/new_text."),
        expected_sha256: z.string().optional().describe("Hex SHA-256 of the file's current full content. The edit is refused if the file on disk differs. Use sha256_after from your last write/edit of this file; read_file's sha256 only matches when the whole file was returned. When given, the result is re-read after the write and reports verified."),
        ...editFuzzyShape(fuzzy),
        reason: reason_,
      }),
    },
    (args) => runOne("edit_file", args),
  );
  server.registerTool(
    "project_edit_batch",
    {
      ...config(
        "Edit batch",
        {
          speed_profile: "depends on item count; each runs edit_file and clears caches.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ),
      // Loose for the same reason as project_read_batch: `max_response_bytes_per_item` is not advertised.
      inputSchema: z.looseObject({
        edits: z.array(editBatchItemFor(fuzzy)).min(1).max(64).describe("edit_file argument objects (typed like project_edit_file). Unknown fields are rejected with a did-you-mean hint and nothing is applied."),
      }),
    },
    (args) => runEditBatch(args as Args, batchDeps),
  );

  server.registerTool(
    "project_delete_path",
    {
      ...config("Delete path", {
        speed_profile: "fast; clears the read/list/search cache.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      inputSchema: {
        relative_path: path_.describe("Exact workspace path to delete."),
        recursive: flag01.optional().describe("1 = delete a directory recursively (required for directories); snapshot it first."),
        reason: reason_,
      },
    },
    (args) => runOne("delete_path", args),
  );
}
