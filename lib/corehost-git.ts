/**
 * corehost local git ops: git_status, git_diff, git_log,
 * git_branch, git_commit, git_stash.
 * See ROADMAP_TOOLS.md, phase 3. Outputs are parsed and locale-independent.
 */
import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { sanitizeReason } from "./snapshots.js";
import type { RustResponse } from "./corehost-common.js";
import { isProtectedPath } from "./workspace.js";
import {
  assertBranchName,
  assertGitRef,
  assertWorkspaceRelativePaths,
  parseDiff,
  parseStatusPorcelain,
  runGit,
  runGitChecked,
  isGitRepository,
  type GitDiffFile,
  type GitStatusEntry,
} from "./git-local.js";

type Args = Record<string, unknown>;

const toPosix = (value: string) => value.replace(/\\/g, "/");
const relArg = (value: unknown): string | undefined =>
  typeof value === "string" ? toPosix(value.trim()) : undefined;

const stringArray = (value: unknown, field: string): string[] => {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  if (raw.some((item) => typeof item !== "string")) {
    throw new Error(`[invalid_request] ${field} must be a string or an array of strings. Hint: use ["src/a.ts"].`);
  }
  return assertWorkspaceRelativePaths(raw as string[]);
};

const flagBool = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true";
const intArg = (value: unknown, fallback: number, min: number, max: number): number => {
  const raw = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
};

const pathId = (p: string): { dev: bigint; ino: bigint } | null => {
  try {
    const st = statSync(p, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
};

function sameDirectory(a: string, b: string): boolean {
  const ia = pathId(a);
  const ib = pathId(b);
  if (ia && ib) return ia.dev === ib.dev && ia.ino === ib.ino;
  const isWin = process.platform === "win32";
  const norm = (p: string) => {
    const resolved = path.resolve(p).replace(/\\/g, "/");
    return isWin ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

async function resolveWorkspaceRepo(root: string): Promise<string> {
  const result = await runGit(["rev-parse", "--show-toplevel"], root, { maxBuffer: 64 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error("[invalid_request] The workspace is not a git repository. Hint: clone one, run `git init`, or switch the workspace to the repository root.");
  }
  const topLevel = result.stdout.toString("utf8").trim();
  if (!topLevel) {
    throw new Error("[invalid_request] Git could not resolve the repository root. Hint: run git status in the workspace to see the git error.");
  }
  let same = sameDirectory(topLevel, root);
  if (!same) {
    throw new Error("[invalid_request] The workspace is not the repository root. Hint: set VENIRA_WORKSPACE to the repository root returned by git rev-parse --show-toplevel.");
  }
  return topLevel;
}

function pathsAfterDoubleDash(paths: string[]): string[] {
  if (paths.length === 0) return [];
  return ["--", ...paths];
}

async function readStagedFiles(root: string): Promise<string[]> {
  const result = await runGit(["diff", "--cached", "--name-only", "-z"], root, { maxBuffer: 16 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(`[invalid_request] Could not inspect the staged changes. ${detail || "git diff failed"}. Hint: run git_status and fix the repository state.`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

async function assertPathspecMatches(root: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const result = await runGit(["ls-files", "--error-unmatch", "-z", "--", ...paths], root, { maxBuffer: 16 * 1024 * 1024 });
  if (result.exitCode === 0) return;
  const missing: string[] = [];
  for (const rel of paths) {
    let known = false;
    try {
      statSync(path.join(root, rel));
      known = true;
    } catch {
      known = false;
    }
    if (!known) {
      const single = await runGit(["ls-files", "--error-unmatch", "-z", "--", rel], root, { maxBuffer: 64 * 1024 });
      known = single.exitCode === 0;
    }
    if (!known) missing.push(rel);
  }
  if (missing.length > 0) {
    throw new Error(`[invalid_request] Git could not resolve one or more paths: ${missing.join(", ")}. Hint: pass existing tracked or on-disk files, or use write_file to add them first.`);
  }
}

const FAILURE = (code: string, message: string) => {
  const withHint = /Hint:/.test(message) ? message : message + " Hint: run git_status and fix the input values.";
  throw new Error(`[${code}] ${withHint}`);
};

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

export async function opGitStatus(args: Args, root: string): Promise<RustResponse> {
  await resolveWorkspaceRepo(root);
  const paths = stringArray(args.paths, "paths");
  const result = await runGit(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", ...pathsAfterDoubleDash(paths)], root);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    FAILURE("invalid_request", `git status failed. ${detail || "git exited with " + result.exitCode}.`);
  }
  const parsed = parseStatusPorcelain(result.stdout);
  if (paths.length > 0) {
    const set = new Set(paths);
    parsed.files = parsed.files.filter((file) => set.has(toPosix(file.path)) || (file.old_path !== undefined && set.has(toPosix(file.old_path))));
    parsed.clean = parsed.files.length === 0;
    parsed.counts = {
      files: parsed.files.length,
      staged: parsed.files.filter((f) => f.staged).length,
      unstaged: parsed.files.filter((f) => f.unstaged).length,
      untracked: parsed.files.filter((f) => f.untracked).length,
      unmerged: parsed.files.filter((f) => f.unmerged).length,
      added: parsed.files.filter((f) => f.kind === "added").length,
      modified: parsed.files.filter((f) => f.kind === "modified").length,
      deleted: parsed.files.filter((f) => f.kind === "deleted").length,
      renamed: parsed.files.filter((f) => f.kind === "renamed").length,
      typechange: parsed.files.filter((f) => f.kind === "typechange").length,
    };
  }
  return {
    status: "completed",
    result: {
      kind: "git_status",
      data: {
        ...parsed,
        files: parsed.files.map((file) => ({ ...file, path: toPosix(file.path), old_path: file.old_path ? toPosix(file.old_path) : undefined })),
        reason: sanitizeReason(args.reason),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

const clampContext = (value: unknown): number => intArg(value, 3, 0, 20);

const diffSummary = (files: GitDiffFile[]) => ({
  files: files.length,
  added: files.filter((f) => f.action === "added").length,
  modified: files.filter((f) => f.action === "modified").length,
  deleted: files.filter((f) => f.action === "deleted").length,
  renamed: files.filter((f) => f.action === "renamed").length,
  hunks: files.reduce((total, f) => total + f.hunks.length, 0),
  binary: files.filter((f) => f.binary).length,
});

export async function opGitDiff(args: Args, root: string): Promise<RustResponse> {
  await resolveWorkspaceRepo(root);
  const staged = flagBool(args.staged);
  const paths = stringArray(args.paths, "paths");
  const contextLines = clampContext(args.context_lines);
  const includePatch = flagBool(args.include_patch);
  const maxBytes = intArg(args.max_bytes, 65_536, 1_024, 1_048_576);
  const gitArgs = ["diff", "--no-color", "--no-ext-diff", `--unified=${contextLines}`, ...(staged ? ["--cached"] : []), ...pathsAfterDoubleDash(paths)];
  const result = await runGit(gitArgs, root, { maxBuffer: Math.max(32 * 1024 * 1024, maxBytes * 4) });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    FAILURE("invalid_request", `git diff failed. ${detail || "git exited with " + result.exitCode}.`);
  }
  const text = result.stdout.toString("utf8");
  const files = parseDiff(text);
  const patchBytes = result.stdout.length;
  return {
    status: "completed",
    result: {
      kind: "git_diff",
      data: {
        staged,
        context_lines: contextLines,
        files: files.map((file) => ({ ...file, old_path: file.old_path ? toPosix(file.old_path) : null, new_path: file.new_path ? toPosix(file.new_path) : null })),
        counts: diffSummary(files),
        patch_bytes: patchBytes,
        ...(includePatch ? { patch: text.length > maxBytes ? text.slice(0, maxBytes) : text, patch_truncated: text.length > maxBytes } : {}),
        reason: sanitizeReason(args.reason),
      },
    },
    ...(includePatch && patchBytes > maxBytes ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// git_log (and blame mode)
// ---------------------------------------------------------------------------

const parseFormatRecord = (token: string): Record<string, string> => {
  const parts = token.split("\x00");
  return {
    sha: parts[0] ?? "",
    short_sha: parts[1] ?? "",
    author: parts[2] ?? "",
    email: parts[3] ?? "",
    authored_at: parts[4] ?? "",
    committer: parts[5] ?? "",
    committer_email: parts[6] ?? "",
    committed_at: parts[7] ?? "",
    subject: parts[8] ?? "",
    body: parts.slice(9).join("\x00").trim(),
  };
};

async function gitLogEntries(args: Args, root: string): Promise<Record<string, string>[]> {
  const limit = intArg(args.limit, 20, 1, 200);
  const paths = stringArray(args.paths, "paths");
  const ref = typeof args.ref === "string" && args.ref.trim() ? assertGitRef(args.ref, "ref") : undefined;
  const author = typeof args.author === "string" && args.author.trim() ? args.author : undefined;
  const grep = typeof args.grep === "string" && args.grep.trim() ? args.grep : undefined;
  const format = ["%H", "%h", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%s", "%b"].join("%x00");
  const gitArgs = [
    "log",
    "--no-color",
    "--date=iso-strict",
    "--pretty=format:%x1e" + format,
    `--max-count=${limit}`,
    ...(author ? [`--author=${author}`] : []),
    ...(grep ? [`--grep=${grep}`] : []),
    ...(ref ? [ref] : []),
    ...pathsAfterDoubleDash(paths),
  ];
  const result = await runGit(gitArgs, root, { maxBuffer: 32 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    FAILURE("invalid_request", `git log failed. ${detail || "git exited with " + result.exitCode}.`);
  }
  return result.stdout.toString("utf8").split("\x1e").map((token) => token.replace(/^\n+/, "").trim()).filter(Boolean).map(parseFormatRecord);
}

type BlameEntry = {
  line: number;
  commit: string;
  short_sha: string;
  author: string;
  author_mail: string;
  authored_at: string;
  timezone: string;
  summary: string;
  prev_sha: string | undefined;
  prev_path: string | undefined;
  filename: string;
};

function parseBlame(input: string, maxLines: number): BlameEntry[] {
  const entries: BlameEntry[] = [];
  const lines = input.split(/\r?\n/);
  let current: Partial<BlameEntry> = {};
  let lineNumber = 0;
  for (const line of lines) {
    if (line.startsWith("\t")) {
      lineNumber += 1;
      if (lineNumber > maxLines) break;
      entries.push({
        line: lineNumber,
        commit: current.commit ?? "",
        short_sha: current.commit?.slice(0, 12) ?? "",
        author: current.author ?? "",
        author_mail: current.author_mail ?? "",
        authored_at: current.authored_at ?? "",
        timezone: current.timezone ?? "",
        summary: current.summary ?? "",
        prev_sha: current.prev_sha,
        prev_path: current.prev_path,
        filename: current.filename ?? "",
      });
      continue;
    }
    const sha = /^([0-9a-f]{40}|0{40}) /.exec(line)?.[1];
    if (sha) {
      current = { commit: sha };
      continue;
    }
    if (line.startsWith("author ")) current.author = line.slice("author ".length);
    else if (line.startsWith("author-mail ")) current.author_mail = line.slice("author-mail ".length);
    else if (line.startsWith("author-time ")) {
      const epoch = Number(line.slice("author-time ".length));
      current.authored_at = Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : line.slice("author-time ".length);
    } else if (line.startsWith("author-tz ")) current.timezone = line.slice("author-tz ".length);
    else if (line.startsWith("summary ")) current.summary = line.slice("summary ".length);
    else if (line.startsWith("previous ")) {
      const previous = line.slice("previous ".length);
      const split = previous.indexOf(" ");
      current.prev_sha = split < 0 ? previous : previous.slice(0, split);
      current.prev_path = split < 0 ? undefined : previous.slice(split + 1);
    } else if (line.startsWith("filename ")) current.filename = line.slice("filename ".length);
  }
  return entries;
}

export async function opGitLog(args: Args, root: string): Promise<RustResponse> {
  await resolveWorkspaceRepo(root);
  const blame = flagBool(args.blame ?? args.mode === "blame");
  if (blame) {
    const rel = relArg(args.path) ?? relArg(args.relative_path);
    if (!rel) {
      throw new Error("[invalid_request] blame mode needs path. Hint: pass path: \"src/file.ts\" (optionally with ref).");
    }
    if (rel.split("/").includes("..") || rel.startsWith("-") || path.isAbsolute(rel)) {
      throw new Error("[invalid_request] path must be workspace-relative, not an option or absolute path. Hint: use a path like src/file.ts.");
    }
    if (isProtectedPath(path.resolve(root, rel))) {
      throw new Error(`[sensitive_result] Path is protected by policy: ${rel}. Hint: do not blame protected files.`);
    }
    const ref = typeof args.ref === "string" && args.ref.trim() ? assertGitRef(args.ref, "ref") : undefined;
    const maxLines = intArg(args.max_lines, 1_000, 1, 5_000);
    const result = await runGit(["blame", "--line-porcelain", ...(ref ? [ref] : []), "--", rel], root, { maxBuffer: 16 * 1024 * 1024 });
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim();
      FAILURE("invalid_request", `git blame failed. ${detail || "git exited with " + result.exitCode}.`);
    }
    const entries = parseBlame(result.stdout.toString("utf8"), maxLines);
    return {
      status: "completed",
      result: {
        kind: "git_log",
        data: { mode: "blame", path: rel, ref: ref ?? "HEAD", lines: entries.length, entries, reason: sanitizeReason(args.reason) },
      },
    };
  }
  const commits = await gitLogEntries(args, root);
  return {
    status: "completed",
    result: {
      kind: "git_log",
      data: { mode: "log", commits, count: commits.length, reason: sanitizeReason(args.reason) },
    },
  };
}

// ---------------------------------------------------------------------------
// git_branch
// ---------------------------------------------------------------------------

type BranchEntry = {
  name: string;
  current: boolean;
  commit: string;
  short_sha: string;
  last_commit: string;
  upstream: string;
  track: string;
  remote: boolean;
};

const parseBranchFormat = (output: string): BranchEntry[] => {
  const records = output.split("\n").filter(Boolean);
  const branches: BranchEntry[] = [];
  for (const record of records) {
    const parts = record.split("\x00");
    const head = parts[0] ?? " ";
    const rawName = parts[1] ?? "";
    const commit = parts[2] ?? "";
    const lastCommit = parts[3] ?? "";
    const upstream = parts[4] ?? "";
    const track = parts[5] ?? "";
    if (!rawName) continue;
    const isRemote = rawName.startsWith("refs/remotes/");
    const name = isRemote
      ? rawName.slice("refs/remotes/".length)
      : rawName.startsWith("refs/heads/")
        ? rawName.slice("refs/heads/".length)
        : rawName;
    branches.push({
      name,
      current: head.trim() === "*",
      commit,
      short_sha: commit.slice(0, 12),
      last_commit: lastCommit,
      upstream,
      track,
      remote: isRemote,
    });
  }
  return branches;
};

export async function opGitBranch(args: Args, root: string): Promise<RustResponse> {
  await resolveWorkspaceRepo(root);
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "list";
  const includeRemote = flagBool(args.include_remote);
  if (action === "list" || action === "current") {
    const argsList = ["branch", "--format=%(HEAD)%00%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(upstream:short)%00%(upstream:track)"];
    if (includeRemote) argsList.push("--all");
    const result = await runGit(argsList, root);
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim();
      FAILURE("invalid_request", `git branch failed. ${detail || "git exited with " + result.exitCode}.`);
    }
    const branches = parseBranchFormat(result.stdout.toString("utf8"));
    const current = branches.find((branch) => branch.current)?.name ?? null;
    if (action === "current") {
      return { status: "completed", result: { kind: "git_branch", data: { action, branch: current, reason: sanitizeReason(args.reason) } } };
    }
    return {
      status: "completed",
      result: {
        kind: "git_branch",
        data: { action, current, branches, branch_count: branches.length, reason: sanitizeReason(args.reason) },
      },
    };
  }

  const name = typeof args.name === "string" && args.name.trim() ? assertBranchName(args.name, "name") : "";
  if (!name) {
    throw new Error("[invalid_request] git_branch action=" + action + " needs name. Hint: pass name: \"feature/my-branch\".");
  }
  if (action === "create") {
    const exists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], root);
    if (exists.exitCode === 0) {
      throw new Error(`[conflict] Branch already exists: ${name}. Hint: choose another name, or use action=switch.`);
    }
    const from = typeof args.from === "string" && args.from.trim() ? assertGitRef(args.from, "from") : undefined;
    const result = await runGit(["branch", name, ...(from ? [from] : [])], root);
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim();
      FAILURE("invalid_request", `git branch create failed. ${detail || "git exited with " + result.exitCode}.`);
    }
    const sha = (await runGit(["rev-parse", "--verify", `refs/heads/${name}`], root)).stdout.toString("utf8").trim();
    return { status: "completed", result: { kind: "git_branch", data: { action: "create", branch: name, created: true, commit: sha, short_sha: sha.slice(0, 12), reason: sanitizeReason(args.reason) } } };
  }

  if (action === "switch") {
    const exists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], root);
    if (exists.exitCode !== 0) {
      throw new Error(`[not_found] Branch does not exist: ${name}. Hint: list branches with action=list, or create it with action=create.`);
    }
    const result = await runGit(["switch", name], root);
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim();
      FAILURE("invalid_request", `git switch failed. ${detail || "git exited with " + result.exitCode}.`);
    }
    return { status: "completed", result: { kind: "git_branch", data: { action, branch: name, switched: true, reason: sanitizeReason(args.reason) } } };
  }

  if (action === "delete") {
    const exists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], root);
    if (exists.exitCode !== 0) {
      throw new Error(`[not_found] Branch does not exist: ${name}. Hint: list branches with action=list.`);
    }
    const force = flagBool(args.force);
    const sha = (await runGit(["rev-parse", "--verify", `refs/heads/${name}`], root)).stdout.toString("utf8").trim();
    const result = await runGit(["branch", force ? "-D" : "-d", name], root);
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim();
      FAILURE("conflict", `Branch ${name} was not deleted. ${detail || "git exited with " + result.exitCode}.`);
    }
    return { status: "completed", result: { kind: "git_branch", data: { action: "delete", branch: name, deleted: true, commit: sha, short_sha: sha.slice(0, 12), force, reason: sanitizeReason(args.reason) } } };
  }

  throw new Error("[invalid_request] action must be list|current|create|switch|delete. Hint: pass action=list to see branches.");
}

// ---------------------------------------------------------------------------
// git_commit
// ---------------------------------------------------------------------------

export async function opGitCommit(args: Args, root: string): Promise<RustResponse> {
  await resolveWorkspaceRepo(root);
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) {
    throw new Error("[invalid_request] message is required. Hint: pass a short commit message.");
  }
  const paths = stringArray(args.paths, "paths");
  const allowEmpty = flagBool(args.allow_empty);
  const amend = flagBool(args.amend);
  if (paths.length > 0) {
    await assertPathspecMatches(root, paths);
    const add = await runGit(["add", "--", ...paths], root);
    if (add.exitCode !== 0) {
      const detail = add.stderr.toString("utf8").trim();
      FAILURE("invalid_request", `git add failed. ${detail || "git exited with " + add.exitCode}.`);
    }
  }
  const staged = await readStagedFiles(root);
  if (staged.length === 0 && !allowEmpty && !amend) {
    throw new Error("[invalid_request] No staged changes to commit. Hint: pass paths to stage files, or run git add first.");
  }
  const result = await runGit(["commit", ...(amend ? ["--amend"] : []), ...(allowEmpty ? ["--allow-empty"] : []), "-m", message], root, { maxBuffer: 16 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    FAILURE("invalid_request", `git commit failed. ${detail || "git exited with " + result.exitCode}.`);
  }
  const sha = (await runGit(["rev-parse", "HEAD"], root)).stdout.toString("utf8").trim();
  const files = (await runGit(["show", "--name-only", "--format=", "-z", "HEAD"], root)).stdout.toString("utf8").split("\0").filter(Boolean);
  const summary = result.stdout.toString("utf8").trim() || result.stderr.toString("utf8").trim();
  return {
    status: "completed",
    result: {
      kind: "git_commit",
      data: { sha, short_sha: sha.slice(0, 12), amend, subject: message.split(/\r?\n/, 1)[0], files_changed: files.length, files, summary, reason: sanitizeReason(args.reason) },
    },
  };
}

// ---------------------------------------------------------------------------
// git_stash
// ---------------------------------------------------------------------------

type StashEntry = { selector: string; commit: string; short_sha: string; author: string; email: string; authored_at: string; subject: string };

const parseStashList = (input: string): StashEntry[] => {
  const entries: StashEntry[] = [];
  for (const record of input.split("\x1e").map((value) => value.replace(/^\n+/, "").trim()).filter(Boolean)) {
    const parts = record.split("\x00");
    const commit = parts[1] ?? "";
    entries.push({
      selector: parts[0] ?? "",
      commit,
      short_sha: commit.slice(0, 12),
      author: parts[2] ?? "",
      email: parts[3] ?? "",
      authored_at: parts[4] ?? "",
      subject: parts.slice(5).map((value) => value.trim()).filter(Boolean).join(" "),
    });
  }
  return entries;
};

const selectorOf = (value: unknown): string => {
  const selector = typeof value === "string" && value.trim() ? value.trim() : "stash@{0}";
  if (!/^stash@\{\d+\}$/.test(selector)) {
    throw new Error("[invalid_request] selector must be stash@{N}. Hint: use stash@{0} for the latest stash.");
  }
  return selector;
};

export async function opGitStash(args: Args, root: string): Promise<RustResponse> {
  await resolveWorkspaceRepo(root);
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "list";
  const selector = selectorOf(args.selector);
  if (action === "list") {
    const result = await runGit(["stash", "list", "--format=%gd%x00%H%x00%an%x00%ae%x00%aI%x00%s%x1e"], root);
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim();
      FAILURE("invalid_request", `git stash list failed. ${detail || "git exited with " + result.exitCode}.`);
    }
    const entries = parseStashList(result.stdout.toString("utf8"));
    return { status: "completed", result: { kind: "git_stash", data: { action, entries, count: entries.length, reason: sanitizeReason(args.reason) } } };
  }
  if (action === "show") {
    const result = await runGit(["stash", "show", "--name-only", selector], root);
    if (result.exitCode !== 0) {
      throw new Error(`[not_found] Stash not found or not readable: ${selector}. Hint: list stashes with action=list.`);
    }
    const files = result.stdout.toString("utf8").split(/\r?\n/).map((line) => toPosix(line.trim())).filter(Boolean);
    return { status: "completed", result: { kind: "git_stash", data: { action, selector, files, count: files.length, reason: sanitizeReason(args.reason) } } };
  }
  if (action === "push") {
    const paths = stringArray(args.paths, "paths");
    if (paths.length > 0) await assertPathspecMatches(root, paths);
    const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : undefined;
    const includeUntracked = flagBool(args.include_untracked);
    const result = await runGit(["stash", "push", ...(includeUntracked ? ["-u"] : []), ...(message ? ["-m", message] : []), ...pathsAfterDoubleDash(paths)], root, { maxBuffer: 16 * 1024 * 1024 });
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim();
      FAILURE("invalid_request", `git stash push failed. ${detail || "git exited with " + result.exitCode}.`);
    }
    const output = result.stdout.toString("utf8").trim();
    const pushed = output.length > 0 && !/No local changes/i.test(output);
    const remaining = pushed ? (await runGit(["stash", "list", "--format=%gd%x1e"], root)).stdout.toString("utf8").split("\x1e").map((v) => v.trim()).filter(Boolean) : [];
    return { status: "completed", result: { kind: "git_stash", data: { action, pushed, message: message ?? null, selector: remaining[0] ?? null, output, reason: sanitizeReason(args.reason) } } };
  }
  const verified = await runGit(["stash", "list", "--format=%gd"], root);
  const names = verified.stdout.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!names.includes(selector)) {
    throw new Error(`[not_found] Stash does not exist: ${selector}. Hint: list stashes with action=list.`);
  }
  if (action === "apply" || action === "pop" || action === "drop") {
    const result = await runGit(["stash", action, selector], root, { maxBuffer: 16 * 1024 * 1024 });
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim();
      FAILURE("invalid_request", `git stash ${action} failed. ${detail || "git exited with " + result.exitCode}.`);
    }
    return {
      status: "completed",
      result: {
        kind: "git_stash",
        data: { action, selector, applied: action !== "drop", dropped: action === "pop" || action === "drop", output: result.stdout.toString("utf8").trim(), reason: sanitizeReason(args.reason) },
      },
    };
  }
  throw new Error("[invalid_request] action must be push|list|apply|pop|drop|show. Hint: use action=list to see stashes.");
}
