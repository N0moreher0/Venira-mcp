/**
 * Shell policy — bảng luật (HARD_DENY / ASK_RULES / SAFE_COMMANDS) và các helper thuần
 * dùng để khớp luật. Tách khỏi shell-policy.ts; nội dung luật giữ nguyên từng byte.
 */
import os from "node:os";
import path from "node:path";
import { UNRESTRICTED, WORKSPACE, activeDataDir, defaultDataDir } from "./workspace.js";
import { snapshotProtectedRoots } from "./snapshot-paths.js";
import { isNullSink, type ParsedCommand, type Segment } from "./shell-parser.js";
import { dockerReadOnlySegment } from "./shell-policy-balanced-docker.js";
import { pythonModuleRunOk } from "./shell-policy-python.js";
import {
  NETWORK_COMMANDS,
  PKG_MANAGERS,
  PKG_MUTATING,
  READ_COMMANDS,
  SHELL_COMMANDS,
} from "./shell-policy-rules.js";
import { type AskRule, type HardDenyRule } from "./shell-policy-evaluate.js";

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
  // Drive-relative specs (`C:`, `C:foo`) are not absolute to win32 either, yet name another volume on
  // Windows while POSIX `path.resolve` takes them for plain file names. Anywhere but Windows they are
  // treated as outside so the verdict does not depend on the host OS.
  if (process.platform !== "win32" && /^[A-Za-z]:/.test(expanded)) return true;
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

/** `-r`, `-rf`, `-fr`, `-R` or `--recursive`. */
function hasRecursiveFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--recursive" || /^-[a-z]*r/i.test(arg));
}

/** `-f`, `-rf`, `-fr` or `--force`. */
function hasForceFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--force" || /^-[a-z]*f/i.test(arg));
}

function hasRecursiveForce(argv: string[]): boolean {
  return hasRecursiveFlag(argv) && hasForceFlag(argv);
}

const POSIX_ROOT_TARGET = /^\/+(?:\.\/+)*\*?$/;
const WINDOWS_ROOT_TARGET = /^[A-Za-z]:[\\/](?:\*)?$/;
const HOME_TARGET = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?:[\\/]\*)?$/i;
/** The Windows user-profiles tree: deleting it destroys every home directory on the drive. */
const WINDOWS_USER_TREE_TARGET = /^[A-Za-z]:[\\/]Users(?:[\\/]\*)?$/i;

/**
 * True for a delete target that is a filesystem root, the whole home
 * directory, or a wildcard directly under either. Quoting is already removed by
 * the tokenizer, so `"$HOME"`, `${HOME}` and `~/` all reduce to the same check.
 */
function catastrophicDeleteTarget(target: string, cwd: string): boolean {
  const raw = target.trim();
  if (!raw) return false;
  if (POSIX_ROOT_TARGET.test(raw) || WINDOWS_ROOT_TARGET.test(raw) || HOME_TARGET.test(raw)) return true;
  // `C:\Users` is the parent of every profile: same catastrophe as deleting `~`, and a plain
  // `Remove-Item -Recurse -Force C:\Users` used to only ask. Wildcards one level down match too.
  if (WINDOWS_USER_TREE_TARGET.test(raw)) return true;
  const expanded = expandHome(
    raw
      .replace(/^\$\{HOME\}/i, os.homedir())
      .replace(/^\$HOME/i, os.homedir())
      .replace(/^%USERPROFILE%/i, os.homedir()),
  );
  const abs = path.resolve(cwd, expanded);
  if (abs === path.parse(abs).root) return true;
  const home = path.resolve(os.homedir());
  if (abs === home) return true;
  return abs.startsWith(home + path.sep) && /[\\/]\*$/.test(expanded);
}

function writeTargetsOutside(parsed: ParsedCommand, cwd: string): string[] {
  const targets: string[] = [];
  for (const target of parsed.redirect_targets) {
    if (isNullSink(target, parsed.dialect)) continue;
    if (isOutsideWorkspace(target, cwd)) targets.push(target);
  }
  for (const segment of parsed.segments) {
    if (!WRITE_COMMANDS.has(segment.command)) continue;
    for (const arg of segment.argv.slice(1)) {
      if (arg.startsWith("-")) continue;
      // cmd.exe switch flags use the `/x` spelling (`/f`, `/s`, `/q`), not `-x`.
      // Skip them so a cmd delete like `del /f /s /q C:\Windows` is evaluated by
      // its real operands instead of flagging the flags themselves as paths.
      if (parsed.dialect === "cmd" && arg.startsWith("/")) continue;
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

  // Only expand globs for names a broad pattern can genuinely target: dotfiles
  // and SSH keys. Generic names such as `credentials.json` stay literal-only so
  // `cat *.json` is not turned into a hard deny.
  const protectedCandidates = [
    ...[...protectedNames].filter((name) => name.startsWith(".") || name.startsWith("id_")),
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
    if (!globSpecificEnough(base, candidate)) return false;
    return globMatches(base, candidate);
  });
}

/**
 * A `*` alone matches every protected name, which would make `cat *` a hard
 * deny. Require the pattern to carry a literal run (>=3 chars) that also appears
 * in the candidate, or a literal prefix the candidate starts with
 * (`id_*` → `id_rsa`). Specific patterns such as `*.env` still match.
 */
function globSpecificEnough(pattern: string, candidate: string): boolean {
  const p = pattern.toLowerCase();
  const c = candidate.toLowerCase();
  const prefix = p.split(/[*?[\]]/)[0] ?? "";
  if (prefix.length >= 3 && c.startsWith(prefix)) return true;
  // A character class constrains the pattern (`[.]env`, `.e[n]v`), so keep
  // matching it. Bare `*`/`?` patterns still fail the literal-check below.
  if (/\[[^\]]+\]/.test(p) && p.replace(/\[[^\]]*\]/g, "").replace(/[*?]/g, "").length >= 2) {
    return true;
  }
  return p
    .split(/[*?[\]]+/)
    .filter((run) => run.length >= 3)
    .some((run) => c.includes(run));
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
    if (isNullSink(target, parsed.dialect)) continue;
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
export const HARD_DENY: HardDenyRule[] = [
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
    test: (parsed, raw) =>
      // Check parsed commands too: quoting, a path prefix (`/usr/bin/sudo`)
      // or a shell escape must not hide an elevation from the raw regex.
      parsed.segments.some((segment) => ["sudo", "doas", "pkexec", "runas"].includes(segment.command)) ||
      // With the PowerShell parameter model, `-Verb:RunAs` is normalized to `-Verb` + `RunAs`, so the
      // elevation target is an operand of the segment and must be judged from parsed argv.
      parsed.segments.some(
        (segment) =>
          (segment.command === "start-process" || segment.command === "start-process") &&
          segment.argv.some(
            (arg, index) => arg.toLowerCase() === "-verb" && (segment.argv[index + 1] ?? "").toLowerCase() === "runas",
          ),
      ) ||
      /(^|[\s;&|`("'\\/])(sudo|doas|pkexec|runas)\b/i.test(raw) ||
      /\bstart-process\b[^\n]*\s-verb\s+runas\b/i.test(raw),
  },
  {
    id: "root_delete",
    reason: "This deletes a filesystem root or your entire home directory.",
    test: (parsed, raw, cwd) => {
      const catastrophicRm = parsed.segments.some((segment) => {
        if (segment.command !== "rm") return false;
        const args = segment.argv.slice(1);
        if (!hasRecursiveForce(args)) return false;
        return args
          .filter((arg) => !arg.startsWith("-"))
          .some((target) => catastrophicDeleteTarget(target, cwd));
      });
      if (catastrophicRm) return true;
      return /(^|[\s;&|`(])rm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|\/\*|~|~\/\*|\$HOME|\$HOME\/\*)\s*($|[;&|)`])/i.test(raw);
    },
  },
  {
    id: "chmod_root",
    reason: "Recursively opening permissions on the filesystem root.",
    test: (_p, raw) => /chmod\s+(-R\s+)?(777|a\+rwx)\s+\/(\s|$)/i.test(raw),
  },
  {
    id: "filesystem_root_delete",
    reason: "This deletes a filesystem root, a drive root, or the whole home directory.",
    test: (parsed, _raw, cwd) => {
      const destructiveCommands = new Set([
        "rm",
        "rmdir",
        "rd",
        "del",
        "erase",
        "remove-item",
        "ri",
      ]);
      return parsed.segments.some((segment) => {
        if (!destructiveCommands.has(segment.command)) return false;
        const args = segment.argv.slice(1);
        if (!hasRecursiveForce(args)) return false;
        return args
          .filter((arg) => !arg.startsWith("-"))
          .some((target) => catastrophicDeleteTarget(target, cwd));
      });
    },
  },
  {
    id: "windows_mass_delete",
    reason: "This deletes a drive root, entire drives, and massively recursive files on Windows.",
    test: (parsed, raw) => {
      if (/(\\\\.NUL|>\\\\.NUL|>NUL:)/i.test(raw)) return true;
      // cmd accepts the switches glued to the command and to each other (`rd/s/q C:\Windows`);
      // the parser normalizes them, so judge the operands instead of the raw spelling.
      const parsedHit = parsed.segments.some((segment) => {
        if (!["rd", "rmdir", "del", "erase"].includes(segment.command)) return false;
        const args = segment.argv.slice(1);
        const recursive = args.some((arg) => /^\/s$/i.test(arg) || arg.toLowerCase() === "--recursive");
        if (!recursive) return false;
        const targets = args.filter((arg) => !arg.startsWith("/") && !arg.startsWith("-"));
        if (segment.command === "rd" || segment.command === "rmdir") {
          return targets.some((target) => /^[A-Za-z]:/.test(target));
        }
        return targets.some((target) => /^[A-Za-z]:[\\/]?$/i.test(target) || /^[A-Za-z]:[\\/]\*$/.test(target));
      });
      if (parsedHit) return true;
      // Keep the raw fallback: a command hidden inside an interpreter string is not a parsed segment.
      return (
        /\b(rd|rmdir|del|erase)\b[^\n]*\/s[^\n]*\b[a-z]:\\?(\s|$|\*)/i.test(raw) ||
        /\b(rd|rmdir)\b\s+\/s[\s\S]*?\b[A-Za-z]:/i.test(raw) ||
        /\b(rd|rmdir)\b\s+\/s[^\n]*\b[A-Za-z]:\??[\s\S]*$/i.test(raw)
      );
    },
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
    reason: "This reads or writes a protected secret store, audit database, credential file, or the checkpoint store.",
    test: (parsed, _raw, cwd) => {
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
      // Checkpoints are the rollback safety net: a shell write/delete of the store would let the
      // agent destroy the very backups it may need to restore (`project_snapshot`), so the store is
      // protected from shell side effects exactly like the data dir. File tools already refuse it.
      const foldSeparators = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
      const foldCase = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
      let snapshotRoots: string[] = [];
      try {
        snapshotRoots = snapshotProtectedRoots(defaultDataDir(), WORKSPACE).map((root) => foldCase(foldSeparators(path.resolve(root))));
      } catch {
        /* bad snapshot env: the rest of the rule still applies */
      }
      const hitsSnapshotStore = (token: string): boolean => {
        if (!token || /[$%`]/.test(token)) return false; // unresolved variable: other rules still ask
        const normalized = foldCase(foldSeparators(token));
        for (const root of snapshotRoots) {
          if (normalized === root) return true;
          const resolved = foldCase(foldSeparators(path.resolve(cwd, token)));
          if (resolved === root || resolved.startsWith(`${root}/`)) return true;
        }
        return false;
      };
      const collect = (tokens: string[]): boolean => {
        for (const t of tokens) {
          const base = path.basename(t.replace(/\\/g, "/")).toLowerCase();
          if (mayMatchProtectedBasename(t, protectedNames)) return true;
          if (dataDir && t.toLowerCase().replace(/\\/g, "/").includes(dataDir.replace(/\\/g, "/"))) return true;
          if (/(^|[\\/])venira[\\/](approvals|approval\.key)/i.test(t)) return true;
          if (/\.ssh[\\/]/i.test(t)) return true;
          if (hitsSnapshotStore(t)) return true;
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

export const ASK_RULES: AskRule[] = [
  {
    id: "command_substitution",
    reason: "This command embeds a substitution ($(..), backticks, or in PowerShell a (..) group or {..} block) the policy cannot fully inspect.",
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
    test: (parsed) =>
      parsed.segments.some(
        (segment) => ["docker", "podman", "nerdctl"].includes(segment.command) && !dockerReadOnlySegment(segment),
      ),
  },
  {
    id: "process_control",
    reason: "This kills or signals processes it does not own.",
    test: (parsed) =>
      parsed.segments.some(
        (segment) => ["kill", "killall", "pkill", "taskkill", "stop-process"].includes(segment.command),
      ) ||
      parsed.segments.some(
        (segment) =>
          segment.command === "stop-process" &&
          segment.argv.some((arg) => arg.toLowerCase() === "-force"),
      ),
  },
  {
    id: "secret_dump",
    reason: "This prints the whole environment, which usually contains secrets.",
    test: (parsed) => parsed.segments.some((segment) => ["env", "printenv", "set", "export"].includes(segment.command) && segment.argv.length === 1),
  },
  {
    id: "dynamic_execution",
    reason: "This executes code that the policy cannot safely inspect.",
    test: (parsed, cwd) =>
      parsed.segments.some((segment) => {
        if (["eval", "exec", "source", ".", "invoke-expression", "iex"].includes(segment.command)) return true;
        // `python -m pytest|mypy` is judged like the bare tool (flag guard + no shadowing module in the cwd).
        if (pythonModuleRunOk(segment, cwd)) return false;
        const flags = segment.argv;
        // Interpreter + a script file / code operand the policy cannot statically
        // analyze (`bash ./probe.sh`, `python3 ./probe.py`, `perl x.pl`, …) is
        // dynamic execution, same as `bash -c …` / `python -c …`.
        if (
          [
            "bash", "sh", "zsh", "ksh", "dash", "fish", "pwsh", "powershell", "python",
            "python3", "perl", "ruby", "deno", "node", "nodejs", "tsx", "ts-node", "ts-node-esm", "cmd",
          ].includes(segment.command) &&
          flags.slice(1).some((arg) => !arg.startsWith("-"))
        ) {
          return true;
        }
        if (["node", "nodejs", "tsx", "ts-node", "ts-node-esm"].includes(segment.command)) {
          // `tsx`/`ts-node` run arbitrary TypeScript/JavaScript just like `node`;
          // treating them as safe would make the node gate meaningless.
          const args = flags.slice(1); // drop the command itself
          const informationalFlags = new Set(["--version", "-v", "--help", "-h"]);
          return (
            parsed.has_pipe ||
            parsed.has_redirect ||
            parsed.has_background ||
            args.length === 0 ||
            !args.every((flag) => informationalFlags.has(flag.toLowerCase()))
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
        if (/-Recurse\b/i.test(args) && /-Force\b/i.test(args)) return true;
        if (s.command === "rd" || s.command === "rmdir") {
          if (/\/s\b/i.test(args) && /\/q\b/i.test(args)) return true;
        }
        if (s.command === "del" || s.command === "erase") {
          if (/\/f\b/i.test(args) && /\/q\b/i.test(args)) return true;
        }
        if (s.command === "rm") {
          // Any spelling of recursive+force (`-rf`, `-fr`, `-r -f`,
          // `--recursive --force`) is destructive, not just `-rf`.
          if (hasRecursiveForce(s.argv.slice(1))) return true;
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

/** `tsc` flags that write config (`--init`), never exit (`--watch`), delete output (`--clean`) or dump traces. */
export const TSC_UNSAFE_FLAG = /^(?:--init|--watch|-w|--clean|--generatetrace)(?:=|$)/;

/** Per-tool flags whose value is a path the tool reads code/config from, or writes output to. */
const DEV_TOOL_PATH_FLAGS: Record<string, ReadonlySet<string>> = {
  jest: new Set(["--config", "-c", "--rootdir"]),
  vitest: new Set(["--config", "-c", "--root", "-r"]),
  eslint: new Set(["--config", "-c", "--output-file", "-o"]),
  prettier: new Set(["--config", "--ignore-path", "--plugin"]),
};

/** A path provably relative and inside the workspace: no root/home/drive prefix, `..`, variables or globs. */
function isPlainRelativePath(value: string): boolean {
  if (!value || value.startsWith("-")) return false;
  if (/^[\\/~]|^[A-Za-z]:/.test(value)) return false;
  if (/[$%`*?{}<>|;&"'\s]/.test(value)) return false;
  return !value.split(/[\\/]+/).some((part) => part === "..");
}

/**
 * Flag guard for the dev tools that are routine to run (`eslint`, `prettier`, `jest`, `vitest`):
 * `eslint --fix*` and `prettier --write` rewrite source files, and a config/output/root path that is
 * absolute, escapes with `..`, is a variable or an inline JSON string makes the tool load code from,
 * or write to, a place the policy cannot see. Anything else the tool accepts is judged by its caller.
 */
export function devToolFlagsOk(tool: string, argv: string[]): boolean {
  const lower = argv.map((arg) => arg.toLowerCase());
  if (tool === "eslint" && lower.some((arg) => /^--(?:fix|fix-type|resolve-plugins-relative-to|rulesdir)/.test(arg))) {
    return false;
  }
  // `-w`, and short clusters such as `-lw`, mean --write.
  if (tool === "prettier" && lower.some((arg) => /^--write(?:=|$)/.test(arg) || /^-[a-z]+$/.test(arg) && arg.includes("w"))) {
    return false;
  }
  const pathFlags = DEV_TOOL_PATH_FLAGS[tool];
  if (!pathFlags) return true;
  for (let i = 1; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("-")) continue;
    const eq = raw.indexOf("=");
    const flag = (eq > 0 ? raw.slice(0, eq) : raw).toLowerCase();
    // `-c../x` (value glued to a short flag) cannot be told from a flag cluster, so it asks.
    if (!raw.startsWith("--") && eq < 0 && raw.length > 2 && pathFlags.has(raw.slice(0, 2).toLowerCase())) return false;
    if (!pathFlags.has(flag)) continue;
    const value = eq > 0 ? raw.slice(eq + 1) : argv[i + 1];
    if (value === undefined || !isPlainRelativePath(value)) return false;
  }
  return true;
}

/** Tools `npx --no-install` may run on the routine path: the same ones that are safe when called bare. */
const SAFE_NPX_TOOLS = new Set(["tsc", "esbuild", "tsx", "vitest", "jest", "eslint", "prettier"]);

export function isSafeSegment(segment: Segment): boolean {
  if (!SAFE_COMMANDS.has(segment.command)) return false;
  if (segment.command === "git") {
    const safeSubs = new Set(["status", "diff", "log", "show", "add", "commit", "branch"]);
    if (!segment.subcommand || !safeSubs.has(segment.subcommand)) return false;
    // `git -c core.fsmonitor=... status`, `--output=...`, `--no-index <outside>` run or touch
    // things the policy cannot see; same guard as the balanced read-only tier.
    if (gitSubcommandIndex(segment) < 0) return false;
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
    // Only `npx --no-install <known dev tool> ...`, judged exactly like the bare tool; any other
    // local bin (`rimraf`, `del-cli`, a project script) or a bare `npx --no-install` needs approval.
    const args = segment.argv.slice(1);
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) {
      if (args[i] !== "--no-install" && args[i] !== "--no") return false;
      i += 1;
    }
    const tool = args[i];
    if (i === 0 || !tool || !SAFE_NPX_TOOLS.has(tool)) return false;
    return isSafeSegment({ ...segment, command: tool, argv: args.slice(i) });
  }
  if (segment.command === "tsc") {
    return !segment.argv.slice(1).some((arg) => TSC_UNSAFE_FLAG.test(arg.toLowerCase()));
  }
  if (segment.command === "eslint" || segment.command === "prettier" || segment.command === "jest" || segment.command === "vitest") {
    return devToolFlagsOk(segment.command, segment.argv);
  }
  return true;
}

/**
 * Balanced-mode read-only / inspect allowlist. Narrower than STRICT_ALLOW on
 * purpose: no interpreters (node/python), no `git config|tag|branch`, no
 * `npm config`. Everything here only reads, but several tools can write or run
 * code through flags, so `isBalancedReadOnly` also rejects those flags.
 */
const BALANCED_READ_ONLY: Array<{ command: string; subcommands?: string[] }> = [
  ...[
    "ls", "dir", "pwd", "echo", "write-output", "cat", "type", "head", "tail", "wc", "which", "where",
    "whoami", "date", "stat", "file", "tree", "du", "df", "sort", "uniq", "cut", "grep", "rg", "find",
    "findstr", "test", "true", "false", "cd", "chdir", "set-location", "sl", "get-childitem", "gci",
    "get-content", "gc", "select-string", "sls", "get-location", "test-path", "get-item",
    "get-process", "select-object",
  ].map((command) => ({ command })),
  {
    command: "git",
    subcommands: [
      "status", "log", "diff", "show", "rev-parse", "remote", "describe", "blame", "ls-files", "shortlog",
      "cat-file", "ls-tree", "rev-list", "merge-base", "show-ref", "name-rev", "for-each-ref", "diff-tree",
      "diff-index", "count-objects", "grep", "stash", "config", "tag", "branch",
    ],
  },
  { command: "npm", subcommands: ["ls", "list", "outdated", "view"] },
];

const GIT_GLOBAL_FLAGS_OK = new Set(["--no-pager", "--no-optional-locks", "--paginate", "-p", "-P"]);
const GIT_UNSAFE_FLAG = /^--(output|ext-diff|textconv|open-files-in-pager|exec-path|no-index)/i;
const FIND_UNSAFE_FLAGS = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls",
]);

/**
 * Index of the git subcommand token in argv, or -1 when the invocation carries a
 * global option (`-c`, `-C`, `--git-dir`, `--exec-path` ...) or a subcommand flag that
 * can redirect config/repo/helpers, run programs, or write/read outside the policy's view.
 * Only pager/lock global flags are tolerated before the subcommand.
 */
export function gitSubcommandIndex(segment: Segment, cwd?: string): number {
  let i = 1;
  for (;;) {
    const arg = segment.argv[i];
    if (!arg) break;
    if (GIT_GLOBAL_FLAGS_OK.has(arg)) {
      i += 1;
      continue;
    }
    // `-C <dir>` is fine only when <dir> is provably inside the workspace (needs cwd).
    if (arg === "-C" && cwd !== undefined) {
      const dir = segment.argv[i + 1];
      if (!dir || dir.startsWith("-") || /\$|%[A-Za-z_][A-Za-z0-9_]*%|`/.test(dir) || isOutsideWorkspace(dir, cwd)) return -1;
      i += 2;
      continue;
    }
    break;
  }
  if (!segment.argv[i] || segment.argv[i].startsWith("-")) return -1;
  // `-O` (case-sensitive: `ls-files -o` is a harmless lowercase flag) runs a pager/helper;
  // `--filters` runs configured smudge/clean drivers.
  if (segment.argv.slice(i + 1).some((arg) => GIT_UNSAFE_FLAG.test(arg) || arg.startsWith("-O") || arg === "--filters")) return -1;
  return i;
}

const GIT_MUTATING_TAG_FLAG = /^(-[dDfamsuF]|--delete|--force|--annotate|--message|--sign|--local-user|--file)$/;
const GIT_MUTATING_BRANCH_FLAG = /^(-[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description|--track|--no-track)$/;
const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);
const GIT_CONFIG_UNSAFE_FLAG = /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--file|-f|--global-file|--blob|--includes|--system|--rename-section|--remove-section)/;

/** Per-subcommand read-only check: some subcommands read or write depending on their arguments. */
function gitReadOnlySubcommandOk(segment: Segment, i: number): boolean {
  const rest = segment.argv.slice(i + 1);
  switch (segment.subcommand) {
    case "remote":
      return rest.every((arg) => arg.startsWith("-"));
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "config":
      return rest.length > 0 && GIT_CONFIG_READ_FLAGS.has(rest[0]) && !rest.some((arg) => GIT_CONFIG_UNSAFE_FLAG.test(arg));
    case "tag":
      return (
        rest.length === 0 ||
        (rest.some((arg) => arg === "-l" || arg === "--list") && !rest.some((arg) => GIT_MUTATING_TAG_FLAG.test(arg)))
      );
    case "branch":
      return (
        !rest.some((arg) => GIT_MUTATING_BRANCH_FLAG.test(arg)) &&
        (rest.every((arg) => arg.startsWith("-")) || rest.some((arg) => arg === "-l" || arg === "--list"))
      );
    default:
      return true;
  }
}

export function balancedSegmentOk(segment: Segment, parsed: ParsedCommand, cwd: string): boolean {
  const entry = BALANCED_READ_ONLY.find((rule) => rule.command === segment.command);
  if (!entry) return false;
  if (entry.subcommands && segment.subcommand && !entry.subcommands.includes(segment.subcommand)) return false;
  const args = segment.argv.slice(1);
  const lower = args.map((arg) => arg.toLowerCase());

  for (const arg of args) {
    // Unresolved variables / substitutions hide the real target from the policy.
    if (/\$|%[A-Za-z_][A-Za-z0-9_]*%|`/.test(arg)) return false;
    if (arg.startsWith("-")) continue;
    if (parsed.dialect === "cmd" && arg.startsWith("/")) continue;
    if (isOutsideWorkspace(arg, cwd)) return false;
  }

  switch (segment.command) {
    case "find":
      return !lower.some((arg) => FIND_UNSAFE_FLAGS.has(arg));
    case "sort":
      return !lower.some((arg) => arg === "-o" || arg.startsWith("--output"));
    case "tree":
      return !lower.includes("-o");
    case "rg":
      return !lower.some((arg) => arg.startsWith("--pre") || arg.startsWith("--hostname-bin"));
    case "date":
      return !lower.some((arg) => arg === "-s" || arg.startsWith("--set"));
    case "git": {
      const i = gitSubcommandIndex(segment, cwd);
      if (i < 0) return false;
      return gitReadOnlySubcommandOk(segment, i);
    }
    default:
      return true;
  }
}

/** True when every segment is a read-only/inspect command (pipes allowed, redirects are not). */
export function isBalancedReadOnly(parsed: ParsedCommand, cwd: string): boolean {
  if (parsed.has_redirect || parsed.has_background || parsed.has_substitution) return false;
  return parsed.segments.every((segment) => balancedSegmentOk(segment, parsed, cwd));
}

// ---------------------------------------------------------------------------
// Policy loading
// ---------------------------------------------------------------------------
