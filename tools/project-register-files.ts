import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import type { Args } from "./project-cache.js";
import { runEditBatch, runReadBatch, type BatchDeps } from "./project-batch.js";
import { runHybridSearch, type HybridDeps } from "./project-hybrid.js";
import { runRecentFiles, type RecentFilesDeps } from "./project-recent.js";
import {
  config,
  editBatchItem,
  editOp,
  flag01,
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
};

export function registerFileTools(server: McpServer, deps: FileToolsDeps): void {
  const { runOne, hybridDeps, recentFilesDeps, batchDeps, maxBatchItemBytes } = deps;
  server.registerTool(
    "project_list_files",
    {
      ...config(
        "List files/directories in the workspace. depth 1..3 shows the tree in a single call.",
        "List files",
        {
          use_when: "you need to see the directory tree, check a path, or list files before reading.",
          avoid_when: "you only need one file's metadata (project_get_file_info) or one file's contents (project_read_file).",
          speed_profile: "fast; TTL cache 1.5s, auto-wiped on write/edit/delete.",
          output_kind: "file_list: entries, truncated, hint.",
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
        "Read a text file, optionally by line range (1-based). The result carries next_start_line when truncated.",
        "Read file",
        {
          use_when: "you need the contents of one file, or one line range of a large file.",
          avoid_when: "you need to read 2+ files (project_read_batch) or only need metadata (project_get_file_info).",
          speed_profile: "very fast on repeat; cache validated by mtime+size.",
          output_kind: "file_read: text, first_line, last_line, total_bytes, next_start_line.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        start_line: z.number().int().min(1).optional().describe("First line (1-based). Together with end_line it selects one line range. When truncated, read again with start_line=next_start_line."),
        end_line: z.number().int().min(1).optional().describe("Last line (1-based, inclusive)."),
        line_numbers: flag01.optional().describe("1 prefixes each line with its line number (default 0)."),
        max_bytes: z.number().int().min(1).max(1048576).optional().describe("Max text bytes returned (default 1,048,576 = 1 MiB, max 1 MiB)."),
        ranges: z
          .array(
            z.object({
              start_line: z.number().int().min(1).describe("First line (1-based)."),
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
        "File/directory metadata (kind, size, modification time).",
        "Get file info",
        {
          use_when: "you only need size/mtime/kind, or want to check that a path exists.",
          avoid_when: "you need the file's contents (project_read_file).",
          speed_profile: "very fast; cache validated by mtime+size.",
          output_kind: "file_info: relative_path, kind, size_bytes, modified_unix_seconds.",
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
        "Search by file name, directory name, content (literal or regex=1), or symbol declaration lines (definition).",
        "Search workspace",
        {
          use_when: "you need to find code/strings/symbols before reading; use kind=literal_content or definition.",
          avoid_when: "you already know the exact path to read.",
          speed_profile: "medium (file scan); TTL cache 3s for the same query.",
          output_kind:
            "search: hits (source+confidence when hybrid:1), complete, diagnostics, hint.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        query: z.string().describe("What to find (meaning depends on kind)."),
        kind: z.enum(["file_name", "directory_name", "literal_content", "definition"]).describe("name substring | content (substring, or regex when regex=1) | declaration lines."),
        relative_path: path_.optional(),
        glob: z.string().optional().describe("rg glob filter ('*.ts' = any depth, 'tools/*.ts' = that dir)."),
        exclude_glob: z.string().optional().describe("rg glob exclusion (same dialect as glob)."),
        regex: flag01.optional().describe("1 treats query as a regular expression for literal_content/definition (default 0 = plain substring)."),
        case_sensitive: flag01.optional().describe("1 makes literal_content/definition matching case-sensitive (default 0)."),
        whole_word: flag01.optional().describe("1 = whole-word match only (rg -w / JS word boundaries) for literal_content and definition."),
        include_hidden: flag01.optional().describe("1 = include hidden files (default); 0 = skip dotfiles. Secrets always excluded."),
        context_lines: z.number().int().min(0).max(20).optional().describe("Context lines around each hit (default 0)."),
        count_only: flag01.optional().describe("1 returns only match counts; limit is then ignored. 0 (default) returns hits."),
        limit: z.number().int().min(1).max(200).optional().describe("Max hits returned (ignored when count_only=1)."),
        hybrid: flag01.optional().describe("1 = tag hits with source/confidence; literal_content only."),
      },
    },
    (args) =>
      args.hybrid === true && args.kind === "literal_content"
        ? runHybridSearch(args as Args, hybridDeps)
        : runOne("search", args),
  );

  server.registerTool(
    "project_recent_files",
    {
      ...config(
        "List files modified most recently in the workspace, newest first, plus session_edits (files you already wrote this session). Cheap orientation call: use it at the start of a task, when resuming, before editing a file the user may have changed, and after shell/build/git steps to see what really changed (bounded filesystem scan, skips node_modules/target/.git).",
        "Recent files",
        {
          use_when: "starting or resuming a task, checking what the user or a command just changed (after shell/build/format/git), re-orienting after context loss, or picking the next files to feed into project_read_batch. Prefer it over listing a whole tree.",
          avoid_when: "you need the full list / by name (project_list_files) or content search (project_search).",
          speed_profile: "medium (filesystem walk); TTL cache 2s, bounded to 4000 files / 300 directories.",
          output_kind: "recent_files: entries[] sorted by mtime desc, scanned_files, truncated.",
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
        "Run up to 8 READ-ONLY ops (list_files, read_file, get_file_info, search) in one call; read/info use the cache so repeats are very fast. Each item takes the same arguments as the standalone tool, including numeric 0/1 flags (e.g. search regex, case_sensitive, hybrid).",
        "Batch read",
        {
          use_when: "you need to read 2+ files/ops in the same step (reading context, scanning several files).",
          avoid_when: "there is only a single op; or you need a mutating op (use the corresponding tool).",
          speed_profile: "fastest for read-heavy work; sequential + cached, with a response budget.",
          output_kind: "read_batch: responses[] (each item is an ok/error envelope).",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
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
        max_response_bytes_per_item: z.number().int().min(1024).max(2 * 1024 * 1024).optional().describe("Max serialized bytes per item (default 1 MiB)."),
      },
    },
    ({ requests, max_response_bytes_per_item }) =>
      runReadBatch(requests, max_response_bytes_per_item ?? maxBatchItemBytes, batchDeps),
  );

  server.registerTool(
    "project_write_file",
    {
      ...config(
        "Write a file. mode=create errors if it exists; overwrite replaces existing contents; append concatenates. Create and verify a scoped project_snapshot before overwriting existing file contents.",
        "Write file",
        {
          use_when: "create a new file or append content; before mode=overwrite on an existing file, create a scoped project_snapshot, confirm it captured the target, and keep the returned id.",
          avoid_when: "only a small section needs to change (project_edit_file), or an existing file would be overwritten without a verified pre-write project_snapshot.",
          speed_profile: "fast; clears the read/list/search cache for the affected path.",
          output_kind: "file_written: action, bytes_written, sha256_after.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        content: z.string().describe("Full file content to write."),
        mode: z.enum(["create", "overwrite", "append"]).optional().describe("Default overwrite: replaces existing contents; create and verify a scoped project_snapshot first. create fails if the path exists; append adds to the end."),
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
        "Edit a file by exact text replacement: one old_text/new_text pair, or edits[] for multiple sections (edits[] takes precedence over old_text/new_text). Supports TOCTOU guard mode (guard=sha256, which requires expected_sha256) for an atomic read-edit-verify cycle. Fuzzy matching of old_text needs VENIRA_EDIT_FUZZY=1 on the host.",
        "Edit file",
        {
          use_when: "change one or a few text sections whose exact content you know; pair with expected_sha256 to guard against blind overwrites. Use guard=sha256 for atomic read-edit-verify. Before editing 2+ files or 2+ sections, create a scoped project_snapshot and confirm coverage.",
          avoid_when: "the whole file must change (project_write_file), or you have not read the file to know old_text.",
          speed_profile: "fast; clears the read/list/search cache for the affected path.",
          output_kind: "file_written: replacements, sha256_before/after, verified (with guard=sha256).",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        old_text: z.string().min(1).optional().describe("Exact text to replace. Must match exactly once unless replace_all=1. With VENIRA_EDIT_FUZZY=1 a near-match is used instead when there is no exact match. Ignored when edits[] is given."),
        new_text: z.string().optional().describe("Replacement text (paired with old_text; ignored when edits[] is given)."),
        replace_all: flag01.optional().describe("1 replaces every match; 0 (default) requires exactly one match."),
        edits: z.array(editOp).max(64).optional().describe("Multiple section replacements in this file; takes precedence over old_text/new_text. Create a scoped project_snapshot first when applying 2+ edits or when the change is hard to recreate."),
        expected_sha256: z.string().optional().describe("Hex SHA-256 of the file's current full content. The edit is refused if the file on disk differs. Use sha256_after from your last write/edit of this file; read_file's sha256 only matches when the whole file was returned. With guard=sha256 this value is required."),
        old_text_fuzzy: z.string().optional().describe("Ignored: fuzzy matching applies to old_text when VENIRA_EDIT_FUZZY=1 is set. Send old_text instead."),
        fuzzy_distance: z.number().int().min(0).max(10).optional().describe("Max edit distance for fuzzy matching of old_text (default 3). Needs VENIRA_EDIT_FUZZY=1."),
        ignore_indentation: flag01.optional().describe("Fuzzy matching ignores leading whitespace. Fuzzy path only (needs VENIRA_EDIT_FUZZY=1)."),
        case_insensitive: flag01.optional().describe("Fuzzy matching ignores case. Fuzzy path only (needs VENIRA_EDIT_FUZZY=1)."),
        guard: z.enum(["sha256"]).optional().describe("TOCTOU guard: 'sha256' reads fresh content, verifies expected_sha256, applies edits, writes, then re-reads to verify content+sha256 match. Provides atomic read-edit-verify cycle. Requires expected_sha256."),
        reason: reason_,
      },
    },
    (args) => runOne("edit_file", args),
  );
  server.registerTool(
    "project_edit_batch",
    {
      ...config(
        "Apply multiple edit_file operations atomically in one call; aborts after the first failure and restores the pre-batch snapshot when possible.",
        "Edit batch",
        {
          use_when: "before editing existing files in a multi-edit batch, create a scoped project_snapshot when it spans multiple files/sections or needs rollback after later checks. Batch rollback covers an in-batch failure only; it does not undo a successful batch after tests fail.",
          avoid_when: "a single edit (project_edit_file) or a whole-file rewrite (project_write_file).",
          speed_profile: "depends on item count; each runs edit_file and clears caches.",
          output_kind: "batch: responses[] {ok, response|error}, atomic metadata with executed/skipped indexes and rollback status.",
          batch_safe: false,
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ),
      inputSchema: {
        edits: z.array(editBatchItem).min(1).max(64).describe("edit_file argument objects (typed like project_edit_file). Unknown fields are rejected with a did-you-mean hint and nothing is applied. Snapshot first when later checks may need a full rollback; automatic rollback covers in-batch failures only."),
        max_response_bytes_per_item: z.number().int().min(256).max(1048576).optional().describe("Max serialized bytes per edit item (default 1 MiB)."),
      },
    },
    (args) => runEditBatch(args as Args, batchDeps),
  );

  server.registerTool(
    "project_delete_path",
    {
      ...config("Delete a file or directory (directories require recursive=1). Create and verify a scoped snapshot before using this irreversible tool; do not delete if the checkpoint is incomplete.", "Delete path", {
        use_when: "only after creating a scoped project_snapshot for the exact target, confirming file_count/truncated/skipped cover the intended files, and keeping its id for recovery.",
        avoid_when: "the target is ambiguous or a pre-delete snapshot is missing, truncated, or skipped the target. This op is not undoable; capture and verify a checkpoint first.",
        speed_profile: "fast; clears the read/list/search cache.",
        output_kind: "path_deleted: entries_deleted, bytes_deleted.",
        batch_safe: false,
      }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      inputSchema: {
        relative_path: path_.describe("Exact workspace path to delete. Create a scoped project_snapshot first and confirm this target is captured; do not delete if it is skipped or the checkpoint is truncated."),
        recursive: flag01.optional().describe("For recursive directory deletion, set 1 only after confirming the target and creating a scoped project_snapshot; required for directory deletion."),
        reason: reason_,
      },
    },
    (args) => runOne("delete_path", args),
  );
}
