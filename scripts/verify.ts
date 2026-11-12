/**
 * Verify MCP behaviour after the envelope refactor (ok/kind/data/hint), cache invalidation,
 * batch, shell, full error standards, envelopes for health/recent_files/read_ranges,
 * compact mode (when spawning a binary client), metrics, tool annotations.
 *
 * Fix the session so audit rows belong to this run only.
 */
import "./clean-env.js"; // must stay first: drops inherited VENIRA_* before lib modules read env
import { promises as fs } from "node:fs";
import { harness } from "./verify/harness.js";
import { runCore } from "./verify/core.js";
import { runShellPolicy } from "./verify/shell-policy.js";
import { runShellEnvAudit } from "./verify/shell-env-audit.js";
import { runSearch } from "./verify/search.js";
import { runCheckpointsErrors } from "./verify/checkpoints-errors.js";
import { runSecrets } from "./verify/secrets.js";
import { runGithubCi } from "./verify/github-ci.js";
import { runDiagnosticsReadPlan } from "./verify/diagnostics-read-plan.js";
import { runProvidersConfig } from "./verify/providers-config.js";
import { runAuditSymbols } from "./verify/audit-symbols.js";
import { runConsistency } from "./verify/consistency.js";

// Sections run in the original order; later sections receive the state earlier ones produced.
const {
  originalDataDir,
  verifyDataDir,
  githubMock,
  gitlabMock,
  bitbucketMock,
  client,
  results,
  dir,
} = harness;

const core = await runCore(harness);
const shellPolicy = await runShellPolicy(harness, { ...core });
const shellEnvAudit = await runShellEnvAudit(harness, {
  ...core,
  ...shellPolicy,
});
await runSearch(harness, { ...core, ...shellPolicy, ...shellEnvAudit });
const checkpointsErrors = await runCheckpointsErrors(harness, {
  ...core,
  ...shellPolicy,
  ...shellEnvAudit,
});
const secrets = await runSecrets(harness, { ...shellPolicy });
await runGithubCi(harness, {
  ...core,
  ...shellPolicy,
  ...shellEnvAudit,
  ...secrets,
});
await runDiagnosticsReadPlan(harness);
await runProvidersConfig(harness, {
  ...core,
  ...shellPolicy,
  ...shellEnvAudit,
  ...secrets,
});
await runAuditSymbols(harness, {
  ...core,
  ...shellPolicy,
  ...shellEnvAudit,
  ...checkpointsErrors,
  ...secrets,
});
await runConsistency(harness, {
  ...core,
  ...shellPolicy,
  ...shellEnvAudit,
});

console.log("[verify] done");
await client.close();
await new Promise((resolve) => setTimeout(resolve, 1500));
await Promise.all([
  githubMock.close(),
  gitlabMock.close(),
  bitbucketMock.close(),
]);
await fs.rm(dir, { recursive: true, force: true });
await fs.rm(verifyDataDir, { recursive: true, force: true });
if (originalDataDir === undefined) delete process.env.VENIRA_DATA_DIR;
else process.env.VENIRA_DATA_DIR = originalDataDir;
console.log(JSON.stringify(results, null, 2));
const failedChecks = Object.entries(results).filter(
  ([, result]) => typeof result === "string" && result.startsWith("FAIL "),
);
if (failedChecks.length > 0) {
  console.error(`[verify] ${failedChecks.length} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(
    `[verify] ${Object.values(results).filter((result) => result === "PASS").length} checks passed.`,
  );
}
