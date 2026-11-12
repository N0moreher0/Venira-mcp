import { promises as fs } from "node:fs";
import { rankCandidates } from "../../lib/read-plan.js";
import type { Harness } from "./harness.js";

export async function runDiagnosticsReadPlan($h: Harness): Promise<void> {
  const { call, check, dir, textOf } = $h;
  const asEnvelope = (result: unknown) => JSON.parse(textOf(result) || "{}");
  // 11d-bis. Diagnostics + read planning (deterministic, no model call).
  console.log("[verify] checking diagnostics + read planning...");
  const explainEconn = asEnvelope(
    await call("project_explain_error", {
      error_text:
        "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect",
    }),
  );
  check(
    "explain_error_econnrefused",
    explainEconn.ok === true &&
      explainEconn.data?.matched === true &&
      explainEconn.data?.diagnoses?.[0]?.rule_id === "net.econnrefused",
    explainEconn.data,
  );

  const explainTs = asEnvelope(
    await call("project_explain_error", {
      error_text:
        "src/git-provider.ts:120 - error TS2322: Type 'string' is not assignable to type 'number'.",
    }),
  );
  check(
    "explain_error_typescript",
    explainTs.ok === true &&
      explainTs.data?.matched === true &&
      explainTs.data?.diagnoses?.[0]?.rule_id === "ts.type_error" &&
      (explainTs.data?.next_actions ?? []).some(
        (action: { tool?: string }) => action.tool === "project_read_file",
      ),
    explainTs.data,
  );
  const explainVenira = asEnvelope(
    await call("project_explain_error", {
      error_text: "[path_escape] Path is outside the workspace: ../secrets.txt",
    }),
  );
  check(
    "explain_error_venira_path_escape",
    explainVenira.ok === true &&
      explainVenira.data?.matched === true &&
      explainVenira.data?.diagnoses?.[0]?.rule_id === "venira.path_escape",
    explainVenira.data,
  );
  const explainSensitive = asEnvelope(
    await call("project_explain_error", {
      error_text: "[sensitive_result] Path is protected by policy",
    }),
  );
  check(
    "explain_error_venira_sensitive_result",
    explainSensitive.ok === true &&
      explainSensitive.data?.matched === true &&
      explainSensitive.data?.diagnoses?.[0]?.rule_id === "venira.sensitive_result",
    explainSensitive.data,
  );
  const explainUnknown = asEnvelope(
    await call("project_explain_error", { error_text: "everything is fine" }),
  );
  check(
    "explain_error_unknown_is_ok",
    explainUnknown.ok === true && explainUnknown.data?.matched === false,
    explainUnknown.data,
  );
  // Roadmap item 17: the codes that make an agent loop must be diagnosable.
  const explainRepeat = asEnvelope(
    await call("project_explain_error", {
      error_text:
        "[repeated_failure] This exact invocation already failed in this session (exit code 1, 1 time(s)). The command was not run again.",
    }),
  );
  check(
    "explain_error_venira_repeated_failure",
    explainRepeat.ok === true &&
      explainRepeat.data?.matched === true &&
      explainRepeat.data?.diagnoses?.[0]?.rule_id === "venira.repeated_failure" &&
      (explainRepeat.data?.diagnoses?.[0]?.retry_hint ?? "").includes("identical"),
    explainRepeat.data,
  );
  const explainStale = asEnvelope(
    await call("project_explain_error", {
      error_text:
        "[stale_content] The file changed since you read it (current sha256 aabbccddeeff..., expected 1122334455...).",
    }),
  );
  check(
    "explain_error_venira_stale_content",
    explainStale.ok === true &&
      explainStale.data?.matched === true &&
      explainStale.data?.diagnoses?.[0]?.rule_id === "venira.stale_content",
    explainStale.data,
  );
  const explainDenied = asEnvelope(
    await call("project_explain_error", {
      error_text: "[command_denied] Blocked by deny.filesystem_root_delete: refuses to delete a filesystem root.",
    }),
  );
  check(
    "explain_error_venira_command_denied",
    explainDenied.ok === true &&
      explainDenied.data?.matched === true &&
      explainDenied.data?.diagnoses?.[0]?.rule_id === "venira.command_denied",
    explainDenied.data,
  );
  const explainShellMissing = asEnvelope(
    await call("project_explain_error", {
      error_text: '[shell_unavailable] Shell "pwsh" (pwsh) was not found, so the command did not run.',
    }),
  );
  check(
    "explain_error_venira_shell_unavailable",
    explainShellMissing.ok === true &&
      explainShellMissing.data?.matched === true &&
      explainShellMissing.data?.diagnoses?.[0]?.rule_id === "venira.shell_unavailable",
    explainShellMissing.data,
  );
  const explainOldText = asEnvelope(
    await call("project_explain_error", {
      error_text: "[old_text_not_found] old_text not found in src/app.ts.",
    }),
  );
  check(
    "explain_error_venira_old_text_not_found",
    explainOldText.ok === true &&
      explainOldText.data?.matched === true &&
      explainOldText.data?.diagnoses?.[0]?.rule_id === "venira.old_text_not_found",
    explainOldText.data,
  );
  const githubEmptyPending = asEnvelope(
    await call("project_github_connect", { action: "poll", pending_id: "" }),
  );
  check(
    "github_poll_empty_pending_id_is_specific",
    githubEmptyPending.ok === false &&
      githubEmptyPending.error?.code === "invalid_request" &&
      /cannot be empty/i.test(String(githubEmptyPending.error?.message ?? "")),
    githubEmptyPending,
  );
  const explainEmpty = asEnvelope(await call("project_explain_error", {}));
  check(
    "explain_error_requires_input",
    explainEmpty.error?.code === "invalid_request",
    explainEmpty,
  );

  const planTask = asEnvelope(
    await call("project_plan_read_batch", {
      task_description: "add retry handling to the GitHub client",
    }),
  );
  check(
    "plan_read_batch_search",
    planTask.ok === true &&
      (planTask.data?.keywords ?? []).some((keyword: string) =>
        /retry|github/i.test(keyword),
      ) &&
      (planTask.data?.candidates ?? []).some(
        (candidate: { relative_path?: string }) =>
          /^lib[\\/]+git-[^\\/]+\.ts$/i.test(String(candidate.relative_path)),
      ) &&
      planTask.data?.steps?.[0]?.tool === "project_read_batch",
    planTask.data,
  );
  const rankedByPath = rankCandidates(
    [
      {
        relative_path: "lib/approval-gate.ts",
        reason: "search:retry",
        hits: 6,
      },
      { relative_path: "lib/git-github.ts", reason: "search:GitHub", hits: 2 },
    ],
    ["GitHub", "retry"],
    "add retry handling to the GitHub client",
    2,
  );
  check(
    "plan_path_match_beats_incidental_hits",
    rankedByPath[0]?.relative_path === "lib/git-github.ts",
    rankedByPath,
  );
  const planHint = asEnvelope(
    await call("project_plan_read_batch", {
      task_description: "refactor the checkpoint store",
      files_hint: ["lib/snapshots.ts"],
      include_search: 0,
    }),
  );
  check(
    "plan_read_batch_hints",
    planHint.ok === true &&
      planHint.data?.searched === false &&
      planHint.data?.candidates?.[0]?.relative_path === "lib/snapshots.ts" &&
      planHint.data?.steps?.[0]?.tool === "project_read_batch",
    planHint.data,
  );
  const planEmpty = asEnvelope(
    await call("project_plan_read_batch", { task_description: "   " }),
  );
  check(
    "plan_read_batch_requires_task",
    planEmpty.error?.code === "invalid_request",
    planEmpty,
  );

  // Artifacts (audit DB, logs, build output) match keyword searches but must never
  // rank as read targets — the real-world symptom was data/venira.db topping a plan.
  const artifactToken = `PLAN_ARTIFACT_${Date.now()}`;
  await fs.writeFile(`${dir}/plan-artifact.db`, `noise ${artifactToken}\n`);
  await fs.writeFile(`${dir}/plan-artifact.log`, `${artifactToken}\n`);
  const planArtifact = asEnvelope(
    await call("project_plan_read_batch", {
      task_description: artifactToken,
      include_search: 1,
    }),
  );
  const artifactCandidates = (planArtifact.data?.candidates ?? []) as Array<{
    relative_path?: string;
  }>;
  const artifactRequests = (
    (planArtifact.data?.steps ?? []) as Array<{
      arguments?: {
        requests?: Array<{ arguments?: { relative_path?: string } }>;
      };
    }>
  ).flatMap((step) => step.arguments?.requests ?? []);
  check(
    "plan_read_batch_excludes_artifacts",
    planArtifact.ok === true &&
      artifactCandidates.every(
        (c) => !/\.(db|log)$/i.test(String(c.relative_path)),
      ) &&
      artifactRequests.every(
        (r) => !/\.(db|log)$/i.test(String(r.arguments?.relative_path)),
      ),
    {
      candidates: artifactCandidates.map((c) => c.relative_path),
      requests: artifactRequests.map((r) => r.arguments?.relative_path),
    },
  );
  const planSource = asEnvelope(
    await call("project_plan_read_batch", {
      task_description: "inline review comment git-provider",
    }),
  );
  check(
    "plan_read_batch_ranks_source",
    planSource.ok === true &&
      (planSource.data?.candidates ?? []).some(
        (c: { relative_path?: string }) =>
          /^lib[\\/]+git-[^\\/]+\.ts$/i.test(String(c.relative_path)),
      ),
    planSource.data?.candidates,
  );

  // A file *named* after the task is the target even when the word never occurs
  // inside it (the live symptom: "git-provider" ranked docs, not lib/git-provider.ts).
  const nameToken = `plan_name_${Date.now()}`;
  const nameSlug = nameToken.toLowerCase().replace(/_/g, "-");
  await fs.mkdir(`${dir}/docs`, { recursive: true });
  await fs.writeFile(
    `${dir}/${nameToken}-impl.ts`,
    "export const noop = () => 0;\n",
  );
  await fs.writeFile(
    `${dir}/docs/${nameSlug}.md`,
    `${nameToken} prose\n`.repeat(25),
  );
  const planName = asEnvelope(
    await call("project_plan_read_batch", {
      task_description: `update ${nameToken} handling`,
      include_search: 1,
    }),
  );
  const nameCandidates = (planName.data?.candidates ?? []) as Array<{
    relative_path?: string;
    score?: number;
  }>;
  const nameFiles = nameCandidates.map((c) => String(c.relative_path));
  const implIndex = nameFiles.findIndex((file) =>
    file.endsWith(`${nameToken}-impl.ts`),
  );
  const docIndex = nameFiles.findIndex((file) =>
    file.includes(`docs/${nameSlug}`),
  );
  check(
    "plan_read_batch_ranks_named_file",
    planName.ok === true &&
      implIndex !== -1 &&
      (docIndex === -1 || docIndex > implIndex),
    { candidates: nameCandidates.map((c) => `${c.relative_path}=${c.score}`) },
  );

  // Prose must not outrank code for a code task, but must keep its hits when the
  // task is explicitly about documentation.
  const planDocs = asEnvelope(
    await call("project_plan_read_batch", {
      task_description: "document the retry handling in README",
      max_files: 4,
    }),
  );
  check(
    "plan_read_batch_docs_when_asked",
    planDocs.ok === true &&
      (planDocs.data?.candidates ?? []).some((c: { relative_path?: string }) =>
        /readme/i.test(String(c.relative_path)),
      ),
    planDocs.data?.candidates,
  );

  // Credentials and key material must never be proposed as read targets (the live
  // E2E run ranked data/secrets.json + data/secrets.key for a secret-related task).
  const secretToken = `PLAN_SECRET_${Date.now()}`;
  await fs.writeFile(`${dir}/secrets.json`, `{"token":"${secretToken}"}\n`);
  await fs.writeFile(`${dir}/secrets.key`, `${secretToken}\n`);
  await fs.writeFile(`${dir}/deploy.key`, `${secretToken}\n`);
  await fs.writeFile(`${dir}/.env`, `TOKEN=${secretToken}\n`);
  const planSecret = asEnvelope(
    await call("project_plan_read_batch", {
      task_description: `rotate ${secretToken} token`,
      include_search: 1,
    }),
  );
  const secretFiles: string[] = (planSecret.data?.candidates ?? []).map(
    (c: { relative_path?: string }) => String(c.relative_path),
  );
  check(
    "plan_read_batch_excludes_secrets",
    planSecret.ok === true &&
      secretFiles.every(
        (file) => !/(^|\/)(secrets\.(json|key)|deploy\.key|\.env)$/i.test(file),
      ),
    { candidates: secretFiles },
  );

  // Estimate must be calibrated against the measured batch (6 files ≈ 62 ms), not
  // the old flat 6 ms.
  const planEstimate = Number(planTask.data?.estimated_ms ?? 0);
  const planFileCount = (planTask.data?.candidates ?? []).length;
  check(
    "plan_read_batch_estimate_calibrated",
    planTask.ok === true && planEstimate >= 8 + 9 * Math.min(planFileCount, 8),
    { estimated_ms: planEstimate, files: planFileCount },
  );
}
