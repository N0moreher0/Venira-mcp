/**
 * One-time stderr note for a deprecated variable alias
 * (ROADMAP_ENV_SLIM.md phase 2d). The old name keeps working; the note only
 * tells the operator which name to use. stderr only: stdout is the MCP protocol.
 *
 * Keep this file dependency-free.
 */
const noted = new Set<string>();

/**
 * Print the note at most once per process per `oldName`, and only when the old
 * name is actually set. Returns whether a note was printed.
 */
export function noteDeprecatedAlias(
  oldName: string,
  newName: string,
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => console.error(line),
): boolean {
  if (env[oldName] === undefined || noted.has(oldName)) return false;
  noted.add(oldName);
  const tail =
    env[newName] !== undefined
      ? `it is ignored because ${newName} is set`
      : `it still works; rename it to ${newName}`;
  write(`[env] NOTE: ${oldName} is a deprecated alias of ${newName}; ${tail}.`);
  return true;
}

/** Test hook: forget which notes were already printed. */
export function resetDeprecatedAliasNotes(): void {
  noted.clear();
}
