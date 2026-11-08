/**
 * Shell policy — PowerShell parameter model (colon form).
 *
 * PowerShell accepts `-Name:value` as well as `-Name value` for every cmdlet parameter, so
 * `Get-Content -Path:.env` reads the same file as `Get-Content -Path .env`. The policy rules look at
 * separate argv entries, so the glued spelling used to hide the operand from protected-file,
 * root-delete and workspace-boundary checks. This module splits the glued form at parse time.
 *
 * Scope is deliberately narrow: only cmdlets (verb-noun names) and a short list of well-known aliases
 * are split. External programs keep their own conventions (`dotnet build -p:Configuration=Release`,
 * `msbuild /p:X=1`, `git -c:x`) and are left untouched.
 *
 * Switch values (`-Force:$true`, `-Recurse:$false`) are reduced to the bare switch. Treating
 * `-Recurse:$false` as `-Recurse` only ever makes the policy stricter, never looser.
 */

/** Aliases (and legacy cmd names) that PowerShell resolves to cmdlets taking `-Name:value`. */
const POWERSHELL_ALIASES = new Set([
  "rm", "ri", "del", "erase", "rd", "rmdir",
  "cat", "gc", "type", "sc", "ac", "clc",
  "cp", "cpi", "copy", "mv", "mi", "move", "ren", "rni",
  "ls", "dir", "gci", "gi", "gp", "gl", "sl", "cd", "chdir",
  "ni", "mkdir", "md", "ii", "sls", "select", "tee",
  "iex", "saps", "start", "sasv",
]);

const VERB_NOUN = /^[A-Za-z]+-[A-Za-z][A-Za-z0-9]*$/;
const COLON_PARAM = /^-([A-Za-z][A-Za-z0-9]*):([\s\S]*)$/;
const SWITCH_VALUE = /^\$(?:true|false)$/i;

/** True when `command` (the first word, already stripped of path/extension) is a PowerShell cmdlet or alias. */
export function isPowerShellCmdlet(command: string): boolean {
  return VERB_NOUN.test(command) || POWERSHELL_ALIASES.has(command.toLowerCase());
}

/**
 * Split `-Name:value` into `-Name`, `value` for cmdlet segments. Returns the same array when nothing
 * changed so callers can cheaply skip rebuilding the segment.
 */
export function splitColonParameters(argv: string[], command: string): string[] {
  if (argv.length < 2 || !isPowerShellCmdlet(command)) return argv;
  let changed = false;
  const out: string[] = [argv[0]];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = COLON_PARAM.exec(arg);
    if (!match) {
      out.push(arg);
      continue;
    }
    changed = true;
    out.push(`-${match[1]}`);
    const value = match[2];
    if (value.length > 0 && !SWITCH_VALUE.test(value)) out.push(value);
  }
  return changed ? out : argv;
}
