/**
 * A shell that is not installed fails with `[shell_unavailable]` and an install hint (lib/shell-unavailable.ts +
 * opShellRun), instead of returning `exit_code: -1` with an empty stderr.
 *
 * Run with: npm run test:shell-unavailable
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change the policy under test
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-unavailable-"));
const workspaceDir = path.join(tempDir, "workspace");
const emptyPathDir = path.join(tempDir, "empty-path");
await mkdir(workspaceDir, { recursive: true });
await mkdir(emptyPathDir, { recursive: true });
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
process.env.VENIRA_SNAPSHOT_DIR = path.join(tempDir, "snapshots");
process.env.VENIRA_SECURITY_PROFILE = "balanced";

const unavailable = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "shell-unavailable.ts")).href
)) as typeof import("../lib/shell-unavailable.js");
const shellModule = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "corehost-shell.ts")).href
)) as typeof import("../lib/corehost-shell.js");
const output = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "output.ts")).href
)) as typeof import("../lib/output.js");

let checks = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  checks += 1;
  try {
    await fn();
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    console.log(`not ok ${checks} - ${name} (${error instanceof Error ? error.message : String(error)})`);
    failures.push(name);
  }
}

await check("isSpawnNotFound recognises ENOENT only", () => {
  assert.equal(unavailable.isSpawnNotFound(Object.assign(new Error("x"), { code: "ENOENT" })), true);
  assert.equal(unavailable.isSpawnNotFound(Object.assign(new Error("x"), { code: "EACCES" })), false);
  assert.equal(unavailable.isSpawnNotFound(new Error("x")), false);
  assert.equal(unavailable.isSpawnNotFound(null), false);
  assert.equal(unavailable.isSpawnNotFound("ENOENT"), false);
});

await check("pwsh hint names the install command per platform and a working alternative", () => {
  const win = unavailable.shellUnavailableMessage("pwsh", "pwsh", "win32");
  assert.match(win, /^\[shell_unavailable\] Shell "pwsh" \(pwsh\) was not found/);
  assert.match(win, /winget install --id Microsoft\.PowerShell/);
  assert.match(win, /restart the MCP client/);
  assert.match(win, /shell "powershell"/);
  assert.match(unavailable.shellUnavailableMessage("pwsh", "pwsh", "darwin"), /brew install --cask powershell/);
  const linux = unavailable.shellUnavailableMessage("pwsh", "pwsh", "linux");
  assert.match(linux, /installing-powershell/);
  assert.match(linux, /shell "bash"/);
  assert.doesNotMatch(linux, /winget/);
});

await check("other shells get a platform-correct hint", () => {
  assert.match(unavailable.shellUnavailableMessage("powershell", "powershell.exe", "linux"), /only on Windows/);
  assert.match(unavailable.shellUnavailableMessage("powershell", "powershell.exe", "win32"), /use shell "cmd" or "pwsh"/);
  assert.match(unavailable.shellUnavailableMessage("cmd", "cmd.exe", "darwin"), /only on Windows/);
  assert.match(unavailable.shellUnavailableMessage("fish", "fish", "linux"), /Install fish/);
});

await check("every message ends with the do-not-retry hint and carries a stable code", () => {
  for (const shell of ["pwsh", "powershell", "cmd", "bash", "fish"]) {
    for (const platform of ["win32", "darwin", "linux"]) {
      const message = unavailable.shellUnavailableMessage(shell, shell, platform);
      assert.match(message, /^\[shell_unavailable\] /, message);
      assert.match(message, /Hint: .+ Do not retry unchanged\.$/, message);
    }
  }
});

type Outcome = { threw: string | null; exit_code?: unknown };
async function runWithEmptyPath(shell: string, background: 0 | 1): Promise<Outcome> {
  const previous = process.env.PATH;
  process.env.PATH = emptyPathDir; // nothing resolvable: spawn must fail with ENOENT
  try {
    const response = await shellModule.opShellRun({ command: "git status", shell, background }, workspaceDir, "test-session");
    return { threw: null, exit_code: (response.result?.data as { exit_code?: unknown } | undefined)?.exit_code };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

await check("a missing pwsh fails the foreground call with [shell_unavailable], not exit_code -1", async () => {
  const outcome = await runWithEmptyPath("pwsh", 0);
  assert.ok(outcome.threw, `expected a throw, got exit_code ${String(outcome.exit_code)}`);
  assert.match(outcome.threw, /^\[shell_unavailable\] Shell "pwsh"/, outcome.threw);
  assert.match(outcome.threw, /restart the MCP client/, outcome.threw);
});

await check("a missing pwsh fails the background call the same way", async () => {
  const outcome = await runWithEmptyPath("pwsh", 1);
  assert.ok(outcome.threw, `expected a throw, got exit_code ${String(outcome.exit_code)}`);
  assert.match(outcome.threw, /^\[shell_unavailable\]/, outcome.threw);
});

await check("the tool envelope carries the code, the install hint and retryable=false", async () => {
  const outcome = await runWithEmptyPath("pwsh", 0);
  assert.ok(outcome.threw);
  const failure = output.parseToolError(new Error(outcome.threw));
  assert.equal(failure.code, "shell_unavailable");
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /^Shell "pwsh" \(pwsh\) was not found, so the command did not run\.$/);
  assert.match(failure.hint ?? "", /restart the MCP client/);
});

await check("the default hint exists for the code even without an inline Hint", () => {
  const failure = output.parseToolError(new Error("[shell_unavailable] Shell \"x\" was not found."));
  assert.equal(failure.code, "shell_unavailable");
  assert.match(failure.hint ?? "", /not installed or not on PATH/);
  assert.equal(failure.retryable, false);
});

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.error(`Failed: ${failures.join(", ")}`);
  process.exit(1);
}
