import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { access, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-security-"));
const workspaceDir = path.join(tempDir, "workspace");
await mkdir(workspaceDir);
const sessionId = `shell-security-${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/server.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    VENIRA_WORKSPACE: workspaceDir,
    VENIRA_DATA_DIR: tempDir,
    VENIRA_SESSION_ID: sessionId,
    VENIRA_SECRET_KEYCHAIN: "off",
    VENIRA_SHELL_MODE: "balanced",
    VENIRA_SHELL_OVERRIDES: "",
    VENIRA_SHELL_AUTO_APPROVE_TOKEN: "0",
  },
  stderr: "pipe",
});
const client = new Client({ name: "shell-security-regressions", version: "0.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const callShell = async (command: string) => {
    const result = await client.callTool({ name: "project_shell_run", arguments: { command, shell } });
    const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
    return { result, envelope: JSON.parse(text) as { error?: { code?: string }; data?: Record<string, unknown> } };
  };

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

  const selfEnabledOverride = await client.callTool({
    name: "project_shell_run",
    arguments: {
      command: "git push origin main",
      shell,
      override: "ALLOW_GIT_PUSH",
      reason: "test disabled operator gate",
    },
  });
  const selfEnabledText = (selfEnabledOverride as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
  assert.equal(JSON.parse(selfEnabledText).error?.code, "override_not_enabled");

  const missingReason = await client.callTool({
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
      VENIRA_DATA_DIR: tempDir,
      VENIRA_SESSION_ID: overrideSession,
      VENIRA_SECRET_KEYCHAIN: "off",
      VENIRA_SHELL_MODE: "strict",
      VENIRA_SHELL_OVERRIDES: "ALLOW_ENV_READ,ALLOW_GIT_PUSH",
      VENIRA_SHELL_AUTO_APPROVE_TOKEN: "0",
    },
    stderr: "pipe",
  });
  try {
    await overrideClient.connect(overrideTransport);
    const envReadOverride = await overrideClient.callTool({
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
      const symlinkRead = await overrideClient.callTool({
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
      const outOfScope = await overrideClient.callTool({
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

    const pushOverride = await overrideClient.callTool({
      name: "project_shell_run",
      arguments: {
        command: "git push --dry-run origin HEAD:main",
        shell,
        relative_cwd: "repo",
        background: 0,
        override: "ALLOW_GIT_PUSH",
        reason: "verify local dry-run push authorization",
      },
    });
    const pushText = (pushOverride as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
    const pushEnvelope = JSON.parse(pushText);
    assert.equal((pushOverride as { isError?: boolean }).isError, undefined);
    assert.equal(pushEnvelope.data?.policy?.rule, "override.ALLOW_GIT_PUSH");
    assert.equal(pushEnvelope.data?.policy?.approver, "agent:ALLOW_GIT_PUSH");
    assert.equal(pushEnvelope.data?.exit_code, 0, pushEnvelope.data?.stderr);
    await assert.rejects(access(path.join(remotePath, "refs", "heads", "main")));

    const audit = new Database(path.join(tempDir, "venira.db"), { readonly: true });
    try {
      const row = audit.prepare(
        "SELECT decision, policy_rule, reason, approver FROM project_tool_audit WHERE session_id = ? AND operation = 'shell_run' ORDER BY id DESC LIMIT 1",
      ).get(overrideSession) as {
        decision: string;
        policy_rule: string;
        reason: string;
        approver: string;
      } | undefined;
      assert.equal(row?.decision, "allow");
      assert.equal(row?.policy_rule, "override.ALLOW_GIT_PUSH");
      assert.equal(row?.reason, "verify local dry-run push authorization");
      assert.equal(row?.approver, "agent:ALLOW_GIT_PUSH");
    } finally {
      audit.close();
    }
  } finally {
    await overrideClient.close();
  }
} finally {
  try {
    await client.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

console.log("Shell security regression tests passed.");
