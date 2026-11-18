import { z } from "zod";
import { parseBackgroundFlag } from "../lib/env.js";

// Shared zod fragments and the tool-config builder used by every tool registration.
// Extracted from tools/project.ts (roadmap item 6, step 5i) so registration groups can import
// them without importing project.ts.

/** One shared string for every path parameter (JSON Schema repeats it per use, so keep it short). */
export const PATH_DESC = "Workspace-relative ('.' = root); absolute/.. outside it rejected.";
export const path_ = z.string().describe(PATH_DESC);
/**
 * Boolean convention (item 20): tool flags are advertised as a bare JSON Schema `{ "type": "boolean" }` and the
 * descriptions say true/false. The base is `z.unknown()` on purpose: `.meta()` only adds keys on top of what zod
 * derives from the input side, so a `z.union([boolean, integer 0|1])` input kept an `anyOf` with the integer
 * branch in `tools/list` (~70 B per flag) even with `type: "boolean"` set. The transform still accepts
 * `true`/`false` and the integers `1`/`0` that older prompts and cached clients send, and refuses anything else
 * with a validation error, like the union did.
 */
export const flag01 = z
  .unknown()
  .transform((value, ctx) => {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    ctx.issues.push({ code: "custom", message: "Invalid input: expected true or false", input: value });
    return z.NEVER;
  })
  .meta({ type: "boolean" });
/**
 * `shell_run.background` is advertised as a boolean like every other flag (item 20), but the value is still
 * normalised from the older shapes a cached client may send: `1`/`0`, `"1"`/`"0"`, `"true"`/`"False"`.
 * `.meta()` overrides only the JSON Schema, so `tools/list` stays boolean while `safeParse` keeps a permissive
 * input.
 */
export const backgroundFlag = z
  .unknown()
  .transform((value) => parseBackgroundFlag(value))
  .meta({ type: "boolean" })
  .describe(
    "true = background (default): return immediately with run_id. " +
      "false = foreground: block until the command exits, then return the final stdout/stderr in this call.",
  );
/**
 * `reason` rule (item 16): optional on every tool, audit-logged when provided.
 * The only required `reason` is on `ci_control` (remote CI effect).
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
  replace_all: flag01.describe("true replaces every match; false (default) requires exactly one match."),
});

/**
 * Fuzzy-match options of `edit_file` (advertised in the `edit_file` schema only). They are only part of
 * the published schema when `VENIRA_EDIT_FUZZY=1` (ROADMAP_TOOL_SCHEMA.md, phase 3), like `execute_js`
 * and `VENIRA_JS_EXEC_MODE`; with the variable off the shape is empty and `lib/corehost-filewrite.ts` rejects
 * a caller that still sends them. Since they are only visible when fuzzy is on, the descriptions do not repeat
 * the variable name. Keys must match `EDIT_ITEM_FUZZY_KEYS` in `lib/arg-hints.ts`.
 */
export function editFuzzyShape(enabled: boolean) {
  if (!enabled) return {};
  return {
    fuzzy_distance: z.number().int().min(0).max(10).optional().describe("Max edit distance when old_text has no exact match (default 3)."),
    ignore_indentation: flag01.optional().describe("true = fuzzy match ignores leading whitespace."),
    case_insensitive: flag01.optional().describe("true = fuzzy match ignores case."),
  };
}

/**
 * `edit_file` / multi-file edit items: the full `edit_file` shape.
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
    old_text: z.string().min(1).optional().describe("Exact text to replace (see edit_file)."),
    new_text: z.string().optional().describe("Replacement text (see edit_file)."),
    replace_all: flag01.optional().describe("true replaces every match; false (default) requires exactly one match."),
    edits: z.array(editOp).max(64).optional().describe("Several replacements in this file; wins over old_text/new_text."),
    expected_sha256: z.string().optional().describe("Hex SHA-256 of the current full content; edit refused if it differs; when given, the result also reports verified."),
    ...editFuzzyShape(fuzzy),
    reason: reason_,
  });
}

/**
 * `read_file` items of a multi-file call (`requests[]`): the full read_file shape.
 * Deliberately loose (unknown keys pass through) and optional per field so a single bad item
 * fails only itself instead of killing the whole multi-file call. The handler in
 * `tools/project-batch.ts` (`checkReadItemKeys`) enforces `relative_path` per item with a
 * did-you-mean message for misspellings.
 */
export const readFileRequestArgs = z.looseObject({
  relative_path: path_.optional().describe("Required (optional here so one bad item fails only itself)."),
  start_line: z.number().int().min(1).optional().describe("First line (1-based)."),
  end_line: z.number().int().min(1).optional().describe("Last line (1-based)."),
  line_numbers: flag01.optional().describe("true prefixes lines (default false)."),
  max_bytes: z.number().int().min(1).max(1_048_576).optional().describe("Max bytes returned (default 1 MiB)."),
  ranges: z.array(z.object({ start_line: z.number().int().min(1).describe("First line (1-based)."), end_line: z.number().int().min(1).optional().describe("Last line (1-based)."), max_bytes: z.number().int().min(1).optional().describe("Max bytes for this range.") })).min(1).max(16).optional().describe("Disjoint ranges (max 16)."),
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
