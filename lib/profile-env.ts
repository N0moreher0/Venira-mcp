/**
 * Side-effect module: applies the active security profile's env defaults
 * (see `envDefaults` in `security-profile.ts`) to `process.env`, for variables
 * the operator left unset.
 *
 * ROADMAP_ENV_SLIM.md phase 2a. It must be the FIRST import of every entry
 * point (`server.ts`, `native-adapter.ts`): ES modules evaluate imports in
 * order, and constants such as `UNRESTRICTED` in `workspace.ts` are computed
 * when that module is imported, so the defaults have to be in place before it.
 *
 * Keep this file dependency-free apart from `security-profile.ts`.
 */
import { applySecurityProfileEnvDefaults } from "./security-profile.js";

applySecurityProfileEnvDefaults();
