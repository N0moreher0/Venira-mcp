/**
 * Roadmap item 15 (P0): the shell invocation must not change what the user
 * asked for.
 *
 *   1. `cmd.exe` does not understand Node's argument escaping. A command with
 *      double quotes arrived as `\"a b\"` and `node -e "console.log('x')"`
 *      printed nothing while the run reported exit code 0 - the agent saw a
 *      success that never happened.
 *   2. PowerShell reported the exit code of the *script*, so every failing
 *      native command collapsed to exit code 1.
 *   3. `bash` on Windows is often the WSL launcher, whose messages come back
 *      as UTF-16LE (`w\u0000s\u0000l\u0000...`).
 *
 * Run with: npm run test:shell-invocation
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-invocation-"));
const workspaceDir = path.join(tempDir, "workspace");
await mkdir(workspaceDir, { recursive: true });
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
process.env.VENIRA_SNAPSHOT_DIR = path.join(tempDir, "snapshots");
process.env.VENIRA_SECURITY_PROFILE = "balanced";
process.env.VENIRA_SHELL_CACHE = "0";

const invocation = (await import("../lib/shell-invocation.js")) as typeof import("../lib/shell-invocation.js");
const shellModule = (await import("../lib/corehost-shell.js")) as typeof import("../lib/corehost-shell.js");

type RunData = {
  exit_code: number | null;
  stdout?: string;
  stderr?: string;
  stdout_tail?: string;
  stderr_tail?: string;
  shell_path?: string;
  shell_kind?: string;
  output_decoded?: boolean;
  shell_hint?: string;
};

const run = async (command: string, shell: string): Promise<RunData> => {
  const response = await shellModule.opShellRun(
    { command, shell, background: 0 },
    workspaceDir,
    "invocation-session",
  );
  return (response.result?.data ?? {}) as RunData;
};

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

const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// The invocation itself
// ---------------------------------------------------------------------------
await check("cmd gets its command verbatim, without Node's escaping", () => {
  const built = invocation.buildShellInvocation("cmd", 'echo "a b"');
  assert.equal(built.file, "cmd.exe");
  assert.equal(built.verbatim, true);
  assert.deepEqual(built.args, ["/d", "/s", "/c", 'echo "a b"']);
});

await check("the other shells are not verbatim", () => {
  for (const shell of ["bash", "sh", "zsh", "fish", "powershell", "pwsh"]) {
    assert.equal(invocation.buildShellInvocation(shell, "echo hi").verbatim, undefined, shell);
  }
});

await check("the PowerShell wrapper keeps the native exit code", () => {
  const wrapped = invocation.powershellCommand("git status");
  assert.match(wrapped, /\$global:LASTEXITCODE = \$null; git status/);
  assert.match(wrapped, /\$ec = \$LASTEXITCODE/);
  // The wrapper sits on its own line, so a trailing `#` comment cannot
  // swallow it.
  assert.ok(wrapped.includes("\n"), "the wrapper must start on a new line");
});

await check("the PowerShell wrapper does not touch the policy view", () => {
  // The policy sees the user's command; the wrapper is added at spawn time.
  const wrapped = invocation.powershellCommand("git status");
  assert.ok(wrapped.startsWith("$global:LASTEXITCODE = $null; git status"));
});

// ---------------------------------------------------------------------------
// The output decoding
// ---------------------------------------------------------------------------
await check("a UTF-16 stream is decoded", () => {
  const utf16 = Buffer.from("wsl: no installed distributions", "utf16le").toString("utf8");
  const decoded = invocation.decodeShellOutput(utf16);
  assert.equal(decoded.decoded, true);
  assert.equal(decoded.text, "wsl: no installed distributions");
});

await check("a plain stream is left alone", () => {
  const decoded = invocation.decodeShellOutput("plain ascii\n");
  assert.equal(decoded.decoded, false);
  assert.equal(decoded.text, "plain ascii\n");
});

await check("stray NUL bytes are stripped from a non-UTF-16 stream", () => {
  const decoded = invocation.decodeShellOutput("a\u0000b\u0000c");
  assert.equal(decoded.text, "abc");
});

await check("the default shell is cmd on Windows and the user's shell elsewhere", () => {
  const fallback = invocation.defaultShellForPlatform();
  if (isWindows) {
    assert.equal(fallback, "cmd");
  } else {
    assert.ok(fallback.length > 0, "a default shell name");
  }
});

await check("the resolved binary tells WSL from Git Bash", () => {
  const binary = invocation.resolveShellBinary("bash");
  if (!isWindows) {
    assert.equal(binary.kind, "native");
    return;
  }
  // On Windows `bash` is either the WSL launcher (System32) or Git Bash.
  assert.ok(["wsl", "git-bash", "unknown"].includes(binary.kind), binary.kind);
  if (binary.kind === "wsl") {
    assert.match(binary.path ?? "", /system32/i);
  }
});

await check("the WSL hint names the problem and the way out", () => {
  const hint = invocation.shellRuntimeHint(
    "bash",
    "wsl",
    "Windows Subsystem for Linux has no installed distributions.",
  );
  assert.ok(hint && hint.includes("wsl --install"), hint ?? "no hint");
  assert.equal(
    invocation.shellRuntimeHint("bash", "native", "no installed distributions"),
    undefined,
    "a native shell gets no WSL hint",
  );
});

// ---------------------------------------------------------------------------
// win32 shell resolution, simulated cross-platform (fake PATH, fake fs probe)
// ---------------------------------------------------------------------------
await check("resolveShellBinary names WSL for a System32 bash (simulated win32)", () => {
  const entry = "c:\\windows\\system32";
  const hit = `${entry}\\bash.exe`;
  const fake = (candidate: string) => candidate.toLowerCase() === hit.toLowerCase();
  const resolved = invocation.resolveShellBinary("bash", "win32", entry, fake);
  assert.equal(resolved.kind, "wsl");
  assert.equal(resolved.path?.toLowerCase(), hit.toLowerCase());
});

await check("resolveShellBinary tells Git Bash from WSL (simulated win32)", () => {
  const entry = "c:\\program files\\git\\bin";
  const hit = `${entry}\\bash.exe`;
  const fake = (candidate: string) => candidate.toLowerCase() === hit.toLowerCase();
  const resolved = invocation.resolveShellBinary("bash", "win32", entry, fake);
  assert.equal(resolved.kind, "git-bash");
  assert.equal(resolved.path?.toLowerCase(), hit.toLowerCase());
});

await check("resolveShellBinary names a non-System32 non-Git bash as unknown (simulated win32)", () => {
  const entry = "c:\\msys64\\usr\\bin";
  const hit = `${entry}\\bash.exe`;
  const fake = (candidate: string) => candidate.toLowerCase() === hit.toLowerCase();
  const resolved = invocation.resolveShellBinary("bash", "win32", entry, fake);
  assert.equal(resolved.kind, "unknown");
  assert.equal(resolved.path?.toLowerCase(), hit.toLowerCase());
});

await check("resolveShellBinary reports native for cmd.exe and pwsh.exe (simulated win32)", () => {
  const fake = (candidate: string) =>
    candidate === "c:\\windows\\system32\\cmd.exe" || candidate === "c:\\tools\\pwsh.exe";
  assert.equal(invocation.resolveShellBinary("cmd", "win32", "c:\\windows\\system32", fake).kind, "native");
  assert.equal(invocation.resolveShellBinary("pwsh", "win32", "c:\\tools", fake).kind, "native");
});

await check("resolveShellBinary handles quotes and extra separators in PATH (simulated win32)", () => {
  const entry = "c:\\tools";
  const hit = `${entry}\\cmd.exe`;
  const pathEnv = ' "c:\\missing" ;"c:\\tools"; "" ;';
  const fake = (candidate: string) => candidate === hit;
  const resolved = invocation.resolveShellBinary("cmd", "win32", pathEnv, fake);
  assert.equal(resolved.path, hit);
});

await check("resolveShellBinary reports unknown when no entry contains the binary (simulated win32)", () => {
  const resolved = invocation.resolveShellBinary("fish", "win32", "c:\\nothing", () => false);
  assert.deepEqual(resolved, { path: null, kind: "unknown" });
});

await check("resolveShellBinary reports unknown for a shell name it does not map (simulated win32)", () => {
  const resolved = invocation.resolveShellBinary("yarn", "win32", "c:\\nothing", () => true);
  assert.deepEqual(resolved, { path: null, kind: "unknown" });
});

await check("resolveShellBinary off-win32 never probes the filesystem", () => {
  const resolved = invocation.resolveShellBinary("bash", "linux", "", () => {
    throw new Error("must not probe the filesystem off-win32");
  });
  assert.deepEqual(resolved, { path: null, kind: "native" });
});

// ---------------------------------------------------------------------------
// End to end: what the agent actually sees
// ---------------------------------------------------------------------------
await check("cmd prints the command as written (no backslash escaping)", async () => {
  if (!isWindows) return;
  const data = await run('echo "a b"', "cmd");
  const stdout = String(data.stdout ?? data.stdout_tail ?? "");
  assert.ok(stdout.includes("a b"), `unexpected stdout: ${JSON.stringify(stdout)}`);
  assert.equal(stdout.includes("\\"), false, `the command was escaped: ${JSON.stringify(stdout)}`);
});

await check("a failing native command reports its own exit code", async () => {
  // `git status` outside a repository exits 128. PowerShell used to report 1.
  const shells = isWindows ? ["cmd", "powershell", "pwsh"] : ["bash"];
  for (const shell of shells) {
    let data: RunData;
    try {
      data = await run("git status", shell);
    } catch (error) {
      // A shell that is not installed is reported by its own error code.
      assert.match(error instanceof Error ? error.message : "", /shell_unavailable|approval_required/);
      continue;
    }
    assert.equal(data.exit_code, 128, `${shell} reported ${String(data.exit_code)}`);
  }
});

await check("the response names the binary that ran the command", async () => {
  const data = await run("echo hello", isWindows ? "cmd" : "bash");
  assert.ok(data.shell_kind, "shell_kind must be reported");
  assert.ok(
    ["native", "wsl", "git-bash", "unknown"].includes(String(data.shell_kind)),
    String(data.shell_kind),
  );
  if (isWindows) {
    assert.ok(data.shell_path, "shell_path must be reported on Windows");
  }
});

if (failures.length > 0) {
  console.error(`\nShell invocation tests FAILED (${failures.length}/${checks}):`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log(`\nShell invocation tests passed (${checks} checks).`);
}
