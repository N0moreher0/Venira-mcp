import { existsSync, readFileSync } from "node:fs";

export type ToolTier = "allow" | "ask" | "deny";
export type ToolRule = {
  tool: string;
  tier: ToolTier;
  args?: Record<string, string>;
  reason?: string;
};

export type ToolDecision = {
  tier: ToolTier;
  tool: string;
  reason: string;
};

export function loadToolPolicy(): ToolRule[] {
  const inline = process.env.VENIRA_TOOL_POLICY_JSON;
  const file = process.env.VENIRA_TOOL_POLICY_FILE;

  let raw = "";
  let source = "";

  if (inline && inline.trim()) {
    raw = inline;
    source = "inline (VENIRA_TOOL_POLICY_JSON)";
  } else if (file) {
    if (!existsSync(file)) {
      console.error(`[tool-policy] file not found: ${file} (no tool policy applied)`);
      return [];
    }
    try {
      raw = readFileSync(file, "utf8");
      source = file;
    } catch (err) {
      console.error(`[tool-policy] invalid file ${file}: ${err}`);
      return [];
    }
  } else {
    return [];
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[tool-policy] invalid json source ${source}: ${err}`);
    return [];
  }

  const rules: ToolRule[] = [];
  if (!Array.isArray(parsed?.rules)) return rules;

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

  console.error(`[tool-policy] loaded ${rules.length} rule(s) from ${source}`);
  return rules;
}

export function evaluateToolPolicy(
  tool: string,
  args: Record<string, unknown>,
): ToolDecision | null {
  const rules = loadToolPolicy();
  if (rules.length === 0) return null;

  let best: { tier: ToolTier; reason: string } | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    if (rule.tool !== tool) continue;

    let matches = true;
    let score = 0;
    for (const [key, pattern] of Object.entries(rule.args ?? {})) {
      const value = args[key];
      if (pattern === "*") {
        score += 0;
        continue;
      }
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
