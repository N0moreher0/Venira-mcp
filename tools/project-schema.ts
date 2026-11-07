import { z } from "zod";
import { parseBackgroundFlag } from "../lib/env.js";

// Shared zod fragments and the tool-config builder used by every tool registration.
// Extracted from tools/project.ts (roadmap item 6, step 5i) so registration groups can import
// them without importing project.ts.

export const path_ = z.string().describe("Path inside the workspace (relative, or absolute inside the workspace)");
export const flag01 = z.number().int().min(0).max(1).transform((value) => value === 1).describe("Numeric flag: 1=enabled, 0=disabled.");
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
    "Why this change is made (e.g. \"sua loi null pointer o dong 45\"). Recorded in the audit trail so later sessions know the intent. Single line, max 400 chars, secrets are redacted.",
  );
export const editOp = z.object({
  old_text: z.string().min(1),
  new_text: z.string(),
  replace_all: flag01.optional(),
});

export type ToolMeta = {
  use_when: string;
  avoid_when: string;
  speed_profile: string;
  output_kind: string;
  batch_safe: boolean;
};

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
    description:
      `${base}\nUse when: ${meta.use_when}\nAvoid when: ${meta.avoid_when}\n` +
      `Speed: ${meta.speed_profile}\nOutput: ${meta.output_kind}\n` +
      `Batch-safe: ${meta.batch_safe ? "yes" : "no"}`,
    annotations,
    _meta: { venira: meta },
  };
}
