/**
 * Deterministic error diagnosis for `project_explain_error`.
 *
 * Why rules instead of a model?
 * ----------------------------
 * The MCP server must stay predictable, offline-capable and fast: the agent
 * already has the model. What it lacks is a *stable* map from "this familiar
 * failure" to "the next tool call". This module is that map: a small table of
 * well-known failure signatures (POSIX/Node errno, TypeScript, Python/pytest,
 * git, npm, GitHub provider codes, venira's own error codes) with the cause and
 * the concrete next action.
 *
 * Contract: pure function, no I/O, no network, no timers. The tool wrapper adds
 * the envelope. `matched: false` is a normal result (unknown error), never an
 * error: the caller gets a generic triage checklist instead.
 */
import type { NextAction } from "./read-plan.js";

export type { NextAction };

export type Diagnosis = {
  rule_id: string;
  title: string;
  confidence: "high" | "medium" | "low";
  matched_line: string;
  likely_cause: string;
  suggested_fix: string[];
  retry_hint?: string;
  next_actions: NextAction[];
};

export type ExplainResult = {
  matched: boolean;
  summary: string;
  error_line: string | null;
  language: string | null;
  diagnoses: Diagnosis[];
  next_actions: NextAction[];
  notes: string;
};

const MAX_INPUT = 32 * 1024;
const MAX_LINE = 300;

/** `src/app.ts:42`, `C:\work\app.py:12`, `app.py:12:5`. */
const FILE_LINE_RE = /((?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.(?:[A-Za-z0-9]{1,8})):(\d+)(?::\d+)?/;

const EXT_LANG: Array<[RegExp, string]> = [
  [/\.(ts|tsx|mts|cts)$/i, "typescript"],
  [/\.(js|jsx|mjs|cjs)$/i, "javascript"],
  [/\.py$/i, "python"],
  [/\.(rs)$/i, "rust"],
  [/\.go$/i, "go"],
  [/\.(java|kt)$/i, "jvm"],
  [/\.(rb)$/i, "ruby"],
  [/\.(cs)$/i, "csharp"],
  [/\.(sql)$/i, "sql"],
];

type RuleContext = { text: string; errorLine: string; file: string | null; line: number | null; language: string | null };

type Rule = {
  id: string;
  title: string;
  confidence: Diagnosis["confidence"];
  pattern: RegExp;
  cause: string;
  fix: string[];
  retry?: string;
  actions?: (ctx: RuleContext) => NextAction[];
};

/** Read the failing frame (`file:line`) as a ready-to-send read_ranges call. */
function readFailingFrame(ctx: RuleContext, why = "read the failing frame with context"): NextAction[] {
  if (!ctx.file || !ctx.line) return [];
  const start = Math.max(1, ctx.line - 8);
  return [
    {
      tool: "project_read_ranges",
      arguments: { relative_path: ctx.file, ranges: [{ start_line: start, end_line: ctx.line + 20 }] },
      why,
    },
  ];
}

function searchTerm(ctx: RuleContext, term: string, why: string): NextAction[] {
  const value = term.trim().slice(0, 80);
  if (!value) return [];
  return [{ tool: "project_search", arguments: { query: value, kind: "literal_content", limit: 20 }, why }];
}

const RULES: Rule[] = [
  {
    id: "venira.network_disabled",
    title: "Outbound network is disabled",
    confidence: "high",
    pattern: /\[network_disabled\]|VENIRA_NETWORK=0/,
    cause: "The server runs with VENIRA_NETWORK=0, so GitHub/CI calls are refused before a socket opens.",
    fix: [
      "Set VENIRA_NETWORK=1 in the MCP server environment and restart the server.",
      "If outbound access is intentionally blocked, use local tools (git, shell) instead of the provider tools.",
    ],
    retry: "Safe to retry once the env change is applied (the server must be restarted).",
  },
  {
    id: "venira.secret_expired",
    title: "Stored secret expired",
    confidence: "high",
    pattern: /\[secret_expired\]/,
    cause: "The secret's `expires_at` is in the past; injection and provider tokens are refused until it is rotated.",
    fix: [
      "Rotate it: project_secret action=set name=<NAME> value=<new value> expires_in_days=<days>.",
      "Check what is due with project_secret action=list (each entry reports expires_at / days_left).",
    ],
    retry: "Retry the original call after rotating.",
  },
  {
    id: "venira.secret_missing",
    title: "Secret not found in the store",
    confidence: "high",
    pattern: /\[secret_missing\]|\[rogue_secret\]/,
    cause: "`secret_env` / provider auth named a secret that was never stored (or was deleted).",
    fix: [
      "List names: project_secret action=list.",
      "Store it once: project_secret action=set name=<NAME> value_env=<HOST_ENV_VAR> keeps the value out of the transcript.",
    ],
  },
  {
    id: "venira.approval_required",
    title: "Shell policy requires approval",
    confidence: "high",
    pattern: /\[approval_required\]|approval_required|requires_approval/,
    cause: "The command matched an `ask` rule in the shell policy (cd outside workspace, pipe-to-shell, sudo, ...).",
    fix: [
      "Prefer a workspace-relative command (omit `cd ..`, use relative_cwd).",
      "If the command is intended, use the approval flow: the response carries approval_token; resubmit with it.",
      "For a repeated safe command, request a session grant instead of approving each call.",
    ],
  },
  {
    id: "fs.enoent",
    title: "File or directory does not exist (ENOENT)",
    confidence: "high",
    pattern: /ENOENT|no such file or directory/i,
    cause: "The path does not exist in the current workspace/cwd — often a stale guess, a wrong root, or a filename typo.",
    fix: [
      "Locate it first: project_search (literal_content) or project_list_files; then pass the exact workspace-relative path.",
      "Paths are workspace-relative; absolute paths outside the workspace are rejected unless VENIRA_UNRESTRICTED=1.",
    ],
    actions: (ctx) => searchTerm(ctx, basename(ctx.file ?? ""), "find the real path of the missing file"),
  },
  {
    id: "fs.eacces",
    title: "Permission denied (EACCES/EPERM)",
    confidence: "high",
    pattern: /EACCES|EPERM|permission denied/i,
    cause: "The current user cannot read/write that path (or the file is locked by another process).",
    fix: [
      "Check whether the file is inside the workspace (outside paths are policy-scoped).",
      "On Windows, a file open in another process cannot be replaced: close the editor/test runner, or write a new file.",
      "Never chmod/chown through the shell unless the user asked for it.",
    ],
  },
  {
    id: "net.eaddrinuse",
    title: "Port already in use (EADDRINUSE)",
    confidence: "high",
    pattern: /EADDRINUSE|address already in use/i,
    cause: "Another process (often a dev server started earlier) already listens on that port.",
    fix: [
      "Inspect running shells: project_shell_status for your run_id, or project_health for the queue.",
      "Stop the previous run (project_shell_cancel / project_shell_cancel_session) or start on another port.",
    ],
  },
  {
    id: "net.econnrefused",
    title: "Connection refused (ECONNREFUSED)",
    confidence: "high",
    pattern: /ECONNREFUSED|connection refused/i,
    cause: "Nothing is listening on the target host:port — the service was not started, or it crashed.",
    fix: [
      "Start the dependency (database/dev server) in the background, then poll it with project_shell_status.",
      "Confirm the port matches the config (often .env vs docker-compose).",
    ],
  },
  {
    id: "net.timeout",
    title: "Timeout (ETIMEDOUT / timed out)",
    confidence: "medium",
    pattern: /ETIMEDOUT|timed out|timeout of \d+ms exceeded|TimeoutError/i,
    cause: "The operation exceeded its budget: slow dependency, blocked network, or a command that needs longer.",
    fix: [
      "Raise the budget where it is supported (project_shell_run timeout_ms, or the tool's own timeout).",
      "Poll instead of blocking: project_shell_run returns a run_id; project_shell_status(wait_seconds=5..30) observes it.",
      "Check VENIRA_SHELL_TIMEOUT_POLICY=hard|soft for long-running commands.",
    ],
  },
  {
    id: "mem.enomem",
    title: "Out of memory (ENOMEM / heap)",
    confidence: "medium",
    pattern: /ENOMEM|JavaScript heap out of memory|heap limit Allocation failed|MemoryError/i,
    cause: "The process needed more memory than the runtime allows (large file, big test matrix, unbounded loop).",
    fix: [
      "Process in chunks (project_read_ranges, batch reads) instead of loading everything at once.",
      "For Node builds/tests, raise the heap via the command env, e.g. NODE_OPTIONS=--max-old-space-size=4096.",
      "Keep checkpoint/restore scope narrow (paths[]) to avoid hashing huge trees.",
    ],
  },
  {
    id: "fs.enospc",
    title: "No space left on device (ENOSPC)",
    confidence: "high",
    pattern: /ENOSPC|no space left on device/i,
    cause: "The disk (or the tmp volume) is full.",
    fix: [
      "Free build output (dist/, node_modules/.cache, temp checkpoint stores).",
      "Keep checkpoints bounded: VENIRA_SNAPSHOT_KEEP (default 20) prunes old ones.",
    ],
  },
  {
    id: "node.module_not_found",
    title: "Module not found",
    confidence: "high",
    pattern: /Cannot find module|MODULE_NOT_FOUND|module not found/i,
    cause: "A dependency is not installed, or the import path/extension is wrong (ESM needs the file extension).",
    fix: [
      "Install dependencies in the workspace: npm ci (or npm install for a new package).",
      "Check the specifier: relative ESM imports need the .js extension after compilation.",
      "If a workspace package is linked, verify the package name in package.json.",
    ],
  },
  {
    id: "python.module_not_found",
    title: "Python module missing",
    confidence: "high",
    pattern: /ModuleNotFoundError: No module named|ImportError: cannot import name/i,
    cause: "The package is not installed in the active interpreter, or the import path is wrong.",
    fix: [
      "Confirm the interpreter: `python -c \"import sys; print(sys.executable)\"` via project_shell_run.",
      "Install it (pip install <pkg>) or point PYTHONPATH at the source directory.",
      "Prefer running tests through the project's own entry point (pytest, tox, poetry run).",
    ],
  },
  {
    id: "python.traceback",
    title: "Python exception (traceback)",
    confidence: "high",
    pattern: /Traceback \(most recent call last\)/,
    cause: "An unhandled exception; the last frame points at the failing line.",
    fix: [
      "Read the last frame shown in the traceback (file + line) before changing anything.",
      "Reproduce with the narrowest test first, then widen.",
    ],
    actions: (ctx) => readFailingFrame(ctx, "read the raising frame and the code that supplied its inputs"),
  },
  {
    id: "python.indentation",
    title: "Python indentation/syntax error",
    confidence: "high",
    pattern: /IndentationError|TabError|unexpected indent|expected an indented block/i,
    cause: "Mixed tabs/spaces or a broken block after an edit.",
    fix: [
      "Open the reported file around the line: indentation must be uniform (4 spaces typical).",
      "Use project_edit_file instead of retyping whole blocks; keep the surrounding indentation when pasting.",
    ],
    actions: (ctx) => readFailingFrame(ctx, "inspect the indentation around the reported line"),
  },
  {
    id: "ts.type_error",
    title: "TypeScript type error",
    confidence: "high",
    pattern: /\bTS\d{3,5}\b|error TS\d+/,
    cause: "The compiler rejected a type. Fix the type at the source, not with `as any`.",
    fix: [
      "Read the reported file:line; the error often comes from a widened/narrowed type one call away.",
      "Check the symbol's declaration with project_file_symbols or project_symbol_references.",
      "Re-run the project's type-check (npm run build / tsc --noEmit) after the fix.",
    ],
    actions: (ctx) => [
      ...readFailingFrame(ctx, "read the type error site"),
      ...searchTerm(ctx, (/\bTS\d{3,5}\b/.exec(ctx.text)?.[0] ?? ""), "find other places that hit the same diagnostic"),
    ],
  },
  {
    id: "js.syntax_error",
    title: "JavaScript syntax error",
    confidence: "medium",
    pattern: /SyntaxError:|Unexpected token|Unexpected end of JSON input/i,
    cause: "Malformed source (or malformed JSON payload parsed at runtime).",
    fix: [
      "Read the reported line; an unbalanced brace/bracket usually starts a few lines earlier.",
      "If it is JSON, validate the file (node -e \"JSON.parse(require('fs').readFileSync('<file>','utf8'))\").",
    ],
    actions: (ctx) => readFailingFrame(ctx, "inspect the syntax error site"),
  },
  {
    id: "test.assertion",
    title: "Test assertion failed",
    confidence: "high",
    pattern: /AssertionError|expect\(.+\).to(Be|Equal|Match|Throw)|assert.*failed|FAILED .* - /i,
    cause: "Behaviour and expectation disagree: either the code changed or the test encodes an outdated assumption.",
    fix: [
      "Read both sides: the failing test and the implementation it exercises.",
      "Run only that test (e.g. `npm test -- <pattern>` / `pytest <file>::<test>`) to shorten the loop.",
      "Do not weaken the assertion unless the user agrees the new behaviour is intended.",
    ],
    actions: (ctx) => [
      ...readFailingFrame(ctx, "read the failing assertion"),
      ...searchTerm(ctx, basename(ctx.file ?? ""), "find the test that owns this failure"),
    ],
  },
  {
    id: "git.not_repo",
    title: "Not a git repository",
    confidence: "high",
    pattern: /fatal: not a git repository/i,
    cause: "The command ran in a directory that has no .git (wrong cwd, or a nested folder).",
    fix: [
      "Run git from the workspace root (project_shell_run relative_cwd=\".\").",
      "Check the layout with project_list_files depth=1 before assuming the repo root.",
    ],
  },
  {
    id: "git.conflict",
    title: "Merge/rebase conflict",
    confidence: "high",
    pattern: /CONFLICT \(content\)|Automatic merge failed|fix conflicts and then commit|both modified/i,
    cause: "Two branches changed the same lines; git stopped and left conflict markers.",
    fix: [
      "List conflicted files: `git status --short` via project_shell_run.",
      "Resolve each file with project_read_file + project_edit_file (remove <<<<<<< / ======= / >>>>>>> markers).",
      "Then `git add <file>` and continue the merge/rebase; run the tests before committing.",
    ],
  },
  {
    id: "git.push_rejected",
    title: "Push rejected (non-fast-forward)",
    confidence: "high",
    pattern: /! \[rejected\]|failed to push some refs|non-fast-forward|fetch first/i,
    cause: "The remote branch moved ahead of your local branch.",
    fix: [
      "Fetch and rebase: `git pull --rebase origin <branch>`, resolve conflicts, then push again.",
      "Never force-push a shared branch unless the user explicitly asks.",
    ],
  },
  {
    id: "git.auth",
    title: "Git authentication failed",
    confidence: "high",
    pattern: /Authentication failed|Permission denied \(publickey\)|could not read Username|terminal prompts disabled/i,
    cause: "No usable credential for the remote (expired token, missing SSH key, non-interactive terminal).",
    fix: [
      "For HTTPS remotes, make sure the credential helper has a token (or use the GitHub tools with a stored token).",
      "For SSH, verify the key is loaded (ssh -T git@github.com).",
      "Do not paste tokens into a shell command: store them with project_secret and inject via secret_env.",
    ],
  },
  {
    id: "npm.eresolve",
    title: "npm dependency conflict (ERESOLVE)",
    confidence: "high",
    pattern: /ERESOLVE|peer dep|peerDependencies/i,
    cause: "Two packages require incompatible versions of a third one.",
    fix: [
      "Prefer aligning versions in package.json over --legacy-peer-deps.",
      "Check whether a lockfile update is enough (npm install, then commit package-lock.json).",
    ],
  },
  {
    id: "github.auth",
    title: "GitHub token rejected or missing",
    confidence: "high",
    pattern: /Bad credentials|Requires authentication|\b401\b|\[auth_missing\]/,
    cause: "No token, or the token is invalid/expired/revoked.",
    fix: [
      "Check the stored token metadata: project_secret action=get name=GITHUB_TOKEN (never prints the value).",
      "Rotate it: project_secret action=set name=GITHUB_TOKEN value=<new PAT>.",
    ],
  },
  {
    id: "github.scope",
    title: "GitHub token lacks permission",
    confidence: "high",
    pattern: /Resource not accessible by (integration|personal access token)|\b403\b|\[forbidden\]/,
    cause: "The token is valid but lacks the scope the call needs (repo, workflow, ...).",
    fix: [
      "Read the provider error code: forbidden / auth_failed carry the required scope in the hint.",
      "Re-issue the PAT with the scope (repo for PRs, workflow for workflow_dispatch).",
    ],
  },
  {
    id: "github.rate_limit",
    title: "GitHub rate limit",
    confidence: "high",
    pattern: /API rate limit|rate_limited|\b429\b|secondary rate limit/i,
    cause: "Too many requests in a short window (unauthenticated calls are limited hardest).",
    fix: [
      "Wait for the reset window (the provider error carries x-ratelimit-reset when available).",
      "Batch reads instead of one call per item; authenticated calls have a much larger budget.",
    ],
  },
  {
    id: "shell.command_not_found",
    title: "Command not found",
    confidence: "high",
    pattern: /command not found|is not recognized as an internal or external command/i,
    cause: "The binary is not on PATH for the shell the server uses (often a different shell than the user's terminal).",
    fix: [
      "Use the project's own runner (npm run <script>, npx <bin>, python -m <module>) instead of a global binary.",
      "Check the shell in use (project_health -> shell section) and the PATH it inherits.",
    ],
  },
  {
    id: "db.locked",
    title: "Database locked / busy",
    confidence: "medium",
    pattern: /database is locked|SQLITE_BUSY|deadlock detected/i,
    cause: "Another connection holds the write lock (a dev server, a test run, or a second MCP session).",
    fix: [
      "Stop the competing process (project_shell_cancel_session) or point the tool at a scratch DB.",
      "Write in WAL mode where the project allows it; retry with a short backoff.",
    ],
  },
];

function shortLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_LINE);
}

/** Pick the most informative line: an explicit error marker, else the first non-empty one. */
function pickErrorLine(lines: string[]): string | null {
  const markers = /(error|exception|failed|failure|fatal|panic|traceback|cannot|denied|not found|refused|timeout)/i;
  const first = lines.find((line) => markers.test(line));
  if (first) return shortLine(first);
  const fallback = lines.find((line) => line.trim());
  return fallback ? shortLine(fallback) : null;
}

function guessLanguage(text: string): string | null {
  for (const [re, lang] of EXT_LANG) {
    if (re.test(text)) return lang;
  }
  if (/Traceback \(most recent call last\)/.test(text)) return "python";
  if (/error TS\d+/.test(text)) return "typescript";
  return null;
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function dedupeActions(actions: NextAction[]): NextAction[] {
  const seen = new Set<string>();
  const out: NextAction[] = [];
  for (const action of actions) {
    const key = `${action.tool}:${JSON.stringify(action.arguments)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out.slice(0, 6);
}

export function explainErrorText(input: { error_text: string; log_tail?: string }): ExplainResult {
  const raw = `${input.error_text ?? ""}\n${input.log_tail ?? ""}`.slice(0, MAX_INPUT);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const errorLine = pickErrorLine(lines);

  const fileMatch = FILE_LINE_RE.exec(raw);
  const file = fileMatch ? fileMatch[1] : null;
  const line = fileMatch ? Number(fileMatch[2]) : null;
  const language = guessLanguage(raw);
  const ctx: RuleContext = { text: raw, errorLine: errorLine ?? "", file, line, language };

  const diagnoses: Diagnosis[] = [];
  for (const rule of RULES) {
    if (!rule.pattern.test(raw)) continue;
    diagnoses.push({
      rule_id: rule.id,
      title: rule.title,
      confidence: rule.confidence,
      matched_line: errorLine ?? shortLine(raw),
      likely_cause: rule.cause,
      suggested_fix: rule.fix,
      ...(rule.retry ? { retry_hint: rule.retry } : {}),
      next_actions: rule.actions ? dedupeActions(rule.actions(ctx)) : [],
    });
    if (diagnoses.length >= 3) break; // three is enough to act on; more is noise
  }

  const actions = dedupeActions(diagnoses.flatMap((d) => d.next_actions));
  const summary = diagnoses.length
    ? diagnoses.map((d) => d.title).join("; ")
    : "No known signature matched — triage manually.";

  return {
    matched: diagnoses.length > 0,
    summary,
    error_line: errorLine,
    language,
    diagnoses,
    next_actions: actions,
    notes:
      "Deterministic rules (no model call). The first diagnosis is the best match; next_actions are ready-to-send tool calls.",
  };
}
