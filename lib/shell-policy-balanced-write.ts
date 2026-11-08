/**
 * Shell policy — balanced-mode tiers for in-workspace file writes and lockfile-faithful installs.
 *
 * `balanced.workspace_write`: mkdir/touch/cp/mv/tee/chmod, simple `sed -i 's/a/b/'`, create-only `tar`,
 *   PowerShell New-Item/Copy-Item/Move-Item/Set-Content/Add-Content/Out-File, cmd copy/move, and
 *   redirects (`>`, `>>`) — only when every target resolves inside the workspace (symlink-safe,
 *   the same `resolveWithin` / `isProtectedPath` the file tools use) and is not a build/config/hook
 *   file whose contents decide what runs next (package.json, lockfiles, Makefile, Cargo.toml,
 *   tsconfig, *.config.*, .git/, .github/, .husky/, node_modules/ ...).
 * `balanced.install`: dependency installs that reproduce what the project already declares with
 *   lifecycle scripts disabled (`npm ci --ignore-scripts`, `go mod tidy|download|verify`, `dotnet restore`).
 *
 * Deletion is deliberately NOT here: explicit single files live in `balanced.workspace_delete`
 * (shell-policy-balanced-delete.ts, checkpointed first); recursive deletes keep asking.
 * Installing a new package, running install scripts, `pip install`, `cargo add` also keep asking:
 * they fetch and later execute code the project did not already contain.
 */
import path from "node:path";
import { isNullSink, type ParsedCommand, type Segment } from "./shell-parser.js";
import { WORKSPACE, isProtectedPath, resolveWithin } from "./workspace.js";

const UNRESOLVED = /\$|%[A-Za-z_][A-Za-z0-9_]*%|`/;

// ---------------------------------------------------------------------------
// Path checks
// ---------------------------------------------------------------------------

const SENSITIVE_DIRS = new Set([
  ".git", ".github", ".gitlab", ".circleci", ".husky", ".vscode", ".idea", ".cargo", "node_modules",
]);
const SENSITIVE_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock",
  ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", ".npmrc", "makefile", "gnumakefile", "justfile", "taskfile.yml",
  "taskfile.yaml", "dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
  "cargo.toml", "cargo.lock", "build.rs", "rust-toolchain", "rust-toolchain.toml", "go.mod", "go.sum", "go.work",
  "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "noxfile.py", "conftest.py", "pytest.ini", "nuget.config",
  "directory.build.props", "directory.build.targets", "global.json", ".gitattributes", ".gitmodules",
]);
const SENSITIVE_PATTERNS: RegExp[] = [
  /^tsconfig.*\.json$/,
  /\.(?:csproj|fsproj|vbproj|sln|props|targets)$/,
  /^(?:jest|vitest|vite|webpack|rollup|babel|eslint|prettier|mocha|karma|playwright|cypress|next|nuxt|svelte|tailwind|postcss)\.config\./,
  /^\.(?:babelrc|eslintrc|prettierrc|mocharc|stylelintrc)/,
];

function isSensitiveRelative(rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
  if (parts.some((part) => SENSITIVE_DIRS.has(part))) return true;
  const base = parts[parts.length - 1] ?? "";
  return SENSITIVE_NAMES.has(base) || SENSITIVE_PATTERNS.some((pattern) => pattern.test(base));
}

/** Workspace-relative path of `raw`, or null when it escapes the workspace (symlink-safe) or is protected. */
function containedRelative(raw: string, cwd: string): string | null {
  if (!raw || UNRESOLVED.test(raw)) return null;
  // `~` is expanded by the shell (path.resolve would treat it as a literal folder), and `{a,b}`
  // brace expansion can hide an outside target inside one token.
  if (raw.startsWith("~") || /[{}]/.test(raw)) return null;
  let abs: string;
  try {
    abs = resolveWithin(WORKSPACE, path.resolve(cwd, raw));
  } catch {
    return null;
  }
  const rel = path.relative(path.resolve(WORKSPACE), abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  if (isProtectedPath(abs)) return null;
  return rel;
}

/** Readable inside the workspace and not protected (used for read-only operands). */
export function pathContained(raw: string, cwd: string): boolean {
  return containedRelative(raw, cwd) !== null;
}

/** Writable: contained, not protected, not the workspace root, not a build/config/hook file. */
export function writeTargetOk(raw: string, cwd: string): boolean {
  const rel = containedRelative(raw, cwd);
  return rel !== null && rel !== "" && !isSensitiveRelative(rel);
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

/**
 * "none"  : no redirect; "sink": only /dev/null-style sinks; "write": file targets, all safe;
 * null    : at least one target is unsafe.
 */
export function redirectKind(parsed: ParsedCommand, cwd: string): "none" | "sink" | "write" | null {
  if (!parsed.has_redirect) return "none";
  let write = false;
  for (const target of parsed.redirect_targets) {
    if (isNullSink(target, parsed.dialect)) continue;
    if (!writeTargetOk(target, cwd)) return null;
    write = true;
  }
  return write ? "write" : "sink";
}

// ---------------------------------------------------------------------------
// Write commands
// ---------------------------------------------------------------------------

/** Operands left after removing accepted flags; null when an unknown flag is present. */
function operandsOf(args: string[], flagOk: (arg: string) => boolean): string[] | null {
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === "") continue;
    if (flagOk(arg)) continue;
    if (arg.startsWith("-")) return null;
    operands.push(arg);
  }
  return operands;
}

function allTargets(operands: string[] | null, min: number, cwd: string): boolean {
  return operands !== null && operands.length >= min && operands.every((operand) => writeTargetOk(operand, cwd));
}

/** `s<d>pattern<d>replacement<d>flags` with no `e`/`w` flag, no extra commands. */
function simpleSubstitution(script: string): boolean {
  if (script.length < 4 || script[0] !== "s" || /[\r\n]/.test(script)) return false;
  const delimiter = script[1];
  if (/[A-Za-z0-9\\\s;{}]/.test(delimiter)) return false;
  const parts: string[] = [];
  let current = "";
  for (let i = 2; i < script.length; i += 1) {
    const char = script[i];
    if (char === "\\") {
      current += char + (script[i + 1] ?? "");
      i += 1;
    } else if (char === delimiter) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.length === 3 && /^[gGiI0-9]*$/.test(parts[2]);
}

function sedOk(args: string[], cwd: string): boolean {
  let inPlace = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === "") continue;
    if (/^-i[A-Za-z0-9._~-]*$/.test(arg) || arg === "--in-place") inPlace = true;
    else if (arg === "-E" || arg === "-r" || arg === "--regexp-extended") continue;
    else if (arg.startsWith("-")) return false;
    else operands.push(arg);
  }
  if (!inPlace || operands.length < 2) return false;
  const [script, ...files] = operands;
  return simpleSubstitution(script) && files.every((file) => writeTargetOk(file, cwd));
}

/** Create-only archives: `tar -czf out.tgz dist` / `tar czf out.tgz dist`. */
function tarOk(args: string[], cwd: string): boolean {
  const first = args[0];
  if (!first) return false;
  const bundle = first.startsWith("-") ? first.slice(1) : first;
  if (!/^[czjJvfp]+$/.test(bundle) || !bundle.includes("c") || !bundle.includes("f")) return false;
  const operands = args.slice(1);
  if (operands.some((operand) => operand.startsWith("-"))) return false;
  return operands.length >= 2 && operands.every((operand) => writeTargetOk(operand, cwd));
}

const CHMOD_MODE = /^(?:[ugoa]*[+-][rx]+|u[+-][rwx]+|[0-7]{2}[0145])$/;
const PS_PARAMS = new Set([
  "-path", "-literalpath", "-name", "-itemtype", "-value", "-force", "-recurse", "-destination", "-encoding",
  "-filepath", "-append", "-noclobber", "-nonewline", "-passthru", "-exclude", "-include", "-filter",
]);
const PS_NON_PATH_VALUE = new Set(["-value", "-encoding", "-itemtype"]);

function powershellWriteOk(args: string[], cwd: string): boolean {
  let sawTarget = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const lower = arg.toLowerCase();
    if (arg.startsWith("-")) {
      if (!PS_PARAMS.has(lower)) return false;
      if (PS_NON_PATH_VALUE.has(lower)) {
        const value = args[i + 1];
        if (value === undefined) {
          if (lower === "-value") return false;
          continue;
        }
        i += 1;
        if (UNRESOLVED.test(value)) return false;
        // SymbolicLink / Junction / HardLink would let a later write escape the workspace.
        if (lower === "-itemtype" && !/^(?:directory|file)$/i.test(value)) return false;
      }
      continue;
    }
    if (!writeTargetOk(arg, cwd)) return false;
    sawTarget = true;
  }
  return sawTarget;
}

export function writeSegmentOk(segment: Segment, _parsed: ParsedCommand, cwd: string): boolean {
  const args = segment.argv.slice(1);
  switch (segment.command) {
    case "mkdir":
    case "md":
      return allTargets(operandsOf(args, (arg) => /^-[pv]+$/.test(arg)), 1, cwd);
    case "touch":
      return allTargets(operandsOf(args, (arg) => arg === "-c"), 1, cwd);
    case "cp":
      return allTargets(operandsOf(args, (arg) => /^-[rRpvnf]+$/.test(arg)), 2, cwd);
    case "mv":
      return allTargets(operandsOf(args, (arg) => /^-[vnf]+$/.test(arg)), 2, cwd);
    case "copy":
    case "move":
      return allTargets(operandsOf(args, (arg) => /^\/(?:-?y|v)$/i.test(arg)), 2, cwd);
    case "tee":
      return allTargets(operandsOf(args, (arg) => arg === "-a"), 1, cwd);
    case "chmod": {
      const [mode, ...files] = args;
      return Boolean(mode) && CHMOD_MODE.test(mode) && files.length > 0 && files.every((file) => writeTargetOk(file, cwd));
    }
    case "sed":
      return sedOk(args, cwd);
    case "tar":
      return tarOk(args, cwd);
    case "new-item":
    case "ni":
    case "copy-item":
    case "move-item":
    case "set-content":
    case "sc":
    case "add-content":
    case "ac":
    case "out-file":
    case "tee-object":
      return powershellWriteOk(args, cwd);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Extra read-only commands (no write, no execution)
// ---------------------------------------------------------------------------

const PLAIN_FLAG = /^-{1,2}[A-Za-z][A-Za-z-]*$/;

export function extraReadOnlyOk(segment: Segment, parsed: ParsedCommand, cwd: string): boolean {
  const args = segment.argv.slice(1);
  switch (segment.command) {
    case "pip":
    case "pip3":
      return (
        ["list", "show", "freeze", "check"].includes(args[0] ?? "") &&
        args.slice(1).every((arg) => PLAIN_FLAG.test(arg) || /^[A-Za-z0-9_.-]+$/.test(arg))
      );
    case "diff":
    case "cmp":
    case "fc": {
      const operands = operandsOf(args, (arg) => PLAIN_FLAG.test(arg) || (parsed.dialect === "cmd" && /^\/[A-Za-z]$/.test(arg)));
      return operands !== null && operands.length >= 1 && operands.every((operand) => pathContained(operand, cwd));
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Installs that only reproduce what the project already declares
// ---------------------------------------------------------------------------

const NPM_INSTALL_FLAGS = new Set([
  "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--legacy-peer-deps", "--silent", "--no-progress",
]);
const PNPM_INSTALL_FLAGS = new Set(["--ignore-scripts", "--frozen-lockfile", "--prefer-offline", "--silent"]);
const YARN_INSTALL_FLAGS = new Set([
  "--ignore-scripts", "--frozen-lockfile", "--immutable", "--mode=skip-build", "--silent", "--prefer-offline",
  "--non-interactive",
]);
const DOTNET_RESTORE_FLAGS = new Set(["--no-cache", "--force", "--nologo"]);

function onlyFlags(args: string[], allowed: Set<string>): boolean {
  return args.every((arg) => allowed.has(arg));
}

export function installSegmentOk(segment: Segment, _parsed: ParsedCommand, cwd: string): boolean {
  const [, sub, ...rest] = segment.argv;
  if (!sub) return false;
  switch (segment.command) {
    case "npm":
      // No package operands: only what package.json / the lockfile already declare.
      return ["ci", "install", "i"].includes(sub) && onlyFlags(rest, NPM_INSTALL_FLAGS) && rest.includes("--ignore-scripts");
    case "pnpm":
      return (sub === "install" || sub === "i") && onlyFlags(rest, PNPM_INSTALL_FLAGS) && rest.includes("--ignore-scripts");
    case "yarn":
      return (
        sub === "install" &&
        onlyFlags(rest, YARN_INSTALL_FLAGS) &&
        (rest.includes("--ignore-scripts") || rest.includes("--mode=skip-build"))
      );
    case "go":
      return sub === "mod" && ["tidy", "download", "verify"].includes(rest[0] ?? "") && rest.slice(1).every((arg) => arg === "-v");
    case "dotnet":
      return (
        sub === "restore" &&
        rest.every((arg) => DOTNET_RESTORE_FLAGS.has(arg) || (!arg.startsWith("-") && pathContained(arg, cwd)))
      );
    default:
      return false;
  }
}
