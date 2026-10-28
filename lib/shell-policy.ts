/**
 * Shell command policy for `project_shell_run`.
 *
 * Why this exists
 * ---------------
 * The workspace lock protects the *file* tools, but a shell can do anything the
 * user can: `rm -rf ~`, `curl … | sh`, `git push --force`. A blacklist alone is
 * not a security boundary (there are unbounded ways to spell the same command),
 * so this module combines three layers:
 *
 *   1. A small, high-confidence DENY set for unambiguous catastrophes.
 *   2. An ASK set for commands whose blast radius is real but sometimes wanted
 *      (writes outside the workspace, network fetches, package publishing,
 *      history rewriting, privilege escalation).
 *   3. A strict ALLOW list (opt-in via VENIRA_SHELL_MODE=strict) for
 *      read-only / workspace-local commands, so "everything else" requires an
 *      explicit approval instead of being allowed by default.
 *
 * Decisions are deterministic and auditable: every result carries the rule id
 * that produced it.
 *
 * Approval model
 * --------------
 * `ask` never runs the command. The caller receives an `approval_required`
 * error containing a signed, short-lived `approval_token` bound to the exact
 * command text (SHA-256), the rule id and the session. Retrying the same command
 * with that token executes it once. `approval_scope: "session"` upgrades it to a
 * TTL grant for the same rule + command head (e.g. `git push`), which avoids
 * blocking an agent on every poll while staying narrow.
 *
 * Policy file
 * -----------
 * Optional JSON at `VENIRA_SHELL_POLICY_FILE` (explicit path only). Policy is
 * deliberately NOT read from the workspace by default: a cloned repository must
 * not be able to ship a permissive policy for itself.
 */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { PLATFORM, UNRESTRICTED, WORKSPACE } from "./workspace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShellMode = "strict" | "balanced" | "permissive" | "off";
export type Tier = "allow" | "ask" | "deny";

export type ShellRule = {
  id: string;
  tier: Tier;
  command?: string;
  subcommand?: string;
  /** Regex matched against the joined arguments of a segment. */
  args_regex?: string;
  reason?: string;
};

export type ShellPolicy = {
  mode: ShellMode;
  allow: ShellRule[];
  ask: ShellRule[];
  deny: ShellRule[];
  source: string;
};

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
};

export type Decision = {
  tier: Tier;
  rule: string;
  reason: string;
  mode: ShellMode;
  command_hash: string;
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const REDIRECT_OPS = new Set([">", ">>", ">|", "<", "<<", "&>", "&>>"]);
const SEPARATOR_OPS = new Set([";", "&&", "||", "|", "&"]);

type Token = { type: "word" | "op" | "redirect"; value: string };

/**
 * Split a raw command line into words / operators / redirects, honouring
 * quotes and backslash escapes. Deliberately conservative: anything this
 * parser cannot model makes the command *more* likely to require approval,
 * never less.
 */
export function tokenize(raw: string): { tokens: Token[]; has_substitution: boolean } {
  const tokens: Token[] = [];
  let word = "";
  let hasWord = false;
  let quote: "'" | '"' | null = null;
  let hasSubstitution = false;

  const flush = (): void => {
    if (!hasWord) return;
    tokens.push({ type: "word", value: word });
    word = "";
    hasWord = false;
  };
  const pushOp = (op: string): void => {
    flush();
    tokens.push({ type: REDIRECT_OPS.has(op) || op.startsWith(">&") ? "redirect" : "op", value: op });
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else {
        word += ch;
        hasWord = true;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < raw.length) {
        word += raw[i + 1];
        i += 1;
        hasWord = true;
        continue;
      }
      if (ch === "`" || (ch === "$" && raw[i + 1] === "(")) hasSubstitution = true;
      word += ch;
      hasWord = true;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < raw.length) {
        word += raw[i + 1];
        i += 1;
        hasWord = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      flush();
      continue;
    }
    if (ch === "`") {
      hasSubstitution = true;
      word += ch;
      hasWord = true;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "(") {
      hasSubstitution = true;
      word += ch;
      hasWord = true;
      continue;
    }

    if (";&|<>".includes(ch)) {
      // File-descriptor redirects such as 2>&1 or 1>&2: keep the whole thing
      // as one redirect token, and drop the numeric fd word we already have.
      if ((ch === ">" || ch === "&") && raw[i + 1] === "&" && /^[0-9]*$/.test(word)) {
        let j = i + 2;
        let fd = "";
        while (j < raw.length && /[0-9-]/.test(raw[j])) {
          fd += raw[j];
          j += 1;
        }
        word = "";
        hasWord = false;
        tokens.push({ type: "redirect", value: ">&" + fd });
        i = j - 1;
        continue;
      }
      // Pure-number word directly before a redirect is a fd, not an argument.
      if ((ch === ">" || ch === "<") && /^[0-9]+$/.test(word)) {
        word = "";
        hasWord = false;
      }

      const three = raw.slice(i, i + 3);
      const two = raw.slice(i, i + 2);
      let op = ch;
      if (["&>>"].includes(three)) op = three;
      else if ([">>", "&&", "||", "&>", ">|", "<<", "2>", "1>", "0<"].includes(two)) op = two;
      pushOp(op);
      i += op.length - 1;
      continue;
    }

    word += ch;
    hasWord = true;
  }
  flush();

  return { tokens, has_substitution: hasSubstitution };
}

/** Commands that take a subcommand we care about in policy rules. */
const RUNNERS = new Set([
  "git",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "cargo",
  "go",
  "python",
  "python3",
  "pip",
  "pip3",
  "dotnet",
  "docker",
  "podman",
  "kubectl",
  "gh",
  "apt",
  "apt-get",
  "dnf",
  "yum",
  "pacman",
  "brew",
  "winget",
  "choco",
  "scoop",
  "deno",
  "ruby",
  "gem",
  "php",
  "composer",
  "mvn",
  "gradle",
]);

const REDIRECT_NEEDS_TARGET = new Set([">", ">>", ">|", "<", "<<", "&>", "&>>"]);

function makeSegment(argv: string[], raw: string): Segment {
  const first = argv[0] ?? "";
  const base = first.split(/[\\/]/).pop() ?? first;
  const command = PLATFORM === "win32" ? base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase() : base;
  let subcommand: string | null = null;
  if (RUNNERS.has(command)) {
    subcommand = argv.slice(1).find((arg) => !arg.startsWith("-")) ?? null;
    if (subcommand) subcommand = subcommand.toLowerCase();
  } else if (argv.length > 1 && !argv[1].startsWith("-")) {
    subcommand = argv[1].toLowerCase();
  }
  return { raw, argv, command, subcommand };
}

export function parseShellCommand(raw: string): ParsedCommand {
  const { tokens, has_substitution } = tokenize(raw);
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

  const cd_targets: string[] = [];
  for (const segment of segments) {
    if (["cd", "chdir", "sl", "set-location"].includes(segment.command) && segment.argv[1]) {
      cd_targets.push(segment.argv[1]);
    }
  }

  return {
    raw,
    segments,
    operators,
    redirect_targets,
    cd_targets,
    has_operator: operators.length > 0,
    has_pipe: operators.includes("|"),
    has_redirect: redirect_targets.length > 0,
    has_substitution,
    has_background: operators.includes("&"),
    empty: segments.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function expandHome(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/") || target.startsWith("~\\")) return path.join(os.homedir(), target.slice(2));
  return target;
}

/** True when `target` resolves outside the workspace (ignores env vars / globs). */
export function isOutsideWorkspace(target: string, cwd: string): boolean {
  if (UNRESTRICTED) return false;
  const raw = target.trim();
  if (!raw || raw === "-" || raw.startsWith("$") || raw.startsWith("%")) return false;
  if (/^[|&<>]/.test(raw)) return false;
  const expanded = expandHome(raw);
  const abs = path.resolve(cwd, expanded);
  const rel = path.relative(WORKSPACE, abs);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

const WRITE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "mv",
  "move",
  "cp",
  "copy",
  "mkdir",
  "md",
  "touch",
  "tee",
  "truncate",
  "dd",
  "robocopy",
  "xcopy",
  "ln",
  "mklink",
]);

function writeTargetsOutside(parsed: ParsedCommand, cwd: string): string[] {
  const targets: string[] = [];
  for (const target of parsed.redirect_targets) {
    if (isOutsideWorkspace(target, cwd)) targets.push(target);
  }
  for (const segment of parsed.segments) {
    if (!WRITE_COMMANDS.has(segment.command)) continue;
    for (const arg of segment.argv.slice(1)) {
      if (arg.startsWith("-")) continue;
      if (isOutsideWorkspace(arg, cwd)) targets.push(arg);
    }
  }
  return targets;
}

const NETWORK_COMMANDS = new Set([
  "curl",
  "curl.exe",
  "wget",
  "httpie",
  "http",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "telnet",
  "nc",
  "ncat",
  "netcat",
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "irm",
]);

const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "node", "python", "python3", "perl", "ruby", "pwsh", "powershell"]);

const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "go", "gem", "composer", "dotnet", "winget", "choco", "scoop", "brew", "apt", "apt-get", "dnf", "yum", "pacman", "mvn", "gradle"]);

/** Subcommands that fetch and install/uninstall software or publish artifacts. */
const PKG_MUTATING = new Set([
  "publish",
  "upgrade",
  "update",
  "global",
]);

/**
 * Dev-workflow package mutations that are routine and low-risk:
 * they only touch the local workspace node_modules.  Kept out of
 * `PKG_MUTATING` so that `balanced` mode does not ask approval for
 * `npm install`, `npm ci`, `pnpm add`, `yarn add`, etc.
 */
const PKG_SAFE = new Set([
  "install",
  "i",
  "add",
  "ci",
  "uninstall",
  "remove",
  "rm",
  "exec",
  "create",
  "dlx",
]);

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

/** Unambiguous catastrophes: always denied, in every mode except `off`. */
const HARD_DENY: Array<{ id: string; test: (parsed: ParsedCommand, raw: string, cwd: string) => boolean; reason: string }> = [
  {
    id: "disk_destroy",
    reason: "This command overwrites a disk or filesystem device.",
    test: (_p, raw) => /\b(mkfs(\.[a-z0-9]+)?|mke2fs|fdisk|sfdisk|parted|diskpart|wipefs)\b/i.test(raw) || /\bdd\b[^\n]*\bof=\/dev\//i.test(raw) || /\bformat\s+[a-z]:/i.test(raw),
  },
  {
    id: "filesystem_mount_overwrite",
    reason: "Mounting a filesystem over a path may replace the entire directory tree.",
    test: (_p, raw) => /\bmount\b/i.test(raw),
  },
  {
    id: "power_state",
    reason: "This command shuts down or reboots the machine.",
    test: (_p, raw) => /^\s*(shutdown|reboot|halt|poweroff)\b/im.test(raw) || /^\s*(shutdown|restart-computer|stop-computer)\b/im.test(raw),
  },
  {
    id: "vm_state",
    reason: "Powering off or destroying a virtual machine / container is unrecoverable.",
    test: (_p, raw) => /\b(virtualbox|vmware|libvirt|virsh|lxc)\b[^\n]*\b(destroy|off|stop|delete|kill)\b/i.test(raw) || /\bdestroy-machine\b/i.test(raw),
  },
  {
    id: "container_state",
    reason: "Stopping or destroying containers or images on the host.",
    test: (_p, raw) => /\b(docker|podman|nerdctl|kubernetes|kubectl)\b[^\n]*\b(destroy|rm|delete|stop|prune|system)\b/i.test(raw),
  },
  {
    id: "fork_bomb",
    reason: "This is a fork bomb.",
    test: (_p, raw) => /:\(\)\s*\{[^}]*\|[^}]*:/.test(raw),
  },
  {
    id: "pipe_download_to_shell",
    reason: "Piping a download straight into a shell executes unverified remote code.",
    test: (parsed) => {
      if (!parsed.has_pipe) return false;
      const first = parsed.segments[0];
      const last = parsed.segments[parsed.segments.length - 1];
      if (!first || !last) return false;
      return NETWORK_COMMANDS.has(first.command) && SHELL_COMMANDS.has(last.command);
    },
  },
  {
    id: "privilege_escalation",
    reason: "Elevating privileges is never allowed from an agent session.",
    test: (_p, raw, _cwd) => /(^|[\s;&|])(sudo|doas|pkexec|runas)\b/i.test(raw),
  },
  {
    id: "root_delete",
    reason: "This deletes a filesystem root or your entire home directory.",
    test: (_p, raw) => /(^|[\s;&|])rm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|\/\*|~|~\/\*|\$HOME|\$HOME\/\*)\s*($|[;&|])/i.test(raw),
  },
  {
    id: "chmod_root",
    reason: "Recursively opening permissions on the filesystem root.",
    test: (_p, raw) => /chmod\s+(-R\s+)?(777|a\+rwx)\s+\/(\s|$)/i.test(raw),
  },
  {
    id: "windows_mass_delete",
    reason: "This deletes a drive root on Windows.",
    test: (_p, raw) => /\b(rd|rmdir|del|erase)\b[^\n]*\/s[^\n]*\b[a-z]:\\?(\s|$|\*)/i.test(raw),
  },
];

type AskRule = { id: string; reason: string; test: (parsed: ParsedCommand, cwd: string) => boolean };

const ASK_RULES: AskRule[] = [
  {
    id: "writes_outside_workspace",
    reason: "This command writes or deletes outside the workspace.",
    test: (parsed, cwd) => writeTargetsOutside(parsed, cwd).length > 0,
  },
  {
    id: "cd_outside_workspace",
    reason: "This command changes directory outside the workspace.",
    test: (parsed, cwd) => parsed.cd_targets.some((target) => isOutsideWorkspace(target, cwd)),
  },
  {
    id: "network_access",
    reason: "This command reaches the network.",
    test: (parsed) => parsed.segments.some((segment) => NETWORK_COMMANDS.has(segment.command)),
  },
  {
    id: "package_mutation",
    reason: "This command mutates the global / shared package state.",
    test: (parsed) =>
      parsed.segments.some(
        (segment) =>
          PKG_MANAGERS.has(segment.command) &&
          segment.subcommand !== null &&
          PKG_MUTATING.has(segment.subcommand),
      ),
  },
  {
    id: "git_history_rewrite",
    reason: "This can overwrite commits or discard working-tree changes.",
    test: (parsed) =>
      parsed.segments.some((segment) => {
        if (segment.command !== "git" || !segment.subcommand) return false;
        const args = segment.argv.join(" ");
        if (segment.subcommand === "push") return /\s(-f|--force|--force-with-lease)\b/.test(args) || /\+[^\s]+/.test(args);
        if (segment.subcommand === "reset") return /--hard/.test(args);
        if (segment.subcommand === "clean") return /\s-[a-z]*[fx]/.test(args);
        if (segment.subcommand === "branch") return /\s-D\b/.test(args);
        if (segment.subcommand === "checkout" || segment.subcommand === "restore") return /\s(--\s+)?\.[\s]*$|\s--\s/.test(args);
        if (segment.subcommand === "filter-branch" || segment.subcommand === "reflog") return true;
        return false;
      }),
  },
  {
    id: "container_control",
    reason: "This controls containers or images on the host.",
    test: (parsed) => parsed.segments.some((segment) => ["docker", "podman", "nerdctl"].includes(segment.command)),
  },
  {
    id: "process_control",
    reason: "This kills or signals processes it does not own.",
    test: (parsed) => parsed.segments.some((segment) => ["kill", "killall", "pkill", "taskkill", "stop-process"].includes(segment.command)),
  },
  {
    id: "secret_dump",
    reason: "This prints the whole environment, which usually contains secrets.",
    test: (parsed) => parsed.segments.some((segment) => ["env", "printenv", "set", "export"].includes(segment.command) && segment.argv.length === 1),
  },
  {
    id: "dynamic_execution",
    reason: "This evaluates a string as code, which the policy cannot inspect.",
    test: (parsed) => parsed.segments.some((segment) => ["eval", "exec", "source", ".", "invoke-expression", "iex"].includes(segment.command)),
  },
  {
    id: "recursive_delete_glob",
    reason: "This deletes recursively with a wildcard, which is easy to mis-scope.",
    test: (parsed) => parsed.segments.some((segment) => /^(rm|rd|rmdir|del|erase)$/.test(segment.command) && segment.argv.some((arg) => /[rf]/i.test(arg.startsWith("-") || arg.startsWith("/") ? arg : "") && /[*?]/.test(segment.argv.join(" ")))),
  },
];

/** Commands that are safe and routine in a dev workspace. Not flagged. */
const SAFE_COMMANDS = new Set([
  "node",
  "npx",
  "tsc",
  "esbuild",
  "tsx",
  "vitest",
  "jest",
  "eslint",
  "prettier",
  "node_modules",
  "git",
]);

/** Read-only / workspace-local commands allowed without approval in `strict`. */
const STRICT_ALLOW: Array<{ command: string; subcommands?: string[] }> = [
  { command: "ls" },
  { command: "dir" },
  { command: "pwd" },
  { command: "echo" },
  { command: "write-output" },
  { command: "cat" },
  { command: "type" },
  { command: "get-content" },
  { command: "head" },
  { command: "tail" },
  { command: "wc" },
  { command: "which" },
  { command: "where" },
  { command: "whoami" },
  { command: "date" },
  { command: "stat" },
  { command: "file" },
  { command: "tree" },
  { command: "du" },
  { command: "df" },
  { command: "sort" },
  { command: "uniq" },
  { command: "cut" },
  { command: "grep" },
  { command: "rg" },
  { command: "select-string" },
  { command: "find" },
  { command: "test" },
  { command: "true" },
  { command: "false" },
  { command: "mkdir" },
  { command: "touch" },
  { command: "cp" },
  { command: "mv" },
  { command: "rm" },
  { command: "node" },
  { command: "git", subcommands: ["status", "log", "diff", "show", "branch", "rev-parse", "remote", "describe", "blame", "ls-files", "shortlog", "tag", "config"] },
  { command: "npm", subcommands: ["ls", "list", "view", "outdated", "config"] },
  { command: "pnpm", subcommands: ["ls", "list", "why", "outdated"] },
  { command: "yarn", subcommands: ["info", "why", "list", "outdated"] },
  { command: "tsc", subcommands: [] },
  { command: "python", subcommands: [] },
  { command: "python3", subcommands: [] },
  { command: "go", subcommands: ["version", "env", "list"] },
  { command: "cargo", subcommands: ["version", "--version"] },
  { command: "dotnet", subcommands: ["--info", "--version", "build", "test"] },
];

// ---------------------------------------------------------------------------
// Policy loading
// ---------------------------------------------------------------------------

function readRules(value: unknown, tier: Tier): ShellRule[] {
  if (!Array.isArray(value)) return [];
  const rules: ShellRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.command !== "string" || !candidate.command) continue;
    rules.push({
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : `${tier}_${candidate.command}`,
      tier,
      command: candidate.command.toLowerCase(),
      ...(typeof candidate.subcommand === "string" ? { subcommand: candidate.subcommand.toLowerCase() } : {}),
      ...(typeof candidate.args_regex === "string" ? { args_regex: candidate.args_regex } : {}),
      ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
    });
  }
  return rules;
}

function normaliseMode(value: string | undefined): ShellMode | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "strict" || v === "balanced" || v === "permissive" || v === "off") return v;
  if (v === "ask") return "strict";
  if (v === "allow") return "permissive";
  if (v === "disabled" || v === "none") return "off";
  return null;
}

let cachedPolicy: ShellPolicy | null = null;

export function loadShellPolicy(): ShellPolicy {
  if (cachedPolicy) return cachedPolicy;

  const policy: ShellPolicy = { mode: "balanced", allow: [], ask: [], deny: [], source: "builtin" };
  const envMode = normaliseMode(process.env.VENIRA_SHELL_MODE);
  if (envMode) policy.mode = envMode;

  const file = process.env.VENIRA_SHELL_POLICY_FILE;
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const fileMode = normaliseMode(typeof parsed.mode === "string" ? parsed.mode : undefined);
      if (fileMode && !envMode) policy.mode = fileMode;
      policy.allow = readRules(parsed.allow, "allow");
      policy.ask = readRules(parsed.ask, "ask");
      policy.deny = readRules(parsed.deny, "deny");
      policy.source = file;
    } catch (error) {
      console.error(
        `[shell-policy] ignoring ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      policy.source = "builtin (policy file unreadable)";
    }
  } else if (file) {
    console.error(`[shell-policy] policy file not found: ${file} (using built-in rules)`);
    policy.source = "builtin (policy file missing)";
  }

  cachedPolicy = policy;
  return policy;
}

/** Test hook: drop the cache so a new env/policy file is picked up. */
export function resetShellPolicyCache(): void {
  cachedPolicy = null;
}

export function describeShellPolicy(): { mode: ShellMode; source: string; rules: { allow: number; ask: number; deny: number }; builtin: { deny: number; ask: number } } {
  const policy = loadShellPolicy();
  return {
    mode: policy.mode,
    source: policy.source,
    rules: { allow: policy.allow.length, ask: policy.ask.length, deny: policy.deny.length },
    builtin: { deny: HARD_DENY.length, ask: ASK_RULES.length },
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function commandHash(command: string): string {
  return crypto.createHash("sha256").update(command.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 32);
}

/** The narrow key used for session-scoped approvals, e.g. "git push". */
export function commandKey(parsed: ParsedCommand): string {
  const first = parsed.segments[0];
  if (!first) return "empty";
  return `${first.command}${first.subcommand ? " " + first.subcommand : ""}`;
}

function matchCustomRule(parsed: ParsedCommand, rule: ShellRule): boolean {
  if (!rule.command) return false;
  return parsed.segments.some((segment) => {
    if (segment.command !== rule.command) return false;
    if (rule.subcommand && segment.subcommand !== rule.subcommand) return false;
    if (rule.args_regex) {
      try {
        if (!new RegExp(rule.args_regex, "i").test(segment.argv.slice(1).join(" "))) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
}

function strictAllow(parsed: ParsedCommand): boolean {
  return parsed.segments.every((segment) => {
    const entry = STRICT_ALLOW.find((rule) => rule.command === segment.command);
    if (!entry) return false;
    if (!entry.subcommands) return true;
    if (entry.subcommands.length === 0) return true;
    // Flags like --version are not subcommands; accept a bare flag-only call.
    if (!segment.subcommand) return true;
    return entry.subcommands.includes(segment.subcommand);
  });
}

export function evaluateShellCommand(
  command: string,
  cwd: string,
  options: { mode?: ShellMode } = {},
): Decision {
  const policy = loadShellPolicy();
  const mode = options.mode ?? policy.mode;
  const hash = commandHash(command);
  const parsed = parseShellCommand(command);

  if (mode === "off") {
    return { tier: "allow", rule: "policy_off", reason: "Policy disabled via VENIRA_SHELL_MODE=off.", mode, command_hash: hash };
  }
  if (parsed.empty) {
    return { tier: "allow", rule: "empty", reason: "Nothing to execute.", mode, command_hash: hash };
  }

  // 1. Hard, non-negotiable denials.
  for (const rule of HARD_DENY) {
    if (rule.test(parsed, command, cwd)) {
      return { tier: "deny", rule: `deny.${rule.id}`, reason: rule.reason, mode, command_hash: hash };
    }
  }
  for (const rule of policy.deny) {
    if (matchCustomRule(parsed, rule)) {
      return { tier: "deny", rule: rule.id, reason: rule.reason ?? "Denied by policy file.", mode, command_hash: hash };
    }
  }

  // 2. Explicit allow from the policy file beats the built-in ask heuristics.
  for (const rule of policy.allow) {
    if (matchCustomRule(parsed, rule)) {
      return { tier: "allow", rule: rule.id, reason: rule.reason ?? "Allowed by policy file.", mode, command_hash: hash };
    }
  }

  // 3. Risk heuristics that apply in balanced/strict. `permissive` keeps only
  //    the hard denials above, so an existing workflow cannot start prompting.
  if (mode !== "permissive") {
    // Safe dev-workspace commands are exempt from ask rules in balanced/strict.
    // If the command contains shell operators (pipe, redirect, background)
    // the exemption does not apply — those need human review.
    const allSafe =
      !parsed.has_pipe &&
      !parsed.has_redirect &&
      !parsed.has_background &&
      parsed.segments.every((segment) => SAFE_COMMANDS.has(segment.command));
    if (allSafe) {
      return { tier: "allow", rule: "safe_command", reason: "Routine dev-workspace command.", mode, command_hash: hash };
    }
    for (const rule of ASK_RULES) {
      if (rule.test(parsed, cwd)) {
        return { tier: "ask", rule: `ask.${rule.id}`, reason: rule.reason, mode, command_hash: hash };
      }
    }
  }
  for (const rule of policy.ask) {
    if (matchCustomRule(parsed, rule)) {
      return { tier: "ask", rule: rule.id, reason: rule.reason ?? "Requires approval (policy file).", mode, command_hash: hash };
    }
  }

  // 4. Mode-dependent default.
  if (mode === "strict") {
    if (strictAllow(parsed)) {
      return { tier: "allow", rule: "strict.allowlist", reason: "Read-only or workspace-local command.", mode, command_hash: hash };
    }
    return {
      tier: "ask",
      rule: "strict.default_ask",
      reason: "Not on the strict allow list; approval required by VENIRA_SHELL_MODE=strict.",
      mode,
      command_hash: hash,
    };
  }

  return {
    tier: "allow",
    rule: "default_allow",
    reason: "No deny/ask rule matched.",
    mode,
    command_hash: hash,
  };
}

// ---------------------------------------------------------------------------
// Approval tokens and session grants
// ---------------------------------------------------------------------------

const APPROVAL_SECRET = crypto.randomBytes(32);
const TTL_MS = (() => {
  const value = Number(process.env.VENIRA_SHELL_APPROVAL_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
})();

const usedTokens = new Map<string, number>();
const sessionGrants = new Map<string, number>();

function prune(map: Map<string, number>): void {
  const now = Date.now();
  for (const [key, expires] of map) {
    if (expires <= now) map.delete(key);
  }
}

export function issueApprovalToken(
  sessionId: string,
  decision: Decision,
  ttlMs = TTL_MS,
): { token: string; expires_at: number } {
  const expiresAt = Date.now() + ttlMs;
  const mac = crypto
    .createHmac("sha256", APPROVAL_SECRET)
    .update(`${sessionId}|${decision.rule}|${decision.command_hash}|${expiresAt}`)
    .digest("base64url");
  return { token: `v1.${expiresAt}.${mac}`, expires_at: expiresAt };
}

export function verifyApprovalToken(
  token: string,
  sessionId: string,
  decision: Decision,
): { ok: boolean; reason?: string } {
  const match = /^v1\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(token.trim());
  if (!match) return { ok: false, reason: "malformed" };
  const expiresAt = Number(match[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  const expected = crypto
    .createHmac("sha256", APPROVAL_SECRET)
    .update(`${sessionId}|${decision.rule}|${decision.command_hash}|${expiresAt}`)
    .digest("base64url");
  const a = Buffer.from(match[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };
  if (usedTokens.has(token)) return { ok: false, reason: "already_used" };
  usedTokens.set(token, expiresAt);
  prune(usedTokens);
  return { ok: true };
}

export function grantSessionApproval(sessionId: string, decision: Decision, key: string, ttlMs = TTL_MS): number {
  const expiresAt = Date.now() + ttlMs;
  sessionGrants.set(`${sessionId}|${decision.rule}|${key}`, expiresAt);
  prune(sessionGrants);
  return expiresAt;
}

export function hasSessionApproval(sessionId: string, decision: Decision, key: string): boolean {
  const expires = sessionGrants.get(`${sessionId}|${decision.rule}|${key}`);
  if (!expires) return false;
  if (expires <= Date.now()) {
    sessionGrants.delete(`${sessionId}|${decision.rule}|${key}`);
    return false;
  }
  return true;
}

/** Test hook. */
export function clearApprovals(): void {
  usedTokens.clear();
  sessionGrants.clear();
}

// ---------------------------------------------------------------------------
// Secret redaction (audit + error messages)
// ---------------------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  [/(--?(?:password|passwd|pass|token|secret|api[-_]?key|apikey|access[-_]?key)[=\s]+)(["']?)[^\s"']+\2/gi, "$1[REDACTED]"],
  [/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s]+@/g, "$1[REDACTED]@"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\b((?:export\s+)?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/g, "$1[REDACTED]"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

// ---------------------------------------------------------------------------
// Runtime counters (surfaced by project_health)
// ---------------------------------------------------------------------------

const stats = {
  evaluated: 0,
  allowed: 0,
  asked: 0,
  denied: 0,
  approved: 0,
  timed_out: 0,
  timeout_warn: 0,
  killed_tree: 0,
  output_capped: 0,
};

export function recordDecision(decision: Decision): void {
  stats.evaluated += 1;
  if (decision.tier === "allow") stats.allowed += 1;
  else if (decision.tier === "ask") stats.asked += 1;
  else stats.denied += 1;
}

export function recordApproval(kind: "approved" | "timed_out" | "timeout_warn" | "killed_tree" | "output_capped"): void {
  stats[kind] += 1;
}

export function shellStats(): typeof stats {
  return { ...stats };
}
