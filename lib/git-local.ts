/**
 * Local git runner and parsers (ROADMAP_TOOLS.md, phase 3).
 *
 * Every git invocation uses `execFile` with an argv array and a fixed LC_ALL=C
 * environment, so output and wording are locale-independent. Pathspecs always
 * follow `--`; refs and branch names that start with `-` are rejected.
 */
import { execFile } from "node:child_process";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export type GitResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
};

export type GitOptions = {
  maxBuffer?: number;
  /** Extra `-c key=value` pairs, for one-off config such as a test user. */
  config?: Readonly<Record<string, string>>;
};

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  LC_ALL: "C",
  LANG: "C",
  LC_MESSAGES: "C",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "false",
});

const isBadRef = (value: string): boolean => value.startsWith("-") || value.includes("\0") || value.includes("\n");

export function assertGitRef(value: string, what: string): string {
  const trimmed = value.trim();
  if (!trimmed || isBadRef(trimmed)) {
    throw new Error(`[invalid_request] ${what} must be a git ref, not an option: ${JSON.stringify(value)}. Hint: pass a branch name or commit sha, without a leading dash.`);
  }
  return trimmed;
}

export function assertWorkspaceRelativePaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path || path.startsWith("-") || path.includes("\0") || path.includes("\n") || path.split("/").includes("..")) {
      throw new Error(`[invalid_request] paths must be workspace-relative, not options or absolute paths. Hint: use paths like src/file.ts.`);
    }
    if (path === ".") continue;
    out.push(path);
  }
  return [...new Set(out)];
}

export function assertBranchName(value: string, what: string): string {
  const name = assertGitRef(value, what);
  if (name.includes(" ") || name.includes("..") || name.includes("~") || name.includes("^") || name.includes(":") || name.includes("?") || name.includes("*") || name.includes("[") || name.includes("\\")) {
    throw new Error(`[invalid_request] ${what} is not a valid branch name: ${JSON.stringify(value)}. Hint: use letters, digits, dot, dash, underscore and slash.`);
  }
  return name;
}

export async function runGit(args: readonly string[], root: string, options: GitOptions = {}): Promise<GitResult> {
  const config = options.config ?? {};
  const configArgs: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (value.includes("\0") || value.includes("\n")) {
      throw new Error(`[invalid_request] Invalid git config for ${key}: contains a control character. Hint: set a plain one-line value.`);
    }
    configArgs.push("-c", `${key}=${value}`);
  }
  const argv = ["-C", root, ...configArgs, ...args];
  return new Promise<GitResult>((resolve) => {
    execFile(
      "git",
      argv,
      {
        cwd: root,
        env: gitEnv(),
        encoding: "buffer",
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
        if (error && typeof error.code === "string" && error.code === "ENOENT") {
          throw new Error("[shell_unavailable] Git is not available. Hint: install git and make sure `git --version` works in a terminal.");
        }
        if (error && (error as NodeJS.ErrnoException).code === "ENOBUFS") {
          throw new Error("[resource_limit] Git returned more data than the configured limit. Hint: narrow the paths or use a smaller max_bytes.");
        }
        const rawCode = error && typeof error.code === "number" ? error.code : 0;
        resolve({ stdout: out, stderr: err, exitCode: rawCode });
      },
    );
  });
}

export async function runGitText(
  args: readonly string[],
  root: string,
  options: GitOptions = {},
): Promise<string> {
  const { stdout } = await runGit(args, root, options);
  return stdout.toString("utf8");
}

export async function runGitChecked(
  args: readonly string[],
  root: string,
  options: GitOptions & { what: string } = { what: "git" },
): Promise<GitResult> {
  const result = await runGit(args, root, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(`[invalid_request] ${options.what} failed. ${detail || "git exited with " + result.exitCode}. Hint: run git_status to inspect the repository, or fix the input arguments.`);
  }
  return result;
}

export async function isGitRepository(root: string): Promise<boolean> {
  try {
    const result = await runGit(["rev-parse", "--show-toplevel"], root, { maxBuffer: 64 * 1024 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

const splitNul = (input: Buffer | string): string[] => {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  return text.split("\0").filter((token) => token.length > 0);
};

const parseSpacePath = (line: string, splitIndex: number): string => line.split(" ").slice(splitIndex).join(" ");

export type GitStatusEntry = {
  path: string;
  old_path?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  unmerged: boolean;
  status: string;
  index_status: string;
  worktree_status: string;
  staged_status: string;
  worktree_status_detailed: string;
  kind: "added" | "modified" | "deleted" | "renamed" | "typechange" | "unmerged" | "untracked" | "updated";
  staged_status_char: string;
  worktree_status_char: string;
  submodule?: boolean;
};

export type GitStatus = {
  ok: true;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  upstream_gone: boolean;
  ahead: number;
  behind: number;
  files: GitStatusEntry[];
  counts: {
    files: number;
    staged: number;
    unstaged: number;
    untracked: number;
    unmerged: number;
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    typechange: number;
  };
  clean: boolean;
};

const classifyChange = (code: string): GitStatusEntry["kind"] => {
  const ch = code.replace(/\./g, "");
  if (ch.includes("R")) return "renamed";
  if (ch.includes("U")) return "unmerged";
  if (ch.includes("T")) return "typechange";
  if (ch.includes("A")) return "added";
  if (ch.includes("D")) return "deleted";
  if (ch.includes("?")) return "untracked";
  if (ch.includes("M") || ch.includes("m")) return "modified";
  return "updated";
};

export function parseStatusPorcelain(input: Buffer): GitStatus {
  const tokens = splitNul(input);
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let upstreamGone = false;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("# branch.oid ")) continue;
    if (token === "# branch.oid (initial)") continue;
    if (token.startsWith("# branch.head ")) {
      const value = token.slice("# branch.head ".length);
      if (value === "(detached)" || value === "(unreachable)") detached = true;
      else branch = value;
      continue;
    }
    if (token.startsWith("# branch.upstream ")) {
      const value = token.slice("# branch.upstream ".length);
      const gone = / \[gone\]$/.test(value);
      upstreamGone = gone;
      upstream = gone ? value.replace(/ \[gone\]$/, "") : value;
      continue;
    }
    if (token.startsWith("# branch.ab ")) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(token);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (token.startsWith("? ")) {
      const path = token.slice(2);
      files.push({
        path,
        staged: false,
        unstaged: true,
        untracked: true,
        unmerged: false,
        status: "?",
        index_status: "?",
        worktree_status: "?",
        staged_status: "?",
        worktree_status_detailed: "",
        kind: "untracked",
        staged_status_char: "?",
        worktree_status_char: "?",
      });
      continue;
    }
    const parts = token.split(" ");
    const marker = parts[0];
    if (marker === "1" || marker === "2") {
      const status = parts[1];
      const path = marker === "1" ? parseSpacePath(token, 8) : parseSpacePath(token, 9);
      const oldPath = marker === "2" ? tokens[index + 1] : undefined;
      if (marker === "2") index += 1;
      const staged = status[0] !== "." && status[0] !== "?";
      const unstaged = status[1] !== ".";
      files.push({
        path,
        ...(oldPath ? { old_path: oldPath } : {}),
        staged,
        unstaged,
        untracked: false,
        unmerged: status.includes("U"),
        status,
        index_status: status[0],
        worktree_status: status[1],
        staged_status: "",
        worktree_status_detailed: "",
        kind: classifyChange(status),
        staged_status_char: status[0],
        worktree_status_char: status[1],
      });
      continue;
    }
    if (marker === "u") {
      const status = parts[1] ?? "UU";
      const path = parseSpacePath(token, 11);
      files.push({
        path,
        staged: status[0] !== ".",
        unstaged: status[1] !== ".",
        untracked: false,
        unmerged: true,
        status,
        index_status: status[0],
        worktree_status: status[1],
        staged_status: "",
        worktree_status_detailed: "",
        kind: "unmerged",
        staged_status_char: status[0],
        worktree_status_char: status[1],
      });
    }
  }
  const trackedUnmerged = files.filter((f) => f.unmerged).length;
  return {
    ok: true,
    branch,
    detached,
    upstream,
    upstream_gone: upstreamGone,
    ahead,
    behind,
    files,
    counts: {
      files: files.length,
      staged: files.filter((f) => f.staged).length,
      unstaged: files.filter((f) => f.unstaged).length,
      untracked: files.filter((f) => f.untracked).length,
      unmerged: trackedUnmerged,
      added: files.filter((f) => f.kind === "added").length,
      modified: files.filter((f) => f.kind === "modified").length,
      deleted: files.filter((f) => f.kind === "deleted").length,
      renamed: files.filter((f) => f.kind === "renamed").length,
      typechange: files.filter((f) => f.kind === "typechange").length,
    },
    clean: files.length === 0,
  };
}

export type GitDiffFile = {
  old_path: string | null;
  new_path: string | null;
  action: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  hunks: Array<{
    old_start: number;
    old_lines: number;
    new_start: number;
    new_lines: number;
    section: string | undefined;
  }>;
};

const stripGitPath = (raw: string | undefined): string | null => {
  if (raw === undefined || raw === "/dev/null") return null;
  let s = raw.trim();
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  if (s === "/dev/null") return null;
  return s;
};

export function parseDiff(input: string): GitDiffFile[] {
  const sections = input.split(/(?=^diff --git )/m).filter((section) => section.trim().length > 0);
  const files: GitDiffFile[] = [];
  for (const section of sections) {
    let oldHeader: string | undefined;
    let newHeader: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    const hunks: GitDiffFile["hunks"] = [];
    let binary = /^Binary files /m.test(section);
    for (const line of section.split(/\r?\n/)) {
      if (line.startsWith("--- ")) oldHeader = line.slice(4);
      else if (line.startsWith("+++ ")) newHeader = line.slice(4);
      else if (line.startsWith("rename from ")) renameFrom = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) renameTo = line.slice("rename to ".length);
      else if (/^Binary files /.test(line)) binary = true;
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (hunk) {
        hunks.push({
          old_start: Number(hunk[1]),
          old_lines: hunk[2] === undefined ? 1 : Number(hunk[2]),
          new_start: Number(hunk[3]),
          new_lines: hunk[4] === undefined ? 1 : Number(hunk[4]),
          section: hunk[5]?.trim() || undefined,
        });
      }
    }
    let oldPath = renameFrom ?? stripGitPath(oldHeader);
    let newPath = renameTo ?? stripGitPath(newHeader);
    const action: GitDiffFile["action"] =
      oldPath === null ? "added" : newPath === null ? "deleted" : renameFrom && renameTo ? "renamed" : "modified";
    if (renameFrom && renameTo) {
      oldPath = renameFrom;
      newPath = renameTo;
    }
    files.push({ old_path: oldPath, new_path: newPath, action, binary, hunks });
  }
  return files;
}
