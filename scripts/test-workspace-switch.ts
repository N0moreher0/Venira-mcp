/**
 * Runtime workspace switching: root validation (`lib/workspace.ts`).
 *
 * The gated core op `project_tool.workspace.switch` is not exposed by any tool yet. These checks pin the
 * validation it relies on, so exposing it later cannot widen what a switch may reach:
 *
 *   - switching is refused unless `VENIRA_DYNAMIC_WORKSPACE=1`, even when roots are configured;
 *   - the target must be an existing directory inside `VENIRA_WORKSPACE_ROOTS` (or the active workspace);
 *   - `..` traversal, a sibling directory, a file, a missing path and a link that resolves outside the
 *     allowed roots are all refused with `[workspace_switch_denied]`;
 *   - nonexistent root entries are ignored and both `,` and `;` separate roots;
 *   - a refused switch leaves the active workspace unchanged, a successful one moves it, and the file-tool
 *     path guard (`toHostPath`) follows the new root.
 *
 * Run with: npm run test:workspace-switch
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change the roots under test
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = realpathSync(await mkdtemp(path.join(os.tmpdir(), "venira-workspace-switch-")));
const startDir = path.join(tempRoot, "start");
const allowedDir = path.join(tempRoot, "allowed");
const allowedSub = path.join(allowedDir, "sub");
const otherDir = path.join(tempRoot, "other");
const secondAllowed = path.join(tempRoot, "second-allowed");
const escapeLink = path.join(allowedDir, "escape-link");
const aFile = path.join(allowedDir, "file.txt");

for (const dir of [startDir, allowedDir, allowedSub, otherDir, secondAllowed]) mkdirSync(dir, { recursive: true });
writeFileSync(aFile, "not a directory\n");

const isWindows = process.platform === "win32";
let linkCreated = false;
try {
  symlinkSync(otherDir, escapeLink, isWindows ? "junction" : "dir");
  linkCreated = true;
} catch (error) {
  console.warn(`workspace-switch: link check skipped, cannot create a link here (${(error as Error).message})`);
}

process.env.VENIRA_WORKSPACE = startDir;
process.env.VENIRA_DATA_DIR = path.join(tempRoot, "data");

const ws = await import(pathToFileURL(path.join(repoRoot, "lib", "workspace.ts")).href);

function setSwitching(enabled: boolean, roots: string): void {
  if (enabled) process.env.VENIRA_DYNAMIC_WORKSPACE = "1";
  else delete process.env.VENIRA_DYNAMIC_WORKSPACE;
  if (roots) process.env.VENIRA_WORKSPACE_ROOTS = roots;
  else delete process.env.VENIRA_WORKSPACE_ROOTS;
}

function assertDenied(target: string): void {
  assert.throws(() => ws.switchWorkspaceRoot(target), /\[workspace_switch_denied\]/);
  assert.equal(ws.WORKSPACE, startDir, "a refused switch must not move the workspace");
}

let checks = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error(`FAIL - ${name}`);
    throw error;
  }
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

try {
  check("starts_in_the_configured_workspace", () => {
    assert.equal(ws.WORKSPACE, startDir);
  });

  check("switching_is_refused_unless_dynamic_workspace_is_enabled_even_with_roots_configured", () => {
    setSwitching(false, allowedDir);
    assert.equal(ws.dynamicWorkspaceEnabled(), false);
    assert.equal(ws.canSwitchWorkspace(allowedDir), null);
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir], "disabled switching exposes no extra roots");
    assertDenied(allowedDir);
  });

  check("enabled_without_roots_only_allows_the_active_workspace", () => {
    setSwitching(true, "");
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir]);
    assert.equal(ws.canSwitchWorkspace(otherDir), null);
    assert.equal(ws.canSwitchWorkspace(startDir), startDir);
    assertDenied(otherDir);
  });

  check("a_target_outside_every_allowed_root_is_refused", () => {
    setSwitching(true, allowedDir);
    assert.equal(ws.canSwitchWorkspace(otherDir), null);
    assert.equal(ws.canSwitchWorkspace(tempRoot), null, "the parent of an allowed root is not allowed");
    assertDenied(otherDir);
  });

  check("dot_dot_traversal_out_of_an_allowed_root_is_refused", () => {
    setSwitching(true, allowedDir);
    assert.equal(ws.canSwitchWorkspace(path.join(allowedDir, "..", "other")), null);
    assert.equal(ws.canSwitchWorkspace(path.join(allowedSub, "..", "..", "other")), null);
    assertDenied(path.join(allowedDir, "..", "other"));
  });

  check("a_file_and_a_missing_path_are_refused_even_inside_an_allowed_root", () => {
    setSwitching(true, allowedDir);
    assert.equal(ws.canSwitchWorkspace(aFile), null);
    assert.equal(ws.canSwitchWorkspace(path.join(allowedDir, "missing")), null);
    assertDenied(aFile);
    assertDenied(path.join(allowedDir, "missing"));
  });

  check("a_link_that_resolves_outside_the_allowed_roots_is_refused", () => {
    if (!linkCreated) return;
    setSwitching(true, allowedDir);
    assert.equal(ws.canSwitchWorkspace(escapeLink), null);
    assertDenied(escapeLink);
  });

  check("nonexistent_root_entries_are_ignored_and_both_separators_work", () => {
    setSwitching(true, [path.join(tempRoot, "does-not-exist"), allowedDir].join(","));
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir, allowedDir]);
    setSwitching(true, `${allowedDir};${secondAllowed}`);
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir, allowedDir, secondAllowed]);
    setSwitching(true, ` ${allowedDir} ; ;${allowedDir}`);
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir, allowedDir], "blanks and duplicates are dropped");
  });

  check("an_unset_dynamic_flag_ignores_roots_in_allowed_workspace_roots", () => {
    setSwitching(false, `${allowedDir};${secondAllowed}`);
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir]);
  });

  check("a_successful_switch_moves_the_workspace_and_the_path_guard_follows_it", () => {
    setSwitching(true, `${allowedDir};${secondAllowed}`);
    const next = ws.switchWorkspaceRoot(allowedSub);
    assert.equal(next, allowedSub);
    assert.equal(ws.WORKSPACE, allowedSub);
    assert.equal(ws.allowedWorkspaceRoots()[0], allowedSub, "the active workspace is always the first root");
    assert.equal(ws.toHostPath("a.txt"), path.join(allowedSub, "a.txt"));
    assert.throws(() => ws.toHostPath(path.join(startDir, "a.txt")), /\[path_escape\]/, "the old workspace is now outside the lock");
    assert.throws(() => ws.toHostPath(path.join("..", "x.txt")), /\[path_escape\]/);
  });

  check("a_switch_to_a_second_allowed_root_works_and_a_refused_one_keeps_the_current_workspace", () => {
    setSwitching(true, `${allowedDir};${secondAllowed}`);
    assert.equal(ws.switchWorkspaceRoot(secondAllowed), secondAllowed);
    assert.equal(ws.WORKSPACE, secondAllowed);
    assert.throws(() => ws.switchWorkspaceRoot(otherDir), /\[workspace_switch_denied\]/);
    assert.equal(ws.WORKSPACE, secondAllowed, "a refused switch must not move the workspace");
  });
} finally {
  if (linkCreated) rmSync(escapeLink, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`workspace-switch: ${checks} checks passed`);
