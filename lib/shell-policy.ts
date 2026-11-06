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
 *      explicit approval instead of being allowed by default. Git history
 *      rewrites remain an approval gate even in permissive mode.
 *
 * Decisions are deterministic and auditable: every result carries the rule id
 * that produced it.
 *
 * Approval model
 * --------------
 * `ask` never runs the command. The caller receives an `approval_required`
 * error with a pending `approval_id` bound to the exact command, shell, cwd,
 * secret_env and rule. Only a human can grant it (`npx venira-mcp --approve <id>`
 * in a TTY, or MCP elicitation in the client UI); the agent then retries once with
 * `approval_id`. The grant's scope (`once` or `session`) is chosen by the human,
 * never by the model. A `session` grant only covers rules in
 * VENIRA_SESSION_GRANT_RULES, for the same rule + command head (e.g. `git push`).
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
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { UNRESTRICTED, WORKSPACE, activeDataDir, resolveWithin } from "./workspace.js";
import { parseShellCommand, type ParsedCommand, type Segment } from "./shell-parser.js";
import {
  NETWORK_COMMANDS,
  PKG_MANAGERS,
  PKG_MUTATING,
  PKG_SAFE,
  READ_COMMANDS,
  SHELL_COMMANDS,
  STRICT_ALLOW,
} from "./shell-policy-rules.js";
import { evaluateParsedShellCommand, type AskRule, type HardDenyRule } from "./shell-policy-evaluate.js";
import { resolveSecurityProfile, securityProfileIsExplicit, securityProfileSettings } from "./security-profile.js";

export { tokenize } from "./shell-tokenizer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShellMode = "strict" | "balanced" | "permissive" | "off";
export type ShellOverride = "ALLOW_GIT_PUSH" | "ALLOW_ENV_READ";
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

export type { ParsedCommand, Segment };

export type Decision = {
  tier: Tier;
  rule: string;
  reason: string;
  mode: ShellMode;
  command_hash: string;
  /** Human-readable hint shown to the user, e.g. suggesting a safer alternative tool. */
  hint?: string;
};

export { parseShellCommand } from "./shell-parser.js";

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
  if (!raw || raw === "-") return false;
  // An unresolved environment-variable / expression path cannot be proven
  // workspace-local. Require approval rather than allowing `cat $HOME/...`,
  // `${HOME}/...`, `${env:USERPROFILE}\...`, `%USERPROFILE%\...` or `$(...)`.
  // The old pattern only knew the bare `$VAR` form, so `${VAR}` and `${env:VAR}`
  // fell through to default_allow.
  if (/\$\{|\$[A-Za-z_@*#?$!(]|%[A-Za-z_][A-Za-z0-9_]*%|`|\$\(/.test(raw)) return true;
  if (/^[|&<>]/.test(raw)) return false;
  const expanded = expandHome(raw);
  if (path.win32.isAbsolute(expanded) && !path.isAbsolute(expanded)) return true;
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
  "remove-item",
  "ri",
  "rm",
  "del",
  "set-content",
  "sc",
  "add-content",
  "ac",
  "out-file",
  "move-item",
  "mi",
  "copy-item",
  "cpi",
  "new-item",
  "ni",
  "rename-item",
  "clear-content",
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

function globMatches(pattern: string, value: string): boolean {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) return false;
      let characterClass = pattern.slice(i + 1, end);
      if (!characterClass) return false;
      if (characterClass[0] === "!") characterClass = `^${characterClass.slice(1)}`;
      source += `[${characterClass.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`${source}$`, "i").test(value);
  } catch {
    return false;
  }
}

function mayMatchProtectedBasename(token: string, protectedNames: Set<string>): boolean {
  const base = path.basename(token.replace(/\\/g, "/")).toLowerCase();
  if (protectedNames.has(base) || base.startsWith(".env")) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg)$/i.test(base)) return true;
  if (!/[*?[]/.test(base)) return false;

  const protectedCandidates = [
    ...protectedNames,
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "venira.db-wal",
    "venira.db-shm",
    "credential.pem",
    "credential.key",
    "credential.p12",
    "credential.pfx",
    "credential.jks",
    "credential.keystore",
    "credential.crt",
    "credential.cer",
    "credential.der",
    "credential.asc",
    "credential.gpg",
  ];
  return protectedCandidates.some((candidate) => {
    if (candidate.startsWith(".") && !base.startsWith(".")) return false;
    return globMatches(base, candidate);
  });
}

/**
 * A token whose final value is produced by the shell at run time cannot be
 * checked statically. `cat ${HOME}/x`, `cp .e{nv} out`, and PowerShell
 * `Copy-Item ('.e'+'nv') out` all name a path the policy never sees, so any
 * file-reading or file-writing command that carries one needs approval.
 */
const UNRESOLVABLE_TOKEN_PATTERNS: RegExp[] = [
  /\$\{/, // ${VAR}, ${env:VAR}
  /\$[A-Za-z_@*#?$!(]/, // $VAR, $env:..., $(...)
  /%[A-Za-z_][A-Za-z0-9_]*%/, // %VAR%
  /`/, // backtick substitution
  /[{}]/, // brace expansion / script block
  /[()]/, // PowerShell sub-expression / grouping
];

/**
 * Only arguments that can plausibly be a path are inspected, so a regular
 * expression such as `foo(bar)` or `{print $1}` does not turn into an approval
 * prompt for `grep`/`awk`.
 */
function looksLikePathExpression(token: string): boolean {
  if (/[\\/]/.test(token)) return true;
  return [".", "~", "$", "%", "(", "["].includes(token[0] ?? "");
}

function isUnresolvableToken(token: string): boolean {
  return UNRESOLVABLE_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
}

/** Commands that print file contents but are not part of READ_COMMANDS. */
const FILE_INSPECT_COMMANDS = new Set(["select-string", "sls", "findstr"]);

function hasUnresolvableFileArgument(parsed: ParsedCommand): boolean {
  for (const target of parsed.redirect_targets) {
    if (isUnresolvableToken(target)) return true;
  }
  for (const segment of parsed.segments) {
    if (
      !READ_COMMANDS.has(segment.command) &&
      !WRITE_COMMANDS.has(segment.command) &&
      !FILE_INSPECT_COMMANDS.has(segment.command)
    ) {
      continue;
    }
    for (const arg of segment.argv.slice(1)) {
      if (arg.startsWith("-")) continue;
      if (isUnresolvableToken(arg) && looksLikePathExpression(arg)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

/** Unambiguous catastrophes: always denied in every mode. */
const HARD_DENY: HardDenyRule[] = [
  {
    id: "disk_destroy",
    reason: "This command overwrites a disk or filesystem device.",
    test: (parsed, raw) => parsed.segments.some((s) => /^(mkfs|mke2fs|fdisk|sfdisk|parted|diskpart|wipefs|format)$/.test(s.command)) || /\bdd\b[^\n]*\bof=\/dev\//i.test(raw),
  },
  {
    id: "filesystem_mount_overwrite",
    reason: "Mounting a filesystem over a path may replace the entire directory tree.",
    test: (parsed) => parsed.segments.some((s) => s.command === "mount"),
  },
  {
    id: "power_state",
    reason: "This command shuts down or reboots the machine.",
    test: (_p, raw) => /(^|[\s;&|`(])(shutdown|reboot|halt|poweroff)\b/im.test(raw) || /(^|[\s;&|`(])(shutdown|restart-computer|stop-computer)\b/im.test(raw),
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
      if (parsed.segments.length < 2) return false;
      return parsed.segments.some(
        (segment, index) =>
          NETWORK_COMMANDS.has(segment.command) &&
          SHELL_COMMANDS.has(parsed.segments[index + 1]?.command ?? ""),
      );
    },
  },
  {
    id: "privilege_escalation",
    reason: "Elevating privileges is never allowed from an agent session.",
    test: (_p, raw, _cwd) => /(^|[\s;&|`(])(sudo|doas|pkexec|runas)\b/i.test(raw),
  },
  {
    id: "root_delete",
    reason: "This deletes a filesystem root or your entire home directory.",
    test: (_p, raw) => /(^|[\s;&|`(])rm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|\/\*|~|~\/\*|\$HOME|\$HOME\/\*)\s*($|[;&|)`])/i.test(raw),
  },
  {
    id: "chmod_root",
    reason: "Recursively opening permissions on the filesystem root.",
    test: (_p, raw) => /chmod\s+(-R\s+)?(777|a\+rwx)\s+\/(\s|$)/i.test(raw),
  },
  {
    id: "windows_mass_delete",
    reason: "This deletes a drive root, entire drives, and massively recursive files on Windows.",
    test: (_p, raw) =>
      /\b(rd|rmdir|del|erase)\b[^\n]*\/s[^\n]*\b[a-z]:\\?(\s|$|\*)/i.test(raw) ||
      /\b(rd|rmdir)\b\s+\/s[\s\S]*?\b[A-Za-z]:/i.test(raw) ||
      /(\\\\.NUL|>\\\\.NUL|>NUL:)/i.test(raw) ||
      /\b(rd|rmdir)\b\s+\/s[^\n]*\b[A-Za-z]:\??[\s\S]*$/i.test(raw),
  },
  {
    id: "windows_file_delete_wrong_targets",
    reason: "This deletes files with wildcard targets on Windows, which can match multiple files or entire directories.",
    test: (_p, raw) =>
      /\b(del|erase|rd|rmdir)\b[^\n]*\s[\s\S]*?\s(?:\/f[\s\S]*?[\s\S]*?)?\*$/i.test(raw) ||
      /\b(del|erase)\b[^\n]*\s*\*\s*(?:\/s|--recursive)?\s*(?:\/f|--force)?\s*(?:\/q|--quiet)?\s*$/i.test(raw) ||
      /\b((?:^|[\s;&|\\`\)])rm[\s\S]*?-rf[\s\S]*?\/\*[^\n]*)/i.test(raw),
  },
  {
    id: "self_approval",
    reason:
      "Approvals must come from the human operator. Running the approve CLI, importing the approvals module " +
      "or touching the approval store from the agent would let it approve its own request.",
    test: (_p, raw) =>
      (/--approve\b/i.test(raw) && /venira/i.test(raw)) ||
      /scripts[\\/]+approve(\.[cm]?[jt]s)?\b/i.test(raw) ||
      /lib[\\/]+approvals(\.[cm]?[jt]s)?\b/i.test(raw) ||
      /approval\.key\b/i.test(raw) ||
      /approvals[\\/]+[^\s"']*\.(granted|json)\b/i.test(raw),
  },
  {
    id: "powershell_encoded_command",
    reason: "PowerShell encoded commands (-enc/-e/-ec/-encodedcommand) are a common obfuscation technique used in attacks.",
    test: (parsed, raw) =>
      // Keep this check independent of host shell parsing: cross-platform CI
      // may parse a PowerShell command differently when the host shell is bash.
      /(?:powershell|pwsh).*-(?:e|ec|enc|encodedcommand)/i.test(raw) ||
      parsed.segments.some((segment) => {
        if (segment.command !== "powershell" && segment.command !== "pwsh") return false;
        const flags = segment.argv.map((a) => a.toLowerCase());
        return flags.some((f) => ["-e", "-ec", "-enc", "-encodedcommand"].includes(f));
      }),
  },
  {
    id: "protected_file_access",
    reason: "This reads or writes a protected secret store, audit database, or credential file.",
    test: (parsed) => {
      const protectedNames = new Set([
        "secrets.json",
        "secrets.key",
        "venira.db",
        "venira.db-wal",
        "venira.db-shm",
        ".env",
        ".npmrc",
        ".netrc",
        ".pgpass",
        ".git-credentials",
        "credentials.json",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
      ]);
      const dataDir = activeDataDir().toLowerCase();
      const collect = (tokens: string[]): boolean => {
        for (const t of tokens) {
          const base = path.basename(t.replace(/\\/g, "/")).toLowerCase();
          if (mayMatchProtectedBasename(t, protectedNames)) return true;
          if (dataDir && t.toLowerCase().replace(/\\/g, "/").includes(dataDir.replace(/\\/g, "/"))) return true;
          if (/(^|[\\/])venira[\\/](approvals|approval\.key)/i.test(t)) return true;
          if (/\.ssh[\\/]/i.test(t)) return true;
        }
        return false;
      };
      const all: string[] = [];
      for (const seg of parsed.segments) {
        all.push(...seg.argv);
      }
      all.push(...parsed.redirect_targets);
      return collect(all);
    },
  },
];

const ASK_RULES: AskRule[] = [
  {
    id: "command_substitution",
    reason: "This command embeds a substitution ($(..) or backticks) the policy cannot fully inspect.",
    test: (parsed) => parsed.has_substitution,
  },
  {
    id: "read_outside_workspace",
    reason: "This command reads files outside the workspace.",
    test: (parsed, cwd) =>
      parsed.segments.some(
        (segment) =>
          READ_COMMANDS.has(segment.command) &&
          segment.argv.some((arg) => !arg.startsWith("-") && isOutsideWorkspace(arg, cwd)),
      ),
  },
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
      if (segment.command !== "git") return false;
      if (!segment.subcommand) {
        return segment.argv.length > 1 && !segment.argv.slice(1).every((arg) => ["--version", "--help", "-v", "-h"].includes(arg));
      }
      const args = segment.argv.join(" ");
        if (segment.subcommand === "push") return true;
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
    reason: "This executes code that the policy cannot safely inspect.",
    test: (parsed) =>
      parsed.segments.some((segment) => {
        if (["eval", "exec", "source", ".", "invoke-expression", "iex"].includes(segment.command)) return true;
        const flags = segment.argv;
        if (segment.command === "node" || segment.command === "nodejs") {
          const informationalFlags = new Set(["--version", "-v", "--help", "-h"]);
          return (
            parsed.has_pipe ||
            parsed.has_redirect ||
            parsed.has_background ||
            flags.length === 0 ||
            !flags.every((flag) => informationalFlags.has(flag.toLowerCase()))
          );
        }
        const interpreters: Record<string, string[]> = {
          node: ["-e", "--eval", "-p", "--print", "-pe", "-pr"],
          nodejs: ["-e", "--eval", "-p", "--print", "-pe", "-pr"],
          python: ["-c"],
          python3: ["-c"],
          deno: ["eval"],
          bash: ["-c", "-lc", "-ec"],
          sh: ["-c", "-ec"],
          zsh: ["-c", "-lc"],
          powershell: ["-command", "-encodedcommand", "-e", "-ec", "-enc", "-co", "-c"],
          pwsh: ["-command", "-encodedcommand", "-e", "-ec", "-enc", "-co", "-c"],
          cmd: ["/c"],
          perl: ["-e"],
          ruby: ["-e"],
        };
        const expected = interpreters[segment.command];
        if (!expected) return false;
        return flags.some((flag) => expected.some((exp) => {
          const f = flag.toLowerCase();
          const e = exp.toLowerCase();
          if (f === e) return true;
          if (f.startsWith("-") && e.startsWith("-") && f.length > 2 && e.length === 2) {
            return f.includes(e.slice(1));
          }
          return false;
        }));
      }),
  },
  {
    id: "wrapper_command",
    reason: "This wraps another command; the policy cannot see what it will run and requires approval.",
    test: (parsed) => parsed.segments.some((s) => ["command", "builtin", "env", "nohup", "time", "nice", "xargs", "exec", "stdbuf", "setsid", "start", "call"].includes(s.command)),
  },
  {
    id: "find_mutation",
    reason: "find with -delete/-exec can mutate files outside a simple scope.",
    test: (parsed) => parsed.segments.some((s) => s.command === "find" && s.argv.some((a) => a === "-delete" || a === "-exec" || a === "-execdir")),
  },
  {
    id: "destructive_delete",
    reason: "This command performs a destructive recursive/force delete. Use project_delete_path instead for controlled deletion.",
    test: (parsed) =>
      parsed.segments.some((s) => {
        if (!["rm", "rd", "rmdir", "del", "erase", "remove-item", "ri"].includes(s.command)) return false;
        const args = s.argv.join(" ");
        if (/\b-Recurse\b/i.test(args) && /\b-Force\b/i.test(args)) return true;
        if (s.command === "rd" || s.command === "rmdir") {
          if (/\b\/s\b/i.test(args) && /\b\/q\b/i.test(args)) return true;
        }
        if (s.command === "del" || s.command === "erase") {
          if (/\b\/f\b/i.test(args) && /\b\/q\b/i.test(args)) return true;
        }
        if (s.command === "rm") {
          if (/\b-rf\b/i.test(args) && /\/\*$/i.test(args)) return true;
        }
        return false;
      }),
  },
  {
    id: "vm_state",
    reason: "Powering off or destroying a virtual machine / container is unrecoverable.",
    test: (_p, raw) => /\b(virtualbox|vmware|libvirt|virsh|lxc)\b[^\n]*\b(destroy|off|stop|delete|kill)\b/i.test(raw) || /\bdestroy-machine\b/i.test(raw),
  },
  {
    id: "container_state",
    reason: "Destroying container state or pruning container resources on the host is irreversible.",
    test: (_p, raw) => /\b(docker|podman|nerdctl|kubernetes|kubectl)\b[^\n]*\b(destroy|prune|system)\b/i.test(raw),
  },
  {
    id: "taskkill_force",
    reason: "Force-killing processes can terminate critical system processes or applications.",
    test: (_p, raw) => /\btaskkill\b[^\n]*\/f/i.test(raw) || /\btaskkill\b[^\n]*--force/i.test(raw),
  },

  {
    id: "windows_attribute_reset",
    reason: "This attempts to remove hidden/system/read-only attributes, which can bypass certain protections.",
    test: (_p, raw) => /\b(attrib)\b[^\n]*\s*-s\b/i.test(raw) && /\b(attrib)\b[^\n]*\s*-h\b/i.test(raw) && /\b(attrib)\b[^\n]*\s*-r\b/i.test(raw),
  },
  {
    id: "windows_infinite_write",
    reason: "This sends output to NUL (null device) which may create the final file or fail catastrophically on some shells.",
    test: (_p, raw) => /\b(>|>>|>>\s*>)\s*(?:\\\\.NUL|NUL:|nul)\b/i.test(raw),
  },
  {
    id: "unresolved_file_argument",
    reason:
      "This file command takes a path the policy cannot resolve statically (variable, brace expansion, or expression), " +
      "so the protected-file guard cannot see what it will actually read or write.",
    test: (parsed) => hasUnresolvableFileArgument(parsed),
  },
];

/** Commands that are safe and routine in a dev workspace. Not flagged. */
const SAFE_COMMANDS = new Set([
  "start-sleep", "sleep", "node",
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

function isSafeSegment(segment: Segment): boolean {
  if (!SAFE_COMMANDS.has(segment.command)) return false;
  if (segment.command === "git") {
    const safeSubs = new Set(["status", "diff", "log", "show", "add", "commit", "branch"]);
    if (!segment.subcommand || !safeSubs.has(segment.subcommand)) return false;
    if (segment.subcommand === "branch" && /\s-D\b/.test(segment.argv.join(" "))) return false;
    return true;
  }
  if (segment.command === "node") {
    const evalFlags = ["-e", "--eval", "-p", "--print"];
    if (segment.argv.some((arg) => evalFlags.includes(arg.toLowerCase()))) return false;
    const hasFileArg = segment.argv.some((arg) => !arg.startsWith("-"));
    return hasFileArg;
  }
  if (segment.command === "npx") {
    return segment.argv.includes("--no-install");
  }
  return true;
}

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
  return null;
}

const SHELL_OVERRIDE_NAMES = new Set<ShellOverride>(["ALLOW_GIT_PUSH", "ALLOW_ENV_READ"]);

export function isShellOverride(value: unknown): value is ShellOverride {
  return typeof value === "string" && SHELL_OVERRIDE_NAMES.has(value as ShellOverride);
}

export function enabledShellOverrides(): Set<ShellOverride> {
  const raw = process.env.VENIRA_SHELL_OVERRIDES;
  if (raw === undefined || raw.trim() === "") return new Set();
  const enabled = new Set<ShellOverride>();
  for (const token of raw.split(",")) {
    const name = token.trim();
    if (!isShellOverride(name)) {
      throw new Error(
        `[config_invalid] VENIRA_SHELL_OVERRIDES accepts only: ${[...SHELL_OVERRIDE_NAMES].join(", ")}.`,
      );
    }
    enabled.add(name);
  }
  return enabled;
}

function matchesOverride(parsed: ParsedCommand, cwd: string, name: ShellOverride): boolean {
  if (
    parsed.segments.length !== 1 ||
    parsed.has_pipe ||
    parsed.has_redirect ||
    parsed.has_background ||
    parsed.has_substitution
  ) {
    return false;
  }
  const segment = parsed.segments[0];
  if (name === "ALLOW_GIT_PUSH") {
    return segment.command === "git" && segment.subcommand === "push" && segment.argv[1]?.toLowerCase() === "push";
  }
  if (!READ_COMMANDS.has(segment.command)) return false;
  const paths = segment.argv.slice(1).filter((arg) => arg !== "--" && !arg.startsWith("-"));
  if (paths.length !== 1) return false;
  const target = paths[0];
  if (!target || /[*?\[\]$%`]/.test(target) || isOutsideWorkspace(target, cwd)) return false;
  if (!/^\.env(?:\.[a-z0-9._-]+)?$/i.test(path.basename(target.replace(/\\/g, "/")))) return false;
  try {
    const absolute = path.resolve(cwd, target);
    const entry = lstatSync(absolute);
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    resolveWithin(cwd, realpathSync(absolute));
    return true;
  } catch {
    return false;
  }
}

export function shellOverrideMatches(name: ShellOverride, command: string, cwd: string): boolean {
  return matchesOverride(parseShellCommand(command), cwd, name);
}

let cachedPolicy: ShellPolicy | null = null;

export function loadShellPolicy(): ShellPolicy {
  if (cachedPolicy) return cachedPolicy;

  const policy: ShellPolicy = { mode: "balanced", allow: [], ask: [], deny: [], source: "builtin" };
  const rawEnvMode = process.env.VENIRA_SHELL_MODE;
  const envMode = normaliseMode(rawEnvMode);
  if (rawEnvMode !== undefined && !envMode) {
    throw new Error("[config_invalid] VENIRA_SHELL_MODE must be balanced, strict, permissive, or off.");
  }
  // VENIRA_SECURITY_PROFILE sets the baseline; VENIRA_SHELL_MODE (and a policy file mode) override it.
  const profile = resolveSecurityProfile();
  const profileExplicit = securityProfileIsExplicit();
  if (profileExplicit) policy.mode = securityProfileSettings(profile).shellMode;
  if (envMode) policy.mode = envMode;

  const file = process.env.VENIRA_SHELL_POLICY_FILE;
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const rawFileMode = typeof parsed.mode === "string" ? parsed.mode : undefined;
      const fileMode = normaliseMode(rawFileMode);
      if (rawFileMode !== undefined && !fileMode) {
        throw new Error("[config_invalid] shell policy mode must be balanced, strict, permissive, or off.");
      }
      if (fileMode && !envMode) policy.mode = fileMode;
      policy.allow = readRules(parsed.allow, "allow");
      policy.ask = readRules(parsed.ask, "ask");
      policy.deny = readRules(parsed.deny, "deny");
      policy.source = file;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("[config_invalid]")) throw error;
      console.error(
        `[shell-policy] ignoring ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      policy.source = "builtin (policy file unreadable)";
    }
  } else if (file) {
    console.error(`[shell-policy] policy file not found: ${file} (using built-in rules)`);
    policy.source = "builtin (policy file missing)";
  }

  if (policy.mode === "off") {
    console.error(
      "[shell-policy] WARNING: shell mode off (VENIRA_SECURITY_PROFILE=off or VENIRA_SHELL_MODE=off) disables ALL shell policy checks (hard-deny included). " +
        "Use only in a trusted environment. secret_env still requires approval.",
    );
  }

  if (/^(1|true|yes|on)$/i.test((process.env.VENIRA_SHELL_AUTO_APPROVE_TOKEN ?? "").trim())) {
    console.error(
      "[shell-policy] WARNING: VENIRA_SHELL_AUTO_APPROVE_TOKEN was removed in v1.15 and is ignored. " +
        "Approvals now always use approval_id granted by a human (npx venira-mcp --approve <id> or client elicitation).",
    );
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

export function evaluateShellCommand(
  command: string,
  cwd: string,
  options: { mode?: ShellMode; override?: ShellOverride; overrideReason?: string } = {},
): Decision {
  const policy = loadShellPolicy();
  const mode = options.mode ?? policy.mode;
  const parsed = parseShellCommand(command);
  const enabled = enabledShellOverrides();
  const override = options.override
    ? {
        name: options.override,
        reason: options.overrideReason ?? "",
        enabled: enabled.has(options.override),
        matches: (candidate: ParsedCommand, currentCwd: string) =>
          matchesOverride(candidate, currentCwd, options.override!),
      }
    : undefined;
  return evaluateParsedShellCommand(
    command,
    cwd,
    parsed,
    policy,
    mode,
    HARD_DENY,
    ASK_RULES,
    STRICT_ALLOW,
    isSafeSegment,
    override,
  );
}

// ---------------------------------------------------------------------------
// Session grants (fed only by verified human grants: CLI or elicitation)
// ---------------------------------------------------------------------------

const TTL_MS = (() => {
  const value = Number(process.env.VENIRA_SHELL_APPROVAL_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
})();

const sessionGrants = new Map<string, number>();

function prune(map: Map<string, number>): void {
  const now = Date.now();
  for (const [key, expires] of map) {
    if (expires <= now) map.delete(key);
  }
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
  // ENV-style secret vars in Rust / cargo log output (DATABASE_URL=..., GITHUB_TOKEN=..., ...)
  [/\b((?:export\s+)?[A-Z][A-Z0-9_]*(?:_URL|SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/g, "$1[REDACTED]"],
  // Rust/cargo logs that read secrets through env::var("GITHUB_TOKEN", ...) / env::var("DATABASE_URL", ...)
  [/\benv::var(?:_with_default|_with_current)?\(\s*["'](?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|DATABASE_URL)[A-Z0-9_]*)["']/g, "[REDACTED]"],
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
