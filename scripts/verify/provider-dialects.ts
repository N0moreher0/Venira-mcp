import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { zipStored } from "../github-mock.js";
import { logBufferToText, skippedLogEntries } from "../../lib/git-common.js";
import type { Harness } from "./harness.js";

export async function runProviderDialects($h: Harness): Promise<void> {
  const { githubMock, gitlabMock, bitbucketMock, verifyEnv, check } = $h;
  // 11d-ter. Provider dialects: GitLab + Bitbucket Cloud against local mocks.
  console.log("[verify] checking gitlab/bitbucket dialects...");
  async function providerClient(extraEnv: Record<string, string>) {
    const providerTransport = new StdioClientTransport({
      command: "node",
      args: ["dist/server.js"],
      cwd: process.cwd(),
      env: verifyEnv(extraEnv, "full"),
      stderr: "pipe",
    });
    const providerClientInstance = new Client(
      { name: "verify-provider", version: "0.0.0" },
      { capabilities: {} },
    );
    await providerClientInstance.connect(providerTransport);
    return providerClientInstance;
  }
  const providerCall = async (
    target: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const raw = await target.callTool({ name, arguments: args });
    return JSON.parse(
      (raw as { content?: { text?: string }[] }).content?.[0]?.text ?? "{}",
    );
  };

  const gl = await providerClient({
    VENIRA_GIT_PROVIDER: "gitlab",
    VENIRA_GIT_API_URL: gitlabMock.apiUrl,
    VENIRA_GIT_REPO: "acme/demo",
    VENIRA_GIT_TOKEN: "verify-gitlab-token",
    VENIRA_GIT_RETRIES: "0",
  });
  const glCreate = await providerCall(gl, "pr_create", {
    title: "Add GitLab dialect",
    head: "verify-branch",
    body: "MR body",
  });
  check(
    "gitlab_pr_create",
    glCreate.ok === true &&
      glCreate.data?.provider === "gitlab" &&
      glCreate.data?.number === 11 &&
      glCreate.data?.base === "main",
    glCreate,
  );
  const glComment = await providerCall(gl, "pr_comment", {
    pr: 11,
    body: "LGTM from verify",
  });
  check(
    "gitlab_pr_comment",
    glComment.ok === true &&
      glComment.data?.comment_id === 501 &&
      gitlabMock.state.comments === 1,
    glComment,
  );
  const glInline = await providerCall(gl, "pr_comment", {
    pr: 11,
    body: "inline note",
    path: "src/app.ts",
    line: 42,
  });
  check(
    "gitlab_pr_comment_inline",
    glInline.ok === true &&
      glInline.data?.inline === true &&
      glInline.data?.commit_id === "head-sha" &&
      gitlabMock.state.lastInline?.position?.new_line === 42 &&
      gitlabMock.state.lastInline?.position?.position_type === "text",
    { data: glInline.data, position: gitlabMock.state.lastInline?.position },
  );
  const glList = await providerCall(gl, "pr_list", { state: "open" });
  check(
    "gitlab_pr_list",
    glList.ok === true &&
      glList.data?.provider === "gitlab" &&
      glList.data?.prs?.length === 1,
    glList,
  );
  const glClose = await providerCall(gl, "pr_close", { pr: 11 });
  check(
    "gitlab_pr_close",
    glClose.ok === true &&
      glClose.data?.state === "closed" &&
      gitlabMock.state.closes === 1,
    glClose,
  );
  const glReopen = await providerCall(gl, "pr_reopen", { pr: 11 });
  check(
    "gitlab_pr_reopen",
    glReopen.ok === true &&
      glReopen.data?.state === "open" &&
      gitlabMock.state.reopens === 1,
    glReopen,
  );
  const glMerge = await providerCall(gl, "pr_merge", {
    pr: 11,
    method: "squash",
    delete_branch: 1,
  });
  check(
    "gitlab_pr_merge",
    glMerge.ok === true &&
      glMerge.data?.merged === true &&
      glMerge.data?.sha === "gl-merge-sha",
    glMerge,
  );
  const glCi = await providerCall(gl, "ci_status", {
    ref: "verify-branch",
  });
  check(
    "gitlab_ci_status",
    glCi.ok === true &&
      glCi.data?.provider === "gitlab" &&
      glCi.data?.source === "pipelines" &&
      glCi.data?.overall === "failure" &&
      glCi.data?.runs?.[0]?.id === 77 &&
      glCi.data?.runs?.[1]?.id === 76 &&
      gitlabMock.requests.some((request) => request.path.includes("page=2")),
    glCi,
  );
  const glRun = await providerCall(gl, "ci_status", { run_id: 77 });
  check(
    "gitlab_ci_run",
    glRun.ok === true &&
      glRun.data?.run?.id === 77 &&
      glRun.data?.jobs?.length === 2 &&
      glRun.data?.overall === "failure",
    glRun,
  );
  const glTrigger = await providerCall(gl, "ci_trigger", {
    ref: "main",
    inputs: { suite: "full" },
  });
  check(
    "gitlab_ci_trigger",
    glTrigger.ok === true &&
      glTrigger.data?.triggered === true &&
      glTrigger.data?.pipeline_id === 78,
    glTrigger,
  );
  const glCancel = await providerCall(gl, "ci_control", {
    action: "cancel",
    run_id: "77",
    reason: "stop stale GitLab pipeline",
  });
  check(
    "gitlab_ci_cancel",
    glCancel.ok === true &&
      glCancel.data?.action === "cancel" &&
      glCancel.data?.run_id === "77" &&
      glCancel.data?.status === "completed" &&
      glCancel.data?.conclusion === "cancelled" &&
      gitlabMock.state.ciCancels === 1,
    glCancel,
  );
  const glRetry = await providerCall(gl, "ci_control", {
    action: "retry_failed",
    run_id: 77,
    reason: "retry transient GitLab jobs",
  });
  check(
    "gitlab_ci_retry_failed",
    glRetry.ok === true &&
      glRetry.data?.action === "retry_failed" &&
      glRetry.data?.pipeline_id === 78 &&
      glRetry.data?.status === "in_progress" &&
      gitlabMock.state.ciRetries === 1,
    glRetry,
  );
  const glBadRun = await providerCall(gl, "ci_control", {
    action: "cancel",
    run_id: "77/../88",
    reason: "reject malformed GitLab id",
  });
  check(
    "gitlab_ci_control_rejects_non_numeric_run_id",
    glBadRun.ok === false &&
      glBadRun.error?.code === "invalid_request" &&
      !gitlabMock.requests.some(
        (request) =>
          request.method === "POST" &&
          request.path.includes("/pipelines/77/../88/"),
      ),
    glBadRun,
  );
  const glJobLogs = await providerCall(gl, "ci_logs", { job_id: 7 });
  check(
    "gitlab_ci_logs_job",
    glJobLogs.ok === true &&
      String(glJobLogs.data?.text ?? "").includes("FAIL src/demo.test.ts:42"),
    glJobLogs.data?.text,
  );
  const glRunLogs = await providerCall(gl, "ci_logs", {
    run_id: 77,
    tail_lines: 2,
  });
  check(
    "gitlab_ci_logs_run",
    glRunLogs.ok === true &&
      String(glRunLogs.data?.text ?? "").includes("FAIL src/demo.test.ts:42") &&
      glRunLogs.data?.truncated === true,
    glRunLogs.data,
  );
  check(
    "gitlab_token_header",
    gitlabMock.requests.some(
      (request) =>
        request.path.includes("/merge_requests") &&
        request.privateToken === "verify-gitlab-token",
    ),
    gitlabMock.requests.slice(0, 3),
  );
  // E.5: provider failure mapping, Retry-After, token hygiene on redirects, and read-only retries.
  const glFaultCases: Array<{
    label: string;
    status: number;
    headers: Record<string, string>;
    code: string;
  }> = [
    { label: "401", status: 401, headers: {}, code: "auth_failed" },
    { label: "403", status: 403, headers: {}, code: "forbidden" },
    { label: "404", status: 404, headers: {}, code: "not_found" },
    {
      label: "429",
      status: 429,
      headers: { "Retry-After": "7" },
      code: "rate_limited",
    },
  ];
  const glPipelineHits = () =>
    gitlabMock.requests.filter((request) => request.path.includes("/pipelines"))
      .length;
  for (const faultCase of glFaultCases) {
    gitlabMock.state.fault = {
      status: faultCase.status,
      headers: faultCase.headers,
      remaining: 1,
    };
    const hitsBefore = glPipelineHits();
    const faulted = await providerCall(gl, "ci_status", {
      ref: `fault-${faultCase.label}`,
    });
    check(
      `gitlab_ci_error_${faultCase.label}`,
      faulted.ok === false &&
        faulted.error?.code === faultCase.code &&
        glPipelineHits() - hitsBefore === 1 &&
        !JSON.stringify(faulted).includes("verify-gitlab-token"),
      faulted,
    );
    if (faultCase.status === 429) {
      check(
        "gitlab_ci_rate_limit_retry_after_seconds",
        /retry after 7s/.test(String(faulted.hint ?? "")),
        { hint: faulted.hint, error: faulted.error },
      );
    }
  }
  gitlabMock.state.fault = null;
  const glRecovered = await providerCall(gl, "ci_status", {
    ref: "fault-recovered",
  });
  check(
    "gitlab_ci_recovers_after_faults",
    glRecovered.ok === true && glRecovered.data?.runs?.[0]?.id === 77,
    glRecovered,
  );

  // A cross-origin redirect must not carry the GitLab token to the new host.
  gitlabMock.state.fault = {
    status: 302,
    headers: { Location: `${bitbucketMock.apiUrl}/redirect-target` },
    remaining: 1,
    method: "GET",
  };
  const bbSeenBeforeRedirect = bitbucketMock.requests.length;
  const glRedirected = await providerCall(gl, "ci_status", {
    ref: "fault-redirect",
  });
  const redirectHit = bitbucketMock.requests
    .slice(bbSeenBeforeRedirect)
    .find((request) => request.path.endsWith("/redirect-target"));
  check(
    "gitlab_redirect_strips_private_token",
    redirectHit !== undefined &&
      redirectHit.privateToken === null &&
      redirectHit.auth === null,
    { redirectHit, error: glRedirected.error },
  );
  gitlabMock.state.fault = null;

  // Safe reads are retried after a 503; writes (POST) are never replayed.
  const glRetrying = await providerClient({
    VENIRA_GIT_PROVIDER: "gitlab",
    VENIRA_GIT_API_URL: gitlabMock.apiUrl,
    VENIRA_GIT_REPO: "acme/demo",
    VENIRA_GIT_TOKEN: "verify-gitlab-token",
    VENIRA_GIT_RETRIES: "2",
  });
  gitlabMock.state.fault = { status: 503, remaining: 1, method: "GET" };
  const glRetriedRead = await providerCall(glRetrying, "ci_status", {
    ref: "fault-retry-read",
  });
  check(
    "gitlab_ci_safe_read_retried_after_503",
    glRetriedRead.ok === true && gitlabMock.state.fault.remaining === 0,
    glRetriedRead,
  );
  gitlabMock.state.fault = { status: 503, remaining: 5, method: "POST" };
  const glCancelPosts = () =>
    gitlabMock.requests.filter(
      (request) =>
        request.method === "POST" && request.path.includes("/cancel"),
    ).length;
  const glCancelPostsBefore = glCancelPosts();
  const glFailedCancel = await providerCall(glRetrying, "ci_control", {
    action: "cancel",
    run_id: 77,
    reason: "verify POST is never replayed",
  });
  check(
    "gitlab_ci_control_post_not_replayed_on_503",
    glFailedCancel.ok === false &&
      glCancelPosts() - glCancelPostsBefore === 1 &&
      gitlabMock.state.ciCancels === 1,
    glFailedCancel,
  );
  gitlabMock.state.fault = null;
  await glRetrying.close();
  await gl.close();

  const bb = await providerClient({
    VENIRA_GIT_PROVIDER: "bitbucket",
    VENIRA_GIT_API_URL: bitbucketMock.apiUrl,
    VENIRA_GIT_REPO: "acme/demo",
    VENIRA_GIT_TOKEN: "verify-bb-token",
    VENIRA_GIT_USERNAME: "bot",
    VENIRA_GIT_RETRIES: "0",
  });
  const bbCreate = await providerCall(bb, "pr_create", {
    title: "Add Bitbucket dialect",
    head: "verify-branch",
  });
  check(
    "bitbucket_pr_create",
    bbCreate.ok === true &&
      bbCreate.data?.provider === "bitbucket" &&
      bbCreate.data?.number === 21 &&
      bbCreate.data?.base === "main",
    bbCreate,
  );
  const bbComment = await providerCall(bb, "pr_comment", {
    pr: 21,
    body: "LGTM from verify",
  });
  check(
    "bitbucket_pr_comment",
    bbComment.ok === true && bbComment.data?.comment_id === 701,
    bbComment,
  );
  const bbInline = await providerCall(bb, "pr_comment", {
    pr: 21,
    body: "inline",
    path: "src/app.ts",
    line: 9,
  });
  check(
    "bitbucket_pr_comment_inline",
    bbInline.ok === true &&
      bbInline.data?.inline === true &&
      bitbucketMock.state.lastInline?.to === 9 &&
      bitbucketMock.state.lastInline?.path === "src/app.ts",
    { data: bbInline.data, inline: bitbucketMock.state.lastInline },
  );
  const bbList = await providerCall(bb, "pr_list", { state: "open" });
  check(
    "bitbucket_pr_list",
    bbList.ok === true &&
      bbList.data?.prs?.length === 1 &&
      bbList.data?.provider === "bitbucket",
    bbList,
  );
  const bbClose = await providerCall(bb, "pr_close", { pr: 21 });
  check(
    "bitbucket_pr_close",
    bbClose.ok === true &&
      bbClose.data?.state === "closed" &&
      bitbucketMock.state.declines === 1,
    bbClose,
  );
  const bbReopen = await providerCall(bb, "pr_reopen", { pr: 21 });
  check(
    "bitbucket_pr_reopen_unsupported",
    bbReopen.ok === false && bbReopen.error?.code === "unsupported",
    bbReopen,
  );
  const bbMerge = await providerCall(bb, "pr_merge", {
    pr: 21,
    method: "squash",
    delete_branch: 1,
  });
  check(
    "bitbucket_pr_merge",
    bbMerge.ok === true &&
      bbMerge.data?.merged === true &&
      bbMerge.data?.sha === "bb-merge-sha",
    bbMerge,
  );
  const bbCi = await providerCall(bb, "ci_status", {
    ref: "verify-branch",
  });
  check(
    "bitbucket_ci_status",
    bbCi.ok === true &&
      bbCi.data?.source === "pipelines" &&
      bbCi.data?.overall === "failure" &&
      bbCi.data?.runs?.[0]?.id === "{pipeline-1}",
    bbCi,
  );
  const bbRun = await providerCall(bb, "ci_status", {
    run_id: "{pipeline-1}",
  });
  check(
    "bitbucket_ci_run",
    bbRun.ok === true &&
      bbRun.data?.jobs?.length === 1 &&
      bbRun.data?.overall === "failure",
    bbRun,
  );
  const bbTrigger = await providerCall(bb, "ci_trigger", {
    ref: "main",
  });
  check(
    "bitbucket_ci_trigger",
    bbTrigger.ok === true &&
      bbTrigger.data?.triggered === true &&
      bbTrigger.data?.workflow === "default",
    bbTrigger,
  );
  const bbCancel = await providerCall(bb, "ci_control", {
    action: "cancel",
    run_id: "{pipeline-1}",
    reason: "stop stale Bitbucket pipeline",
  });
  check(
    "bitbucket_ci_cancel_204",
    bbCancel.ok === true &&
      bbCancel.data?.action === "cancel" &&
      bbCancel.data?.run_id === "{pipeline-1}" &&
      bbCancel.data?.request_submitted === true &&
      bitbucketMock.state.ciStops === 1,
    bbCancel,
  );
  const bbRequestsBeforeUnsupportedRetry = bitbucketMock.requests.length;
  const bbRetryUnsupported = await providerCall(bb, "ci_control", {
    action: "retry_failed",
    run_id: "{pipeline-1}",
    reason: "retry failed step",
  });
  check(
    "bitbucket_ci_retry_explicitly_unsupported",
    bbRetryUnsupported.ok === false &&
      bbRetryUnsupported.error?.code === "unsupported" &&
      bitbucketMock.requests.length === bbRequestsBeforeUnsupportedRetry,
    bbRetryUnsupported,
  );
  const bbBadUuid = await providerCall(bb, "ci_control", {
    action: "cancel",
    run_id: "{x}",
    reason: "reject malformed Bitbucket UUID",
  });
  check(
    "bitbucket_ci_control_rejects_short_uuid",
    bbBadUuid.ok === false &&
      bbBadUuid.error?.code === "invalid_request" &&
      bitbucketMock.state.ciStops === 1,
    bbBadUuid,
  );
  const bbStepId = String(
    (bbRun.data?.jobs?.[0] as { id?: unknown } | undefined)?.id ?? "{step-1}",
  );
  const bbLogs = await providerCall(bb, "ci_logs", {
    run_id: "{pipeline-1}",
    job_id: bbStepId,
  });
  check(
    "bitbucket_ci_logs_step",
    bbLogs.ok === true &&
      String(bbLogs.data?.text ?? "").includes("FAIL demo.test.ts:42"),
    bbLogs.data?.text,
  );
  check(
    "bitbucket_basic_auth",
    bitbucketMock.requests.some(
      (request) =>
        request.path.includes("/pullrequests") &&
        request.auth ===
          `Basic ${Buffer.from("bot:verify-bb-token").toString("base64")}`,
    ),
    bitbucketMock.requests.slice(0, 2).map((r) => r.auth),
  );
  // E.5: Bitbucket failure mapping + Retry-After as an HTTP-date.
  const bbFaultCases: Array<{
    label: string;
    status: number;
    headers: Record<string, string>;
    code: string;
  }> = [
    { label: "401", status: 401, headers: {}, code: "auth_failed" },
    { label: "403", status: 403, headers: {}, code: "forbidden" },
    { label: "404", status: 404, headers: {}, code: "not_found" },
    {
      label: "429",
      status: 429,
      headers: { "Retry-After": new Date(Date.now() + 30_000).toUTCString() },
      code: "rate_limited",
    },
  ];
  const bbPipelineHits = () =>
    bitbucketMock.requests.filter((request) =>
      request.path.includes("/pipelines"),
    ).length;
  for (const faultCase of bbFaultCases) {
    bitbucketMock.state.fault = {
      status: faultCase.status,
      headers: faultCase.headers,
      remaining: 1,
    };
    const hitsBefore = bbPipelineHits();
    const faulted = await providerCall(bb, "ci_status", {
      ref: `fault-${faultCase.label}`,
    });
    check(
      `bitbucket_ci_error_${faultCase.label}`,
      faulted.ok === false &&
        faulted.error?.code === faultCase.code &&
        bbPipelineHits() - hitsBefore === 1 &&
        !JSON.stringify(faulted).includes("verify-bb-token"),
      faulted,
    );
    if (faultCase.status === 429) {
      check(
        "bitbucket_ci_rate_limit_retry_after_http_date",
        /retry after (2[5-9]|30)s/.test(String(faulted.hint ?? "")),
        { hint: faulted.hint, error: faulted.error },
      );
    }
  }
  bitbucketMock.state.fault = null;
  const bbRecovered = await providerCall(bb, "ci_status", {
    ref: "fault-recovered",
  });
  check(
    "bitbucket_ci_recovers_after_faults",
    bbRecovered.ok === true &&
      bbRecovered.data?.runs?.[0]?.id === "{pipeline-1}",
    bbRecovered,
  );

  // E.3: Bitbucket body-`next` pagination, real COMPLETED+result state shape, failing step first in logs.
  console.log(
    "[verify] checking E.3 bitbucket pagination + failing-step logs...",
  );
  const bbPagedRun = await providerCall(bb, "ci_status", {
    run_id: "{pipeline-paged}",
  });
  check(
    "bitbucket_ci_steps_paginated_via_body_next",
    bbPagedRun.ok === true &&
      bbPagedRun.data?.jobs_total === 3 &&
      bbPagedRun.data?.jobs?.length === 3 &&
      bbPagedRun.data?.jobs?.[2]?.id === "{step-red-0003}" &&
      bbPagedRun.data?.jobs?.[2]?.conclusion === "failure" &&
      bbPagedRun.data?.partial === undefined,
    bbPagedRun,
  );
  check(
    "bitbucket_ci_real_state_shape_failure_is_not_green",
    bbPagedRun.data?.overall === "failure" &&
      bbPagedRun.data?.run?.conclusion === "failure" &&
      bbPagedRun.data?.jobs?.[0]?.conclusion === "success",
    bbPagedRun.data,
  );
  const bbPagedLogs = await providerCall(bb, "ci_logs", {
    run_id: "{pipeline-paged}",
  });
  check(
    "bitbucket_ci_logs_pick_failing_step_first",
    bbPagedLogs.ok === true &&
      String(bbPagedLogs.data?.text ?? "").includes("RED-FAIL-LINE") &&
      !String(bbPagedLogs.data?.text ?? "").includes("green-log") &&
      bbPagedLogs.data?.skipped_entries === 1 &&
      bbPagedLogs.data?.truncated === true,
    bbPagedLogs,
  );
  check(
    "bitbucket_ci_steps_second_page_requested",
    bitbucketMock.requests.filter((request) =>
      request.path.endsWith("{pipeline-paged}/steps"),
    ).length >= 2,
    bitbucketMock.requests
      .filter((request) => request.path.includes("{pipeline-paged}"))
      .map((request) => request.path),
  );

  // E.4: ci_wait gives one concise summary + next step, and reads the failing Bitbucket step (UUID job id).
  console.log("[verify] checking E.4 ci_wait summary + failing-step tail...");
  const bbWait = await providerCall(bb, "ci_wait", {
    run_id: "{pipeline-paged}",
    timeout_ms: 5000,
  });
  check(
    "ci_wait_summary_and_next_step_on_failure",
    bbWait.ok === true &&
      bbWait.data?.terminal === true &&
      bbWait.data?.overall === "failure" &&
      typeof bbWait.data?.summary === "string" &&
      /failed/i.test(bbWait.data.summary) &&
      bbWait.data.summary.includes("test") &&
      bbWait.data?.next_step === "fix_failing_step_then_push" &&
      bbWait.data?.failing_jobs?.[0]?.id === "{step-red-0003}",
    bbWait.data,
  );
  check(
    "ci_wait_bitbucket_uuid_job_tail_is_failing_step_only",
    bbWait.data?.failure_tail?.job_id === "{step-red-0003}" &&
      String(bbWait.data?.failure_tail?.text ?? "").includes("RED-FAIL-LINE") &&
      !String(bbWait.data?.failure_tail?.text ?? "").includes("green-log"),
    bbWait.data?.failure_tail,
  );
  // Roadmap item 15 (P1): the summary, the list and the counters must agree.
  const bbFailing = (bbWait.data?.failing_jobs ?? []) as Array<{ id?: unknown }>;
  const bbFailingTotal = Number(bbWait.data?.failing_jobs_total ?? 0);
  check(
    "ci_wait_failing_job_counts_agree",
    bbFailing.length > 0 &&
      bbFailing.length === Math.min(bbFailingTotal, 5) &&
      bbWait.data?.failing_jobs_shown === bbFailing.length &&
      // The summary names the same jobs the list shows (same cap, same count).
      !new RegExp(`\\+\\s*${bbFailingTotal - bbFailing.length}\\s+more`).test(String(bbWait.data?.summary ?? "")),
    {
      failing: bbFailing.length,
      total: bbFailingTotal,
      shown: bbWait.data?.failing_jobs_shown,
      summary: bbWait.data?.summary,
    },
  );
  check(
    "ci_wait_does_not_duplicate_the_job_list",
    bbWait.data?.ci_status !== undefined &&
      (bbWait.data?.ci_status as { jobs?: unknown })?.jobs === undefined &&
      (bbWait.data?.ci_status as { check_runs?: unknown })?.check_runs === undefined,
    bbWait.data?.ci_status,
  );

  // E.3: GitHub bounded pagination + oversized logs (small caps so the fixtures stay tiny).
  console.log("[verify] checking E.3 github pagination + oversized logs...");
  const gh = await providerClient({
    VENIRA_GIT_PROVIDER: "github",
    VENIRA_GIT_API_URL: githubMock.apiUrl,
    VENIRA_GIT_REPO: "acme/demo",
    VENIRA_GIT_TOKEN: "verify-github-token",
    VENIRA_GIT_RETRIES: "0",
    VENIRA_GIT_LOG_ZIP_BYTES: "4096",
    VENIRA_GIT_LOG_ENTRY_BYTES: "2048",
    VENIRA_GIT_LOG_TIMEOUT_MS: "5000",
  });
  const ghPaged = await providerCall(gh, "ci_status", {
    ref: "paged-checks",
  });
  check(
    "github_ci_check_runs_paginated_overall_sees_page2",
    ghPaged.ok === true &&
      ghPaged.data?.overall === "failure" &&
      ghPaged.data?.check_runs_total === 130 &&
      ghPaged.data?.check_runs?.length === 20 &&
      ghPaged.data?.check_runs?.[0]?.conclusion === "failure" &&
      ghPaged.data?.partial === undefined,
    ghPaged,
  );
  const ghJobs = await providerCall(gh, "ci_status", { run_id: 300 });
  check(
    "github_ci_jobs_paginated_failure_on_page2",
    ghJobs.ok === true &&
      ghJobs.data?.jobs_total === 120 &&
      ghJobs.data?.jobs?.length === 50 &&
      ghJobs.data?.jobs?.[0]?.name === "matrix-117" &&
      ghJobs.data?.jobs?.[0]?.conclusion === "failure" &&
      ghJobs.data?.partial === undefined,
    ghJobs,
  );
  const endlessHits = () =>
    githubMock.requests.filter((request) =>
      request.path.includes("/commits/endless-checks/check-runs"),
    ).length;
  const endlessBefore = endlessHits();
  const ghEndless = await providerCall(gh, "ci_status", {
    ref: "endless-checks",
  });
  check(
    "github_ci_pagination_is_bounded",
    ghEndless.ok === true &&
      ghEndless.data?.partial === true &&
      endlessHits() - endlessBefore === 5 &&
      String(ghEndless.hint ?? "").includes("incomplete"),
    {
      hits: endlessHits() - endlessBefore,
      partial: ghEndless.data?.partial,
      hint: ghEndless.hint,
    },
  );
  const blobHitsBefore = githubMock.blobAuth.length;
  const ghForeign = await providerCall(gh, "ci_status", {
    ref: "foreign-next",
  });
  check(
    "github_ci_pagination_never_follows_cross_origin_next",
    ghForeign.ok === true &&
      ghForeign.data?.check_runs?.length === 1 &&
      githubMock.blobAuth.length === blobHitsBefore,
    {
      blobHits: githubMock.blobAuth.length - blobHitsBefore,
      data: ghForeign.data,
    },
  );
  const hugeStart = Date.now();
  const ghHugeDeclared = await providerCall(gh, "ci_logs", {
    run_id: 302,
  });
  check(
    "github_ci_logs_oversized_declared_aborts_early",
    ghHugeDeclared.ok === false &&
      ghHugeDeclared.error?.code === "resource_limit" &&
      Date.now() - hugeStart < 4000 &&
      JSON.stringify(ghHugeDeclared).includes("VENIRA_GIT_LOG_ZIP_BYTES"),
    { ms: Date.now() - hugeStart, response: ghHugeDeclared },
  );
  const chunkedStart = Date.now();
  const ghHugeChunked = await providerCall(gh, "ci_logs", {
    run_id: 303,
  });
  check(
    "github_ci_logs_oversized_stream_aborts_early",
    ghHugeChunked.ok === false &&
      ghHugeChunked.error?.code === "resource_limit" &&
      Date.now() - chunkedStart < 4000,
    { ms: Date.now() - chunkedStart, response: ghHugeChunked },
  );
  const ghSkipped = await providerCall(gh, "ci_logs", { run_id: 304 });
  check(
    "github_ci_logs_skipped_entries_are_reported",
    ghSkipped.ok === true &&
      ghSkipped.data?.skipped_entries === 1 &&
      ghSkipped.data?.truncated === true &&
      String(ghSkipped.data?.text ?? "").includes("BUILD finished") &&
      JSON.stringify(ghSkipped.data?.entries ?? []).includes(
        "entry too large",
      ) &&
      /skipped/.test(String(ghSkipped.hint ?? "")),
    ghSkipped,
  );
  await gh.close();

  // E.3: cumulative inflate budget + output cap are reported, not silent.
  const budgetZip = zipStored([
    { name: "a.txt", data: Buffer.alloc(1000, "a") },
    { name: "b.txt", data: Buffer.alloc(1000, "b") },
    { name: "c.txt", data: Buffer.alloc(1000, "c") },
  ]);
  const budgetParsed = logBufferToText(budgetZip, "budget", 2048, 1500);
  const budgetSkips = skippedLogEntries(budgetParsed.entries);
  check(
    "log_zip_inflate_budget_and_output_cap_reported",
    budgetParsed.entries.length === 3 &&
      budgetSkips.count === 2 &&
      budgetParsed.entries[1]?.skipped === "output cap" &&
      String(budgetParsed.entries[2]?.skipped ?? "").includes(
        "inflate budget",
      ) &&
      Buffer.byteLength(budgetParsed.text, "utf8") <= 1500 &&
      !!budgetSkips.hint,
    budgetParsed.entries,
  );
  await bb.close();

}
