import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-security-"));
const sessionId = `shell-security-${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/server.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    VENIRA_WORKSPACE: process.cwd(),
    VENIRA_DATA_DIR: tempDir,
    VENIRA_SESSION_ID: sessionId,
    VENIRA_SECRET_KEYCHAIN: "off",
    VENIRA_SHELL_MODE: "balanced",
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
} finally {
  try {
    await client.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

console.log("Shell security regression tests passed.");
