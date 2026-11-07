import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WORKSPACE } from "../lib/workspace.js";

type ToolMode = "default" | "expert";

/**
 * Per-mode tool exclusions layered on top of `VENIRA_DISABLE_TOOLS` and the
 * `VENIRA_PROFILE=core` preset. `expert` keeps the full set (everything the
 * server can do: shell, JS eval, CI/CD shipping, secrets, intel); `default` is
 * the **full sandbox coding toolset** — all specialized tools for reading,
 * writing, editing, searching, code intelligence, diagnostics, snapshots,
 * config, **shell execution, JS execution**; only excludes CI/CD shipping
 * (PR/CI tools). `project_delete_path` is available in both modes — shell
 * `rm -rf` / `rd /s` / `Remove-Item -Recurse -Force` are hard-denied by shell
 * policy in every mode, so `project_delete_path` is the controlled, auditable
 * deletion path.
 */
const TOOL_MODE_EXCLUDES: Record<ToolMode, string[]> = {
  expert: [],
  default: [
    "project_ci_status",
    "project_ci_trigger",
    "project_ci_logs",
    "project_ci_wait",
    "project_ci_control",
    "project_pr_create",
    "project_pr_comment",
    "project_pr_merge",
    "project_pr_list",
    "project_pr_close",
    "project_pr_reopen",
  ],
};

function resolveToolMode(): ToolMode {
  const raw = (process.env.VENIRA_TOOL_MODE ?? "").trim().toLowerCase();
  if (raw === "expert" || raw === "default") return raw;
  try {
    const file = path.join(WORKSPACE, "venira.config.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { toolMode?: unknown };
    const candidate = String(parsed?.toolMode ?? "").trim().toLowerCase();
    if (candidate === "expert" || candidate === "default") return candidate;
  } catch {
    /* no config -> default */
  }
  return "default";
}

/**
 * Tool modes (default/expert) + `VENIRA_DISABLE_TOOLS` (deployment-level)
 * keep tools out of `tools/list` entirely, so a client can never call them.
 * Mode exclusions layer on top of the disable list; `expert` keeps the full set.
 */
export function applyDisabledTools(server: McpServer): void {
  const profile = (process.env.VENIRA_PROFILE ?? "full").toLowerCase();
  const disabled = (process.env.VENIRA_DISABLE_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const mode = resolveToolMode();
  const modeExcludes = TOOL_MODE_EXCLUDES[mode];
  if (profile === "core") {
    disabled.push(
      "project_execute_js",
      "project_outline_symbol",
      "project_diff_files",
      "project_symbol_references",
      "project_selective_search",
      "project_recent_files",
      "project_dependency_graph",
      "project_change_impact",
    );
  }
  const blocked = new Set<string>([...disabled, ...modeExcludes]);
  if (blocked.size === 0) return;
  const original = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
  server.registerTool = ((name: string, ...rest: unknown[]) =>
    blocked.has(name) ? undefined : original(name, ...rest)) as unknown as typeof server.registerTool;
  console.error(`[venira-coding] disabled tools (${mode}): ${[...blocked].join(", ")}`);
}
