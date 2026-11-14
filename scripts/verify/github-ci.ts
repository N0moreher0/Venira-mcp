/** Verify section module: github-ci. Behaviour is unchanged from the original scripts/verify.ts. */
import { runDependencyImpact } from "./dependency-impact.js";
import { runProviderDialects } from "./provider-dialects.js";
import type { Harness } from "./harness.js";
import type { runCore } from "./core.js";
import type { runShellPolicy } from "./shell-policy.js";
import type { runShellEnvAudit } from "./shell-env-audit.js";
import type { runSecrets } from "./secrets.js";

export async function runGithubCi(
  $h: Harness,
  $prior: Awaited<ReturnType<typeof runCore>> &
    Awaited<ReturnType<typeof runShellPolicy>> &
    Awaited<ReturnType<typeof runShellEnvAudit>> &
    Awaited<ReturnType<typeof runSecrets>>,
) {
  const {
    githubMock,
    gitlabMock,
    bitbucketMock,
    verifyEnv,
    client,
    call,
    check,
    dir,
    names,
  } = $h;
  const { tools, missing, run, status, asEnvelope, cli, token, target } =
    $prior;
  // 11d. GitHub provider + CI against the local mock (no network, fixed token).
  console.log("[verify] checking git/ci provider...");
  const prCreate = asEnvelope(
    await call("pr_create", {
      title: "Add provider tools",
      head: "verify-branch",
      draft: 1,
    }),
  );
  check(
    "pr_create",
    prCreate.ok === true &&
      prCreate.kind === "pr_create" &&
      prCreate.data?.number === 7 &&
      prCreate.data?.base === "main" &&
      prCreate.data?.head === "verify-branch" &&
      prCreate.data?.created === true,
    prCreate,
  );
  check(
    "pr_create_uses_token_header",
    githubMock.requests.some(
      (r) =>
        r.path.startsWith("/repos/acme/demo/pulls") &&
        r.auth === "Bearer verify-github-token",
    ),
    githubMock.requests.filter((r) =>
      r.path.startsWith("/repos/acme/demo/pulls"),
    ),
  );

  const prComment = asEnvelope(
    await call("pr_comment", { pr: 7, body: "LGTM from verify" }),
  );
  check(
    "pr_comment",
    prComment.ok === true &&
      prComment.data?.comment_id === 1001 &&
      prComment.data?.pr === 7,
    prComment,
  );
  const prCommentUrl = asEnvelope(
    await call("pr_comment", {
      pr: "https://github.com/acme/demo/pull/7",
      body: "URL form",
    }),
  );
  check(
    "pr_comment_accepts_url",
    prCommentUrl.ok === true && prCommentUrl.data?.comment_id === 1002,
    prCommentUrl,
  );

  // Inline review comment: path+line switches to the pull review-comment API.
  const prInline = asEnvelope(
    await call("pr_comment", {
      pr: 7,
      body: "This branch can be simplified",
      path: "src/app.ts",
      line: 42,
      start_line: 40,
      side: "RIGHT",
    }),
  );
  check(
    "pr_comment_inline",
    prInline.ok === true &&
      prInline.data?.inline === true &&
      prInline.data?.path === "src/app.ts" &&
      prInline.data?.line === 42 &&
      prInline.data?.start_line === 40 &&
      prInline.data?.side === "RIGHT" &&
      prInline.data?.commit_id === "0123456789abcdef0123456789abcdef01234567",
    prInline,
  );
  check(
    "pr_comment_inline_payload",
    githubMock.state.inlineComments === 1 &&
      githubMock.state.lastInline?.path === "src/app.ts" &&
      githubMock.state.lastInline?.line === 42 &&
      githubMock.state.lastInline?.start_line === 40 &&
      githubMock.state.lastInline?.start_side === "RIGHT" &&
      // GitHub requires commit_id whenever line is used; it is resolved from the PR head.
      githubMock.state.lastInline?.commit_id ===
        "0123456789abcdef0123456789abcdef01234567",
    githubMock.state.lastInline,
  );

  // An explicit commit_id must be honoured (anchoring to an older revision).
  const prInlineCommit = asEnvelope(
    await call("pr_comment", {
      pr: 7,
      body: "explicit anchor",
      path: "src/app.ts",
      line: 10,
      commit_id: "feedfacefeedfacefeedfacefeedfacefeedface",
    }),
  );
  check(
    "pr_comment_inline_explicit_commit",
    prInlineCommit.ok === true &&
      prInlineCommit.data?.commit_id ===
        "feedfacefeedfacefeedfacefeedfacefeedface" &&
      githubMock.state.inlineComments === 2 &&
      githubMock.state.lastInline?.commit_id ===
        "feedfacefeedfacefeedfacefeedfacefeedface",
    { data: prInlineCommit.data, lastInline: githubMock.state.lastInline },
  );
  const prInlineNoLine = asEnvelope(
    await call("pr_comment", {
      pr: 7,
      body: "no anchor",
      path: "src/app.ts",
    }),
  );
  check(
    "pr_comment_inline_requires_line",
    prInlineNoLine.error?.code === "invalid_request",
    prInlineNoLine,
  );
  const prLineNoPath = asEnvelope(
    await call("pr_comment", { pr: 7, body: "no file", line: 42 }),
  );
  check(
    "pr_comment_line_requires_path",
    prLineNoPath.error?.code === "invalid_request",
    prLineNoPath,
  );

  const prMerge = asEnvelope(
    await call("pr_merge", {
      pr: 7,
      method: "squash",
      delete_branch: 1,
      reason: "VERIFY_PROVIDER_REASON",
    }),
  );
  check(
    "pr_merge",
    prMerge.ok === true &&
      prMerge.data?.merged === true &&
      prMerge.data?.sha === "sha-merge" &&
      prMerge.data?.method === "squash",
    prMerge,
  );
  check(
    "pr_merge_deletes_branch",
    prMerge.data?.branch_deleted === true &&
      githubMock.state.branchDeletes === 1,
    {
      state: githubMock.state,
    },
  );

  const prMissing = asEnvelope(await call("pr_merge", { pr: 999 }));
  check("pr_merge_not_found", prMissing.error?.code === "not_found", prMissing);

  const prList = asEnvelope(
    await call("pr_list", { state: "open", limit: 5 }),
  );
  check(
    "pr_list",
    prList.ok === true &&
      prList.kind === "pr_list" &&
      prList.data?.provider === "github" &&
      prList.data?.prs?.length === 2 &&
      prList.data?.prs?.[0]?.number === 7 &&
      prList.data?.prs?.[0]?.head === "verify-branch",
    prList,
  );
  let prListBadState: { error?: { code?: string } };
  try {
    prListBadState = asEnvelope(
      await call("pr_list", { state: "bogus" }),
    );
  } catch (e) {
    prListBadState = { error: { code: "invalid_request" } };
  }
  check(
    "pr_list_state_validated",
    prListBadState.error?.code === "invalid_request",
    prListBadState,
  );

  const prClose = asEnvelope(await call("pr_close", { pr: 7 }));
  check(
    "pr_close",
    prClose.ok === true &&
      prClose.data?.state === "closed" &&
      prClose.data?.closed === true &&
      githubMock.state.closes === 1,
    prClose,
  );
  const prReopen = asEnvelope(await call("pr_reopen", { pr: 7 }));
  check(
    "pr_reopen",
    prReopen.ok === true &&
      prReopen.data?.state === "open" &&
      prReopen.data?.reopened === true &&
      githubMock.state.reopens === 1,
    prReopen,
  );

  const ciList = asEnvelope(await call("ci_status", { limit: 3 }));
  check(
    "ci_status_list",
    ciList.ok === true &&
      ciList.data?.runs?.length === 2 &&
      ciList.data?.overall === "failure",
    ciList.data,
  );
  const ciRun = asEnvelope(await call("ci_status", { run_id: 99 }));
  check(
    "ci_status_run_with_jobs",
    ciRun.ok === true &&
      ciRun.data?.run?.id === 99 &&
      ciRun.data?.jobs?.length === 2 &&
      ciRun.data?.overall === "failure",
    ciRun.data,
  );

  // Branch-protection check-runs (ref → check-runs API; pr → head sha first).
  const ciChecks = asEnvelope(
    await call("ci_status", { ref: "verify-branch", limit: 2 }),
  );
  check(
    "ci_status_check_runs",
    ciChecks.ok === true &&
      ciChecks.data?.source === "check-runs" &&
      ciChecks.data?.check_runs?.length === 2 &&
      ciChecks.data?.check_runs?.[1]?.conclusion === "failure" &&
      ciChecks.data?.overall === "failure",
    ciChecks.data,
  );
  const ciChecksPr = asEnvelope(await call("ci_status", { pr: 7 }));
  check(
    "ci_status_check_runs_for_pr",
    ciChecksPr.ok === true &&
      ciChecksPr.data?.pr === 7 &&
      String(ciChecksPr.data?.ref ?? "").startsWith("0123456789ab") &&
      ciChecksPr.data?.check_runs_total === 2,
    ciChecksPr.data,
  );
  const ciChecksBadRef = asEnvelope(
    await call("ci_status", { ref: "../etc/passwd" }),
  );
  check(
    "ci_status_ref_validated",
    ciChecksBadRef.error?.code === "invalid_request",
    ciChecksBadRef,
  );
  const ciTrigger = asEnvelope(
    await call("ci_trigger", {
      workflow: "ci.yml",
      ref: "main",
      inputs: { suite: "full", retries: 1 },
    }),
  );
  check(
    "ci_trigger",
    ciTrigger.ok === true &&
      ciTrigger.data?.triggered === true &&
      ciTrigger.data?.inputs?.suite === "full" &&
      githubMock.state.dispatches === 1,
    ciTrigger,
  );

  console.log("[verify] checking CI control...");
  const ciCancel = asEnvelope(
    await call("ci_control", {
      action: "cancel",
      run_id: 99,
      reason: "stop stale test run",
    }),
  );
  check(
    "github_ci_cancel_accepted",
    ciCancel.ok === true &&
      ciCancel.data?.action === "cancel" &&
      ciCancel.data?.run_id === "99" &&
      ciCancel.data?.request_submitted === true &&
      githubMock.state.ciCancels === 1 &&
      !JSON.stringify(ciCancel).includes("verify-github-token"),
    ciCancel,
  );
  const ciRetryFailed = asEnvelope(
    await call("ci_control", {
      action: "retry_failed",
      run_id: "99",
      reason: "retry transient test failure",
    }),
  );
  check(
    "github_ci_retry_failed_accepted",
    ciRetryFailed.ok === true &&
      ciRetryFailed.data?.action === "retry_failed" &&
      ciRetryFailed.data?.run_id === "99" &&
      ciRetryFailed.data?.request_submitted === true &&
      githubMock.state.ciRetries === 1,
    ciRetryFailed,
  );

  async function ciControlRejected(
    args: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const raw = (await call("ci_control", args)) as {
        isError?: boolean;
      };
      const envelope = asEnvelope(raw);
      return raw.isError === true || envelope.ok === false;
    } catch {
      return true;
    }
  }
  const invalidCiControlBefore =
    githubMock.state.ciCancels +
    githubMock.state.ciRetries +
    githubMock.state.ciPostFailures;
  const ciBadAction = await ciControlRejected({
    action: "force",
    run_id: 99,
    reason: "test",
  });
  const ciMissingRun = await ciControlRejected({
    action: "cancel",
    reason: "test",
  });
  const ciMissingReason = await ciControlRejected({
    action: "cancel",
    run_id: 99,
  });
  const ciBlankReason = await ciControlRejected({
    action: "cancel",
    run_id: 99,
    reason: "   ",
  });
  const ciPathRun = asEnvelope(
    await call("ci_control", {
      action: "cancel",
      run_id: "../99/cancel",
      reason: "reject path-like run id",
    }),
  );
  const ciUnsafeRun = asEnvelope(
    await call("ci_control", {
      action: "cancel",
      run_id: String(Number.MAX_SAFE_INTEGER + 1),
      reason: "reject unsafe numeric run id",
    }),
  );
  const ciLongRun = await ciControlRejected({
    action: "cancel",
    run_id: "9".repeat(81),
    reason: "reject oversized id",
  });
  check(
    "ci_control_invalid_inputs_rejected_without_network",
    ciBadAction &&
      ciMissingRun &&
      ciMissingReason &&
      ciBlankReason &&
      ciLongRun &&
      ciPathRun.error?.code === "invalid_request" &&
      ciUnsafeRun.error?.code === "invalid_request" &&
      githubMock.state.ciCancels +
        githubMock.state.ciRetries +
        githubMock.state.ciPostFailures ===
        invalidCiControlBefore,
    {
      ciBadAction,
      ciMissingRun,
      ciMissingReason,
      ciBlankReason,
      ciPathRun,
      ciUnsafeRun,
      ciLongRun,
    },
  );

  const ciPostFailure = asEnvelope(
    await call("ci_control", {
      action: "cancel",
      run_id: 500,
      reason: "verify failed POST is not replayed",
    }),
  );
  check(
    "ci_control_post_failure_not_retried",
    ciPostFailure.ok === false &&
      githubMock.state.ciPostFailures === 1 &&
      githubMock.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path === "/repos/acme/demo/actions/runs/500/cancel",
      ).length === 1,
    { error: ciPostFailure.error, requests: githubMock.state.ciPostFailures },
  );

  const ciLogs = asEnvelope(await call("ci_logs", { run_id: 99 }));
  check(
    "ci_logs_run_zip",
    ciLogs.ok === true &&
      ciLogs.data?.entries?.length === 2 &&
      String(ciLogs.data?.text ?? "").includes("FAIL src/demo.test.ts:42") &&
      ciLogs.data?.truncated === false,
    { entries: ciLogs.data?.entries, truncated: ciLogs.data?.truncated },
  );
  const ciLogsTail = asEnvelope(
    await call("ci_logs", { run_id: 99, tail_lines: 1 }),
  );
  check(
    "ci_logs_tail_lines",
    String(ciLogsTail.data?.text ?? "").trim() ===
      "Test run finished with 1 failed" && ciLogsTail.data?.truncated === true,
    { text: ciLogsTail.data?.text, truncated: ciLogsTail.data?.truncated },
  );
  const ciJobLogs = asEnvelope(
    await call("ci_logs", { job_id: 1, tail_lines: 3 }),
  );
  check(
    "ci_logs_job",
    ciJobLogs.ok === true &&
      String(ciJobLogs.data?.text ?? "").includes("FAIL demo.test.ts:42"),
    ciJobLogs.data?.text,
  );
  check(
    "ci_logs_redirect_drops_auth",
    githubMock.blobAuth.length === 3 &&
      githubMock.blobAuth.every((auth) => auth === null),
    githubMock.blobAuth,
  );

  // 11d-bis. ci_wait: terminal, transition, timeout, selector validation.
  console.log("[verify] checking ci_wait...");
  const ciWaitTerminal = asEnvelope(
    await call("ci_wait", { run_id: 99 }),
  );
  check(
    "ci_wait_terminal_failure_tail",
    ciWaitTerminal.ok === true &&
      ciWaitTerminal.data?.terminal === true &&
      ciWaitTerminal.data?.overall === "failure" &&
      ciWaitTerminal.data?.polls === 1 &&
      String(ciWaitTerminal.data?.failure_tail?.text ?? "").includes(
        "FAIL demo.test.ts:42",
      ),
    {
      overall: ciWaitTerminal.data?.overall,
      polls: ciWaitTerminal.data?.polls,
      tail: ciWaitTerminal.data?.failure_tail,
    },
  );
  const ciWaitTransition = asEnvelope(
    await call("ci_wait", {
      run_id: 100,
      timeout_s: 10,
      interval_s: 2,
    }),
  );
  check(
    "ci_wait_reaches_terminal",
    ciWaitTransition.ok === true &&
      ciWaitTransition.data?.terminal === true &&
      ciWaitTransition.data?.overall === "success" &&
      ciWaitTransition.data?.changed === true &&
      Number(ciWaitTransition.data?.polls) >= 2,
    {
      overall: ciWaitTransition.data?.overall,
      changed: ciWaitTransition.data?.changed,
      polls: ciWaitTransition.data?.polls,
    },
  );
  const ciWaitTimeout = asEnvelope(
    await call("ci_wait", {
      run_id: 101,
      timeout_s: 2.5,
      interval_s: 2,
    }),
  );
  check(
    "ci_wait_timeout_returns_state",
    ciWaitTimeout.ok === true &&
      ciWaitTimeout.data?.terminal === false &&
      ciWaitTimeout.data?.overall === "in_progress" &&
      Number(ciWaitTimeout.data?.waited_ms) >= 2000 &&
      Number(ciWaitTimeout.data?.polls) >= 2,
    {
      overall: ciWaitTimeout.data?.overall,
      waited_ms: ciWaitTimeout.data?.waited_ms,
      polls: ciWaitTimeout.data?.polls,
    },
  );
  const ciWaitNoSelector = asEnvelope(await call("ci_wait", {}));
  check(
    "ci_wait_requires_selector",
    ciWaitNoSelector.error?.code === "invalid_request",
    ciWaitNoSelector,
  );
  const ciWaitTwoSelectors = asEnvelope(
    await call("ci_wait", { run_id: 99, branch: "main" }),
  );
  check(
    "ci_wait_rejects_two_selectors",
    ciWaitTwoSelectors.error?.code === "invalid_request",
    ciWaitTwoSelectors,
  );
  // Phase 8 patch 1: ci_status rejects ambiguous selectors like ci_wait does
  // (no hidden precedence); 0 or 1 selector still works.
  for (const [label, selectors] of [
    ["run_id_ref", { run_id: 99, ref: "main" }],
    ["ref_pr", { ref: "main", pr: 1 }],
    ["pr_branch", { pr: 1, branch: "main" }],
  ] as const) {
    const ambiguous = asEnvelope(await call("ci_status", { ...selectors }));
    check(
      `ci_status_rejects_two_selectors_${label}`,
      ambiguous.error?.code === "invalid_request",
      ambiguous,
    );
  }
  const ciStatusNone = asEnvelope(await call("ci_status", {}));
  check("ci_status_accepts_no_selector", ciStatusNone.ok === true, ciStatusNone);
  const ciStatusOne = asEnvelope(await call("ci_status", { run_id: 99 }));
  check("ci_status_accepts_one_selector", ciStatusOne.ok === true, ciStatusOne);
  const waitAudit = asEnvelope(
    await call("read_audit", { operation: "ci_wait", limit: 50 }),
  );
  const completedWaits = (waitAudit.data?.rows ?? []).filter(
    (row: Record<string, unknown>) => row.outcome === "succeeded",
  );
  check(
    "ci_wait_audit_one_row_per_wait",
    waitAudit.ok === true && completedWaits.length === 3,
    { count: completedWaits.length, rows: waitAudit.data?.rows },
  );

  await runDependencyImpact($h);

  await runProviderDialects($h);
  return {};
}
