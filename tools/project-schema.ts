import { z } from "zod";
import { parseBackgroundFlag } from "../lib/env.js";

// Shared zod fragments and the tool-config builder used by every tool registration.
// Extracted from tools/project.ts (roadmap item 6, step 5i) so registration groups can import
// them without importing project.ts.

export const path_ = z.string().describe("Workspace-relative path.");
export const flag01 = z.number().int().min(0).max(1).transform((value) => value === 1).describe("1=on, 0=off.");
/** `background` accepts 0/1, booleans and strings so `false`/`"False"` works. */
export const backgroundFlag = z
  .union([z.number().int().min(0).max(1), z.boolean(), z.string().max(20)])
  .transform((value) => parseBackgroundFlag(value))
  .describe(
    "1/true = background (default): return immediately with run_id. " +
      "0/false = foreground: block until the command exits, then return the final stdout/stderr in this call.",
  );
export const reason_ = z
  .string()
  .max(400)
  .optional()
  .describe(
    "Why, in one line (max 400 chars). Audit-logged.",
  );
export const editOp = z.object({
  old_text: z.string().min(1),
  new_text: z.string(),
  replace_all: flag01.optional(),
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
