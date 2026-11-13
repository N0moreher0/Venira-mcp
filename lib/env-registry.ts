/**
 * Environment variable registry: the single source of truth for every
 * `VENIRA_*` variable the server, CLI scripts or tests read.
 *
 * Why it exists: variables used to be described in four unrelated places (the
 * startup boolean list in `env.ts`, the README tables, `config-posture.ts` and
 * ad-hoc `envInt(...)` calls), so a new variable could ship undocumented and a
 * typo such as `VENIRA_SECURITY_PROFLE` was silently ignored.
 *
 * Contract (enforced by `npm run check:docs` and `npm run test:env-registry`):
 *   - every `VENIRA_*` name found in runtime source is registered here;
 *   - every registered non-test variable is still referenced by runtime source;
 *   - a variable is either documented in the README tables (`documented: true`)
 *     or carries a `reason` explaining why it is not;
 *   - removed variables stay registered so setting one produces a clear warning
 *     instead of "unknown variable".
 *
 * Keep this file dependency-free: `env.ts` imports it, and `env.ts` is imported
 * almost everywhere, so any import here risks a cycle.
 */

export type EnvKind = "flag" | "int" | "enum" | "string" | "path" | "list";
export type EnvStatus = "supported" | "internal" | "test" | "removed";
export type EnvArea =
  | "security"
  | "tools"
  | "shell"
  | "workspace"
  | "cache"
  | "audit"
  | "snapshot"
  | "git"
  | "secrets"
  | "observability"
  | "test";

export interface EnvVarSpec {
  name: string;
  kind: EnvKind;
  status: EnvStatus;
  area: EnvArea;
  description: string;
  /** Human-readable effective default; omitted when it is derived (for example from the security profile). */
  default?: string;
  /** Accepted values for `enum` (compared trimmed and lower-cased). */
  choices?: readonly string[];
  /** Empty string is accepted and treated like "unset". */
  allowEmpty?: boolean;
  /** Listed in a README environment-variable table. */
  documented: boolean;
  /** Required when `documented` is false: why the variable is intentionally not in the README. */
  reason?: string;
  /** Required for `removed`: what to do instead (appended to the startup warning). */
  removedNote?: string;
}

type Extra = Partial<Pick<EnvVarSpec, "default" | "choices" | "allowEmpty" | "reason" | "removedNote">>;

const spec =
  (kind: EnvKind, area: EnvArea) =>
  (name: string, description: string, documented: boolean, extra: Extra = {}): EnvVarSpec => ({
    name,
    kind,
    status: "supported",
    area,
    description,
    documented,
    ...extra,
  });


// ---------------------------------------------------------------------------
// security / approvals
// ---------------------------------------------------------------------------
const secFlag = spec("flag", "security");
const secEnum = spec("enum", "security");
const secList = spec("list", "security");
const secPath = spec("path", "security");
const secInt = spec("int", "security");
const secStr = spec("string", "security");

// ---------------------------------------------------------------------------
// tools / output
// ---------------------------------------------------------------------------
const toolFlag = spec("flag", "tools");
const toolEnum = spec("enum", "tools");
const toolInt = spec("int", "tools");
const toolList = spec("list", "tools");
const toolStr = spec("string", "tools");
const toolPath = spec("path", "tools");

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------
const shFlag = spec("flag", "shell");
const shEnum = spec("enum", "shell");
const shInt = spec("int", "shell");
const shList = spec("list", "shell");
const shStr = spec("string", "shell");

// ---------------------------------------------------------------------------
// workspace / data
// ---------------------------------------------------------------------------
const wsFlag = spec("flag", "workspace");
const wsList = spec("list", "workspace");
const wsPath = spec("path", "workspace");

// ---------------------------------------------------------------------------
// cache / audit / snapshot
// ---------------------------------------------------------------------------
const cacheFlag = spec("flag", "cache");
const cacheEnum = spec("enum", "cache");
const cacheInt = spec("int", "cache");
const auditFlag = spec("flag", "audit");
const auditInt = spec("int", "audit");
const auditEnum = spec("enum", "audit");
const snapInt = spec("int", "snapshot");
const snapPath = spec("path", "snapshot");

// ---------------------------------------------------------------------------
// git providers
// ---------------------------------------------------------------------------
const gitFlag = spec("flag", "git");
const gitInt = spec("int", "git");
const gitStr = spec("string", "git");
const gitList = spec("list", "git");
const gitEnum = spec("enum", "git");

// ---------------------------------------------------------------------------
// secrets / observability
// ---------------------------------------------------------------------------
const secretFlag = spec("flag", "secrets");
const secretEnum = spec("enum", "secrets");
const obsFlag = spec("flag", "observability");
const obsPath = spec("path", "observability");

const internal = (
  kind: EnvKind,
  area: EnvArea,
  name: string,
  description: string,
  reason: string,
): EnvVarSpec => ({ name, kind, status: "internal", area, description, documented: false, reason });

const testOnly = (name: string, description: string): EnvVarSpec => ({
  name,
  kind: "string",
  status: "test",
  area: "test",
  description,
  documented: false,
  reason: "test-only fixture variable",
});

const removed = (name: string, kind: EnvKind, description: string, removedNote: string): EnvVarSpec => ({
  name,
  kind,
  status: "removed",
  area: "security",
  description,
  documented: false,
  reason: "removed; kept so setting it produces a clear warning",
  removedNote,
});

export const ENV_REGISTRY: readonly EnvVarSpec[] = [
  // --- security / approvals ------------------------------------------------
  secEnum("VENIRA_SECURITY_PROFILE", "Approval posture preset: shell policy plus defaults for related variables. `off` is full trust (shell off, no workspace lock, JS auto, no elicitation); the deprecated alias `open` means the same and prints a one-time note; explicitly set variables still win.", true, {
    default: "balanced",
    choices: ["strict", "balanced", "trusted", "off"],
    allowEmpty: true,
  }),
  secEnum("VENIRA_SHELL_MODE", "Advanced override of the shell policy mode; wins over the security profile.", true, {
    choices: ["strict", "balanced", "permissive", "off"],
  }),
  secEnum("VENIRA_JS_EXEC_MODE", "`project_execute_js` gate: `off` hides the tool, `ask` requires per-call approval (unless VENIRA_PERMISSION_MODE=allow_all), `semi-auto` runs without approval but keeps workspace-only fs and scrubbed env (network is always open), `auto` runs without approval and without containment.", true, {
    default: "off",
    choices: ["off", "ask", "semi-auto", "auto"],
    allowEmpty: true,
  }),
  removed(
    "VENIRA_JS_EXEC_APPROVAL",
    "flag",
    "Per-call JS approval flag (removed; replaced by VENIRA_JS_EXEC_MODE).",
    "replaced by VENIRA_JS_EXEC_MODE (off / ask / semi-auto / auto).",
  ),
  removed(
    "VENIRA_ALLOW_JS_EXEC",
    "flag",
    "JS exec enable flag (removed; replaced by VENIRA_JS_EXEC_MODE).",
    "replaced by VENIRA_JS_EXEC_MODE (off / ask / semi-auto / auto).",
  ),
  secFlag("VENIRA_UNRESTRICTED", "Disable the workspace lock (absolute paths outside the workspace allowed).", true, {
    default: "0",
  }),
  secList("VENIRA_SESSION_GRANT_RULES", "Extra shell rule ids a human may approve for a whole session.", true),
  secInt("VENIRA_SHELL_APPROVAL_TTL_MS", "Lifetime of a session-wide shell grant.", true, { default: "600000" }),
  secList("VENIRA_SHELL_OVERRIDES", "Named exceptions the operator enables (ALLOW_ENV_READ).", true),
  secPath("VENIRA_SHELL_POLICY_FILE", "JSON file with extra shell allow/ask/deny rules and an optional mode.", true),
  secFlag("VENIRA_ALLOW_SELF_INSTALL", "Let `project_install_self` write other MCP clients' config files.", true, {
    default: "0",
  }),
  secStr("VENIRA_SESSION_ID", "Session id used to bind approvals and tag audit rows.", true),
  secStr(
    "VENIRA_PERMISSION_MODE",
    "Client-facing permission mode (manual / best_effort / allow_all), set by the native adapter or the client. `allow_all` (the default) also means no per-call approval for project_execute_js in ask mode.",
    true,
  ),
  removed(
    "VENIRA_SHELL_AUTO_APPROVE_TOKEN",
    "flag",
    "Legacy auto-approve token (removed in v1.15).",
    "approvals now use a human-granted approval_id (or a session grant).",
  ),
  removed(
    "VENIRA_NETWORK",
    "string",
    "Application-level network kill switch (removed).",
    "network access is always open. Dangerous or unclear commands still ask by mode: VENIRA_SHELL_MODE=strict blocks, balanced asks, permissive asks only on the high-risk rule set, off bypasses. Restrict outbound network at the OS, container or firewall level instead.",
  ),
  removed(
    "VENIRA_SHELL_EXIT_EARLY",
    "flag",
    "Pollers return as soon as the exit code is known (removed; always on).",
    "nothing to set: always on.",
  ),
  removed(
    "VENIRA_SHELL_TIMEOUT_POLICY",
    "string",
    "`soft` warns on timeout, `hard` kills the process tree (removed; always `hard`).",
    "nothing to set: an expired command kills its process tree; raise VENIRA_SHELL_MAX_TIMEOUT_MS for longer budgets.",
  ),
  removed(
    "VENIRA_SHELL_ENV_PASS_ALL",
    "flag",
    "Pass the full parent environment to shell runs (removed; merged into VENIRA_SHELL_MODE).",
    "nothing to set: the full host environment is passed in VENIRA_SHELL_MODE=permissive and off; other modes get the scrubbed allow list.",
  ),
  removed(
    "VENIRA_SHELL_ELICIT",
    "flag",
    "Ask the MCP client to confirm risky shell commands via elicitation (removed; merged into VENIRA_SHELL_MODE).",
    "nothing to set: elicitation is VENIRA_SHELL_MODE=balanced (all ask-rule prompts) and =permissive (high-risk rules only); strict never prompts, off bypasses.",
  ),
  removed(
    "VENIRA_SECRET_ALLOW_REVEAL",
    "flag",
    "Allow `project_secret reveal=1` to print a stored secret (removed; merged into VENIRA_SHELL_MODE).",
    "nothing to set: secrets may be revealed only in VENIRA_SHELL_MODE=permissive or off; strict and balanced refuse.",
  ),
  removed(
    "VENIRA_AUDIT_FAST",
    "flag",
    "No effect on audit writes; only reported by project_health (removed).",
    "nothing to set: audit_fast is always reported as true.",
  ),
  removed(
    "VENIRA_CACHE_ALL",
    "flag",
    "Alias of VENIRA_CACHE (removed).",
    "use VENIRA_CACHE=all|list|search|off (default all).",
  ),
  removed(
    "VENIRA_TRACE",
    "flag",
    "Write a trace of tool calls to stderr (removed; always on).",
    "nothing to set: tracing is always on; set VENIRA_TRACE_FILE to also append to a rotating file.",
  ),

  // --- tools / output ------------------------------------------------------
  toolEnum("VENIRA_TOOL_MODE", "Tool surface: `core` (small models: default minus code-intelligence tools), `default` (full coding toolset, no CI/CD) or `expert` (everything).", true, {
    default: "default",
    choices: ["default", "expert", "core"],
    allowEmpty: true,
  }),
  removed(
    "VENIRA_PROFILE",
    "string",
    "Tool-surface split (removed; merged into VENIRA_TOOL_MODE).",
    "use VENIRA_TOOL_MODE (core | default | expert).",
  ),
  toolList("VENIRA_DISABLE_TOOLS", "Comma-separated tool names kept out of tools/list entirely.", true),
  toolStr("VENIRA_TOOL_POLICY_JSON", "Inline JSON tool policy (per-tool allow/deny).", true),
  toolPath("VENIRA_TOOL_POLICY_FILE", "JSON file with the per-tool policy.", true),
  toolEnum("VENIRA_OUTPUT_MODE", "Payload size mode; `compact` trims large payloads.", true, {
    default: "full",
    choices: ["full", "compact"],
  }),
  toolFlag("VENIRA_PRETTY", "Pretty-print JSON envelopes.", true, { default: "0" }),
  toolInt("VENIRA_BATCH_ITEM_BYTES", "Per-item response budget inside project_read_batch.", true, {
    default: "524288",
  }),
  toolFlag("VENIRA_EDIT_FUZZY", "Allow fuzzy matching as a fallback in project_edit_file. Also decides whether fuzzy_distance, ignore_indentation and case_insensitive are advertised in the edit tool schemas (tools/list changes with this flag).", true, { default: "0" }),
  toolFlag("VENIRA_SETUP_TOOLS", "Advertise project_detect_harnesses and project_install_self in tools/list (off by default; `npx venira-mcp --install` and `--print-config` do the same from a terminal). tools/list changes with this flag.", true, { default: "0" }),
  toolFlag("VENIRA_USE_RIPGREP", "Use ripgrep for literal content search when available.", true, { default: "1" }),
  toolInt("VENIRA_SEARCH_MAX_FILES", "Max files collected by the JS fallback walker (collectFiles) before the walk stops and `complete=false` is returned. Bounds searches rooted at huge trees (e.g. VENIRA_UNRESTRICTED=1 with an absolute path outside the workspace).", true, { default: "50000" }),

  // --- shell ---------------------------------------------------------------
  shList("VENIRA_SHELL_ENV_ALLOW", "Extra environment variable names passed to shell runs.", true, {}),
  shInt("VENIRA_SHELL_MAX_OUTPUT_BYTES", "Per-stream output cap for a shell run.", true, {
    default: "262144",
  }),
  shInt("VENIRA_SHELL_MAX_TIMEOUT_MS", "Upper bound for a caller-supplied shell timeout.", true, {
    default: "1800000",
  }),
  shInt("VENIRA_SHELL_TAIL_MAX", "Characters kept in a shell run's stdout/stderr tail (minimum 256).", true, {
    default: "2000",
  }),
  shFlag("VENIRA_SHELL_CACHE", "Cache read-only shell results.", true, { default: "1" }),
  shFlag("VENIRA_SHELL_CACHE_READ_ONLY", "Compatibility flag; shell output caching always stays read-only.", true, {
    default: "1",
  }),
  shStr("VENIRA_DEFAULT_SHELL", "Shell used when a call does not name one (powershell, pwsh, cmd or bash).", true, {}),

  // --- workspace / data ----------------------------------------------------
  wsPath("VENIRA_WORKSPACE", "Workspace root; every path resolves against it.", true, { default: "process.cwd()" }),
  wsPath("VENIRA_DATA_DIR", "Directory for the audit DB, approvals and state.", true),
  wsPath("VENIRA_CONFIG_FILE", "Explicit path of the JSON config file (git provider settings).", true, {}),
  wsFlag("VENIRA_DYNAMIC_WORKSPACE", "Allow switching workspace at runtime within VENIRA_WORKSPACE_ROOTS.", true, {
    default: "0",
  }),
  wsList("VENIRA_WORKSPACE_ROOTS", "Allowed workspace roots for dynamic workspace switching.", true, {}),

  // --- cache ---------------------------------------------------------------
  cacheEnum("VENIRA_CACHE", "Cache preset: `all` every cache, `list` only directory listings, `search` only searches, `off` always fresh.", true, {
    default: "all",
    choices: ["all", "list", "search", "off"],
    allowEmpty: true,
  }),
  cacheFlag("VENIRA_CACHE_LIST_ONLY", "Enable only the directory-listing cache.", true, {}),
  cacheFlag("VENIRA_CACHE_SEARCH_ONLY", "Enable only the search cache.", true, {}),
  cacheInt("VENIRA_LIST_CACHE_MS", "Directory-listing cache lifetime.", true, { default: "1500" }),
  cacheInt("VENIRA_NEGATIVE_CACHE_MS", "Lifetime of cached not-found results.", true, {
    default: "500",
  }),
  cacheInt("VENIRA_RECENT_CACHE_MS", "project_recent_files cache lifetime.", true, {
    default: "2000",
  }),
  cacheInt("VENIRA_SEARCH_CACHE_MS", "Search cache lifetime.", true, { default: "3000" }),
  cacheInt("VENIRA_TTL_CACHE_BYTES", "Size cap of each list/search/recent/references cache.", true, {
    default: "8388608",
  }),
  cacheInt("VENIRA_CACHE_RACY_MS", "Files modified this recently are re-read instead of served from the read cache (0 disables).", true, {
    default: "30",
  }),
  cacheInt("VENIRA_READ_CACHE_BYTES", "Total size cap of the file-read cache.", true, {
    default: "67108864",
  }),

  // --- audit ---------------------------------------------------------------
  auditFlag("VENIRA_AUDIT_STRICT", "Fail a tool call when its audit row cannot be written.", true, {
    default: "0",
  }),
  auditEnum("VENIRA_AUDIT_DETAIL", "How much of each job project_read_audit can show: `summary` keeps one-line args and result, `full` also keeps the redacted, size-capped JSON, `off` keeps neither.", true, {
    default: "summary",
    choices: ["off", "summary", "full"],
  }),
  auditInt("VENIRA_AUDIT_KEEP_DAYS", "Audit rows older than this many days are pruned.", true, {
    default: "90",
  }),

  // --- snapshots -----------------------------------------------------------
  snapPath("VENIRA_SNAPSHOT_ROOT", "Shared root folder for per-project checkpoint stores.", true),
  snapPath("VENIRA_SNAPSHOT_DIR", "Exact checkpoint store folder (single project, no sub-folders).", true),
  snapInt("VENIRA_SNAPSHOT_KEEP", "Checkpoints kept per project before pruning.", true, { default: "20" }),
  snapPath("VENIRA_SNAPSHOT_MIRROR_DIR", "Existing folder that receives an append-only copy of the checkpoint store.", true),
  snapInt("VENIRA_SNAPSHOT_MIRROR_TIMEOUT_MS", "Time budget of one snapshot mirror run (milliseconds).", true, { default: "20000" }),
  snapInt("VENIRA_SNAPSHOT_MAX_BYTES", "Total size cap of a project checkpoint.", true, {
    default: "536870912",
  }),
  snapInt("VENIRA_SNAPSHOT_MAX_FILE_BYTES", "Largest single file a checkpoint captures.", true, {
    default: "33554432",
  }),
  snapInt("VENIRA_SNAPSHOT_MAX_FILES", "File-count cap of a checkpoint (0 keeps the built-in limit).", true, {
    default: "0",
  }),

  // --- git providers -------------------------------------------------------
  gitEnum("VENIRA_GIT_PROVIDER", "Force the CI/PR provider instead of detecting it from the remote.", true, {
    choices: ["github", "gitlab", "bitbucket"],
  }),
  gitStr("VENIRA_GIT_TOKEN", "Provider token (prefer a stored secret via project_secret).", true),
  gitInt("VENIRA_GIT_TIMEOUT_MS", "Provider API request timeout.", true),
  gitInt("VENIRA_GIT_RETRIES", "Retries for transient provider errors.", true),
  gitInt("VENIRA_GIT_LOG_TIMEOUT_MS", "Timeout for CI log downloads.", true),
  gitInt("VENIRA_GIT_LOG_ZIP_BYTES", "Largest CI log archive accepted.", true),
  gitInt("VENIRA_GIT_LOG_ENTRY_BYTES", "Largest single log entry read from an archive.", true),
  gitInt("VENIRA_GIT_LOG_TEXT_BYTES", "Largest text kept from one log entry.", true),
  gitInt("VENIRA_GIT_LOG_MAX_BYTES", "Total CI log bytes returned per call.", true, {}),
  gitInt("VENIRA_GIT_MAX_BYTES", "Largest provider API response accepted.", true, {}),
  gitInt("VENIRA_GIT_MAX_REDIRECTS", "Redirects followed (same-origin only).", true, {}),
  gitFlag("VENIRA_GIT_ALLOW_HTTP", "Allow plain-HTTP provider URLs (tokens may travel in clear text).", true, {
    default: "0",
  }),
  gitFlag("VENIRA_GITHUB_ALLOW_HTTP", "Deprecated alias of VENIRA_GIT_ALLOW_HTTP (prints a one-time note); VENIRA_GIT_ALLOW_HTTP wins when both are set.", true, {
    default: "0",
  }),
  gitList("VENIRA_GIT_ALLOWED_HOSTS", "Extra API hosts the provider client may call.", true, {}),
  gitStr("VENIRA_GIT_API_URL", "Provider API base URL (self-hosted instances).", true, {}),
  gitStr("VENIRA_GITHUB_API_URL", "Deprecated alias of VENIRA_GIT_API_URL (prints a one-time note); VENIRA_GIT_API_URL wins when both are set.", true, {}),
  gitStr("VENIRA_GIT_PROXY", "HTTP(S) proxy for provider calls.", true, {}),
  gitStr("VENIRA_GIT_REPO", "Repository slug override (owner/name).", true, {}),
  gitStr("VENIRA_GITHUB_REPO", "GitHub repository slug override.", true, {}),
  gitStr("VENIRA_GITLAB_REPO", "GitLab project path override.", true, {}),
  gitStr("VENIRA_BITBUCKET_REPO", "Bitbucket repository slug override.", true, {}),
  gitStr("VENIRA_GIT_SECRET_NAME", "Name of the stored secret holding the provider token.", true, {}),
  gitStr("VENIRA_GIT_TOKEN_ENV", "Name of another environment variable holding the provider token.", true, {}),
  gitStr("VENIRA_GIT_USERNAME", "Username for providers that need one (Bitbucket app passwords).", true, {}),
  gitStr("VENIRA_GITHUB_TOKEN", "GitHub token (falls back to GITHUB_TOKEN / GH_TOKEN).", true, {}),
  gitStr("VENIRA_GITLAB_TOKEN", "GitLab token (falls back to GITLAB_TOKEN / GL_TOKEN).", true, {}),
  gitStr("VENIRA_BITBUCKET_TOKEN", "Bitbucket token (falls back to BITBUCKET_TOKEN / BB_TOKEN).", true, {}),

  // --- secrets -------------------------------------------------------------
  secretEnum("VENIRA_SECRET_KEYCHAIN", "Windows keychain use for the secret store key.", true, {
    default: "auto",
    choices: ["auto", "off", "required", "0", "1", "false", "true"],
  }),

  // --- observability -------------------------------------------------------
  obsPath("VENIRA_TRACE_FILE", "Also append the trace to this file (rotates at 10 MB).", true, {}),

  // --- internal / test -----------------------------------------------------
  internal("flag", "observability", "VENIRA_VERIFY_DEBUG", "Extra logging inside the verify harness.", "developer diagnostics"),
  testOnly("VENIRA_SHELL_SECURITY_DEBUG", "Echo server stderr during the shell-security regression test."),
  testOnly("VENIRA_TEST_ONLY", "Fixture variable used to check shell environment filtering."),
  testOnly("VENIRA_TEST_SECRET", "Fixture secret used to check scrubbing in verify."),
  testOnly("VENIRA_LEAK_TEST_SECRET", "Fixture secret used by the provider secret-guard test."),
];

const BY_NAME: ReadonlyMap<string, EnvVarSpec> = new Map(ENV_REGISTRY.map((entry) => [entry.name, entry]));

export function envSpec(name: string): EnvVarSpec | undefined {
  return BY_NAME.get(name);
}

/** Names validated as strict 0/1 flags at startup. */
export const ENV_FLAG_NAMES: readonly string[] = ENV_REGISTRY.filter((entry) => entry.kind === "flag").map(
  (entry) => entry.name,
);

export type EnvIssueCode = "invalid_flag" | "invalid_enum" | "invalid_int" | "unknown_name" | "removed_var";

export interface EnvIssue {
  code: EnvIssueCode;
  name: string;
  message: string;
  suggestion?: string;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length];
}

/** Closest registered name for a probable typo, or undefined when nothing is close. */
export function suggestEnvName(name: string): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const entry of ENV_REGISTRY) {
    if (entry.status === "test") continue;
    const distance = editDistance(name, entry.name);
    if (!best || distance < best.distance) best = { name: entry.name, distance };
  }
  if (!best) return undefined;
  const limit = Math.max(2, Math.floor(name.length / 8));
  return best.distance <= limit ? best.name : undefined;
}

const NAME_SHAPE = /^VENIRA_[A-Z0-9_]+$/;

/**
 * Pure environment check against the registry. Reports problems; it never
 * throws and never changes behaviour (flags and enums that already fail closed
 * at read time keep doing so; this surfaces the rest: typos, removed variables
 * and lenient values that would silently fall back to a default).
 */
export function checkEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): EnvIssue[] {
  const issues: EnvIssue[] = [];
  for (const key of Object.keys(env).sort()) {
    if (!NAME_SHAPE.test(key)) continue;
    const value = env[key];
    if (value === undefined) continue;
    const entry = BY_NAME.get(key);
    if (!entry) {
      const suggestion = suggestEnvName(key);
      issues.push({
        code: "unknown_name",
        name: key,
        message: `${key} is not a known VENIRA_ variable and is ignored${suggestion ? `; did you mean ${suggestion}?` : "."}`,
        ...(suggestion ? { suggestion } : {}),
      });
      continue;
    }
    if (entry.status === "removed") {
      issues.push({
        code: "removed_var",
        name: key,
        message: `${key} was removed and is ignored; ${entry.removedNote ?? "remove it from the environment."}`,
      });
      continue;
    }
    if (entry.kind === "flag" && value !== "0" && value !== "1") {
      issues.push({ code: "invalid_flag", name: key, message: `${key} must be "0" or "1" (got "${value}").` });
    } else if (entry.kind === "enum" && entry.choices) {
      const normalized = value.trim().toLowerCase();
      // `open` was merged into `off` (it is a deprecated alias; resolution happens in
      // lib/security-profile.ts, which notes and maps it to `off`). Not an error.
      const isProfileAlias = key === "VENIRA_SECURITY_PROFILE" && normalized === "open";
      const ok = isProfileAlias || (normalized === "" ? entry.allowEmpty === true : entry.choices.includes(normalized));
      if (!ok) {
        issues.push({
          code: "invalid_enum",
          name: key,
          message: `${key} must be one of: ${entry.choices.join(", ")} (got "${value}").`,
        });
      }
    } else if (entry.kind === "int" && !/^\d+$/.test(value.trim())) {
      issues.push({
        code: "invalid_int",
        name: key,
        message: `${key} must be a non-negative integer (got "${value}"); the built-in default is used instead.`,
      });
    }
  }
  return issues;
}
