/**
 * Runtime workspace switching is scoped by VENIRA_SECURITY_PROFILE
 * (VENIRA_DYNAMIC_WORKSPACE was removed).
 *
 * The gated core op `project_tool.workspace.switch` is not exposed directly; the tool is
 * `switch_workspace`. These checks pin the validation:
 *
 *   - trusted/off switch to ANY existing directory, even with VENIRA_WORKSPACE_ROOTS set;
 *   - strict/balanced switch only inside the VENIRA_WORKSPACE_ROOTS allowlist;
 *     with no roots configured, switching is locked to the spawn workspace;
 *   - strict and balanced behave the same; trusted and off behave the same for switching;
 *   - VENIRA_UNRESTRICTED=1 allows any path on top of any profile;
 *   - the target must be an existing directory; `..` traversal, a sibling directory, a file,
 *     a missing path and a link that resolves outside the allowed roots are all refused with
 *     `[workspace_switch_denied]`;
 *   - a refused switch leaves the active workspace unchanged; a successful one moves it,
 *     and the file-tool path guard (`toHostPath`) follows the new root;
 *   - nonexistent root entries are ignored; both `,` and `;` separate roots.
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
delete process.env.VENIRA_UNRESTRICTED;

const ws = await import(pathToFileURL(path.join(repoRoot, "lib", "workspace.ts")).href);

function setProfile(profile: string, roots: string): void {
  process.env.VENIRA_SECURITY_PROFILE = profile;
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

  check("balanced_is_the_default_and_locks_to_the_spawn_workspace_without_roots", () => {
    delete process.env.VENIRA_SECURITY_PROFILE;
    delete process.env.VENIRA_WORKSPACE_ROOTS;
    assert.equal(ws.switchingEnabled(), false, "balanced without roots -> switching locked to the spawn workspace");
    assert.equal(ws.profileAllowsAnyPath(), false);
    assert.equal(ws.canSwitchWorkspace(otherDir), null);
    assert.equal(ws.canSwitchWorkspace(startDir), startDir, "switching to the spawn workspace itself is fine");
    assertDenied(otherDir);
  });

  check("strict_locks_to_the_spawn_workspace_without_roots", () => {
    setProfile("strict", "");
    assert.equal(ws.switchingEnabled(), false);
    assert.equal(ws.canSwitchWorkspace(otherDir), null);
    assertDenied(otherDir);
  });

  check("balanced_with_roots_allows_only_those_roots", () => {
    setProfile("balanced", allowedDir);
    assert.equal(ws.switchingEnabled(), true);
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir, allowedDir]);
    assert.equal(ws.canSwitchWorkspace(allowedDir), allowedDir);
    assert.equal(ws.canSwitchWorkspace(allowedSub), allowedSub);
    assert.equal(ws.canSwitchWorkspace(startDir), startDir);
    assert.equal(ws.canSwitchWorkspace(otherDir), null, "a target outside the allowlist is refused");
    assert.equal(ws.canSwitchWorkspace(tempRoot), null, "the parent of an allowed root is not allowed");
  });

  check("strict_with_roots_allows_only_those_roots", () => {
    setProfile("strict", `${allowedDir};${secondAllowed}`);
    assert.equal(ws.switchingEnabled(), true);
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir, allowedDir, secondAllowed]);
    assert.equal(ws.canSwitchWorkspace(allowedSub), allowedSub);
    assert.equal(ws.canSwitchWorkspace(secondAllowed), secondAllowed);
    assert.equal(ws.canSwitchWorkspace(otherDir), null);
    assertDenied(otherDir);
  });

  check("dot_dot_traversal_out_of_an_allowed_root_is_refused", () => {
    setProfile("balanced", allowedDir);
    assert.equal(ws.canSwitchWorkspace(path.join(allowedDir, "..", "other")), null);
    assert.equal(ws.canSwitchWorkspace(path.join(allowedSub, "..", "..", "other")), null);
    assertDenied(path.join(allowedDir, "..", "other"));
  });

  check("a_file_and_a_missing_path_are_refused_even_inside_an_allowed_root", () => {
    setProfile("balanced", allowedDir);
    assert.equal(ws.canSwitchWorkspace(aFile), null);
    assert.equal(ws.canSwitchWorkspace(path.join(allowedDir, "missing")), null);
    assertDenied(aFile);
    assertDenied(path.join(allowedDir, "missing"));
  });

  check("a_link_that_resolves_outside_the_allowed_roots_is_refused", () => {
    if (!linkCreated) return;
    setProfile("balanced", allowedDir);
    assert.equal(ws.canSwitchWorkspace(escapeLink), null);
    assertDenied(escapeLink);
  });

  check("trusted_allows_any_existing_directory_even_with_roots_set", () => {
    setProfile("trusted", allowedDir); // roots are ignored under trusted
    assert.equal(ws.switchingEnabled(), true);
    assert.equal(ws.profileAllowsAnyPath(), true);
    assert.equal(ws.canSwitchWorkspace(otherDir), otherDir);
    assert.equal(ws.canSwitchWorkspace(tempRoot), tempRoot, "any existing directory, not just the allowlist");
    assert.equal(ws.canSwitchWorkspace(startDir), startDir);
    assert.equal(ws.canSwitchWorkspace(aFile), null, "a file is never a workspace root");
    assert.equal(ws.canSwitchWorkspace(path.join(allowedDir, "missing")), null);
  });

  check("trusted_without_roots_allows_any_existing_directory", () => {
    setProfile("trusted", "");
    assert.equal(ws.canSwitchWorkspace(otherDir), otherDir);
  });

  check("off_allows_any_existing_directory_even_with_roots_set", () => {
    setProfile("off", allowedDir);
    assert.equal(ws.switchingEnabled(), true);
    assert.equal(ws.profileAllowsAnyPath(), true);
    assert.equal(ws.canSwitchWorkspace(otherDir), otherDir);
    assert.equal(ws.canSwitchWorkspace(tempRoot), tempRoot);
    assert.ok(ws.allowedWorkspaceRoots().includes("/"), "off reports '/' as a reachable root");
  });

  check("balanced_with_VENIRA_UNRESTRICTED_allows_any_existing_directory", () => {
    setProfile("balanced", "");
    process.env.VENIRA_UNRESTRICTED = "1";
    assert.equal(ws.switchingEnabled(), true);
    assert.equal(ws.profileAllowsAnyPath(), true);
    assert.equal(ws.canSwitchWorkspace(otherDir), otherDir);
    delete process.env.VENIRA_UNRESTRICTED;
    assert.equal(ws.canSwitchWorkspace(otherDir), null, "removing the override locks switching again");
  });

  check("nonexistent_root_entries_are_ignored_and_both_separators_work", () => {
    setProfile("balanced", [path.join(tempRoot, "does-not-exist"), allowedDir].join(","));
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir, allowedDir]);
    setProfile("balanced", `${allowedDir};${secondAllowed}`);
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir, allowedDir, secondAllowed]);
    setProfile("balanced", ` ${allowedDir} ; ;${allowedDir}`);
    assert.deepEqual(ws.allowedWorkspaceRoots(), [startDir, allowedDir], "blanks and duplicates are dropped");
  });

  check("a_successful_switch_moves_the_workspace_and_the_path_guard_follows_it", () => {
    setProfile("balanced", `${allowedDir};${secondAllowed}`);
    const next = ws.switchWorkspaceRoot(allowedSub);
    assert.equal(next, allowedSub);
    assert.equal(ws.WORKSPACE, allowedSub);
    assert.equal(ws.allowedWorkspaceRoots()[0], allowedSub, "the active workspace is always the first root");
    assert.equal(ws.toHostPath("a.txt"), path.join(allowedSub, "a.txt"));
    assert.throws(() => ws.toHostPath(path.join(startDir, "a.txt")), /\[path_escape\]/, "the old workspace is now outside the lock");
    assert.throws(() => ws.toHostPath(path.join("..", "x.txt")), /\[path_escape\]/);
    assert.equal(ws.switchWorkspaceRoot(startDir), startDir, "switching back to the original workspace works");
    assert.equal(ws.WORKSPACE, startDir);
  });

  check("a_switch_to_a_second_allowed_root_works_and_a_refused_one_keeps_the_current_workspace", () => {
    setProfile("balanced", `${allowedDir};${secondAllowed}`);
    assert.equal(ws.switchWorkspaceRoot(secondAllowed), secondAllowed);
    assert.equal(ws.WORKSPACE, secondAllowed);
    assert.throws(() => ws.switchWorkspaceRoot(otherDir), /\[workspace_switch_denied\]/);
    assert.equal(ws.WORKSPACE, secondAllowed, "a refused switch must not move the workspace");
    assert.equal(ws.switchWorkspaceRoot(startDir), startDir);
  });

  check("trusted_switching_reaches_any_existing_directory_end_to_end", () => {
    setProfile("trusted", "");
    assert.equal(ws.switchWorkspaceRoot(otherDir), otherDir);
    assert.equal(ws.WORKSPACE, otherDir);
    assert.throws(() => ws.switchWorkspaceRoot(path.join(otherDir, "missing")), /\[workspace_switch_denied\]/);
    assert.equal(ws.switchWorkspaceRoot(startDir), startDir);
  });
} finally {
  delete process.env.VENIRA_SECURITY_PROFILE;
  delete process.env.VENIRA_WORKSPACE_ROOTS;
  delete process.env.VENIRA_UNRESTRICTED;
  if (linkCreated) rmSync(escapeLink, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`workspace-switch: ${checks} checks passed`);
