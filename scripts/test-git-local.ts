/**
 * Phase 3 of ROADMAP_TOOLS.md: local git tools (corehost ops git_status /
 * git_diff / git_log / git_branch / git_commit / git_stash).
 *
 * Pins:
 *   1. status: clean repo, untracked, staged added, renamed with old_path, paths filter.
 *   2. diff: staged and worktree flavors, parsed hunks, counts, include_patch budget.
 *   3. log: commit list with author/grep filters and blame mode for one file.
 *   4. branch: list/current/create/switch/delete, duplicate and missing branches.
 *   5. commit: staged commit, explicit paths, nothing-to-commit is invalid_request.
 *   6. stash: push/list/show/pop round trip, invalid selector and a no-op push.
 *   7. Non-repo and out-of-workspace paths are refused.
 *
 * Run with: npm run test:git-local
 */
import "./clean-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempBase = process.platform === "win32" ? fs.realpathSync(os.tmpdir()) : os.tmpdir();
const tempDir = fs.mkdtempSync(path.join(tempBase, "venira-git-local-"));
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
process.env.VENIRA_SNAPSHOT_DIR = path.join(tempDir, "snapshots");

const {
  opGitStatus,
  opGitDiff,
  opGitLog,
  opGitBranch,
  opGitCommit,
  opGitStash,
} = (await import(pathToFileURL(path.join(repoRoot, "lib", "corehost-git.ts")).href)) as typeof import("../lib/corehost-git.js");

const root = path.join(tempDir, "repo");
fs.mkdirSync(root, { recursive: true });
const at = (rel: string) => path.join(root, rel);
const write = (rel: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};
const read = (rel: string) => fs.readFileSync(at(rel), "utf8");
const data = (res: unknown) => (res as { result: { data: Record<string, unknown> } }).result.data;
const git = (args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const initRepo = () => {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Tester"]);
  git(["config", "user.email", "tester@example.com"]);
};

let checks = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("an uninitialized repo is rejected", async () => {
    await assert.rejects(() => opGitStatus({}, root), /^Error: \[invalid_request\]/);
  });

  initRepo();

  await check("a fresh repo is clean", async () => {
    const d = data(await opGitStatus({}, root));
    assert.equal(d.clean, true);
    assert.equal(d.branch, "main");
    assert.equal((d.counts as Record<string, number>).files, 0);
  });

  await check("an untracked file is reported", async () => {
    write("plain.txt", "alpha\n");
    const d = data(await opGitStatus({}, root));
    assert.equal((d.files as Array<Record<string, unknown>>)[0].kind, "untracked");
    assert.equal(d.clean, false);
  });

  await check("staged new files are reported as added", async () => {
    git(["add", "plain.txt"]);
    const d = data(await opGitStatus({}, root));
    const f = (d.files as Array<Record<string, unknown>>)[0];
    assert.equal(f.kind, "added");
    assert.equal(f.staged, true);
    assert.equal((d.counts as Record<string, number>).added, 1);
  });

  await check("a staged rename reports renamed with old_path", async () => {
    git(["commit", "-qm", "add plain"]);
    fs.renameSync(at("plain.txt"), at("renamed.txt"));
    git(["add", "-A"]);
    const d = data(await opGitStatus({}, root));
    const f = (d.files as Array<Record<string, unknown>>).find((x) => x.kind === "renamed");
    assert.ok(f, "should report the rename");
    assert.equal(f.old_path, "plain.txt");
    assert.equal(f.path, "renamed.txt");
  });

  await check("status paths filters the result", async () => {
    write("one.txt", "1\n");
    write("two.txt", "2\n");
    const d = data(await opGitStatus({ paths: ["one.txt"] }, root));
    const files = d.files as Array<Record<string, unknown>>;
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "one.txt");
  });

  await check("commit with paths stages them and reports files_changed", async () => {
    git(["commit", "-qm", "rename plain to renamed"]);
    const d = data(await opGitCommit({ message: "add one and two", paths: ["one.txt", "two.txt"] }, root));
    assert.ok(String(d.sha).length >= 7);
    assert.equal(d.files_changed, 2);
    const d2 = data(await opGitStatus({}, root));
    assert.equal(d2.clean, true);
  });

  await check("a second empty commit is refused without allow_empty=1", async () => {
    await assert.rejects(() => opGitCommit({ message: "nope" }, root), /^Error: \[invalid_request\]/);
    const d = data(await opGitCommit({ message: "empty ok", allow_empty: 1 }, root));
    assert.ok(String(d.sha).length >= 7);
  });

  await check("working-tree diff has hunks", async () => {
    fs.appendFileSync(at("one.txt"), "new line\n");
    const d = data(await opGitDiff({}, root));
    const files = d.files as Array<Record<string, unknown>>;
    assert.equal(files.length, 1);
    assert.equal(files[0].action, "modified");
    const hunks = files[0].hunks as Array<{ old_start: number; new_start: number }>;
    assert.ok(hunks.length >= 1);
    assert.equal((d.counts as Record<string, number>).modified, 1);
    const d2 = data(await opGitDiff({ staged: 1 }, root));
    assert.equal((d2.files as unknown[]).length, 0);
  });

  await check("staged diff appears when requested", async () => {
    git(["add", "one.txt"]);
    const d = data(await opGitDiff({ staged: 1 }, root));
    const files = d.files as Array<Record<string, unknown>>;
    assert.equal(files.length, 1);
    assert.equal(files[0].action, "modified");
    git(["commit", "-qm", "modify one"]);
  });

  await check("log lists commits with author filter", async () => {
    const d = data(await opGitLog({ limit: 50, author: "Tester" }, root));
    assert.ok((d.commits as unknown[]).length >= 2);
  });

  await check("log with grep narrows to matching subjects", async () => {
    const d = data(await opGitLog({ grep: "add plain" }, root));
    assert.equal((d.commits as Array<Record<string, unknown>>)[0].subject, "add plain");
  });

  await check("blame mode returns per-line entries", async () => {
    const d = data(await opGitLog({ blame: 1, path: "one.txt", max_lines: 10 }, root));
    assert.ok((d.entries as unknown[]).length >= 1);
    assert.equal(d.mode, "blame");
  });

  await check("branch create list switch delete round trip", async () => {
    const create = data(await opGitBranch({ action: "create", name: "feature/test" }, root));
    assert.equal(create.created, true);
    const sw = data(await opGitBranch({ action: "switch", name: "feature/test" }, root));
    assert.equal(sw.switched, true);
    const d = data(await opGitBranch({ action: "list" }, root));
    assert.equal(d.current, "feature/test");
    assert.ok((d.branches as Array<Record<string, unknown>>).some((b) => b.name === "feature/test"));
    data(await opGitBranch({ action: "switch", name: "main" }, root));
    const del = data(await opGitBranch({ action: "delete", name: "feature/test" }, root));
    assert.equal(del.deleted, true);
  });

  await check("creating a duplicate branch is a conflict", async () => {
    data(await opGitBranch({ action: "create", name: "feature/dup" }, root));
    await assert.rejects(() => opGitBranch({ action: "create", name: "feature/dup" }, root), /^Error: \[conflict\]/);
    data(await opGitBranch({ action: "delete", name: "feature/dup" }, root));
  });

  await check("deleting a missing branch is not_found", async () => {
    await assert.rejects(() => opGitBranch({ action: "delete", name: "does-not-exist" }, root), /^Error: \[not_found\]/);
  });

  await check("stash push list show pop round trip", async () => {
    fs.appendFileSync(at("one.txt"), "more\n");
    const push = data(await opGitStash({ action: "push", message: "wip one" }, root));
    assert.equal(push.pushed, true);
    const clean = data(await opGitStatus({}, root));
    assert.equal(clean.clean, true);
    const list = data(await opGitStash({ action: "list" }, root));
    assert.equal(list.count, 1);
    assert.equal(String((list.entries as Array<Record<string, unknown>>)[0].subject).includes("wip one"), true);
    const show = data(await opGitStash({ action: "show", selector: "stash@{0}" }, root));
    assert.deepEqual(show.files, ["one.txt"]);
    const pop = data(await opGitStash({ action: "pop", selector: "stash@{0}" }, root));
    assert.equal(pop.dropped, true);
    const d = data(await opGitStatus({}, root));
    assert.equal((d.files as Array<Record<string, unknown>>)[0].kind, "modified");
  });

  await check("push with nothing to stash reports pushed=false", async () => {
    git(["add", "one.txt"]);
    git(["commit", "-qm", "one more"]);
    const d = data(await opGitStash({ action: "push" }, root));
    assert.equal(d.pushed, false);
  });

  await check("an invalid stash selector is invalid_request", async () => {
    await assert.rejects(() => opGitStash({ action: "pop", selector: "stash@abc" }, root), /^Error: \[invalid_request\]/);
  });

  await check("paths outside the workspace are refused for git_status diff log", async () => {
    await assert.rejects(() => opGitStatus({ paths: ["../outside.txt"] }, root), /^Error: \[invalid_request\]/);
    await assert.rejects(() => opGitDiff({ paths: ["../outside.txt"] }, root), /^Error: \[invalid_request\]/);
    await assert.rejects(() => opGitLog({ paths: ["../outside.txt"] }, root), /^Error: \[invalid_request\]/);
  });
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* temp dir is best-effort on locked-down Windows temp folders */
  }
}

console.log(`[test-git-local] ${checks} checks passed.`);
