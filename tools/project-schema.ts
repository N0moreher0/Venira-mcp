import { z } from "zod";
import { parseBackgroundFlag } from "../lib/env.js";

// Shared zod fragments and the tool-config builder used by every tool registration.
// Extracted from tools/project.ts (roadmap item 6, step 5i) so registration groups can import
// them without importing project.ts.

/** One shared string for every path parameter (JSON Schema repeats it per use, so keep it short). */
export const PATH_DESC = "Workspace-relative ('.' = root); absolute/.. outside it rejected.";
export const path_ = z.string().describe(PATH_DESC);
/**
 * Boolean convention (item 16): tool flags are integer 0|1 in the published
 * JSON Schema (`.meta()` keeps tools/list integer), but the parser also
 * accepts `true`/`false` — LLMs are trained on booleans and would otherwise
 * send `true` and get a validation error back.
 */
export const flag01 = z
  .union([z.boolean(), z.number().int().min(0).max(1)])
  .transform((value) => value === true || value === 1)
  .meta({ type: "integer", minimum: 0, maximum: 1 });
/**
 * `project_shell_run.background` is advertised as the integer 0|1 like every other flag (ROADMAP_TOOL_SCHEMA.md,
 * phase 4), but the value is still normalised from the older shapes a cached client may send: `true`/`false`,
 * `"1"`/`"0"`, `"true"`/`"False"`. `.meta()` overrides only the JSON Schema, so `tools/list` stays integer
 * while `safeParse` keeps a permissive input; never advertise a union here again.
 */
export const backgroundFlag = z
  .unknown()
  .transform((value) => parseBackgroundFlag(value))
  .meta({ type: "integer", minimum: 0, maximum: 1 })
  .describe(
    "1 = background (default): return immediately with run_id. " +
      "0 = foreground: block until the command exits, then return the final stdout/stderr in this call.",
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
    "Optional why (max 400 chars), audit-logged.",
  );
/**
 * 1-based line number. Advertised as `minimum: 1` through `.meta()` (which overrides only the JSON Schema, like
 * `flag01`), but the parser stays permissive on purpose: `lib/corehost-fileread.ts` refuses `start_line < 1`
 * with an `[invalid_request]` error and a hint, which beats a generic validation error and does not break a
 * client that sends `0` (ROADMAP_TOOL_SCHEMA.md, phase 7).
 */
export const lineNo = z.number().int().meta({ minimum: 1 });
export const editOp = z.object({
  old_text: z.string().min(1).describe("Exact text to replace."),
  new_text: z.string().describe("Replacement text."),
  replace_all: flag01.describe("1 replaces every match; 0 (default) requires exactly one match."),
});

/**
 * Fuzzy-match options of `project_edit_file` and of every `project_edit_batch` item. They are only part of
 * the published schema when `VENIRA_EDIT_FUZZY=1` (ROADMAP_TOOL_SCHEMA.md, phase 3), like `project_execute_js`
 * and `VENIRA_JS_EXEC_MODE`; with the variable off the shape is empty and `lib/corehost-filewrite.ts` rejects
 * a caller that still sends them. Since they are only visible when fuzzy is on, the descriptions do not repeat
 * the variable name. Keys must match `EDIT_ITEM_FUZZY_KEYS` in `lib/arg-hints.ts`.
 */
export function editFuzzyShape(enabled: boolean) {
  if (!enabled) return {};
  return {
    fuzzy_distance: z.number().int().min(0).max(10).optional().describe("Max edit distance when old_text has no exact match (default 3)."),
    ignore_indentation: flag01.optional().describe("1 = fuzzy match ignores leading whitespace."),
    case_insensitive: flag01.optional().describe("1 = fuzzy match ignores case."),
  };
}

/**
 * One `project_edit_batch` item: the full `project_edit_file` shape.
 * Deliberately loose (unknown keys pass through): the runtime validator in
 * `lib/arg-hints.ts` (`EDIT_ITEM_KEYS`) rejects a misspelled key with a
 * did-you-mean message, so the schema must not strip or reject it first.
 * `relative_path` is optional here for the same reason — the handler enforces
 * it per item. Keep these keys in sync with `EDIT_ITEM_KEYS`; `fuzzy` decides
 * whether the fuzzy options are advertised (see `editFuzzyShape`).
 */
export function editBatchItemFor(fuzzy: boolean) {
  return z.looseObject({
    relative_path: path_.describe("File to edit (required per item)."),
    old_text: z.string().min(1).optional().describe("Exact text to replace (see project_edit_file)."),
    new_text: z.string().optional().describe("Replacement text (see project_edit_file)."),
    replace_all: flag01.optional().describe("1 replaces every match; 0 (default) requires exactly one match."),
    edits: z.array(editOp).max(64).optional().describe("Several replacements in this file; wins over old_text/new_text."),
    expected_sha256: z.string().optional().describe("Hex SHA-256 of the current full content; edit refused if it differs; when given, the result also reports verified."),
    ...editFuzzyShape(fuzzy),
    reason: reason_,
  });
}

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
 * Machine metadata a registration passes to `config()` (`_meta.venira`): the model gains nothing from it,
 * so it is never printed. All model-facing text (description, use/avoid/output lines) lives in
 * tools/project-docs.ts (`TOOL_DOCS`); `applyToolDocs` adds it to `_meta.venira` and the description.
 */
export type ToolMeta = {
  speed_profile: string;
  batch_safe: boolean;
};

type DescribedMeta = { use_when: string; avoid_when: string; output_kind: string };

/** Model-facing description: what it does, when to use it, what to use instead, what comes back. */
export function renderDescription(base: string, meta: DescribedMeta): string {
  return `${base}\nUse when: ${meta.use_when}\nAvoid when: ${meta.avoid_when}\nOutput: ${meta.output_kind}`;
}

/** No description here: `applyToolDocs` serves it from `TOOL_DOCS` (a tool without an entry fails `test:tool-schema`). */
export function config(
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
    annotations,
    _meta: { venira: meta },
  };
}
