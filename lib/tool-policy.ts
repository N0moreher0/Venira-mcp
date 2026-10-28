/**
 * Tool-level policy for `venira-mcp` MCP tools.
 *
 * `VENIRA_TOOL_POLICY_FILE` points to a JSON file (never read from the
 * workspace itself — a cloned repo cannot ship a permissive tool policy
 * for itself). Each entry matches a tool name and optionally specific
 * argument values, and declares a tier:
 *
 *   - "deny"  → the tool call is rejected with a non-retryable envelope.
 *   - "ask"   → the tool call returns an approval-required envelope.
 *   - "allow" → the tool call proceeds without further gating.
 *
 * Default (no file): every tool runs.  The shell policy
 * (`lib/shell-policy.ts`) still applies on top for `project_shell_run`.
 *
 * File format (JSONC):
 * ```jsonc
 * {
 *   "rules": [
 *     { "tool": "project_delete_path", "tier": "deny",
 *       "args": { "recursive": true },
 *       "reason": "Recursive deletion is destructive." },
 *     { "tool": "project_shell_run", "tier": "ask",
 *       "args": { "command": "/^(curl|wget)/" },
 *       "reason": "Network commands need approval." },
 *     { "tool": "project_write_file", "tier": "allow" }
 *   ]
 * }
 * ```
 *
 * `args` matching:
 *   - string value  → exact match against the tool argument
 *   - string value starting with "/" → treated as a RegExp source
 *   - `*` or omitted → wildcard (matches anything)
 */
import { existsSync, readFileSync } from "node:fs";

export type ToolTier = "allow" | "ask" | "deny";

export type ToolRule = {
  tool: string;
  tier: ToolTier;
  /** Optional argument constraints. Keys are arg names; values are
   *  exact-match strings or regex sources (leading "/"). */
  args?: Record<string, string>;
  reason?: string;
};

export type ToolDecision = {
  tier: ToolTier;
  tool: string;
  reason: string;
};

/**
 * Load tool rules from `VENIRA_TOOL_POLICY_FILE`. Cached after first call.
 * Returns an empty array when no file is set — i.e. no tool-level policy.
 */
export function loadToolPolicy(): ToolRule[] {
  const file = process.env.VENIRA_TOOL_POLICY_FILE;
  if (!file) return [];
  if (!existsSync(file)) {
    console.error(`[tool-policy] file not found: ${file} (no tool policy applied)`);
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { rules?: unknown };
    const rules: ToolRule[] = [];
    if (!Array.isArray(parsed.rules)) return rules;
    for (const entry of parsed.rules) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.tool !== "string" || !e.tool) continue;
      const tier = (e.tier === "deny" || e.tier === "ask" || e.tier === "allow")
        ? e.tier as ToolTier
        : "deny";
      const args: Record<string, string> = {};
      if (e.args && typeof e.args === "object") {
        for (const [k, v] of Object.entries(e.args)) {
          if (typeof v === "string") args[k] = v;
        }
      }
      rules.push({
        tool: e.tool,
        tier,
        args,
        reason: typeof e.reason === "string" ? e.reason : "",
      });
    }
    console.error(`[tool-policy] loaded ${rules.length} rule(s) from ${file}`);
    return rules;
  } catch (err) {
    console.error(`[tool-policy] invalid file ${file}: ${err}`);
    return [];
  }
}

/**
 * Evaluate a tool call against the policy.
 * Returns `null` when no rule matches (default: allow).
 */
export function evaluateToolPolicy(
  tool: string,
  args: Record<string, unknown>,
): ToolDecision | null {
  const rules = loadToolPolicy();
  if (rules.length === 0) return null;

  // Most specific rule wins: deny > ask > allow; within same tier, more
  // args constraints wins.
  let best: { tier: ToolTier; reason: string } | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    if (rule.tool !== tool) continue;

    // Check args match
    let matches = true;
    let score = 0;
    for (const [key, pattern] of Object.entries(rule.args ?? {})) {
      const value = args[key];
      if (pattern === "*") {
        score += 0; // wildcard adds no specificity
        continue;
      }
      // RegExp source: string starts with "/"
      if (pattern.startsWith("/") && pattern.length > 1) {
        const source = pattern.slice(1);
        try {
          if (!new RegExp(source, "i").test(String(value ?? ""))) {
            matches = false;
            break;
          }
        } catch {
          matches = false;
          break;
        }
      } else if (String(value ?? "") !== pattern) {
        matches = false;
        break;
      }
      score += 1;
    }
    if (!matches) continue;

    const tierScore: Record<ToolTier, number> = { deny: 3, ask: 2, allow: 1 };
    const total = tierScore[rule.tier] * 10 + score;
    if (total > bestScore) {
      best = { tier: rule.tier, reason: rule.reason || `Rule: ${rule.tool} (${rule.tier})` };
      bestScore = total;
    }
  }

  if (!best) return null;
  return { tier: best.tier, tool, reason: best.reason };
}
