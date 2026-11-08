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
 *
 * Delete cmdlets also accept unambiguous parameter prefixes (`-Rec` for `-Recurse`); those are
 * expanded here as well, because the destructive-delete rules match the full parameter names.
 */

/**
 * PowerShell accepts any unambiguous parameter prefix (`-Rec` for `-Recurse`, `-Fo` for `-Force`).
 * The policy rules look for the full names, so resolve prefixes for the delete cmdlets before
 * evaluation. Ambiguous prefixes (`-F` = `-Force`/`-Filter`, `-In` = `-Include`/`-Information*`) are
 * left untouched: PowerShell itself rejects them.
 */
const REMOVE_ITEM_PARAMETERS = [
  "Path",
  "LiteralPath",
  "Filter",
  "Include",
  "Exclude",
  "Recurse",
  "Force",
  "WhatIf",
  "Confirm",
  "Credential",
  "Verbose",
  "Debug",
  "ErrorAction",
  "WarningAction",
  "InformationAction",
  "ErrorVariable",
  "WarningVariable",
  "InformationVariable",
  "OutVariable",
  "OutBuffer",
  "PipelineVariable",
  "Stream",
  "Attributes",
];

/** Aliases that resolve to Remove-Item in PowerShell (`rm`, `ri`, `del`, `erase`, `rd`, `rmdir`). */
const DELETE_CMDLETS = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);

function resolveParameterPrefix(name: string): string | null {
  const lower = name.toLowerCase();
  const exact = REMOVE_ITEM_PARAMETERS.find((param) => param.toLowerCase() === lower);
  if (exact) return exact;
  const matches = REMOVE_ITEM_PARAMETERS.filter((param) => param.toLowerCase().startsWith(lower));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Expand unambiguous parameter abbreviations on delete cmdlets (`-Rec` → `-Recurse`, `-Fo` → `-Force`).
 * Returns the same array when nothing changed.
 */
export function normalizePowerShellDeleteParameters(argv: string[], command: string): string[] {
  if (argv.length < 2 || !DELETE_CMDLETS.has(command.toLowerCase())) return argv;
  let changed = false;
  const out: string[] = [argv[0]];
  for (const arg of argv.slice(1)) {
    const match = /^-([A-Za-z][A-Za-z0-9]*)$/.exec(arg);
    const resolved = match ? resolveParameterPrefix(match[1]) : null;
    if (!resolved) {
      out.push(arg);
      continue;
    }
    const canonical = `-${resolved}`;
    if (canonical !== arg) changed = true;
    out.push(canonical);
  }
  return changed ? out : argv;
}

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
