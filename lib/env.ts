import { resolveSecurityProfile } from "./security-profile.js";
import { ENV_FLAG_NAMES, checkEnvironment } from "./env-registry.js";

export function envFlag(name: string, defaultValue: boolean, value = process.env[name]): boolean {
  if (value === undefined) return defaultValue;
  if (value === "0") return false;
  if (value === "1") return true;
  throw new Error(`[config_invalid] ${name} must be "0" or "1".`);
}

export function envFlagValue(name: string, value: string | undefined, defaultValue: boolean): boolean {
  return envFlag(name, defaultValue, value);
}

/**
 * `VENIRA_EDIT_FUZZY=1`: project_edit_file may fall back to fuzzy matching. Read at call time so tests can
 * flip it. The tool schemas are built from it when the tools are registered (ROADMAP_TOOL_SCHEMA.md,
 * phase 3): `fuzzy_distance`, `ignore_indentation` and `case_insensitive` are only advertised when it is on.
 */
export function editFuzzyEnabled(): boolean {
  return envFlag("VENIRA_EDIT_FUZZY", false);
}

/**
 * `VENIRA_SETUP_TOOLS=1`: advertise the one-time setup tools (`project_detect_harnesses`, `project_install_self`)
 * in `tools/list`. Off by default (ROADMAP_TOOL_SCHEMA.md, phase 8 patch 2): they are only used when wiring Venira
 * into a client, and `npx venira-mcp --install` / `--print-config` do the same job from a terminal. Read when the
 * tools are registered, so it changes `tools/list` after a restart.
 */
export function setupToolsEnabled(): boolean {
  return envFlag("VENIRA_SETUP_TOOLS", false);
}

export function envChoice<const T extends readonly string[]>(
  name: string,
  defaultValue: T[number],
  choices: T,
): T[number] {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const value = raw.trim().toLowerCase();
  if ((choices as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`[config_invalid] ${name} must be one of: ${choices.join(", ")}.`);
}

/**
 * Normalise the `background` shell flag. Default is async (true); any explicit
 * "foreground" spelling returns false. Accepts numbers, booleans and strings so
 * a client that sends `false`, `0` or `"False"` never silently falls back to
 * async. Unknown values keep the async default.
 */
export function parseBackgroundFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return !Number.isFinite(value) || value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["0", "false", "no", "off", "foreground", "foreground_only", ""].includes(normalized)) return false;
  }
  return true;
}

/**
 * Startup validation. Every `flag` in the environment registry must be exactly
 * "0" or "1" (fails closed with `[config_invalid]`, as `envFlag` does at read
 * time). Everything else the registry can detect (typos, removed variables,
 * lenient enum/int values that would silently fall back to a default) is a
 * warning on stderr only; stdout stays reserved for the MCP protocol.
 */
export function validateBooleanEnvironment(): void {
  resolveSecurityProfile(); // throws [config_invalid] on an unknown VENIRA_SECURITY_PROFILE
  for (const name of ENV_FLAG_NAMES) {
    if (process.env[name] !== undefined) envFlag(name, false);
  }
  for (const issue of checkEnvironment()) {
    if (issue.code === "invalid_flag") continue; // already thrown above
    console.error(`[env] WARNING: ${issue.message}`);
  }
}
