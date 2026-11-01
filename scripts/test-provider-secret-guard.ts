import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalDataDir = process.env.VENIRA_DATA_DIR;
const originalKeychainMode = process.env.VENIRA_SECRET_KEYCHAIN;
const originalLeakTestSecret = process.env.VENIRA_LEAK_TEST_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGithubApiUrl = process.env.VENIRA_GITHUB_API_URL;
const originalGithubRepo = process.env.VENIRA_GITHUB_REPO;
const originalGithubToken = process.env.VENIRA_GITHUB_TOKEN;
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-provider-secret-guard-"));
process.env.VENIRA_DATA_DIR = tempDir;
process.env.VENIRA_SECRET_KEYCHAIN = "off";

try {
  const { assertProviderPayloadSafe } = await import("../lib/provider-secret-guard.js");
  const { setSecret } = await import("../lib/secrets.js");

  await assertProviderPayloadSafe(
    { title: "Add a safe provider change", body: "No credentials are included here." },
    { operation: "pr_create", direction: "request" },
  );

  const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
  await assert.rejects(
    () => assertProviderPayloadSafe(
      { title: "Leaked credential", body: `Please use ${githubToken}` },
      { operation: "pr_create", direction: "request" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("[secret_detected]") &&
      error.message.includes('field "body"') &&
      !error.message.includes(githubToken),
  );

  const gitlabToken = "glpat-abcdefghijklmnopqrstuvwxyz";
  await assert.rejects(
    () => assertProviderPayloadSafe(
      { body: `credential=${gitlabToken}` },
      { operation: "pr_comment", direction: "request" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("[secret_detected]") &&
      !error.message.includes(gitlabToken),
  );

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await assert.rejects(
    () => assertProviderPayloadSafe(
      { body: privateKey },
      { operation: "pr_comment", direction: "request" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("[secret_detected]") &&
      !error.message.includes("BEGIN PRIVATE KEY"),
  );

  await assert.rejects(
    () => assertProviderPayloadSafe(
      { body: `<!-- secretlint-disable-next-line @secretlint/secretlint-rule-github --> ${githubToken}` },
      { operation: "pr_comment", direction: "request" },
    ),
    (error: unknown) => error instanceof Error && error.message.includes("[secret_detected]"),
  );

  const vaultSecret = "local-vault-secret-value-123456";
  await setSecret("VERIFY_PROVIDER_SECRET", vaultSecret);
  await assert.rejects(
    () => assertProviderPayloadSafe(
      { inputs: { deploy_note: `value=${vaultSecret}` } },
      { operation: "ci_trigger", direction: "request" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('field "inputs"') &&
      !error.message.includes(vaultSecret),
  );

  const encodedVaultSecret = Buffer.from(vaultSecret, "utf8").toString("base64");
  await assert.rejects(
    () => assertProviderPayloadSafe(
      { inputs: { deploy_note: `value=${encodedVaultSecret}` } },
      { operation: "ci_trigger", direction: "request" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("[secret_detected]") &&
      !error.message.includes(encodedVaultSecret),
  );

  process.env.VENIRA_LEAK_TEST_SECRET = "local-env-secret-value-987654";
  await assert.rejects(
    () => assertProviderPayloadSafe(
      { body: `copied env value: ${process.env.VENIRA_LEAK_TEST_SECRET}` },
      { operation: "pr_comment", direction: "request" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("[secret_detected]") &&
      !error.message.includes(process.env.VENIRA_LEAK_TEST_SECRET ?? ""),
  );

  const databaseUrl = "postgres://test_user:test_password@db.example.test:5432/verify";
  process.env.DATABASE_URL = databaseUrl;
  for (const encodedDatabaseUrl of [
    encodeURIComponent(databaseUrl),
    Buffer.from(databaseUrl, "utf8").toString("base64"),
  ]) {
    await assert.rejects(
      () => assertProviderPayloadSafe(
        { body: `connection=${encodedDatabaseUrl}` },
        { operation: "pr_comment", direction: "request" },
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("[secret_detected]") &&
        !error.message.includes(databaseUrl) &&
        !error.message.includes(encodedDatabaseUrl),
    );
  }

  await assert.rejects(
    () => assertProviderPayloadSafe(
      { data: `job output: ${githubToken}` },
      { operation: "ci_logs", direction: "response" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("[secret_output_blocked]") &&
      /withheld/i.test(error.message) &&
      !error.message.includes(githubToken),
  );

  const { startGithubMock } = await import("./github-mock.js");
  const mock = await startGithubMock();
  process.env.VENIRA_GITHUB_API_URL = mock.apiUrl;
  process.env.VENIRA_GITHUB_REPO = "acme/demo";
  process.env.VENIRA_GITHUB_TOKEN = "test-provider-token";
  try {
    const { opPrCreate } = await import("../lib/git-provider.js");
    await assert.rejects(
      () => opPrCreate({ title: "No leak", body: `Do not send ${githubToken}` }),
      (error: unknown) => error instanceof Error && error.message.includes("[secret_detected]"),
    );
    assert.equal(mock.requests.length, 0, "sensitive request must be blocked before any network call");
  } finally {
    await mock.close();
    delete process.env.VENIRA_GITHUB_API_URL;
    delete process.env.VENIRA_GITHUB_REPO;
    delete process.env.VENIRA_GITHUB_TOKEN;
  }
} finally {
  if (originalDataDir === undefined) delete process.env.VENIRA_DATA_DIR;
  else process.env.VENIRA_DATA_DIR = originalDataDir;
  if (originalKeychainMode === undefined) delete process.env.VENIRA_SECRET_KEYCHAIN;
  else process.env.VENIRA_SECRET_KEYCHAIN = originalKeychainMode;
  if (originalLeakTestSecret === undefined) delete process.env.VENIRA_LEAK_TEST_SECRET;
  else process.env.VENIRA_LEAK_TEST_SECRET = originalLeakTestSecret;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalGithubApiUrl === undefined) delete process.env.VENIRA_GITHUB_API_URL;
  else process.env.VENIRA_GITHUB_API_URL = originalGithubApiUrl;
  if (originalGithubRepo === undefined) delete process.env.VENIRA_GITHUB_REPO;
  else process.env.VENIRA_GITHUB_REPO = originalGithubRepo;
  if (originalGithubToken === undefined) delete process.env.VENIRA_GITHUB_TOKEN;
  else process.env.VENIRA_GITHUB_TOKEN = originalGithubToken;
  await rm(tempDir, { recursive: true, force: true });
}

console.log("Provider secret guard tests passed.");
