/**
 * Git plumbing that needs no network: repo refs, `.git/config`, `HEAD`.
 *
 * Extracted from `git-provider.ts` so provider dialects and the config resolver
 * can share it without importing each other.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { WORKSPACE } from "./workspace.js";

export type RepoRef = { owner: string; name: string };

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Accept `owner/name`, `https://host/owner/name(.git)`, `git@host:owner/name.git`. */
export function parseRepoRef(raw: string, source: string): RepoRef {
  const text = raw.trim().replace(/\.git$/i, "");
  if (!text) {
    throw new Error(`[repo_unresolved] Empty repo reference from ${source}.`);
  }
  let owner: string;
  let name: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`[repo_unresolved] Cannot parse repo URL from ${source}: "${raw}".`);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error(
        `[repo_unresolved] URL from ${source} has no owner/name: "${raw}". Hint: pass repo="owner/name".`,
      );
    }
    owner = parts[parts.length - 2];
    name = parts[parts.length - 1];
  } else if (/^[\w.-]+@[\w.-]+:/.test(text)) {
    const tail = text.slice(text.indexOf(":") + 1);
    const parts = tail.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`[repo_unresolved] Cannot parse "${raw}" from ${source}. Hint: pass repo="owner/name".`);
    }
    owner = parts[parts.length - 2];
    name = parts[parts.length - 1];
  } else {
    const parts = text.split("/").filter(Boolean);
    if (parts.length !== 2) {
      throw new Error(
        `[repo_unresolved] Expected "owner/name" from ${source}, got "${raw}". Hint: repo="owner/name" (no URL path, no spaces).`,
      );
    }
    owner = parts[0];
    name = parts[1];
  }
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(name)) {
    throw new Error(
      `[repo_unresolved] Invalid owner/name from ${source}: "${owner}/${name}". ` +
        `Hint: names may only contain letters, digits, dot, dash and underscore.`,
    );
  }
  return { owner, name };
}

/** `owner/name` or a pull/merge-request URL (`.../owner/name/pull/7`). */
export function parsePrOrRepo(raw: string): RepoRef | null {
  const pull = /\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:pull|pulls|issues|merge_requests)\/(\d+)(?:[/?#]|$)/i.exec(raw);
  if (pull && SEGMENT_RE.test(pull[1]) && SEGMENT_RE.test(pull[2])) {
    return { owner: pull[1], name: pull[2] };
  }
  return parseRepoRef(raw, "argument");
}

/** Resolve `<root>/.git` (directory, or a `gitdir:` file for worktrees). */
export function gitDirOf(root: string): string | null {
  const dotGit = path.join(root, ".git");
  try {
    if (!existsSync(dotGit)) return null;
    const stat = statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) {
      const text = readFileSync(dotGit, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(text);
      if (match) return path.resolve(root, match[1].trim());
    }
  } catch {
    /* unreadable .git: treat as no repo */
  }
  return null;
}

/** Worktrees keep the shared config in `commondir` (usually `../..`). */
export function gitConfigPath(gitDir: string): string | null {
  const own = path.join(gitDir, "config");
  if (existsSync(own)) return own;
  try {
    const common = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (common) {
      const shared = path.resolve(gitDir, common, "config");
      if (existsSync(shared)) return shared;
    }
  } catch {
    /* no commondir: not a worktree */
  }
  return null;
}

/** Read `[remote "origin"] url` without shelling out to git. */
export function readOriginUrl(root = WORKSPACE): string | null {
  const gitDir = gitDirOf(root);
  if (!gitDir) return null;
  const config = gitConfigPath(gitDir);
  if (!config) return null;
  try {
    let section = "";
    for (const line of readFileSync(config, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const header = /^\[([^\]]+)\]$/.exec(trimmed);
      if (header) {
        section = header[1].trim().toLowerCase().replace(/"/g, "");
        continue;
      }
      if (section !== "remote origin") continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim().toLowerCase();
      const value = trimmed.slice(eq + 1).trim();
      if (key === "url" && value) return value;
    }
  } catch {
    /* malformed config */
  }
  return null;
}

/** Current branch name from `HEAD` (works for worktrees too). */
export function currentBranch(root = WORKSPACE): string | null {
  const gitDir = gitDirOf(root);
  if (!gitDir) return null;
  try {
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}
