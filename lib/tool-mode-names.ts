/**
 * The canonical tool modes.
 *
 * Dependency-free on purpose: `lib/workspace.ts` (which gates `execute_js`) and
 * `tools/project-tool-mode.ts` (which owns the allowlists) must agree on the
 * list, and importing one from the other would create an import cycle.
 */
export const TOOL_MODES = ["default", "expert", "core", "minimal"] as const;

export type ToolModeName = (typeof TOOL_MODES)[number];

export function isToolModeName(value: string): value is ToolModeName {
  return (TOOL_MODES as readonly string[]).includes(value);
}
