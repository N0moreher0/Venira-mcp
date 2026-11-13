/**
 * Shell policy — balanced-mode allow tiers.
 *
 * `balanced.read_only`  : pure inspection (see `balancedSegmentOk` in shell-policy-tables.ts).
 * `balanced.workspace_write` / `balanced.install` / `balanced.workspace_delete`: see the sibling modules
 *   (`workspace_delete` = explicit single-file deletes, run only after a checkpoint).
 * `balanced.local_dev`  : routine local development inside the workspace:
 *   - build / test / lint toolchain commands (npm|pnpm|yarn scripts with conventional names,
 *     cargo, go, dotnet, pytest, eslint, prettier --check, vitest, jest, mocha, tsc ...);
 *   - the same toolchain run through `npx` (`npx tsc --noEmit`) only when the bin is already installed
 *     in the workspace's `node_modules/.bin`, so npx can never download or run a remote package
 *     (`npx tsc` without a local TypeScript would fetch the unrelated `tsc` package);
 *   - reversible git branch/stash operations (`checkout -b`, `switch`, `stash`, `restore --staged`);
 *   - routine git mutations the operator runs constantly (`add`, `rm`, `commit`, `push` when it is a
 *     plain fast-forward push, `pull`, `fetch`, `clone`, `merge`, `rebase`, `cherry-pick`, `tag`,
 *     `branch`, `revert`, `reset` without `--hard`, ...): local, reversible, or needing no explicit
 *     approval; `reset --hard`, `clean`, force/delete/URL pushes and anything else stay ask rules.
 *
 * Everything here still requires: no redirect / background / substitution, workspace-bound
 * paths, no unresolved variables, and no flag that writes outside the workspace or runs
 * another program. A `package.json` script is only auto-allowed after its *current* body
 * (plus `pre`/`post` hooks and the scripts it calls) passes a conservative scan, so a script
 * rewritten to curl|sh, rm, publish, install ... goes back to needing approval.
 *
 * Residual trust: like any build, these commands run project code (build.rs, jest config,
 * a script that merely calls `node some-file.js`). Deny/ask rules and the hard-deny table
 * still run first; use a policy-file override to tighten this per project.
 */
import fs from "node:fs";
import path from "node:path";
import type { ParsedCommand, Segment } from "./shell-parser.js";
import { balancedSegmentOk, devToolFlagsOk, gitSubcommandIndex, isOutsideWorkspace, isPlainGitPushSegment, TSC_UNSAFE_FLAG } from "./shell-policy-tables.js";
import { extraReadOnlyOk, installSegmentOk, redirectKind, writeSegmentOk, writeTargetOk } from "./shell-policy-balanced-write.js";
import { dockerReadOnlySegment } from "./shell-policy-balanced-docker.js";
import { deleteSegmentOk } from "./shell-policy-balanced-delete.js";
import { pythonModuleRunOk } from "./shell-policy-python.js";

export type BalancedAllow = { rule: string; reason: string };

const READ_ONLY: BalancedAllow = {
  rule: "balanced.read_only",
  reason: "Read-only inspect command inside the workspace.",
};
const LOCAL_DEV: BalancedAllow = {
  rule: "balanced.local_dev",
  reason: "Local build/test command or routine git operation inside the workspace.",
};

const WORKSPACE_WRITE: BalancedAllow = {
  rule: "balanced.workspace_write",
  reason: "File write inside the workspace (not a protected, build-config or hook file).",
};
const INSTALL: BalancedAllow = {
  rule: "balanced.install",
  reason: "Dependency install that only reproduces what the project declares, with lifecycle scripts disabled.",
};
const WORKSPACE_DELETE: BalancedAllow = {
  rule: "balanced.workspace_delete",
  reason: "Delete of explicit single files inside the workspace; a checkpoint is stored first and the command does not run without it.",
};
/**
 * Ordered by how much a tier can change: read-only < local dev < workspace write < install < delete.
 * Delete is last so any command containing one reports the rule that makes `opShellRun` take a checkpoint.
 */
const LEVELS: BalancedAllow[] = [READ_ONLY, LOCAL_DEV, WORKSPACE_WRITE, INSTALL, WORKSPACE_DELETE];

const CD_COMMANDS = new Set(["cd", "chdir", "set-location", "sl", "pushd", "popd"]);
const UNRESOLVED = /\$|%[A-Za-z_][A-Za-z0-9_]*%|`/;

/** Every non-flag argument (and every `--flag=value` value) must stay in the workspace. */
function argsContained(segment: Segment, parsed: ParsedCommand, cwd: string): boolean {
  for (const arg of segment.argv.slice(1)) {
    if (UNRESOLVED.test(arg)) return false;
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        const value = arg.slice(eq + 1);
        if (value && isOutsideWorkspace(value, cwd)) return false;
      }
      continue;
    }
    if (parsed.dialect === "cmd" && arg.startsWith("/")) continue;
    if (isOutsideWorkspace(arg, cwd)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// package.json scripts
// ---------------------------------------------------------------------------

const SCRIPT_NAME_OK =
  /^(?:(?:build|test|lint|typecheck|type-check|check|compile|verify)(?::[A-Za-z0-9:_.-]+)?|(?:format|prettier):check)$/;

const DANGEROUS_BODY: RegExp[] = [
  // network / remote shells / privilege
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|invoke-expression|iex|ssh|scp|sftp|rsync|sudo|nc|ncat|telnet|ftp)\b/i,
  // package manager mutation / publishing / arbitrary package execution
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|exec|x|dlx|publish|login|link|update|up|remove|rm|uninstall|config|set|pack|version)\b/i,
  /\bnpx\b(?!\s+--no-install)/i,
  // git mutations beyond reading
  /\bgit\s+(?:push|pull|fetch|clone|reset|clean|rebase|checkout|restore|switch|commit|tag|stash|remote|config|apply|am|merge|cherry-pick|revert|branch\s+-[dDmM])\b/i,
  // destructive / system commands
  /\b(?:rm|rmdir|rd|del|erase|remove-item|ri|mv|move-item|mkfs|dd|shutdown|reboot|chmod|chown|icacls|takeown|reg|setx|schtasks|taskkill|kill|pkill)\b/i,
  // nested shells / eval / pipe to an interpreter
  /\b(?:sh|bash|zsh|cmd|powershell|pwsh)\b\s+(?:-c|\/c|-command|-enc\w*|-e)\b/i,
  /\beval\b|\|\s*(?:sh|bash|zsh|node|python3?|pwsh|powershell)\b/i,
  // unresolved variables, substitution, paths leaving the project
  /\$|`|%[A-Za-z_][A-Za-z0-9_]*%|\.\.[\\/]|~[\\/]|\b[A-Za-z]:[\\/]|(?:^|[\s=])\/(?:etc|usr|bin|var|tmp|home|root|opt)\b|>>?\s*[\\/~]/,
  // runners that fan out to scripts the scan cannot follow
  /\b(?:npm-run-all|run-s|run-p|concurrently|wireit)\b/i,
];

const SCRIPT_REF = /\b(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9:_.-]+)/g;
const BUILTIN_REFS = new Set(["test", "t", "tst", "ls", "list", "view", "outdated"]);
const NPM_UNSAFE_FLAG = /^--(?:script-shell|userconfig|globalconfig|prefix|registry|cache|node-options)/i;

function loadScripts(cwd: string): Record<string, string> | null {
  try {
    const file = path.join(cwd, "package.json");
    if (fs.statSync(file).size > 1_000_000) return null;
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { scripts?: unknown };
    if (!json.scripts || typeof json.scripts !== "object") return null;
    return json.scripts as Record<string, string>;
  } catch {
    return null;
  }
}

function scriptBodySafe(name: string, scripts: Record<string, string>, seen: Set<string>, depth: number): boolean {
  if (depth > 4) return false;
  if (seen.has(name)) return true;
  seen.add(name);
  const body = scripts[name];
  if (typeof body !== "string" || body.length > 2000) return false;
  if (DANGEROUS_BODY.some((pattern) => pattern.test(body))) return false;
  for (const match of body.matchAll(SCRIPT_REF)) {
    const ref = match[1];
    if (ref in scripts) {
      if (!scriptBodySafe(ref, scripts, seen, depth + 1)) return false;
    } else if (!BUILTIN_REFS.has(ref)) {
      return false;
    }
  }
  return true;
}

function scriptRunnerOk(segment: Segment, cwd: string, cdSeen: boolean): boolean {
  // After a `cd`, the project (and its package.json) is no longer the one we can inspect.
  if (cdSeen) return false;
  const [, sub, ...rest] = segment.argv;
  if (!sub) return false;
  let name: string | null = null;

  if (segment.command === "npm") {
    if (sub === "test" || sub === "t" || sub === "tst") name = "test";
    else if ((sub === "run" || sub === "run-script") && rest[0] && !rest[0].startsWith("-")) name = rest[0];
  } else if (segment.command === "pnpm" || segment.command === "yarn") {
    if (sub === "test" || sub === "t") name = "test";
    else if (sub === "run" && rest[0] && !rest[0].startsWith("-")) name = rest[0];
    else if (!sub.startsWith("-") && SCRIPT_NAME_OK.test(sub)) name = sub;
  }
  if (!name || !SCRIPT_NAME_OK.test(name)) return false;
  if (segment.argv.some((arg) => NPM_UNSAFE_FLAG.test(arg))) return false;

  const scripts = loadScripts(cwd);
  if (!scripts || typeof scripts[name] !== "string") return false;
  for (const hook of [`pre${name}`, name, `post${name}`]) {
    if (hook in scripts && !scriptBodySafe(hook, scripts, new Set(), 0)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Toolchain commands
// ---------------------------------------------------------------------------

const GO_UNSAFE_FLAGS = new Set(["exec", "toolexec", "overlay", "modfile"]);

// ---------------------------------------------------------------------------
// npx: only bins that are already installed locally
// ---------------------------------------------------------------------------

/** Tools npx may run; each is also judged by `toolchainOk` exactly like the bare command. */
const NPX_TOOLS = new Set(["tsc", "vue-tsc", "vitest", "jest", "mocha", "eslint", "prettier"]);
/** The only npx flags accepted: both refuse to install anything. */
const NPX_FLAGS = new Set(["--no-install", "--no"]);

function localBinInstalled(cwd: string, tool: string): boolean {
  const dir = path.join(cwd, "node_modules", ".bin");
  return [tool, `${tool}.cmd`].some((name) => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

function npxToolchainOk(segment: Segment, cwd: string, cdSeen: boolean): boolean {
  // After a `cd` the node_modules we can inspect is no longer the one npx would use.
  if (cdSeen) return false;
  const args = segment.argv.slice(1);
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (!NPX_FLAGS.has(args[i])) return false;
    i += 1;
  }
  const tool = args[i];
  if (!tool || !NPX_TOOLS.has(tool) || !localBinInstalled(cwd, tool)) return false;
  return toolchainOk({ ...segment, command: tool, argv: args.slice(i) });
}

function toolchainOk(segment: Segment): boolean {
  const sub = segment.argv[1]?.toLowerCase();
  const lower = segment.argv.map((arg) => arg.toLowerCase());

  switch (segment.command) {
    case "cargo": {
      if (!sub || !["build", "b", "check", "c", "test", "t", "clippy", "fmt", "doc", "bench"].includes(sub)) return false;
      if (lower.some((arg) => arg === "--config" || arg.startsWith("--config=") || arg.startsWith("-z"))) return false;
      return sub !== "fmt" || lower.includes("--check");
    }
    case "go": {
      if (!sub || !["build", "test", "vet", "list"].includes(sub)) return false;
      return !lower.some((arg) => arg.startsWith("-") && GO_UNSAFE_FLAGS.has(arg.replace(/^-+/, "").split("=")[0]));
    }
    case "dotnet":
      return sub === "build" || sub === "test";
    case "pytest":
    case "py.test":
    case "mypy":
    case "vitest":
    case "jest":
      // `--config`/`--rootDir` must stay a plain workspace-relative path.
      return devToolFlagsOk(segment.command, segment.argv);
    case "mocha":
      return true;
    case "tsc":
    case "vue-tsc":
      // `--init` writes tsconfig.json, `--watch` never exits, `--clean` deletes build output,
      // `--generateTrace` writes a trace directory.
      return !lower.some((arg) => TSC_UNSAFE_FLAG.test(arg));
    case "ruff": {
      if (sub === "check") return !lower.some((arg) => /^--(?:fix|unsafe-fixes|add-noqa|fix-only)/.test(arg));
      return sub === "format" && (lower.includes("--check") || lower.includes("--diff"));
    }
    case "python":
    case "python3":
    case "py":
      if (segment.argv.length === 2 && (segment.argv[1] === "--version" || segment.argv[1] === "-V")) return true;
      // `-m <module>` needs the working directory (shadowing check): see pythonModuleRunOk in localDevSegmentOk.
      return false;
    case "eslint":
      return devToolFlagsOk("eslint", segment.argv);
    case "prettier":
      return (
        lower.some((arg) => arg === "--check" || arg === "-c" || arg === "--list-different" || arg === "-l") &&
        devToolFlagsOk("prettier", segment.argv)
      );
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Reversible local git operations
// ---------------------------------------------------------------------------

const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/@~^-]*$/;
const STASH_FLAGS = new Set(["-u", "--include-untracked", "-k", "--keep-index", "--no-keep-index", "-q", "--quiet", "--index"]);

function stashOk(rest: string[]): boolean {
  const hasAction = Boolean(rest[0]) && !rest[0].startsWith("-");
  const action = hasAction ? rest[0] : "push";
  if (!["push", "apply", "pop"].includes(action)) return false;
  for (let i = hasAction ? 1 : 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (STASH_FLAGS.has(arg) || /^stash@\{\d+\}$/.test(arg)) continue;
    if ((arg === "-m" || arg === "--message") && rest[i + 1] && !rest[i + 1].startsWith("-")) {
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * `git restore <file>...` (worktree): overwrites uncommitted edits of explicit files with the committed
 * version. Deliberately accepted at this tier because the project's checkpoints (`project_snapshot`)
 * make the overwrite recoverable. Still asks for: directories, `.`, globs/pathspec magic, `--source`,
 * `--staged --worktree`, `-p`, the `--` separator, and build/config/hook/protected files.
 */
function restoreFilesOk(rest: string[], cwd: string): boolean {
  const paths = rest.filter((arg) => arg !== "-q" && arg !== "--quiet");
  if (paths.length === 0) return false;
  return paths.every((raw) => {
    if (raw.startsWith("-") || /[*?[\]:]/.test(raw) || /[\\/]$/.test(raw) || raw === "." || raw === "..") return false;
    if (!writeTargetOk(raw, cwd)) return false;
    try {
      if (fs.statSync(path.resolve(cwd, raw)).isDirectory()) return false;
    } catch {
      // A missing path is a deleted tracked file; restoring it is the common case.
    }
    return true;
  });
}

function gitLocalOk(segment: Segment, cwd: string): boolean {
  const i = gitSubcommandIndex(segment, cwd);
  if (i < 0) return false;
  const rest = segment.argv.slice(i + 1);
  switch (segment.argv[i].toLowerCase()) {
    case "add":
    case "rm":
    case "commit":
    case "fetch":
    case "pull":
    case "clone":
    case "init":
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "revert":
    case "tag":
      // Workspace-local, routine agent flow. Commit/amend/revert only create local history;
      // `--hard` resets and `clean` stay ask rules (they discard uncommitted bytes).
      return true;
    case "branch":
      // Local branch create/switch/delete: recoverable via reflog, never touches a remote.
      return true;
    case "push":
      // Plain fast-forward pushes only; force/delete/URL/deletion pushes stay ask rules.
      return isPlainGitPushSegment(segment, cwd);
    case "reset":
      return !rest.some((arg) => /^--hard(=.*)?$/i.test(arg) || /^--keep(=.*)?$/i.test(arg));
    case "checkout":
      // Switching branches, or creating one; `checkout <file>` / `.` can discard edits.
      if (rest[0] === "-b" || rest[0] === "-B") {
        return rest.length >= 2 && rest.length <= 3 && rest.slice(1).every((arg) => REF_NAME.test(arg));
      }
      return rest.length === 1 && (rest[0] === "-" || REF_NAME.test(rest[0]));
    case "switch":
      if (rest.length === 1) return rest[0] === "-" || REF_NAME.test(rest[0]);
      if ((rest[0] === "-c" || rest[0] === "--create") && rest.length >= 2 && rest.length <= 3) {
        return rest.slice(1).every((arg) => REF_NAME.test(arg));
      }
      return false;
    case "stash":
      return stashOk(rest);
    case "restore": {
      if (rest.some((arg) => arg === "-s" || arg === "--source" || arg.startsWith("--source="))) return false;
      const staged = rest.includes("--staged") || rest.includes("-S");
      const worktree = rest.some((arg) => arg === "--worktree" || arg === "-W");
      if (staged) return !worktree;
      return restoreFilesOk(rest, cwd);
    }
    default:
      return false;
  }
}

function localDevSegmentOk(segment: Segment, parsed: ParsedCommand, cwd: string, cdSeen: boolean): boolean {
  if (!argsContained(segment, parsed, cwd)) return false;
  if (segment.command === "git") return !(cdSeen && segment.argv.includes("restore")) && gitLocalOk(segment, cwd);
  if (segment.command === "npm" || segment.command === "pnpm" || segment.command === "yarn") {
    return scriptRunnerOk(segment, cwd, cdSeen);
  }
  if (segment.command === "npx") return npxToolchainOk(segment, cwd, cdSeen);
  if (pythonModuleRunOk(segment, cwd)) return !cdSeen;
  return toolchainOk(segment);
}

/**
 * Tier of a segment that is not read-only: 1 local dev, 2 workspace write, 3 install, 4 single-file delete.
 * Combined balanced-mode allow decision: every segment must be read-only, local-dev,
 * a workspace write or a declared-deps install; the result is the highest tier any
 * segment (or redirect) needed. Returns null when the command still needs approval.
 */
function segmentLevel(segment: Segment, parsed: ParsedCommand, cwd: string, cdSeen: boolean): number {
  if (localDevSegmentOk(segment, parsed, cwd, cdSeen)) return 1;
  if (writeSegmentOk(segment, parsed, cwd)) return 2;
  if (deleteSegmentOk(segment, parsed, cwd, cdSeen)) return 4;
  return 3;
}

/**
 * Combined balanced-mode allow decision (see segmentLevel).
 */
export function balancedAllow(parsed: ParsedCommand, cwd: string): BalancedAllow | null {
  if (parsed.has_background || parsed.has_substitution) return null;
  const redirect = redirectKind(parsed, cwd);
  if (redirect === null) return null;
  let level = redirect === "write" ? 2 : 0;

  let cdSeen = false;
  for (const segment of parsed.segments) {
    if (balancedSegmentOk(segment, parsed, cwd) || extraReadOnlyOk(segment, parsed, cwd) || dockerReadOnlySegment(segment)) {
      if (CD_COMMANDS.has(segment.command)) cdSeen = true;
      continue;
    }
    if (
      localDevSegmentOk(segment, parsed, cwd, cdSeen) ||
      writeSegmentOk(segment, parsed, cwd) ||
      installSegmentOk(segment, parsed, cwd) ||
      deleteSegmentOk(segment, parsed, cwd, cdSeen)
    ) {
      level = Math.max(level, segmentLevel(segment, parsed, cwd, cdSeen));
      continue;
    }
    return null;
  }
  return LEVELS[level];
}
