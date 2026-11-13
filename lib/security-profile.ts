/**
 * VENIRA_SECURITY_PROFILE: one variable that picks the shell-policy posture.
 *
 *   profile   | shell mode
 *   ----------|------------
 *   strict    | strict
 *   balanced  | balanced   (default)
 *   trusted   | permissive (personal machine)
 *   off       | off        (loud warning, trusted environments only)
 *   open      | off + full-trust env defaults (UNRESTRICTED=1, JS auto, env passthrough); loud warning
 *
 * The individual variable (VENIRA_SHELL_MODE) still wins over the profile;
 * it is the "Advanced" override. JS exec is gated separately by
 * VENIRA_JS_EXEC_MODE (off/ask/semi-auto/auto), not by the profile, EXCEPT
 * that a profile may supply a default for it (`open` does).
 *
 * ROADMAP_ENV_SLIM.md phase 2a: a profile can also carry `envDefaults`, values
 * for other VENIRA_* variables that are applied only when the operator left
 * them unset. An explicitly set variable always wins. They are applied by
 * `lib/profile-env.ts`, which must be the FIRST import of every entry point,
 * because constants such as UNRESTRICTED are computed at import time.
 *
 * Keep this file dependency-free: it is imported by env.ts, workspace.ts and
 * shell-policy.ts, so any import here risks a cycle.
 */

export const SECURITY_PROFILES = ["strict", "balanced", "trusted", "off", "open"] as const;
export type SecurityProfile = (typeof SECURITY_PROFILES)[number];

export type ProfileShellMode = "strict" | "balanced" | "permissive" | "off";

export interface SecurityProfileSettings {
  shellMode: ProfileShellMode;
  /** Defaults for other VENIRA_* variables, applied only when unset. Explicit values always win. */
  envDefaults: Readonly<Record<string, string>>;
}

/**
 * `open` = the "full trust" posture people used to spell out as several variables.
 * Only variables whose default is NOT already the open value belong here:
 * `VENIRA_PERMISSION_MODE` already defaults to `allow_all` and
 * `VENIRA_SHELL_ELICIT` to off, so they are not repeated.
 * `SHELL_OVERRIDES`, `ALLOW_SELF_INSTALL`, `SECRET_ALLOW_REVEAL` and
 * `SECRET_KEYCHAIN` are deliberate opt-ins and are NOT implied by it.
 */
export const OPEN_PROFILE_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  VENIRA_UNRESTRICTED: "1",
  VENIRA_JS_EXEC_MODE: "auto",
  VENIRA_SHELL_ENV_PASS_ALL: "1",
};

export const SECURITY_PROFILE_TABLE: Readonly<Record<SecurityProfile, SecurityProfileSettings>> = {
  strict: { shellMode: "strict", envDefaults: {} },
  balanced: { shellMode: "balanced", envDefaults: {} },
  trusted: { shellMode: "permissive", envDefaults: {} },
  off: { shellMode: "off", envDefaults: {} },
  open: { shellMode: "off", envDefaults: OPEN_PROFILE_ENV_DEFAULTS },
};

export const DEFAULT_SECURITY_PROFILE: SecurityProfile = "balanced";

/**
 * Read VENIRA_SECURITY_PROFILE. Unset/empty -> `balanced`. An unknown value
 * throws `[config_invalid]` so a typo can never silently weaken the posture.
 */
export function resolveSecurityProfile(raw: string | undefined = process.env.VENIRA_SECURITY_PROFILE): SecurityProfile {
  if (raw === undefined) return DEFAULT_SECURITY_PROFILE;
  const value = raw.trim().toLowerCase();
  if (value === "") return DEFAULT_SECURITY_PROFILE;
  if ((SECURITY_PROFILES as readonly string[]).includes(value)) return value as SecurityProfile;
  throw new Error(`[config_invalid] VENIRA_SECURITY_PROFILE must be one of: ${SECURITY_PROFILES.join(", ")}.`);
}

/** True when the operator set the profile explicitly (not just the default). */
export function securityProfileIsExplicit(raw: string | undefined = process.env.VENIRA_SECURITY_PROFILE): boolean {
  return raw !== undefined && raw.trim() !== "";
}

export function securityProfileSettings(profile: SecurityProfile = resolveSecurityProfile()): SecurityProfileSettings {
  return SECURITY_PROFILE_TABLE[profile];
}

/**
 * Fill the profile's `envDefaults` into `env`, only for variables that are
 * unset (`undefined`). A variable set to anything, including an empty string,
 * is the operator's choice and is left alone. Returns the names that were
 * filled. An invalid VENIRA_SECURITY_PROFILE fills nothing and does not throw
 * here; startup validation reports it with the proper `[config_invalid]`.
 */
export function applySecurityProfileEnvDefaults(env: NodeJS.ProcessEnv = process.env): string[] {
  let profile: SecurityProfile;
  try {
    profile = resolveSecurityProfile(env.VENIRA_SECURITY_PROFILE);
  } catch {
    return [];
  }
  const applied: string[] = [];
  for (const [name, value] of Object.entries(SECURITY_PROFILE_TABLE[profile].envDefaults)) {
    if (env[name] === undefined) {
      env[name] = value;
      applied.push(name);
    }
  }
  return applied;
}
