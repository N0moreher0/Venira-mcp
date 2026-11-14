import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WORKSPACE } from "../lib/workspace.js";

/**
 * Tool modes choose the tools/list surface; one variable: VENIRA_TOOL_MODE.
 *   `expert`  - everything the server can do (shell, JS eval, CI/CD shipping,
 *               secrets, intel).
 *   `default` - the **full sandbox coding toolset** (reading, writing, editing,
 *               searching, code intelligence, diagnostics, snapshots, config,
 *               **shell execution, JS execution**); only excludes the CI/CD
 *               shipping surface (PR/CI tools) plus the two diagnostics-planning
 *               tools, which are expert-only.
 *   `core`    - the small-model / restricted-context preset: `default` minus the
 *               code-intelligence tools (they cost schema tokens on every
 *               prompt). `delete_path` stays available in every mode —
 *               shell `rm -rf` / `rd /s` / `Remove-Item -Recurse -Force` are
 *               hard-denied by shell policy in every mode, so `delete_path`
 *               is the controlled, auditable deletion path.
 * `VENIRA_DISABLE_TOOLS` layers a comma-separated blocklist on top of the
 * chosen mode. `VENIRA_PROFILE` was removed and folded into `core`.
 */
export type ToolMode = "default" | "expert" | "core";

/** Shipping surface (PR/CI) + diagnostics planning kit: default excludes these. */
const SHIPPING_EXCLUDES = [
  // Shipping surface (PR/CI).
  "ci_status",
  "ci_trigger",
  "ci_logs",
  "ci_wait",
  "ci_control",
  "pr_create",
  "pr_comment",
  "pr_merge",
  "pr_list",
  "pr_close",
  "pr_reopen",
  // Diagnostics planning kit: explain_error and plan_read_batch.
  // The envelope already carries hint + next_actions, which is enough for the
  // common case; these two are for agents that want the explicit call. They
  // cost schema tokens in every prompt, so they are expert-only.
  "explain_error",
  "plan_read_batch",
];

/** Code-intelligence surface: core excludes these (on top of the shipping set). */
const CODE_INTEL_EXCLUDES = [
  "execute_js",
  "outline_symbol",
  "diff_files",
  "symbol_references",
  "recent_files",
  "dependency_graph",
  "change_impact",
];

export const TOOL_MODE_EXCLUDES: Record<ToolMode, string[]> = {
  expert: [],
  default: [...SHIPPING_EXCLUDES],
  core: [...SHIPPING_EXCLUDES, ...CODE_INTEL_EXCLUDES],
};

function resolveToolMode(): ToolMode {
  const raw = (process.env.VENIRA_TOOL_MODE ?? "").trim().toLowerCase();
  if (raw === "expert" || raw === "default" || raw === "core") return raw;
  try {
    const file = path.join(WORKSPACE, "venira.config.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { toolMode?: unknown };
    const candidate = String(parsed?.toolMode ?? "").trim().toLowerCase();
    if (candidate === "expert" || candidate === "default" || candidate === "core") return candidate;
  } catch {
    /* no config -> default */
  }
  return "default";
}

/**
 * Tool modes (default/expert/core) + `VENIRA_DISABLE_TOOLS` (deployment-level)
 * keep tools out of `tools/list` entirely, so a client can never call them.
 * Mode exclusions layer on top of the disable list; `expert` keeps the full set.
 */
export function applyDisabledTools(server: McpServer): void {
  const disabled = (process.env.VENIRA_DISABLE_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const mode = resolveToolMode();
  const modeExcludes = TOOL_MODE_EXCLUDES[mode];
  const blocked = new Set<string>([...disabled, ...modeExcludes]);
  if (blocked.size === 0) return;
  const original = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
  server.registerTool = ((name: string, ...rest: unknown[]) =>
    blocked.has(name) ? undefined : original(name, ...rest)) as unknown as typeof server.registerTool;
  console.error(`[venira-coding] disabled tools (${mode}): ${[...blocked].join(", ")}`);
}
