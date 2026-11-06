/**
 * Side-effect module: import it FIRST in verify-style scripts.
 *
 * `verify.ts` imports library modules that read VENIRA_* env at load time
 * (UNRESTRICTED, shell mode, ...). When the script is launched from inside a
 * running venira MCP session (permission_mode=allow_all, VENIRA_UNRESTRICTED=1,
 * VENIRA_SHELL_MODE=off) those values leak into the in-process policy unit tests
 * and produce false failures. Dropping the inherited VENIRA_* vars makes the run
 * independent of the launching environment; every spawned server gets an
 * explicit env from `verifyEnv()` anyway.
 */
const KEEP = new Set(["VENIRA_VERIFY_DEBUG"]);
for (const name of Object.keys(process.env)) {
  if (name.startsWith("VENIRA_") && !KEEP.has(name)) delete process.env[name];
}
