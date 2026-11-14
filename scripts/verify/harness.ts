/**
 * Shared verify harness: isolated data dir, local provider mocks, the MCP client
 * connected to `dist/server.js`, and the `check` / `call` / `textOf` helpers.
 * Imported first by `scripts/verify.ts`; section modules receive it as `Harness`.
 */
import "../clean-env.js"; // must stay first: drops inherited VENIRA_* before lib modules read env
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startGithubMock } from "../github-mock.js";
import { startBitbucketMock, startGitlabMock } from "../git-mocks.js";
import { envFlag } from "../../lib/env.js";

export const SESSION_ID = `verify-${Date.now()}`;
export const originalDataDir = process.env.VENIRA_DATA_DIR;
export const verifyDataDir = await fs.mkdtemp(
  path.join(os.tmpdir(), `venira-verify-${process.pid}-`),
);
process.env.VENIRA_DATA_DIR = verifyDataDir;

/**
 * Local GitHub API mock (no network, no real token). It also serves the log
 * archive from a second origin, so we can prove the token is dropped on
 * GitHub's pre-signed-blob redirect.
 */
export const githubMock = await startGithubMock();
export const gitlabMock = await startGitlabMock();
export const bitbucketMock = await startBitbucketMock();

export function verifyEnv(
  extraEnv: Record<string, string> = {},
  outputMode = "full",
) {
  return {
    ...process.env,
    VENIRA_WORKSPACE: process.cwd(),
    VENIRA_SESSION_ID: SESSION_ID,
    VENIRA_OUTPUT_MODE: outputMode,
    VENIRA_SHELL_MODE: "balanced",
    VENIRA_SHELL_POLICY_FILE: "",
    VENIRA_SHELL_OVERRIDES: "",
    VENIRA_UNRESTRICTED: "0",
    VENIRA_JS_EXEC_MODE: "off",
    VENIRA_CACHE_ALL: "1",
    VENIRA_CACHE_LIST_ONLY: "1",
    VENIRA_SHELL_CACHE: "0",
    VENIRA_AUDIT_STRICT: "0",
    VENIRA_EDIT_FUZZY: "0",
    VENIRA_SETUP_TOOLS: "1", // verify/secrets.ts still exercises install_self; the default-off listing is pinned in test-tool-schema.ts
    VENIRA_SHELL_AUTO_APPROVE_TOKEN: "0",
    VENIRA_PRETTY: "0",
    VENIRA_ALLOW_SELF_INSTALL: "0",
    VENIRA_GIT_ALLOW_HTTP: "0",
    VENIRA_GITHUB_ALLOW_HTTP: "0",
    VENIRA_VERIFY_DEBUG: "0",
    // Most verify transports need the full surface (shell, JS eval, CI/CD);
    // the default tool mode is the lean coding set, so opt them into `expert`.
    // `tool_mode_default_coding_focused` forces "default" on top of this.
    VENIRA_TOOL_MODE: "expert",
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    // keytar/Node 24 can assert during native cleanup in MCP child processes;
    // the backend is covered separately by the Windows keychain integration check.
    VENIRA_SECRET_KEYCHAIN: "off",
    // Point the provider at the mock; a fixed repo keeps resolution
    // independent from this checkout's real git remote.
    VENIRA_GITHUB_API_URL: githubMock.apiUrl,
    VENIRA_GITHUB_REPO: "acme/demo",
    VENIRA_GITHUB_TOKEN: "verify-github-token",
    VENIRA_GIT_TOKEN: "",
    ...extraEnv,
  };
}

// Second client to test VENIRA_OUTPUT_MODE=compact
export const createClient = (extraEnv: Record<string, string> = {}) => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(extraEnv, "compact"),
    stderr: "pipe",
  });
  return new Client({ name: "verify", version: "0.0.0" }, { capabilities: {} });
};

export const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  cwd: process.cwd(),
  env: verifyEnv(
    { VENIRA_SHELL_TIMEOUT_POLICY: "hard", VENIRA_TOOL_MODE: "expert" },
    "full",
  ), // full mode for the remaining checks
  stderr: "pipe",
});
if (envFlag("VENIRA_VERIFY_DEBUG", false)) {
  transport.stderr?.on("data", (chunk: Buffer) =>
    console.error("[server]", chunk.toString("utf8")),
  );
}
export const client = new Client(
  { name: "verify", version: "0.0.0" },
  { capabilities: {} },
);
await client.connect(transport);

export const results: Record<string, unknown> = {};
export const textOf = (result: unknown) =>
  (result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "";
export const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });
export const check = (label: string, condition: boolean, extra?: unknown) => {
  results[label] = condition ? "PASS" : `FAIL ${JSON.stringify(extra ?? "")}`;
  if (!condition) {
    process.exitCode = 1;
    console.error(`[verify] FAIL ${label}: ${JSON.stringify(extra ?? "")}`);
  }
};

export const isWin = process.platform === "win32";
export const dir = ".verify-tmp";
// Start from a clean directory: a previous crashed run must not change counts.
await fs.rm(dir, { recursive: true, force: true });
await fs.mkdir(dir, { recursive: true });
export const names = Array.from({ length: 8 }, (_, i) => `${dir}/f${i}.txt`);
await Promise.all(
  names.map((name, i) => fs.writeFile(name, `noi dung ${i}\n`.repeat(50))),
);

export const harness = {
  SESSION_ID,
  originalDataDir,
  verifyDataDir,
  githubMock,
  gitlabMock,
  bitbucketMock,
  verifyEnv,
  createClient,
  transport,
  client,
  results,
  textOf,
  call,
  check,
  isWin,
  dir,
  names,
};
export type Harness = typeof harness;
