import { z } from "zod";
import { parseBackgroundFlag } from "../lib/env.js";

// Shared zod fragments and the tool-config builder used by every tool registration.
// Extracted from tools/project.ts (roadmap item 6, step 5i) so registration groups can import
// them without importing project.ts.

export const path_ = z.string().describe("Workspace-relative path.");
/**
 * Boolean convention (item 16): every boolean flag on every tool is the integer 0|1.
 * The only exception is `project_shell_run.background`, which additionally accepts
 * true/false/"1"/"0" so clients that send JSON booleans keep working.
 */
export const flag01 = z.number().int().min(0).max(1).transform((value) => value === 1).describe("1=on, 0=off.");
/** `background` accepts 0/1, booleans and strings so `false`/`"False"` works. */
export const backgroundFlag = z
  .union([z.number().int().min(0).max(1), z.boolean(), z.string().max(20)])
  .transform((value) => parseBackgroundFlag(value))
  .describe(
    "1/true = background (default): return immediately with run_id. " +
      "0/false = foreground: block until the command exits, then return the final stdout/stderr in this call. " +
      "This is the one boolean flag that is not integer-only.",
  );
/**
 * `reason` rule (item 16): optional on every tool, audit-logged when provided.
 * The only required `reason` is on `project_ci_control` (remote CI effect).
 * Note: audit rows currently store the reason text; see roadmap item 15.
 */
export const reason_ = z
  .string()
  .max(400)
  .optional()
  .describe(
    "Optional why (max 400 chars), audit-logged. Required only on project_ci_control.",
  );
export const editOp = z.object({
  old_text: z.string().min(1).describe("Exact text to replace."),
  new_text: z.string().describe("Replacement text."),
  replace_all: flag01.describe("1 replaces every match; 0 (default) requires exactly one match."),
});

/**
 * One `project_edit_batch` item: the full `project_edit_file` shape.
 * Deliberately loose (unknown keys pass through): the runtime validator in
 * `lib/arg-hints.ts` (`EDIT_ITEM_KEYS`) rejects a misspelled key with a
 * did-you-mean message, so the schema must not strip or reject it first.
 * `relative_path` is optional here for the same reason — the handler enforces
 * it per item. Keep these keys in sync with `EDIT_ITEM_KEYS`.
 */
export const editBatchItem = z.looseObject({
  relative_path: path_.describe("File to edit (required per item)."),
  old_text: z.string().min(1).optional().describe("Exact text to replace (see project_edit_file)."),
  new_text: z.string().optional().describe("Replacement text (see project_edit_file)."),
  replace_all: flag01.optional(),
  edits: z.array(editOp).max(64).optional().describe("Several replacements in this file; wins over old_text/new_text."),
  expected_sha256: z.string().optional().describe("Hex SHA-256 of the current full content; edit refused if it differs. Required with guard=sha256."),
  old_text_fuzzy: z.string().optional().describe("Ignored: fuzzy applies to old_text (needs VENIRA_EDIT_FUZZY=1)."),
  fuzzy_distance: z.number().int().min(0).max(10).optional().describe("Fuzzy max edit distance (default 3). Needs VENIRA_EDIT_FUZZY=1."),
  ignore_indentation: flag01.optional().describe("Fuzzy ignores leading whitespace (needs VENIRA_EDIT_FUZZY=1)."),
  case_insensitive: flag01.optional().describe("Fuzzy ignores case (needs VENIRA_EDIT_FUZZY=1)."),
  guard: z.enum(["sha256"]).optional().describe("Atomic read-edit-verify; requires expected_sha256."),
  reason: reason_,
});

/**
 * `project_read_batch` arguments, keyed by `operation`: each variant is a loose
 * object holding exactly that standalone tool's parameters (with integer 0|1
 * flags left as numbers — the batch runner normalizes them, see
 * `tools/project-batch.ts` `normalizeBatchArgs`). Fields are optional here so a
 * bad item fails only itself (matching the documented per-item isolation);
 * required fields per operation are named in the describes. The shape is the
 * point: an LLM can call each operation correctly from this alone.
 */
export const readBatchListFilesArgs = z.looseObject({
  relative_path: path_.optional(),
  include_ignored: flag01.optional().describe("1 also lists ignored folders (default 0)."),
  limit: z.number().int().min(1).max(200).optional().describe("Max entries (default 200, max 200)."),
  depth: z.number().int().min(1).max(3).optional().describe("Tree depth (default 1, max 3)."),
});
export const readBatchReadFileArgs = z.looseObject({
  relative_path: path_.optional().describe("Required (optional here so one bad item fails only itself)."),
  start_line: z.number().int().min(1).optional().describe("First line (1-based)."),
  end_line: z.number().int().min(1).optional().describe("Last line (1-based)."),
  line_numbers: flag01.optional().describe("1 prefixes lines (default 0)."),
  max_bytes: z.number().int().min(1).max(1_048_576).optional().describe("Max bytes returned (default 1 MiB)."),
  ranges: z.array(z.object({ start_line: z.number().int().min(1).describe("First line (1-based)."), end_line: z.number().int().min(1).optional().describe("Last line (1-based)."), max_bytes: z.number().int().min(1).optional().describe("Max bytes for this range.") })).min(1).max(16).optional().describe("Disjoint ranges (max 16)."),
});
export const readBatchGetFileInfoArgs = z.looseObject({
  relative_path: path_.optional().describe("Required (optional here so one bad item fails only itself)."),
});
export const readBatchSearchArgs = z.looseObject({
  query: z.string().optional().describe("Required; see kind."),
  kind: z.enum(["file_name", "directory_name", "literal_content", "definition"]).optional().describe("Required: name substring | content | declaration lines."),
  relative_path: path_.optional(),
  glob: z.string().optional().describe("rg glob filter ('*.ts' = any depth)."),
  exclude_glob: z.string().optional().describe("rg glob exclusion (same dialect as glob)."),
  regex: flag01.optional().describe("1 = regex query (default 0)."),
  case_sensitive: flag01.optional().describe("1 = case-sensitive (default 0)."),
  whole_word: flag01.optional().describe("1 = whole-word only (default 0)."),
  include_hidden: flag01.optional().describe("1 includes dotfiles (default); 0 skips them."),
  context_lines: z.number().int().min(0).max(20).optional().describe("Context lines per hit (default 0)."),
  count_only: flag01.optional().describe("1 = counts only (default 0)."),
  limit: z.number().int().min(1).max(200).optional().describe("Max hits (ignored when count_only=1)."),
  hybrid: flag01.optional().describe("1 tags hits with source (default 0)."),
});

/**
 * `use_when` / `avoid_when` / `output_kind` are rendered into the model-facing description.
 * `speed_profile` / `batch_safe` are machine metadata only (`_meta.venira`): the model gains nothing
 * from them, so they are not printed. Final wording lives in tools/project-docs.ts.
 */
export type ToolMeta = {
  use_when: string;
  avoid_when: string;
  speed_profile: string;
  output_kind: string;
  batch_safe: boolean;
};

/** Model-facing description: what it does, when to use it, what to use instead, what comes back. */
export function renderDescription(base: string, meta: Pick<ToolMeta, "use_when" | "avoid_when" | "output_kind">): string {
  return `${base}\nUse when: ${meta.use_when}\nAvoid when: ${meta.avoid_when}\nOutput: ${meta.output_kind}`;
}

export function config(
  base: string,
  title: string,
  meta: ToolMeta,
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  },
) {
  return {
    title,
    description: renderDescription(base, meta),
    annotations,
    _meta: { venira: meta },
  };
}
