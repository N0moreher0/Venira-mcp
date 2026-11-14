/** Verify section module: providers-config. Behaviour is unchanged from the original scripts/verify.ts. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Harness } from "./harness.js";
import type { runCore } from "./core.js";
import type { runShellPolicy } from "./shell-policy.js";
import type { runShellEnvAudit } from "./shell-env-audit.js";
import type { runSecrets } from "./secrets.js";

export async function runProvidersConfig(
  $h: Harness,
  $prior: Awaited<ReturnType<typeof runCore>> &
    Awaited<ReturnType<typeof runShellPolicy>> &
    Awaited<ReturnType<typeof runShellEnvAudit>> &
    Awaited<ReturnType<typeof runSecrets>>,
) {
  const {
    SESSION_ID,
    githubMock,
    gitlabMock,
    verifyEnv,
    client,
    call,
    check,
    dir,
  } = $h;
  const {
    status,
    asEnvelope,
    nodePath,
    token,
    SECRET_NAME,
    SECRET_VALUE,
    source,
  } = $prior;
  // 11e. Missing token (separate client, real env variant).
  const authTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      {
        VENIRA_SESSION_ID: `${SESSION_ID}-auth`,
        VENIRA_DATA_DIR: path.join(".verify-tmp", "data-auth"),
        VENIRA_GITHUB_TOKEN: "",
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
      },
      "full",
    ),
    stderr: "pipe",
  });
  const authClient = new Client(
    { name: "verify-auth", version: "0.0.0" },
    { capabilities: {} },
  );
  await authClient.connect(authTransport);
  const noAuth = asEnvelope(
    await authClient.callTool({
      name: "ci_trigger",
      arguments: { workflow: "ci.yml" },
    }),
  );
  check("provider_auth_missing", noAuth.error?.code === "auth_missing", noAuth);
  await authClient.close();

  // 11f. Provider unit checks (repo parsing, https-only, kill switch).
  const provider = await import("../../lib/git-provider.js");
  let repoSource = "";
  try {
    repoSource = provider.resolveRepo().source;
  } catch {
    repoSource = "error";
  }
  check("provider_repo_from_git_origin", repoSource === "git", repoSource);

  let injectionRejected = false;
  try {
    provider.parseRepoRef("acme/demo/../../evil", "arg");
  } catch {
    injectionRejected = true;
  }
  check("provider_repo_rejects_path_injection", injectionRejected, undefined);
  check(
    "provider_repo_accepts_https",
    provider.parseRepoRef("https://github.com/acme/demo.git", "arg").name ===
      "demo",
    undefined,
  );

  const savedApiUrl = process.env.VENIRA_GITHUB_API_URL;
  process.env.VENIRA_GITHUB_API_URL = "http://evil.example.com";
  let httpsOnly = false;
  try {
    provider.apiBaseUrl();
  } catch {
    httpsOnly = true;
  }
  if (savedApiUrl === undefined) delete process.env.VENIRA_GITHUB_API_URL;
  else process.env.VENIRA_GITHUB_API_URL = savedApiUrl;
  check("provider_https_only", httpsOnly, undefined);

  // 11g. Config precedence, limits and HTTP knobs (pure unit checks).
  console.log("[verify] checking git config precedence + http knobs...");
  const { gitContext, gitHealth } = await import("../../lib/git-config.js");
  const { gitFetch, shouldBypassProxy } = await import("../../lib/git-http.js");
  const cfgPath = `${dir}/venira.config.json`;
  await fs.writeFile(
    cfgPath,
    JSON.stringify({
      git: {
        provider: "gitlab",
        api_url: gitlabMock.apiUrl,
        repo: "acme/demo",
        timeout_ms: 5000,
        retries: 0,
        secret: "GITLAB_TOKEN",
        repos: { "acme/demo": { provider: "bitbucket", secret: "BB_ALT" } },
      },
    }),
  );
  const touched = [
    "VENIRA_CONFIG_FILE",
    "VENIRA_GIT_PROVIDER",
    "VENIRA_GIT_API_URL",
    "VENIRA_GIT_REPO",
    "VENIRA_GIT_TOKEN",
    "VENIRA_GIT_SECRET_NAME",
    "VENIRA_GIT_TIMEOUT_MS",
    "VENIRA_GIT_MAX_REDIRECTS",
    "VENIRA_GIT_RETRIES",
    "VENIRA_GIT_USERNAME",
    "NO_PROXY",
    "no_proxy",
  ];
  const savedEnv = new Map(touched.map((key) => [key, process.env[key]]));
  process.env.VENIRA_CONFIG_FILE = cfgPath;
  process.env.VENIRA_GIT_REPO = "acme/demo";
  process.env.VENIRA_GIT_TOKEN = "unit-token";
  process.env.VENIRA_GITHUB_API_URL = gitlabMock.apiUrl;
  delete process.env.VENIRA_GIT_PROVIDER;
  delete process.env.VENIRA_GIT_API_URL;
  delete process.env.VENIRA_GIT_SECRET_NAME;
  delete process.env.VENIRA_GIT_TIMEOUT_MS;
  delete process.env.VENIRA_GIT_MAX_REDIRECTS;
  delete process.env.VENIRA_GIT_RETRIES;
  delete process.env.VENIRA_GIT_USERNAME;

  const cfgCtx = gitContext();
  check(
    "config_repo_override",
    cfgCtx.provider === "bitbucket" &&
      cfgCtx.provider_source === "config:repo" &&
      cfgCtx.secret_name === "BB_ALT" &&
      cfgCtx.api_base === gitlabMock.apiUrl &&
      cfgCtx.timeout_ms === 5000,
    {
      provider: cfgCtx.provider,
      source: cfgCtx.provider_source,
      secret: cfgCtx.secret_name,
      api: cfgCtx.api_base,
      timeout: cfgCtx.timeout_ms,
    },
  );

  process.env.VENIRA_GIT_PROVIDER = "gitlab";
  const envCtx = gitContext();
  check(
    "config_env_beats_file",
    envCtx.provider === "gitlab" && envCtx.provider_source === "env",
    {
      provider: envCtx.provider,
      source: envCtx.provider_source,
    },
  );

  process.env.VENIRA_GIT_TIMEOUT_MS = "2500";
  const timeoutCtx = gitContext();
  check(
    "config_env_timeout",
    timeoutCtx.timeout_ms === 2500,
    timeoutCtx.timeout_ms,
  );

  process.env.VENIRA_GIT_MAX_REDIRECTS = "99";
  let redirectsRejected = false;
  try {
    gitContext();
  } catch (error) {
    redirectsRejected =
      error instanceof Error && error.message.startsWith("[invalid_request]");
  }
  process.env.VENIRA_GIT_MAX_REDIRECTS = "5";
  check("config_limit_ceiling", redirectsRejected, undefined);

  process.env.VENIRA_GIT_PROVIDER = "svn";
  let providerRejected = false;
  try {
    gitContext();
  } catch (error) {
    providerRejected =
      error instanceof Error && error.message.startsWith("[invalid_request]");
  }
  process.env.VENIRA_GIT_PROVIDER = "gitlab";
  check("config_provider_validated", providerRejected, undefined);

  process.env.NO_PROXY = ".internal,api.github.com";
  check(
    "config_no_proxy",
    shouldBypassProxy("api.github.com") &&
      shouldBypassProxy("build.internal") &&
      shouldBypassProxy("foo.internal") &&
      !shouldBypassProxy("gitlab.com"),
    {
      github: shouldBypassProxy("api.github.com"),
      internal: shouldBypassProxy("foo.internal"),
      gitlab: shouldBypassProxy("gitlab.com"),
    },
  );

  // Retry: one 500 then 200 with retries=1; with retries=0 the 500 surfaces.
  process.env.VENIRA_GIT_PROVIDER = "github";
  process.env.VENIRA_GIT_API_URL = githubMock.apiUrl;
  process.env.VENIRA_GIT_RETRIES = "1";
  const retryCtx = gitContext();
  const retried = await gitFetch(retryCtx, "/retry-once");
  check(
    "http_retries_get",
    retried.status === 200 && githubMock.state.retryOnce === 2,
    { status: retried.status, attempts: githubMock.state.retryOnce },
  );
  process.env.VENIRA_GIT_RETRIES = "0";
  const noRetryCtx = gitContext();
  let noRetryFailed = false;
  try {
    await gitFetch(noRetryCtx, "/always-500");
  } catch (error) {
    noRetryFailed =
      error instanceof Error && error.message.startsWith("[provider_error]");
  }
  check("http_no_retry_when_zero", noRetryFailed, undefined);

  const healthJson = JSON.stringify(gitHealth());
  check(
    "config_health_no_secret",
    gitHealth().provider === "github" &&
      !healthJson.includes("unit-token") &&
      healthJson.includes("acme/demo") &&
      healthJson.includes('"retries":0'),
    gitHealth(),
  );

  for (const key of touched) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(cfgPath, { force: true });

  const healthProvider = asEnvelope(
    await call("health", { include_audit: 0 }),
  );
  check(
    "health_secrets_and_network",
    healthProvider.data?.secrets?.encryption === "aes-256-gcm" &&
      ["file", "os_keychain"].includes(
        healthProvider.data?.secrets?.key_storage,
      ) &&
      healthProvider.data?.secrets?.count >= 1 &&
      healthProvider.data?.network?.github?.repo === "acme/demo" &&
      healthProvider.data?.network?.github?.auth === "present" &&
      !JSON.stringify(healthProvider.data?.network ?? {}).includes(
        SECRET_VALUE,
      ),
    {
      secrets: healthProvider.data?.secrets,
      network: healthProvider.data?.network,
    },
  );

  const secretDelete = asEnvelope(
    await call("secret", { action: "delete", name: SECRET_NAME }),
  );
  check(
    "secret_delete",
    secretDelete.ok === true && secretDelete.data?.deleted === true,
    secretDelete,
  );

  // 18b. JSONC self-install fixture: comments and braces in strings must survive.
  const selfInstallFixture = nodePath.join(dir, "self-install.jsonc");
  await fs.writeFile(
    selfInstallFixture,
    `{
  // Keep this comment and the brace in this string.
  "name": "fixture } value",
  "mcp": {
    // Existing client configuration must remain untouched.
    "existing": { "command": "node" }
  }
}\n`,
  );
  const { installJsonLike } = await import("../../lib/self-install.js");
  const selfInstallResult = await installJsonLike(selfInstallFixture, "mcp", {
    workspace: nodePath.join(dir, "workspace"),
    dataDir: nodePath.join(dir, "data"),
  });
  const selfInstallText = await fs.readFile(selfInstallFixture, "utf8");
  const selfInstallParsed = JSON.parse(
    selfInstallText.replace(/^\s*\/\/.*$/gm, ""),
  );
  check(
    "self_install_jsonc_fixture",
    selfInstallResult.status === "installed" &&
      selfInstallText.includes("Keep this comment") &&
      selfInstallParsed.mcp?.existing?.command === "node" &&
      selfInstallParsed.mcp?.venira?.environment?.VENIRA_WORKSPACE ===
        nodePath.join(dir, "workspace") &&
      selfInstallParsed.mcp?.venira?.environment?.VENIRA_DATA_DIR ===
        nodePath.join(dir, "data") &&
      !selfInstallText.includes(`${process.cwd()}\\data`) &&
      !selfInstallText.includes(`${process.cwd()}/data`),
    { status: selfInstallResult.status, error: selfInstallResult.error },
  );
  return {};
}
