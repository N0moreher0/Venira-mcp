import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { access, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

// The MCP SDK times out every request after 60 s by default. On slow or
// contention-heavy runners that is not enough headroom — and when the spawned
// server dies silently, the timeout is all the caller sees. Capture the
// server's stderr so a failing spawn is diagnosable, and give every request
// generous headroom.
const RPC_OPTS = { timeout: 180_000 };
const callTool = (client: Client, params: { name: string; arguments?: Record<string, unknown> }) =>
  client.callTool(params, CallToolResultSchema, RPC_OPTS);
const serverStderr: string[] = [];
function pipeServerStderr(transport: StdioClientTransport, label: string) {
  transport.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    serverStderr.push(`[server:${label}] ${text}`);
    if (process.env.VENIRA_SHELL_SECURITY_DEBUG === "1") process.stderr.write(`[server:${label}] ${text}`);
  });
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-security-"));
const workspaceDir = path.join(tempDir, "workspace");
const dataDir = path.join(tempDir, "data");
await mkdir(workspaceDir);
await mkdir(dataDir);
const sessionId = `shell-security-${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/server.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    VENIRA_WORKSPACE: workspaceDir,
    VENIRA_DATA_DIR: dataDir,
    VENIRA_SESSION_ID: sessionId,
    VENIRA_SECRET_KEYCHAIN: "off",
    VENIRA_SHELL_MODE: "balanced",
    VENIRA_SHELL_OVERRIDES: "",
    VENIRA_SHELL_AUTO_APPROVE_TOKEN: "0",
    VENIRA_TOOL_MODE: "expert",
  },
  stderr: "pipe",
});
pipeServerStderr(transport, "main");
const client = new Client({ name: "shell-security-regressions", version: "0.0.0" }, { capabilities: {} });

try {
  await client.connect(transport, RPC_OPTS);
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const callShell = async (command: string) => {
    const result = await callTool(client, { name: "project_shell_run", arguments: { command, shell, background: 0 } });
    const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
    return { result, envelope: JSON.parse(text) as { error?: { code?: string }; data?: Record<string, unknown> } };
  };

  const cacheSecret = "shell-cache-redaction-fixture-9f31";
  await writeFile(path.join(workspaceDir, "cache-redaction-fixture.txt"), `before ${cacheSecret} after\n`);
  const secretSet = await callTool(client, {
    name: "project_secret",
    arguments: { action: "set", name: "SHELL_CACHE_REDACTION_FIXTURE", value: cacheSecret },
  });
  assert.equal((secretSet as { isError?: boolean }).isError, undefined);
  const firstCachedRead = await callShell("cat cache-redaction-fixture.txt");
  assert.match(String(firstCachedRead.envelope.data?.stdout), /^before \[REDACTED\] after\r?\n$/, JSON.stringify(firstCachedRead.envelope));
  await writeFile(path.join(workspaceDir, "cache-redaction-fixture.txt"), "after cache refresh\n");
  const cachedRead = await callShell("cat cache-redaction-fixture.txt");
  assert.match(String(cachedRead.envelope.data?.stdout), /^before \[REDACTED\] after\r?\n$/);
  assert.notEqual((cachedRead.envelope.data?.policy as { rule?: string } | undefined)?.rule, "cache.hit");
  assert.equal(JSON.stringify(cachedRead.envelope).includes(cacheSecret), false);
  const dryRunText = (
    (await callTool(client, {
      name: "project_shell_run",
      arguments: { command: "cat cache-redaction-fixture.txt", shell, dry_run: 1 },
    })) as { content?: Array<{ text?: string }> }
  ).content?.[0]?.text ?? "{}";
  const dryRunEnvelope = JSON.parse(dryRunText) as { kind?: string; data?: Record<string, unknown> };
  assert.equal(dryRunEnvelope.kind, "shell_dry_run", dryRunText);
  assert.equal(dryRunEnvelope.data?.dry_run, true);

  const envRead = await callShell("cat .env");
  assert.equal((envRead.result as { isError?: boolean }).isError, true);
  assert.equal(envRead.envelope.error?.code, "command_denied");

  for (const command of ["cat < .env", "cat .e[n]v"]) {
    const protectedPathRead = await callShell(command);
    assert.equal((protectedPathRead.result as { isError?: boolean }).isError, true, command);
    assert.equal(protectedPathRead.envelope.error?.code, "command_denied", command);
  }

  for (const command of [
    "git push --no-verify origin main",
    "git -C . push --no-verify origin main",
    "git -c core.hooksPath=/dev/null push origin main",
  ]) {
    const hookBypassPush = await callShell(command);
    assert.equal((hookBypassPush.result as { isError?: boolean }).isError, true, command);
    assert.equal(hookBypassPush.envelope.error?.code, "approval_required", command);
    assert.equal(hookBypassPush.envelope.data?.rule, "ask.git_history_rewrite", command);
    assert.equal(typeof hookBypassPush.envelope.data?.approval_id, "string", command);
    assert.equal(hookBypassPush.envelope.data?.run_id, undefined, command);
  }

  // A recursive force-delete aimed at one workspace file still requires approval.
  const targetedRmRf = await callShell("rm -rf -- ./rmrf-probe-file.txt");
  assert.equal((targetedRmRf.result as { isError?: boolean }).isError, true);
  assert.equal(targetedRmRf.envelope.error?.code, "approval_required");
  assert.equal(targetedRmRf.envelope.data?.run_id, undefined);
  assert.equal(typeof targetedRmRf.envelope.data?.approval_id, "string");
  const selfEnabledOverride = await callTool(client, {
    name: "project_shell_run",
    arguments: {
      command: "git push origin main",
      shell,
      override: "ALLOW_ENV_READ",
      reason: "test disabled operator gate",
    },
  });
  const selfEnabledText = (selfEnabledOverride as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
  assert.equal(JSON.parse(selfEnabledText).error?.code, "override_not_enabled");

  const missingReason = await callTool(client, {
    name: "project_shell_run",
    arguments: { command: "cat .env", shell, override: "ALLOW_ENV_READ" },
  });
  const missingReasonText = (missingReason as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
  assert.equal(JSON.parse(missingReasonText).error?.code, "invalid_request");

  await writeFile(path.join(workspaceDir, ".env"), "VENIRA_TEST_ONLY=local-fixture\n");
  const overrideSession = `${sessionId}-overrides`;
  const overrideClient = new Client(
    { name: "shell-security-overrides", version: "0.0.0" },
    { capabilities: {} },
  );
  const overrideTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      VENIRA_WORKSPACE: workspaceDir,
      VENIRA_DATA_DIR: dataDir,
      VENIRA_SESSION_ID: overrideSession,
      VENIRA_SECRET_KEYCHAIN: "off",
      VENIRA_SHELL_MODE: "balanced",
      VENIRA_SHELL_OVERRIDES: "ALLOW_ENV_READ",
      VENIRA_SHELL_AUTO_APPROVE_TOKEN: "0",
      VENIRA_TOOL_MODE: "expert",
    },
    stderr: "pipe",
  });
  pipeServerStderr(overrideTransport, "overrides");
  try {
    await overrideClient.connect(overrideTransport, RPC_OPTS);
    const envReadOverride = await callTool(overrideClient, {
      name: "project_shell_run",
      arguments: {
        command: process.platform === "win32" ? "Get-Content .env" : "cat .env",
        shell,
        background: 0,
        override: "ALLOW_ENV_READ",
        reason: "read local test configuration",
      },
    });
    const envReadText = (envReadOverride as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
    const envReadEnvelope = JSON.parse(envReadText);
    assert.equal((envReadOverride as { isError?: boolean }).isError, undefined, envReadText);
    assert.equal(envReadEnvelope.data?.policy?.decision, "allow");
    assert.equal(envReadEnvelope.data?.policy?.rule, "override.ALLOW_ENV_READ");
    assert.equal(envReadEnvelope.data?.policy?.approver, "agent:ALLOW_ENV_READ");
    assert.match(envReadEnvelope.data?.stdout ?? "", /VENIRA_TEST_ONLY=local-fixture/);

    const externalFixture = path.join(tempDir, "outside-env-fixture.txt");
    const envPath = path.join(workspaceDir, ".env");
    await writeFile(externalFixture, "outside workspace\n");
    try {
      await unlink(envPath);
      await symlink(externalFixture, envPath);
      const symlinkRead = await callTool(overrideClient, {
        name: "project_shell_run",
        arguments: {
          command: process.platform === "win32" ? "Get-Content .env" : "cat .env",
          shell,
          override: "ALLOW_ENV_READ",
          reason: "verify symlink is rejected",
        },
      });
      const symlinkText = (symlinkRead as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
      assert.equal(JSON.parse(symlinkText).error?.code, "override_scope_mismatch");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw error;
      console.warn(`[shell-security] symlink override regression skipped: ${code}`);
    } finally {
      await rm(envPath, { force: true });
      await writeFile(envPath, "VENIRA_TEST_ONLY=local-fixture\n");
    }

    for (const command of [
      "cat .env && echo extra",
      "echo changed > .env",
      "cat .e[n]v",
      "cat id_rsa",
    ]) {
      const outOfScope = await callTool(overrideClient, {
        name: "project_shell_run",
        arguments: { command, shell, override: "ALLOW_ENV_READ", reason: "try out-of-scope fixture" },
      });
      const outOfScopeText = (outOfScope as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
      assert.equal(JSON.parse(outOfScopeText).error?.code, "override_scope_mismatch", command);
    }

    const remotePath = path.join(workspaceDir, "remote.git");
    const repoPath = path.join(workspaceDir, "repo");
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["init", "--bare", remotePath], { env: gitEnv, stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main", repoPath], { env: gitEnv, stdio: "ignore" });
    await writeFile(path.join(repoPath, "fixture.txt"), "local fixture\n");
    execFileSync("git", ["-C", repoPath, "add", "fixture.txt"], { env: gitEnv, stdio: "ignore" });
    execFileSync(
      "git",
      ["-C", repoPath, "-c", "user.name=Venira Test", "-c", "user.email=venira-test@example.invalid", "commit", "-m", "fixture"],
      { env: gitEnv, stdio: "ignore" },
    );
    execFileSync("git", ["-C", repoPath, "remote", "add", "origin", remotePath], { env: gitEnv, stdio: "ignore" });

    // A chained command runs in balanced mode once every step is routine (routine git needs no override).
    const chained = await callTool(overrideClient, {
      name: "project_shell_run",
      arguments: {
        command: "git status; git push --dry-run origin HEAD:main",
        shell,
        relative_cwd: "repo",
        background: 0,
      },
    });
    const chainedText = (chained as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
    assert.equal((chained as { isError?: boolean }).isError, undefined, chainedText);
    assert.equal(JSON.parse(chainedText).data?.policy?.rule, "balanced.local_dev");

    // Anything dangerous still needs approval, override or not. Plain pushes — even pipelined or
    // redirected to a workspace file — are routine and need no approval.
    for (const command of [
      "git push --dry-run origin HEAD:main; curl https://example.com",
      "git push --delete origin main",
      "git push --force origin main",
    ]) {
      const rejected = await callTool(overrideClient, {
        name: "project_shell_run",
        arguments: { command, shell, relative_cwd: "repo" },
      });
      const rejectedText = (rejected as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
      assert.equal(JSON.parse(rejectedText).error?.code, "approval_required", command);
    }

    const pushDry = await callTool(overrideClient, {
      name: "project_shell_run",
      arguments: {
        command: "git push --dry-run origin HEAD:main",
        shell,
        relative_cwd: "repo",
        background: 0,
      },
    });
    const pushText = (pushDry as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
    const pushEnvelope = JSON.parse(pushText);
    assert.equal((pushDry as { isError?: boolean }).isError, undefined);
    assert.equal(pushEnvelope.data?.policy?.rule, "balanced.local_dev");
    assert.equal(pushEnvelope.data?.policy?.approver, null);
    assert.equal(pushEnvelope.data?.exit_code, 0, pushEnvelope.data?.stderr);
    // A real push is observable: it creates refs/heads/main in the local bare remote.
    const pushReal = await callTool(overrideClient, {
      name: "project_shell_run",
      arguments: {
        command: "git push origin HEAD:main",
        shell,
        relative_cwd: "repo",
        background: 0,
      },
    });
    const pushRealText = (pushReal as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
    const pushRealEnvelope = JSON.parse(pushRealText);
    assert.equal((pushReal as { isError?: boolean }).isError, undefined, pushRealText);
    assert.equal(pushRealEnvelope.data?.policy?.rule, "balanced.local_dev");
    await access(path.join(remotePath, "refs", "heads", "main"));

    const audit = new Database(path.join(dataDir, "venira.db"), { readonly: true });
    try {
      const row = audit.prepare(
        "SELECT decision, policy_rule, approver FROM project_tool_audit WHERE session_id = ? AND operation = 'shell_run' ORDER BY id DESC LIMIT 1",
      ).get(overrideSession) as {
        decision: string;
        policy_rule: string;
        approver: string | null;
      } | undefined;
      assert.equal(row?.decision, "allow");
      assert.equal(row?.policy_rule, "balanced.local_dev");
      assert.equal(row?.approver, null);
    } finally {
      audit.close();
    }
  } finally {
    await overrideClient.close();
  }
} catch (error) {
  console.error(
    `[shell-security] FAILED — venira server stderr (last 4 KiB):\n${serverStderr.join("").slice(-4096)}`,
  );
  throw error;
} finally {
  try {
    await client.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

console.log("Shell security regression tests passed.");
