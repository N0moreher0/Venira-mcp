/**
 * VENIRA_SECURITY_PROFILE: one variable that picks the shell-policy posture.
 *
 *   profile   | shell mode
 *   ----------|------------
 *   strict    | strict
 *   balanced  | balanced   (default)
 *   trusted   | permissive (personal machine)
 *   off       | off        (loud warning, trusted environments only)
 *
 * The individual variable (VENIRA_SHELL_MODE) still wins over the profile;
 * it is the "Advanced" override. JS exec is gated separately by
 * VENIRA_JS_EXEC_MODE (off/ask/semi-auto/auto), not by the profile.
 *
 * Keep this file dependency-free: it is imported by env.ts, workspace.ts and
 * shell-policy.ts, so any import here risks a cycle.
 */

export const SECURITY_PROFILES = ["strict", "balanced", "trusted", "off"] as const;
export type SecurityProfile = (typeof SECURITY_PROFILES)[number];

export type ProfileShellMode = "strict" | "balanced" | "permissive" | "off";

export interface SecurityProfileSettings {
  shellMode: ProfileShellMode;
}

export const SECURITY_PROFILE_TABLE: Readonly<Record<SecurityProfile, SecurityProfileSettings>> = {
  strict: { shellMode: "strict" },
  balanced: { shellMode: "balanced" },
  trusted: { shellMode: "permissive" },
  off: { shellMode: "off" },
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
