import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setupToolsEnabled } from "../lib/env.js";
import { isToolModeName, type ToolModeName } from "../lib/tool-mode-names.js";
import { effectiveToolMode } from "../lib/workspace.js";

/**
 * Tool modes choose the tools/list surface; one variable: VENIRA_TOOL_MODE.
 *   `expert`  - everything the server can do (shell, JS eval, CI/CD shipping,
 *               secrets, intel).
 *   `default` - the **full sandbox coding toolset** (reading, writing, editing,
 *               searching, code intelligence, diagnostics, snapshots, config,
 *               **shell execution, JS execution**); only excludes the CI/CD
 *               shipping surface (PR/CI tools) plus the two diagnostics-planning
 *               tools, which are expert-only.
 *   `core`    - the small-model / restricted-context preset. Like `minimal`
 *               it is an **allowlist** (`CORE_TOOLS`): only the must-have
 *               tools are advertised (shell, execute_js, read, search, list, recent_files,
 *               outline_symbol,
 *               edit/write/create/move/delete, snapshot, git, memory,
 *               switch_workspace), every other tool stays out
 *               of `tools/list` — including tools added later — because each
 *               one costs schema tokens on every prompt. `delete_path` stays
 *               available: shell `rm -rf` / `rd /s` / `Remove-Item -Recurse
 *               -Force` are hard-denied by shell policy in every mode, so
 *               `delete_path` is the controlled, auditable deletion path.
 *               The setup tools (`detect_harnesses`, `install_self`) are the
 *               one exception: they join core only with `VENIRA_SETUP_TOOLS=1`.
 *   `minimal` - the one-door preset. `tools/list` carries **one** tool
 *               (`execute_js`); every read/edit/search/shell/git goes through the
 *               compact JS SDK that the tool description ships, so a model batches
 *               many operations into one call instead of paying for 30+ schemas.
 *               `shell_status` stays a real tool because a background command
 *               outlives the snippet that started it (it also carries the merged
 *               `shell_cancel`, see MINIMAL_TOOLS).
 * `VENIRA_DISABLE_TOOLS` layers a comma-separated blocklist on top of the
 * chosen mode. `VENIRA_PROFILE` was removed and folded into `core`.
 */
export type ToolMode = ToolModeName;

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

/**
 * Setup-time tools: registered (and listed) only with `VENIRA_SETUP_TOOLS=1`
 * (tools/project-register-workflow.ts). They are a separate group, not part of
 * any mode's regular surface.
 */
export const SETUP_TOOLS: readonly string[] = ["detect_harnesses", "install_self"];

/**
 * `core` allowlist: the must-have tools, grouped by job. Keep it small; a tool
 * that is not listed here is not advertised in core, whatever it does.
 */
export const CORE_TOOLS: readonly string[] = [
  // shell (shell_run runs in the background by default, so status/cancel come with it)
  "shell_run",
  "shell_status",
  "shell_cancel",
  // JavaScript execution (still gated by VENIRA_JS_EXEC_MODE)
  "execute_js",
  // read / search / list
  "read_file",
  "search",
  "list_files",
  "recent_files",
  "outline_symbol",
  // edit
  "edit_file",
  "write_file",
  "delete_path",
  "create",
  "move_path",
  // checkpoint
  "snapshot",
  // git
  "git",
  // handoff note that outlives the chat
  "memory",
  // runtime re-root for clients that spawn the server once (still scoped by VENIRA_SECURITY_PROFILE)
  "switch_workspace",
];

/**
 * `minimal` allowlist: the one-door preset.
 *
 * `execute_js` is the door; `shell_status` stays because a background command
 * (shell_run runs in the background by default) outlives the snippet that started
 * it, so the model needs a real tool to poll it from the NEXT turn. In this mode
 * `shell_status` also carries the merged `shell_cancel` (action="cancel" +
 * kill_key), so `shell_cancel` itself is not advertised.
 */
export const MINIMAL_TOOLS: readonly string[] = ["execute_js", "shell_status"];

/** Exclusion lists for the modes that are defined by what they leave out. `core` and `minimal` are allowlists. */
export const TOOL_MODE_EXCLUDES: Record<Exclude<ToolMode, "core" | "minimal">, string[]> = {
  expert: [],
  default: [...SHIPPING_EXCLUDES],
};

/** True when `mode` keeps `name` out of tools/list (VENIRA_DISABLE_TOOLS is layered separately). */
export function modeBlocksTool(mode: ToolMode, name: string, setupTools: boolean = setupToolsEnabled()): boolean {
  if (mode === "core") {
    if (CORE_TOOLS.includes(name)) return false;
    return !(setupTools && SETUP_TOOLS.includes(name));
  }
  if (mode === "minimal") {
    if (MINIMAL_TOOLS.includes(name)) return false;
    return !(setupTools && SETUP_TOOLS.includes(name));
  }
  return TOOL_MODE_EXCLUDES[mode].includes(name);
}

export function getToolMode(): ToolMode {
  return effectiveToolMode();
}

/**
 * Tool modes (default/expert/core) + `VENIRA_DISABLE_TOOLS` (deployment-level)
 * keep tools out of `tools/list` entirely, so a client can never call them.
 * Mode exclusions layer on top of the disable list; `expert` keeps the full set.
 */
export function applyDisabledTools(server: McpServer): void {
  const disabled = new Set(
    (process.env.VENIRA_DISABLE_TOOLS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const mode = getToolMode();
  const setupTools = setupToolsEnabled();
  if (mode === "expert" && disabled.size === 0) return;
  const blocked = (name: string): boolean => disabled.has(name) || modeBlocksTool(mode, name, setupTools);
  const original = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
  server.registerTool = ((name: string, ...rest: unknown[]) =>
    blocked(name) ? undefined : original(name, ...rest)) as unknown as typeof server.registerTool;
  if (mode === "core") {
    const allowed = [...CORE_TOOLS, ...(setupTools ? SETUP_TOOLS : [])].filter((name) => !disabled.has(name));
    console.error(`[venira-coding] tool mode core: allowlist of ${allowed.length} tools: ${allowed.join(", ")}`);
  } else if (mode === "minimal") {
    const allowed = [...MINIMAL_TOOLS, ...(setupTools ? SETUP_TOOLS : [])].filter((name) => !disabled.has(name));
    console.error(`[venira-coding] tool mode minimal: allowlist of ${allowed.length} tools: ${allowed.join(", ")}`);
  } else {
    const names = [...new Set([...disabled, ...TOOL_MODE_EXCLUDES[mode]])];
    console.error(`[venira-coding] disabled tools (${mode}): ${names.join(", ")}`);
  }
}
