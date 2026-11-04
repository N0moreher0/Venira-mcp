import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const originalNow = Date.now;
const originalDataDir = process.env.VENIRA_DATA_DIR;
const originalKeychainMode = process.env.VENIRA_SECRET_KEYCHAIN;
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-device-flow-"));
process.env.VENIRA_DATA_DIR = tempDir;
process.env.VENIRA_SECRET_KEYCHAIN = "off";
let now = 1_800_000_000_000;
Date.now = () => now;

try {
  const {
    GithubDeviceFlow,
    refreshGithubAccessTokenIfNeeded,
  } = await import("../lib/github-device-flow.js");
  const { getSecretValueSync, listSecrets, setSecret } = await import("../lib/secrets.js");

  const replies = [
    {
      device_code: "device-secret-test-value",
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    },
    { error: "authorization_pending" },
    {
      access_token: "access-secret-test-value",
      refresh_token: "refresh-secret-test-value",
      expires_in: 28_800,
      refresh_token_expires_in: 15_811_200,
      token_type: "bearer",
    },
  ];
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const saved: Array<Record<string, unknown>> = [];
  const flow = new GithubDeviceFlow("test-client-id", {
    hasToken: () => false,
    saveTokens: async (tokens) => {
      saved.push(tokens);
    },
    fetcher: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      const reply = replies.shift();
      assert.ok(reply, "unexpected GitHub request");
      return new Response(JSON.stringify(reply), { status: 200 });
    },
  });

  const start = await flow.start();
  assert.equal(start.user_code, "ABCD-EFGH");
  assert.equal(start.verification_uri, "https://github.com/login/device");
  assert.equal(requests[0].body.scope, "repo offline_access");
  assert.equal(JSON.stringify(start).includes("device-secret-test-value"), false);

  const tooSoon = await flow.poll(start.pending_id);
  assert.equal(tooSoon.status, "pending");
  assert.equal(requests.length, 1);

  now += 5_000;
  const pending = await flow.poll(start.pending_id);
  assert.equal(pending.status, "pending");
  assert.equal(requests.length, 2);

  now += 5_000;
  const connected = await flow.poll(start.pending_id);
  assert.equal(connected.status, "connected");
  assert.equal(connected.credential, "GITHUB_TOKEN");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].accessToken, "access-secret-test-value");
  assert.equal(saved[0].refreshToken, "refresh-secret-test-value");
  assert.equal(JSON.stringify(connected).includes("access-secret-test-value"), false);
  assert.equal(JSON.stringify(connected).includes("refresh-secret-test-value"), false);
  assert.equal(JSON.stringify(connected).includes("device-secret-test-value"), false);
  assert.equal(requests[2].body.device_code, "device-secret-test-value");

  const alreadyConfigured = new GithubDeviceFlow("test-client-id", {
    hasToken: () => true,
    fetcher: async () => {
      throw new Error("should not make a request when replacement was not confirmed");
    },
  });
  await assert.rejects(() => alreadyConfigured.start(), /already_configured/);

  await setSecret("GITHUB_TOKEN", "expired-access-token", {
    source: "provider",
    expiresAt: now - 1,
  });
  await setSecret("GITHUB_REFRESH_TOKEN", "old-refresh-token", {
    source: "provider",
    expiresAt: now + 60_000,
  });
  const refreshRequests: Array<Record<string, unknown>> = [];
  await refreshGithubAccessTokenIfNeeded(async (input, init) => {
    refreshRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 28_800,
        refresh_token_expires_in: 15_811_200,
        token_type: "bearer",
      }),
      { status: 200 },
    );
  });
  assert.equal(refreshRequests[0].grant_type, "refresh_token");
  assert.equal(getSecretValueSync("GITHUB_TOKEN"), "rotated-access-token");
  assert.equal(getSecretValueSync("GITHUB_REFRESH_TOKEN"), "rotated-refresh-token");
  assert.equal(listSecrets().find((secret) => secret.name === "GITHUB_TOKEN")?.expired, false);

  const { startGithubMock } = await import("./github-mock.js");
  const mock = await startGithubMock();
  process.env.VENIRA_GITHUB_API_URL = mock.apiUrl;
  process.env.VENIRA_GITHUB_REPO = "acme/demo";
  process.env.VENIRA_GITHUB_TOKEN = "test-provider-token";
  try {
    const { opPrCreate } = await import("../lib/git-provider.js");
    const result = await opPrCreate({ title: "Device Flow integration test", head: "test-branch" });
    assert.equal(result.status, "completed");
    assert.equal(mock.requests.some((request) => request.path === "/repos/acme/demo/pulls"), true);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/server.js"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        VENIRA_WORKSPACE: process.cwd(),
        VENIRA_DATA_DIR: tempDir,
        VENIRA_SECRET_KEYCHAIN: "off",
        VENIRA_GITHUB_API_URL: mock.apiUrl,
        VENIRA_GITHUB_REPO: "acme/demo",
        VENIRA_GITHUB_TOKEN: "test-mcp-provider-token",
        VENIRA_TOOL_MODE: "expert",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "device-flow-test", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.some((tool) => tool.name === "project_github_connect"), true);
      const mcpResult = await client.callTool({
        name: "project_pr_create",
        arguments: { title: "MCP Device Flow integration test", head: "mcp-test-branch" },
      });
      assert.equal(mcpResult.isError, undefined);
      assert.equal(mock.requests.some((request) => request.path === "/repos/acme/demo/pulls"), true);
    } finally {
      await client.close();
    }
  } finally {
    await mock.close();
    delete process.env.VENIRA_GITHUB_API_URL;
    delete process.env.VENIRA_GITHUB_REPO;
    delete process.env.VENIRA_GITHUB_TOKEN;
  }
} finally {
  Date.now = originalNow;
  if (originalDataDir === undefined) delete process.env.VENIRA_DATA_DIR;
  else process.env.VENIRA_DATA_DIR = originalDataDir;
  if (originalKeychainMode === undefined) delete process.env.VENIRA_SECRET_KEYCHAIN;
  else process.env.VENIRA_SECRET_KEYCHAIN = originalKeychainMode;
  await rm(tempDir, { recursive: true, force: true });
}

console.log("GitHub Device Flow tests passed.");
