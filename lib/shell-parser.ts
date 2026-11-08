import { PLATFORM } from "./workspace.js";
import { resolveShellDialect, type ShellDialect } from "./shell-dialect.js";
import { tokenize, type Token } from "./shell-tokenizer.js";
import { normalizePowerShellParameters } from "./shell-powershell-params.js";
import { normalizeCmdSwitchArgv } from "./shell-cmd-switches.js";

export type Segment = {
  raw: string;
  argv: string[];
  command: string;
  subcommand: string | null;
};

export type ParsedCommand = {
  raw: string;
  segments: Segment[];
  operators: string[];
  redirect_targets: string[];
  cd_targets: string[];
  has_operator: boolean;
  has_pipe: boolean;
  has_redirect: boolean;
  has_substitution: boolean;
  has_background: boolean;
  empty: boolean;
  /** Policy dialect this command was parsed for (posix / powershell / cmd). */
  dialect: ShellDialect;
};

const RUNNERS = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "bun", "node", "cargo", "go",
  "python", "python3", "pip", "pip3", "dotnet", "docker", "podman",
  "kubectl", "gh", "apt", "apt-get", "dnf", "yum", "pacman", "brew",
  "winget", "choco", "scoop", "deno", "ruby", "gem", "php", "composer",
  "mvn", "gradle",
]);

const REDIRECT_NEEDS_TARGET = new Set([">", ">>", ">|", "<", "<<", "&>", "&>>"]);

/**
 * Redirect targets that discard output instead of writing a file. The spelling is dialect-specific:
 * `$null` is only a sink in PowerShell (in POSIX it is an ordinary, possibly attacker-set, variable)
 * and `nul` only in cmd/PowerShell (in POSIX it is a regular file name).
 */
export function isNullSink(target: string, dialect: ShellDialect): boolean {
  const lower = target.toLowerCase();
  if (lower === "/dev/null") return true;
  if (dialect === "powershell") return lower === "$null" || lower === "nul";
  if (dialect === "cmd") return lower === "nul";
  return false;
}
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);

/** Interpreter names (with/without `.exe`) usable as the inner target of `cmd /c <script|command>`. */
const CMD_INTERPRETERS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "pwsh-preview",
  "bash",
  "sh",
  "sh.exe",
  "zsh",
  "fish",
  "ksh",
  "dash",
  "node",
  "nodejs",
  "node.exe",
  "python",
  "python3",
  "perl",
  "ruby",
  "deno",
  "tsx",
  "ts-node",
]);

function gitSubcommand(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (GIT_OPTIONS_WITH_VALUE.has(arg)) {
      if (i + 1 >= argv.length) return null;
      i += 1;
      continue;
    }
    if (
      arg === "--exec-path" ||
      arg === "--no-pager" ||
      arg === "--paginate" ||
      arg === "--no-replace-objects" ||
      arg === "--no-lazy-fetch" ||
      arg === "--no-optional-locks" ||
      arg === "--bare" ||
      arg === "--literal-pathspecs" ||
      arg === "--glob-pathspecs" ||
      arg === "--noglob-pathspecs" ||
      arg === "--icase-pathspecs" ||
      arg === "-p" ||
      arg === "-P"
    ) {
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") ||
      arg.startsWith("--namespace=") || arg.startsWith("--config-env=") ||
      arg.startsWith("--super-prefix=") || arg.startsWith("--exec-path=")) {
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg.toLowerCase();
  }
  return null;
}

function makeSegment(argv: string[], raw: string): Segment {
  const first = argv[0] ?? "";
  const base = first.split(/[\\/]/).pop() ?? first;
  const command = PLATFORM === "win32" ? base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase() : base.toLowerCase();
  let subcommand: string | null = null;
  if (command === "git") {
    subcommand = gitSubcommand(argv);
  } else if (RUNNERS.has(command)) {
    subcommand = argv.slice(1).find((arg) => !arg.startsWith("-")) ?? null;
    if (subcommand) subcommand = subcommand.toLowerCase();
  } else if (argv.length > 1 && !argv[1].startsWith("-")) {
    subcommand = argv[1].toLowerCase();
  }
  return { raw, argv, command, subcommand };
}

export function parseShellCommand(raw: string, options?: { shell?: string }): ParsedCommand {
  const { tokens, has_substitution } = tokenize(raw, options);
  const segments: Segment[] = [];
  const operators: string[] = [];
  const redirect_targets: string[] = [];
  let argv: string[] = [];
  let rawParts: string[] = [];
  let expectTarget = false;

  const flushSegment = (): void => {
    if (argv.length > 0) segments.push(makeSegment(argv, rawParts.join(" ")));
    argv = [];
    rawParts = [];
  };

  for (const tok of tokens) {
    if (tok.type === "word") {
      if (expectTarget) {
        redirect_targets.push(tok.value);
        expectTarget = false;
        rawParts.push(tok.value);
        continue;
      }
      argv.push(tok.value);
      rawParts.push(tok.value);
      continue;
    }
    if (tok.type === "redirect") {
      if (REDIRECT_NEEDS_TARGET.has(tok.value)) expectTarget = true;
      rawParts.push(tok.value);
      continue;
    }
    operators.push(tok.value);
    flushSegment();
  }
  flushSegment();

  const dialect = resolveShellDialect(options?.shell);
  let normalizedSegments: typeof segments;
  if (dialect === "cmd") {
    // Unwrapping can expose another `cmd /c …` shim (`cmd /c cmd /c …`), so iterate to a fixed point.
    let list = segments.map((segment) => normalizeCmdSegment(unwrapCmdSegment(segment)));
    for (let depth = 0; depth < 4; depth += 1) {
      const next = list.map((segment) => normalizeCmdSegment(unwrapCmdSegment(segment)));
      const same =
        next.length === list.length && next.every((segment, index) => segment.argv === list[index].argv && segment.command === list[index].command);
      list = next;
      if (same) break;
    }
    normalizedSegments = list;
  } else {
    normalizedSegments = segments.map((segment) => (dialect === "powershell" ? splitPowerShellSegment(segment) : segment));
  }

  const cd_targets: string[] = [];
  for (const segment of normalizedSegments) {
    if (["cd", "chdir", "sl", "set-location"].includes(segment.command) && segment.argv[1]) {
      cd_targets.push(segment.argv[1]);
    }
  }

  return {
    raw,
    segments: normalizedSegments,
    operators,
    redirect_targets,
    cd_targets,
    has_operator: operators.length > 0,
    has_pipe: operators.includes("|"),
    has_redirect: redirect_targets.length > 0,
    has_substitution,
    has_background: operators.includes("&"),
    empty: segments.length === 0,
    dialect,
  };
}

/** PowerShell `-Name:value` / `-Rec` are the same parameters as `-Name value` / `-Recurse`; expose the operand. */
function splitPowerShellSegment(segment: Segment): Segment {
  const argv = normalizePowerShellParameters(segment.argv, segment.command);
  if (argv === segment.argv) return segment;
  return makeSegment(argv, segment.raw);
}

function normalizeCmdSegment(segment: Segment): Segment {
  const argv = normalizeCmdSwitchArgv(segment.argv);
  if (argv === segment.argv) return segment;
  return makeSegment(argv, argv.join(" "));
}

function cmdBaseName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * cmd.exe semantics: `cmd /c <command-or-script>` (and `/k`) delegates to an
 * inner command. Unwrap the interpreter shim so policy rules evaluate the inner
 * command's flags and operands (`del /f /s /q C:\Windows`, `git push`,
 * `npm publish`, `powershell -enc …`) instead of the shim plus the literal `/c`
 * flag. `cmd/c` (no space) is the same invocation.
 */
function unwrapCmdSegment(segment: Segment): Segment {
  let argv = segment.argv;
  const gluedShell = /^(cmd(?:\.exe)?)(\/[ck])$/i.exec(argv[0] ?? "");
  if (gluedShell) argv = [gluedShell[1], gluedShell[2], ...argv.slice(1)];
  if (cmdBaseName(argv[0] ?? "") !== "cmd") return segment;
  const flag = (argv[1] ?? "").toLowerCase();
  if (flag !== "/c" && flag !== "/k") return segment;
  const inner = normalizeCmdSwitchArgv(argv.slice(2));
  if (inner.length === 0) return segment;
  const firstLower = inner[0].toLowerCase();
  const isInterpreter = [...CMD_INTERPRETERS].some((name) => name === firstLower);
  const isScript = /\.(bat|cmd|ps1|psm1|js|mjs|cjs|ts|tsx|py|pl|rb|sh|bash)$/i.test(inner[0]);
  const hasPathSeparator = /[\\/]/.test(inner[0]);
  const looksLikeCommand = !isScript && !hasPathSeparator;
  if (!isInterpreter && !looksLikeCommand) return segment;
  return makeSegment([...inner], inner.join(" "));
}
