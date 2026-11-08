/**
 * Shell policy — PowerShell parameter model.
 *
 * PowerShell cmdlets accept parameters in several equivalent spellings the policy must normalize
 * before rule matching:
 *
 *   - colon form:      `Get-Content -Path:.env`     == `Get-Content -Path .env`
 *   - abbreviations:   `Remove-Item -Rec -Fo`       == `Remove-Item -Recurse -Force`
 *   - switch values:   `Remove-Item -Recurse:$true` == `Remove-Item -Recurse`
 *
 * Every cmdlet (verb-noun) and known alias is handled. Abbreviations are resolved per cmdlet against
 * that cmdlet's parameter set plus the common parameters: an exact name wins, otherwise the prefix
 * must match exactly one parameter. Ambiguous prefixes (`Set-Content -Pa` = `-Path`/`-PassThru`,
 * `Get-ChildItem -Re` = `-Recurse`/`-ReadOnly`) are left untouched, mirroring PowerShell itself,
 * which rejects them.
 *
 * Unknown cmdlets still get colon splitting and switch-value reduction (grammar that is uniform
 * across all cmdlets); abbreviation resolution for them only considers the common parameters.
 * External programs (`dotnet build -p:Configuration=Release`, `git -c:x`) keep their own
 * conventions and are never touched.
 */

const COMMON_PARAMETERS = [
  "Verbose",
  "Debug",
  "ErrorAction",
  "ErrorVariable",
  "WarningAction",
  "WarningVariable",
  "InformationAction",
  "InformationVariable",
  "OutVariable",
  "OutBuffer",
  "PipelineVariable",
  "WhatIf",
  "Confirm",
] as const;

/** Parameter sets for the cmdlets the policy reasons about (paths, writes, deletes, elevation). */
const CMDLET_PARAMETERS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  [
    "remove-item",
    [
      "Path", "LiteralPath", "Filter", "Include", "Exclude", "Recurse", "Force", "Credential",
      "Stream", "Attributes",
    ],
  ],
  [
    "get-content",
    [
      "Path", "LiteralPath", "ReadCount", "TotalCount", "Tail", "Head", "First", "Last", "Skip",
      "Encoding", "Delimiter", "Wait", "Raw", "AsByteStream", "Stream", "Force", "Credential",
      "Filter", "Include", "Exclude",
    ],
  ],
  [
    "set-content",
    [
      "Path", "LiteralPath", "Value", "PassThru", "Filter", "Include", "Exclude", "Force",
      "NoNewline", "Encoding", "Stream", "AsByteStream",
    ],
  ],
  [
    "add-content",
    [
      "Path", "LiteralPath", "Value", "PassThru", "Filter", "Include", "Exclude", "Force",
      "NoNewline", "Encoding", "Stream", "AsByteStream",
    ],
  ],
  [
    "out-file",
    [
      "FilePath", "LiteralPath", "Encoding", "Width", "InputObject", "Append", "Force",
      "NoClobber", "NoNewline", "PassThru",
    ],
  ],
  [
    "copy-item",
    [
      "Path", "LiteralPath", "Destination", "Container", "Force", "Filter", "Include", "Exclude",
      "Recurse", "PassThru", "Credential", "FromSession", "ToSession",
    ],
  ],
  [
    "move-item",
    [
      "Path", "LiteralPath", "Destination", "Force", "Filter", "Include", "Exclude", "PassThru",
      "Credential",
    ],
  ],
  ["new-item", ["Path", "Name", "ItemType", "Value", "Force", "Credential"]],
  ["rename-item", ["Path", "LiteralPath", "NewName", "Force", "PassThru", "Credential"]],
  ["clear-content", ["Path", "LiteralPath", "Force", "Filter", "Include", "Exclude", "Stream", "Credential"]],
  [
    "get-childitem",
    [
      "Path", "LiteralPath", "Filter", "Include", "Exclude", "Recurse", "Depth", "Force", "Name",
      "File", "Directory", "Hidden", "ReadOnly", "System", "Attributes", "FollowSymlink",
      "Credential",
    ],
  ],
  [
    "select-string",
    [
      "Pattern", "Path", "LiteralPath", "InputObject", "SimpleMatch", "CaseSensitive", "Context",
      "AllMatches", "NotMatch", "Encoding", "Raw", "List", "Quiet", "Include", "Exclude",
    ],
  ],
  [
    "start-process",
    [
      "FilePath", "ArgumentList", "Credential", "WorkingDirectory", "Verb", "WindowStyle", "Wait",
      "PassThru", "RedirectStandardError", "RedirectStandardInput", "RedirectStandardOutput",
      "LoadUserProfile", "NoNewWindow", "UseNewEnvironment", "Environment",
    ],
  ],
  [
    "invoke-webrequest",
    [
      "Uri", "Method", "Body", "Headers", "OutFile", "InFile", "Credential", "UseBasicParsing",
      "UserAgent", "WebSession", "TimeoutSec", "Proxy", "MaximumRedirection",
    ],
  ],
  [
    "get-item",
    [
      "Path", "LiteralPath", "Name", "Filter", "Include", "Exclude", "Credential",
    ],
  ],
  [
    "get-itemproperty",
    ["Name", "Path", "LiteralPath", "Credential"],
  ],
  [
    "get-eventlog",
    ["LogName", "ProviderName", "Source", "MaxEvents", "Forward", "Tail", "Newest", "Oldest"],
  ],
  [
    "get-winevent",
    ["LogName", "ProviderName", "Source", "MaxEvents", "Forward", "Tail", "Newest", "Oldest"],
  ],
  [
    "get-credential",
    ["UserName", "UserId", "Target", "Message", "SupportedAlgorithms", "PinnedHosts", "Options", "Credential"],
  ],
  [
    "get-service",
    ["Name", "Value", "CaseSensitive", "Required", "Status", "InputObject"],
  ],
  [
    "start-service",
    ["Name", "ErrorAction", "ErrorVariable", "WarningAction", "WarningVariable", "InformationAction", "InformationVariable", "OutVariable", "OutBuffer", "PipelineVariable", "WhatIf", "Confirm"],
  ],
  [
    "stop-service",
    ["Name", "Force", "InputObject", "ErrorAction", "ErrorVariable", "WarningAction", "WarningVariable", "InformationAction", "InformationVariable", "OutVariable", "OutBuffer", "PipelineVariable", "WhatIf", "Confirm"],
  ],
  [
    "get-process",
    ["InputObject", "Name", "Id", "Force", "ErrorAction", "ErrorVariable", "WarningAction", "WarningVariable", "InformationAction", "InformationVariable", "OutVariable", "OutBuffer", "PipelineVariable", "WhatIf", "Confirm"],
  ],
  [
    "get-variable",
    ["Name", "Value", "Level", "HelpMessage", "Description", "Option"],
  ],
  [
    "stop-process",
    ["InputObject", "Name", "Id", "Force", "ErrorAction", "ErrorVariable", "WarningAction", "WarningVariable", "InformationAction", "InformationVariable", "OutBuffer", "PipelineVariable", "WhatIf", "Confirm"],
  ],
  ["tee-object", ["FilePath", "LiteralPath", "InputObject", "Append", "Variable"]],
  [
    "invoke-restmethod",
    [
      "Uri", "Method", "Body", "Headers", "OutFile", "InFile", "Credential", "UseBasicParsing",
      "UserAgent", "WebSession", "TimeoutSec", "Proxy", "MaximumRedirection", "ContentType",
    ],
  ],
  [
    "start-bitstransfer",
    ["Source", "Destination", "Credential", "Asynchronous", "Priority", "DisplayName", "Description"],
  ],
  [
    "set-itemproperty",
    [
      "Path", "LiteralPath", "Name", "Value", "Type", "Force", "PassThru", "Filter", "Include",
      "Exclude", "Credential", "InputObject",
    ],
  ],
  [
    "remove-itemproperty",
    ["Path", "LiteralPath", "Name", "Force", "Filter", "Include", "Exclude", "Credential"],
  ],
  [
    "export-csv",
    [
      "Path", "LiteralPath", "InputObject", "Delimiter", "UseCulture", "NoTypeInformation",
      "IncludeTypeInformation", "NoClobber", "Append", "Force", "Encoding", "NoHeader", "QuoteFields",
    ],
  ],
  ["import-csv", ["Path", "LiteralPath", "Delimiter", "Header", "Encoding", "UseCulture"]],
  [
    "export-clixml",
    ["Path", "LiteralPath", "InputObject", "Depth", "Force", "NoClobber", "Encoding"],
  ],
  ["import-clixml", ["Path", "LiteralPath", "IncludeTotalCount", "Skip", "First"]],
  [
    "compress-archive",
    ["Path", "LiteralPath", "DestinationPath", "CompressionLevel", "Update", "PassThru"],
  ],
  ["expand-archive", ["Path", "LiteralPath", "DestinationPath", "Force", "PassThru"]],
  ["set-location", ["Path", "LiteralPath", "PassThru", "StackName"]],
  ["push-location", ["Path", "LiteralPath", "PassThru", "StackName"]],
  ["invoke-item", ["Path", "LiteralPath", "Filter", "Include", "Exclude", "Credential"]],
  ["get-filehash", ["Path", "LiteralPath", "Algorithm", "InputStream"]],
  ["unblock-file", ["Path", "LiteralPath"]],
  [
    "set-acl",
    [
      "Path", "LiteralPath", "AclObject", "InputObject", "ClearCentralAccessPolicy", "PassThru",
      "Filter", "Include", "Exclude",
    ],
  ],
  ["restart-service", ["Name", "DisplayName", "Force", "InputObject", "Include", "Exclude", "PassThru"]],
  [
    "set-service",
    ["Name", "DisplayName", "Description", "StartupType", "Status", "InputObject", "PassThru"],
  ],
  [
    "new-service",
    ["Name", "BinaryPathName", "DisplayName", "Description", "StartupType", "Credential", "DependsOn"],
  ],
  ["remove-service", ["Name", "InputObject"]],
  ["invoke-expression", ["Command"]],
  ["set-executionpolicy", ["ExecutionPolicy", "Scope", "Force"]],
  ["select-object", ["Property", "InputObject", "First", "Last", "Skip", "Unique", "ExpandProperty", "ExcludeProperty", "Index", "Wait"]],
]);

/** Aliases (and legacy cmd names) that PowerShell resolves to a cmdlet. */
const ALIAS_CMDLETS: ReadonlyMap<string, string> = new Map<string, string>([
  ["rm", "remove-item"],
  ["ri", "remove-item"],
  ["del", "remove-item"],
  ["erase", "remove-item"],
  ["rd", "remove-item"],
  ["rmdir", "remove-item"],
  ["cat", "get-content"],
  ["gc", "get-content"],
  ["type", "get-content"],
  ["sc", "set-content"],
  ["ac", "add-content"],
  ["clc", "clear-content"],
  ["cp", "copy-item"],
  ["cpi", "copy-item"],
  ["copy", "copy-item"],
  ["mv", "move-item"],
  ["mi", "move-item"],
  ["move", "move-item"],
  ["ren", "rename-item"],
  ["rni", "rename-item"],
  ["ls", "get-childitem"],
  ["dir", "get-childitem"],
  ["gci", "get-childitem"],
  ["gi", "get-item"],
  ["gp", "get-itemproperty"],
  ["gl", "get-location"],
  ["sl", "set-location"],
  ["cd", "set-location"],
  ["chdir", "set-location"],
  ["ni", "new-item"],
  ["mkdir", "new-item"],
  ["md", "new-item"],
  ["ii", "invoke-item"],
  ["sls", "select-string"],
  ["select", "select-object"],
  ["tee", "tee-object"],
  ["iex", "invoke-expression"],
  ["saps", "start-process"],
  ["start", "start-process"],
  ["sasv", "start-service"],
  ["irm", "invoke-restmethod"],
  ["iwr", "invoke-webrequest"],
  ["sp", "set-itemproperty"],
  ["rp", "remove-itemproperty"],
  ["ipcsv", "import-csv"],
  ["epcsv", "export-csv"],
  ["pushd", "push-location"],
]);

const VERB_NOUN = /^[A-Za-z]+-[A-Za-z][A-Za-z0-9]*$/;
const PARAMETER = /^-([A-Za-z][A-Za-z0-9]*)(?::([\s\S]*))?$/;
const SWITCH_VALUE = /^\$(?:true|false)$/i;

/** Canonical cmdlet name, or null when the first word is not a cmdlet/alias. */
export function resolvePowerShellCmdlet(command: string): string | null {
  if (VERB_NOUN.test(command)) return command.toLowerCase();
  return ALIAS_CMDLETS.get(command.toLowerCase()) ?? null;
}

/** True when `command` (the first word, already stripped of path/extension) is a PowerShell cmdlet or alias. */
export function isPowerShellCmdlet(command: string): boolean {
  return resolvePowerShellCmdlet(command) !== null;
}

function parameterCandidates(cmdlet: string): readonly string[] {
  const specific = CMDLET_PARAMETERS.get(cmdlet);
  return specific ? [...specific, ...COMMON_PARAMETERS] : COMMON_PARAMETERS;
}

/**
 * Resolve `name` to a canonical parameter for `cmdlet`: exact match first, then a unique prefix.
 * Returns null when the name is unknown or ambiguous (PowerShell rejects both).
 */
function resolveParameterPrefix(cmdlet: string, name: string): string | null {
  const lower = name.toLowerCase();
  const candidates = parameterCandidates(cmdlet);
  const exact = candidates.find((param) => param.toLowerCase() === lower);
  if (exact) return exact;
  const matches = candidates.filter((param) => param.toLowerCase().startsWith(lower));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Normalize a PowerShell segment's argv into canonical parameters and separate operands.
 * Returns the same array when nothing changed so callers can cheaply skip rebuilding the segment.
 */
export function normalizePowerShellParameters(argv: string[], command: string): string[] {
  if (argv.length < 2) return argv;
  const cmdlet = resolvePowerShellCmdlet(command);
  if (!cmdlet) return argv;
  let changed = false;
  const out: string[] = [argv[0]];
  for (let i = 1; i < argv.length; i += 1) {
    const match = PARAMETER.exec(argv[i]);
    if (!match) {
      out.push(argv[i]);
      continue;
    }
    const name = match[1];
    const colonValue = match[2];
    const canonical = resolveParameterPrefix(cmdlet, name);
    const resolved = canonical ?? name;
    if (resolved !== name || colonValue !== undefined) changed = true;
    out.push(`-${resolved}`);
    if (colonValue !== undefined && colonValue.length > 0 && !SWITCH_VALUE.test(colonValue)) {
      out.push(colonValue);
    }
  }
  return changed ? out : argv;
}
