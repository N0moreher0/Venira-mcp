/**
 * Shell Output Cache - LRU cache for common read-only shell command outputs.
 *
 * Only commands classified as read-only by {@link isReadOnlyCommand} are cached;
 * anything mutating, networked, or writing (redirection, chains, subshells) is
 * never stored. The key is `${shell}::${cwd}::${command}`.
 *
 *   import { getShellCache, setShellCache } from "./shell-cache.js";
 *   const cached = getShellCache(command, cwd);
 *   if (cached) return cached;
 *   // ... execute command ...
 *   setShellCache(command, cwd, result);
 *
 * `VENIRA_SHELL_CACHE=0` disables the cache entirely (default on).
 * `VENIRA_SHELL_CACHE_READ_ONLY=0` is retained for compatibility but cannot
 * disable the read-only restriction.
 */

// Simple LRU cache with max 100 entries
import { envFlag } from "./env.js";
import { parseShellCommand } from "./shell-parser.js";
const MAX_CACHE_ENTRIES = 100;
const CACHE_DISABLED = !envFlag("VENIRA_SHELL_CACHE", true);
if (!envFlag("VENIRA_SHELL_CACHE_READ_ONLY", true)) {
  console.error("[shell-cache] VENIRA_SHELL_CACHE_READ_ONLY=0 is ignored; only read-only shell commands can be cached.");
}
const CACHE_TTL_MS = 5000; // 5 seconds TTL

interface CacheEntry {
  output: string;
  error: string;
  exitCode: number;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCacheKey(command: string, cwd: string, shell: string): string {
  return `${shell}::${cwd}::${command}`;
}

export function getShellCache(command: string, cwd: string, shell = "default"): CacheEntry | null {
  if (CACHE_DISABLED) return null;
  if (!isReadOnlyCommand(command, shell)) return null;
  const key = getCacheKey(command, cwd, shell);
  const entry = cache.get(key);

  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  // LRU: Move accessed entry to end (most recently used)
  cache.delete(key);
  cache.set(key, entry);

  return entry;
}

export function setShellCache(
  command: string,
  cwd: string,
  output: string,
  error: string,
  exitCode: number,
  shell = "default",
): void {
  if (CACHE_DISABLED) return;
  if (!isReadOnlyCommand(command, shell)) return;
  const key = getCacheKey(command, cwd, shell);

  // If key already exists, delete it first (to update position)
  if (cache.has(key)) {
    cache.delete(key);
  }

  // Evict least recently used (first entry) if at capacity
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const lruKey = cache.keys().next().value;
    if (lruKey) cache.delete(lruKey);
  }

  // Add new entry at end (most recently used)
  cache.set(key, {
    output,
    error,
    exitCode,
    timestamp: Date.now()
  });
}

export function clearShellCache(): void {
  cache.clear();
}

export function getShellCacheStats(): { size: number; maxSize: number; ttlMs: number } {
  return { size: cache.size, maxSize: MAX_CACHE_ENTRIES, ttlMs: CACHE_TTL_MS };
}

// ---------------------------------------------------------------------------
// Command classification: only genuinely read-only commands may be cached.
// The decision is made on the parsed argv (quotes stripped), never on a raw
// substring match. Compound commands (pipes, chains, redirection, substitutions,
// subshells) are never cacheable, because any of those can mutate or hang.
// ---------------------------------------------------------------------------

/** True when the raw text contains shell structure outside of single quotes. */
export function hasRawShellSyntax(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const prev = i > 0 ? command[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle && prev !== "\\") { inDouble = !inDouble; continue; }
    if (inSingle) continue; // single quotes: fully inert
    // $ and backtick are LIVE even inside double quotes ("$(date)" runs).
    if (ch === "$" || ch === "`") return true;
    if (inDouble) continue; // other content is inert inside double quotes
    if (">|;&".includes(ch)) return true;
    if (ch === "<" && command[i + 1] === "(") return true;
  }
  return false;
}

/** Split on whitespace, honoring simple single/double quotes. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0 || started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0 || started) tokens.push(cur);
  return tokens;
}

const baseName = (p: string): string => {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
};

const stripExe = (name: string): string =>
  name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");

const GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show", "blame", "rev-parse", "rev-list",
  "ls-files", "ls-tree", "cat-file", "shortlog", "describe", "name-rev", "var",
]);
// Write flags per subcommand family — `-a` is *list-all* for branch but
// *annotate* (create) for tag, so they must not share one set.
const GIT_BRANCH_WRITE = new Set([
  "-d", "-D", "-m", "-M", "-c", "-C", "-f", "--force", "-u", "-s",
  "--delete", "--move", "--copy", "--set-upstream-to", "--unset-upstream", "--edit-description",
]);
const GIT_TAG_WRITE = new Set(["-d", "-D", "-a", "-s", "-m", "-u", "-f", "--delete", "--force"]);
// git global flags that consume the next token as their value.
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);

function isGitReadOnly(argv: string[]): boolean {
  // Skip git's global flags (and their values) to locate the subcommand.
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (GIT_VALUE_FLAGS.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  const sub = (argv[i] ?? "").toLowerCase();
  const rest = argv.slice(i + 1);
  if (GIT_READ_ONLY.has(sub)) return true;
  if (sub === "" || sub === "version" || sub === "help") return true; // all-flags invocation (e.g. --version)
  if (sub === "branch") {
    // bare `git branch` lists; any write flag disqualifies
    return !rest.some((a) => GIT_BRANCH_WRITE.has(a));
  }
  if (sub === "tag") {
    // bare `git tag` lists; -a/-s/-m/-u/-f/-d create/delete
    return !rest.some((a) => GIT_TAG_WRITE.has(a));
  }
  if (sub === "remote") {
    if (rest.length === 0) return true; // list
    const first = rest[0].toLowerCase();
    return ["-v", "--verbose", "get-url", "get"].includes(first);
  }
  if (sub === "stash") {
    const first = (rest[0] ?? "").toLowerCase();
    return first === "list" || first === "show";
  }
  if (sub === "worktree") return (rest[0] ?? "").toLowerCase() === "list";
  if (sub === "submodule") return (rest[0] ?? "").toLowerCase() === "status";
  if (sub === "version" || sub === "help") return true;
  return false;
}

const READ_ONLY_PROGRAMS = new Set([
  "rg", "ripgrep", "fd", "fdfind", "ls", "dir", "pwd", "cd", "cat", "head", "tail", "type",
  "get-content", "gc", "echo", "write-output", "whoami", "hostname", "date", "time", "ver",
  "uname", "where", "which", "stat", "wc", "findstr", "grep", "find", "tree",
]);

const READ_ONLY_VERSION = new Set(["node", "npm", "npx", "yarn", "pnpm", "cargo", "rustc", "go", "python", "python3", "py"]);

export function isReadOnlyCommand(command: string, shell?: string): boolean {
  if (!shell && hasRawShellSyntax(command)) return false;
  const parsed = parseShellCommand(command, { shell });
  if (
    parsed.has_operator ||
    parsed.has_redirect ||
    parsed.has_background ||
    parsed.has_substitution ||
    parsed.segments.length !== 1
  ) {
    return false;
  }
  const argv = parsed.segments[0].argv;
  if (argv.length === 0) return false;
  const prog = baseName(argv[0]);
  const stripped = stripExe(prog);

  if (stripped === "git") return isGitReadOnly(argv);

  if (stripped === "tail" && argv.some((a) => a === "-f" || a === "--follow" || a === "-F")) return false;
  if (stripped === "get-content" && argv.some((a) => a.toLowerCase() === "-wait")) return false;
  if (stripped === "find" && argv.some((a) => ["-delete", "-ok", "-exec", "-execdir", "-okdir"].includes(a))) return false;

  if (READ_ONLY_PROGRAMS.has(stripped)) return true;

  if (READ_ONLY_VERSION.has(stripped)) {
    const arg = (argv[1] ?? "").toLowerCase();
    return arg === "-v" || arg === "--version" || arg === "version";
  }

  return false;
}
