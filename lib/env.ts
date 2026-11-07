import { resolveSecurityProfile } from "./security-profile.js";

export function envFlag(name: string, defaultValue: boolean, value = process.env[name]): boolean {
  if (value === undefined) return defaultValue;
  if (value === "0") return false;
  if (value === "1") return true;
  throw new Error(`[config_invalid] ${name} must be "0" or "1".`);
}

export function envFlagValue(name: string, value: string | undefined, defaultValue: boolean): boolean {
  return envFlag(name, defaultValue, value);
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

const BOOLEAN_ENV_NAMES = [
  "VENIRA_UNRESTRICTED",
  "VENIRA_ALLOW_JS_EXEC",
  "VENIRA_JS_EXEC_APPROVAL",
  "VENIRA_CACHE_ALL",
  "VENIRA_CACHE_LIST_ONLY",
  "VENIRA_CACHE_SEARCH_ONLY",
  "VENIRA_AUDIT_STRICT",
  "VENIRA_AUDIT_FAST",
  "VENIRA_SHELL_EXIT_EARLY",
  "VENIRA_SHELL_ENV_PASS_ALL",
  "VENIRA_EDIT_FUZZY",
  "VENIRA_SHELL_AUTO_APPROVE_TOKEN",
  "VENIRA_SECRET_ALLOW_REVEAL",
  "VENIRA_SHELL_ELICIT",
  "VENIRA_PRETTY",
  "VENIRA_ALLOW_SELF_INSTALL",
  "VENIRA_GIT_ALLOW_HTTP",
  "VENIRA_GITHUB_ALLOW_HTTP",
  "VENIRA_TRACE",
  "VENIRA_VERIFY_DEBUG",
] as const;

export function validateBooleanEnvironment(): void {
  resolveSecurityProfile(); // throws [config_invalid] on an unknown VENIRA_SECURITY_PROFILE
  if (process.env.VENIRA_NETWORK !== undefined) {
    console.error(
      "[env] WARNING: VENIRA_NETWORK was removed and is ignored; Git-provider calls are always allowed. " +
        "Restrict outbound network at the OS, container or firewall level instead.",
    );
  }
  for (const name of BOOLEAN_ENV_NAMES) {
    if (process.env[name] !== undefined) envFlag(name, false);
  }
}
