/** Verify section module: github-ci. Behaviour is unchanged from the original scripts/verify.ts. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { zipStored } from "../github-mock.js";
import { logBufferToText, skippedLogEntries } from "../../lib/git-common.js";
import { rankCandidates } from "../../lib/read-plan.js";
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
    await call("project_pr_create", {
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
    await call("project_pr_comment", { pr: 7, body: "LGTM from verify" }),
  );
  check(
    "pr_comment",
    prComment.ok === true &&
      prComment.data?.comment_id === 1001 &&
      prComment.data?.pr === 7,
    prComment,
  );
  const prCommentUrl = asEnvelope(
    await call("project_pr_comment", {
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
    await call("project_pr_comment", {
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
    await call("project_pr_comment", {
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
    await call("project_pr_comment", {
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
    await call("project_pr_comment", { pr: 7, body: "no file", line: 42 }),
  );
  check(
    "pr_comment_line_requires_path",
    prLineNoPath.error?.code === "invalid_request",
    prLineNoPath,
  );

  const prMerge = asEnvelope(
    await call("project_pr_merge", {
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

  const prMissing = asEnvelope(await call("project_pr_merge", { pr: 999 }));
  check("pr_merge_not_found", prMissing.error?.code === "not_found", prMissing);

  const prList = asEnvelope(
    await call("project_pr_list", { state: "open", limit: 5 }),
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
      await call("project_pr_list", { state: "bogus" }),
    );
  } catch (e) {
    prListBadState = { error: { code: "invalid_request" } };
  }
  check(
    "pr_list_state_validated",
    prListBadState.error?.code === "invalid_request",
    prListBadState,
  );

  const prClose = asEnvelope(await call("project_pr_close", { pr: 7 }));
  check(
    "pr_close",
    prClose.ok === true &&
      prClose.data?.state === "closed" &&
      prClose.data?.closed === true &&
      githubMock.state.closes === 1,
    prClose,
  );
  const prReopen = asEnvelope(await call("project_pr_reopen", { pr: 7 }));
  check(
    "pr_reopen",
    prReopen.ok === true &&
      prReopen.data?.state === "open" &&
      prReopen.data?.reopened === true &&
      githubMock.state.reopens === 1,
    prReopen,
  );

  const ciList = asEnvelope(await call("project_ci_status", { limit: 3 }));
  check(
    "ci_status_list",
    ciList.ok === true &&
      ciList.data?.runs?.length === 2 &&
      ciList.data?.overall === "failure",
    ciList.data,
  );
  const ciRun = asEnvelope(await call("project_ci_status", { run_id: 99 }));
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
    await call("project_ci_status", { ref: "verify-branch", limit: 2 }),
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
  const ciChecksPr = asEnvelope(await call("project_ci_status", { pr: 7 }));
  check(
    "ci_status_check_runs_for_pr",
    ciChecksPr.ok === true &&
      ciChecksPr.data?.pr === 7 &&
      String(ciChecksPr.data?.ref ?? "").startsWith("0123456789ab") &&
      ciChecksPr.data?.check_runs_total === 2,
    ciChecksPr.data,
  );
  const ciChecksBadRef = asEnvelope(
    await call("project_ci_status", { ref: "../etc/passwd" }),
  );
  check(
    "ci_status_ref_validated",
    ciChecksBadRef.error?.code === "invalid_request",
    ciChecksBadRef,
  );
  const ciTrigger = asEnvelope(
    await call("project_ci_trigger", {
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
    await call("project_ci_control", {
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
    await call("project_ci_control", {
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
      const raw = (await call("project_ci_control", args)) as {
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
    await call("project_ci_control", {
      action: "cancel",
      run_id: "../99/cancel",
      reason: "reject path-like run id",
    }),
  );
  const ciUnsafeRun = asEnvelope(
    await call("project_ci_control", {
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
    await call("project_ci_control", {
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

  const ciLogs = asEnvelope(await call("project_ci_logs", { run_id: 99 }));
  check(
    "ci_logs_run_zip",
    ciLogs.ok === true &&
      ciLogs.data?.entries?.length === 2 &&
      String(ciLogs.data?.text ?? "").includes("FAIL src/demo.test.ts:42") &&
      ciLogs.data?.truncated === false,
    { entries: ciLogs.data?.entries, truncated: ciLogs.data?.truncated },
  );
  const ciLogsTail = asEnvelope(
    await call("project_ci_logs", { run_id: 99, tail_lines: 1 }),
  );
  check(
    "ci_logs_tail_lines",
    String(ciLogsTail.data?.text ?? "").trim() ===
      "Test run finished with 1 failed" && ciLogsTail.data?.truncated === true,
    { text: ciLogsTail.data?.text, truncated: ciLogsTail.data?.truncated },
  );
  const ciJobLogs = asEnvelope(
    await call("project_ci_logs", { job_id: 1, tail_lines: 3 }),
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

  // 11d-bis. project_ci_wait: terminal, transition, timeout, selector validation.
  console.log("[verify] checking ci_wait...");
  const ciWaitTerminal = asEnvelope(
    await call("project_ci_wait", { run_id: 99 }),
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
    await call("project_ci_wait", {
      run_id: 100,
      timeout_ms: 10000,
      interval_ms: 2000,
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
    await call("project_ci_wait", {
      run_id: 101,
      timeout_ms: 2500,
      interval_ms: 2000,
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
  const ciWaitNoSelector = asEnvelope(await call("project_ci_wait", {}));
  check(
    "ci_wait_requires_selector",
    ciWaitNoSelector.error?.code === "invalid_request",
    ciWaitNoSelector,
  );
  const ciWaitTwoSelectors = asEnvelope(
    await call("project_ci_wait", { run_id: 99, branch: "main" }),
  );
  check(
    "ci_wait_rejects_two_selectors",
    ciWaitTwoSelectors.error?.code === "invalid_request",
    ciWaitTwoSelectors,
  );
  const waitAudit = asEnvelope(
    await call("project_read_audit", { operation: "ci_wait", limit: 50 }),
  );
  const completedWaits = (waitAudit.data?.rows ?? []).filter(
    (row: Record<string, unknown>) => row.outcome === "succeeded",
  );
  check(
    "ci_wait_audit_one_row_per_wait",
    waitAudit.ok === true && completedWaits.length === 3,
    { count: completedWaits.length, rows: waitAudit.data?.rows },
  );

  // 11d-ter. Dependency graph + change impact fixtures (written directly: no tool call needed).
  console.log("[verify] checking dependency graph + change impact...");
  const dgRoot = `${dir}/dg`;
  const dgPath = (rel: string) => `${dgRoot}/${rel}`;
  async function writeFixture(rel: string, text: string): Promise<void> {
    const abs = path.join(process.cwd(), dgRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
  }
  await writeFixture(
    "src/app.ts",
    'import { util } from "./lib/util";\nimport { re } from "./lib";\nconst dyn = () => import("./dynamic");\nimport { nope } from "./nope";\nexport function app() { return util(); }\n',
  );
  await writeFixture(
    "src/lib/util.ts",
    "export function util() { return 1; }\nexport class Base {}\n",
  );
  await writeFixture("src/lib/index.ts", 'export * from "./util";\n');
  await writeFixture("src/dynamic.ts", "export const d = 1;\n");
  await writeFixture(
    "src/cycle-a.ts",
    'import { b } from "./cycle-b";\nexport function a() { return b(); }\n',
  );
  await writeFixture(
    "src/cycle-b.ts",
    'import { a } from "./cycle-a";\nexport function b() { return a(); }\n',
  );
  await writeFixture(
    "src/lib/util.test.ts",
    'import { util } from "./util";\nit("x", () => util());\n',
  );
  await writeFixture(
    "src/child.ts",
    'import { Base } from "./lib/util";\nexport class Child extends Base {}\n',
  );
  await writeFixture("src/dup-a.ts", "export function dup() { return 1; }\n");
  await writeFixture("src/dup-b.ts", "export function dup() { return 2; }\n");
  await writeFixture(
    "src/use-dup.ts",
    'import { dup } from "./dup-a";\nexport const v = dup();\n',
  );
  await writeFixture(
    "src/.env.local.ts",
    'import { util } from "./lib/util";\nexport const secret = util();\n',
  );
  await writeFixture("pkg/__init__.py", "");
  await writeFixture("pkg/mod.py", "def thing():\n    return 1\n");
  await writeFixture(
    "pkg/main.py",
    "from .mod import thing\n\ndef main():\n    return thing()\n",
  );

  await writeFixture(
    "rust/cli/src/main.rs",
    `mod report;

use crate::report::run;

pub fn cli() {
    run();
}
`,
  );
  await writeFixture(
    "rust/cli/src/report.rs",
    `pub fn run() {
    println!("hello");
}
`,
  );
  await writeFixture(
    "rust/svc/src/main.rs",
    `mod util;
pub mod api;
extern crate serde;

use crate::util::fmt;
use super::api::Thing;

pub fn main() {}
`,
  );
  await writeFixture(
    "rust/svc/src/util.rs",
    `pub fn fmt() {}
`,
  );
  await writeFixture(
    "rust/svc/src/api/mod.rs",
    `pub struct Thing {}
`,
  );
  await writeFixture(
    "rust/orphan/src/main.rs",
    `use crate::missing::thing;

pub fn orphan() {}
`,
  );

  await writeFixture(
    "go.mod",
    `module example.com/verifyapp

go 1.21
`,
  );
  await writeFixture(
    "main.go",
    `package main

import (
	"fmt"
	"example.com/verifyapp/pkg/tool"
)

func main() {
	fmt.Println(tool.Primary())
}
`,
  );
  await writeFixture(
    "pkg/tool/tool.go",
    `package tool

func Primary() string {
	return "tool"
}
`,
  );
  await writeFixture(
    "pkg/tool/tool_test.go",
    `package tool

import "testing"

func TestPrimary(t *testing.T) {}
`,
  );

  await writeFixture(
    "src/main/java/com/demo/Main.java",
    `package com.demo;

import java.util.List;
import com.demo.service.Service;

public class Main {
    public static void main(String[] args) {
        Service s = new Service();
        List<String> names = List.of(s.greet());
        System.out.println(names);
    }
}
`,
  );
  await writeFixture(
    "src/main/java/com/demo/service/Service.java",
    `package com.demo.service;

public class Service {
    public String greet() {
        return "hello";
    }
}
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KtService.kt",
    `package com.demo

class KtService {
    fun greet(): String = "kotlin"
}
`,
  );
  await writeFixture(
    "src/main/java/com/demo/Named.java",
    `package com.demo;

public interface Named {
}
`,
  );
  await writeFixture(
    "src/main/java/com/demo/Base.java",
    `package com.demo;

public class Base implements Named {
}
`,
  );
  await writeFixture(
    "src/main/java/com/demo/Child.java",
    `package com.demo;

public class Child extends Base implements Named {
}
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KBase.kt",
    `package com.demo

open class KBase
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KNamed.kt",
    `package com.demo

interface KNamed
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KChild.kt",
    `package com.demo

class KChild : KBase()
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KService.kt",
    `package com.demo

class KService : KBase(), KNamed
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KParent.kt",
    `package com.demo

interface KParent
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KChild2.kt",
    `package com.demo

interface KChild2 : KParent
`,
  );

  const graph = asEnvelope(
    await call("project_dependency_graph", {
      kind: "both",
      relative_path: dgRoot,
      depth: 5,
      include_external: 1,
      max_nodes: 100,
      max_edges: 200,
    }),
  );
  const graphNodes = (graph.data?.nodes ?? []).map(
    (node: { id: string }) => node.id,
  ) as string[];
  const graphEdges = (graph.data?.edges ?? []) as Array<{
    from: string;
    to: string;
    type: string;
    confidence: string;
  }>;
  const hasEdge = (
    from: string,
    to: string,
    type: string,
    confidence?: string,
  ) =>
    graphEdges.some(
      (edge) =>
        edge.from === dgPath(from) &&
        edge.to === dgPath(to) &&
        edge.type === type &&
        (!confidence || edge.confidence === confidence),
    );
  check(
    "dependency_graph_ts_relative_imports",
    graph.ok === true &&
      graph.data?.kind === "both" &&
      hasEdge("src/app.ts", "src/lib/util.ts", "import", "exact") &&
      hasEdge("src/lib/index.ts", "src/lib/util.ts", "import", "exact"),
    {
      nodes: graphNodes,
      edges: graphEdges.filter((edge) => edge.type === "import"),
    },
  );
  check(
    "dependency_graph_cycle",
    hasEdge("src/cycle-a.ts", "src/cycle-b.ts", "import") &&
      hasEdge("src/cycle-b.ts", "src/cycle-a.ts", "import"),
    graphEdges.filter((edge) => edge.from.startsWith("src/cycle")),
  );
  check(
    "dependency_graph_dynamic_import_possible",
    hasEdge("src/app.ts", "src/dynamic.ts", "import", "possible"),
    graphEdges.filter((edge) => edge.to === "src/dynamic.ts"),
  );
  check(
    "dependency_graph_python_relative_import",
    hasEdge("pkg/main.py", "pkg/mod.py", "import", "exact"),
    graphEdges.filter((edge) => edge.from.startsWith("pkg/")),
  );
  check(
    "dependency_graph_protected_file_excluded",
    !graphNodes.includes(dgPath("src/.env.local.ts")),
    graphNodes,
  );
  check(
    "dependency_graph_extends_edge",
    hasEdge("src/child.ts", "src/lib/util.ts", "extends"),
    graphEdges.filter((edge) => edge.from === "src/child.ts"),
  );
  check(
    "dependency_graph_unresolved_reported",
    (graph.data?.unresolved ?? []).some(
      (entry: { specifier?: string }) => entry.specifier === "./nope",
    ),
    graph.data?.unresolved,
  );
  check(
    "dependency_graph_rust_mod_decl",
    graph.ok === true &&
      hasEdge(
        "rust/cli/src/main.rs",
        "rust/cli/src/report.rs",
        "import",
        "exact",
      ),
    graphEdges.filter((edge) => edge.from.startsWith("rust/")),
  );
  check(
    "dependency_graph_rust_pub_mod_and_crate_use",
    graph.ok === true &&
      hasEdge(
        "rust/svc/src/main.rs",
        "rust/svc/src/api/mod.rs",
        "import",
        "exact",
      ) &&
      hasEdge(
        "rust/svc/src/main.rs",
        "rust/svc/src/util.rs",
        "import",
        "exact",
      ),
    graphEdges.filter((edge) => edge.from.startsWith("rust/")),
  );
  check(
    "dependency_graph_rust_extern_crate_external",
    (graph.data?.external ?? []).some(
      (entry: { id?: string }) => entry.id === "cargo:serde",
    ),
    graph.data?.external,
  );
  check(
    "dependency_graph_rust_unresolved_module",
    (graph.data?.unresolved ?? []).some(
      (entry: { specifier?: string }) =>
        entry.specifier === "crate::missing::thing",
    ),
    graph.data?.unresolved,
  );
  check(
    "dependency_graph_go_internal_import",
    graph.ok === true &&
      hasEdge("main.go", "pkg/tool/tool.go", "import", "exact"),
    graphEdges.filter(
      (edge) =>
        edge.from === dgPath("main.go") || edge.to === dgPath("main.go"),
    ),
  );
  check(
    "dependency_graph_go_stdlib_external",
    (graph.data?.external ?? []).some(
      (entry: { id?: string }) => entry.id === "gomod:stdlib:fmt",
    ),
    graph.data?.external,
  );
  check(
    "dependency_graph_go_references",
    graphEdges.some(
      (edge) =>
        edge.from === dgPath("main.go") &&
        edge.to === dgPath("pkg/tool/tool.go") &&
        edge.type === "references",
    ),
    graphEdges.filter((edge) => edge.type === "references"),
  );

  const graphDot = asEnvelope(
    await call("project_dependency_graph", {
      kind: "files",
      relative_path: dgRoot,
      depth: 5,
      format: "dot",
    }),
  );
  check(
    "dependency_graph_dot",
    graphDot.ok === true &&
      String(graphDot.data?.graph ?? "").startsWith("digraph dependencies") &&
      String(graphDot.data?.graph ?? "").includes(
        `"${dgPath("src/app.ts")}" -> "${dgPath("src/lib/util.ts")}"`,
      ),
    String(graphDot.data?.graph ?? "").slice(0, 120),
  );
  const graphMermaid = asEnvelope(
    await call("project_dependency_graph", {
      kind: "files",
      relative_path: dgRoot,
      depth: 5,
      format: "mermaid",
    }),
  );
  check(
    "dependency_graph_mermaid",
    graphMermaid.ok === true &&
      String(graphMermaid.data?.graph ?? "").startsWith("graph LR") &&
      String(graphMermaid.data?.graph ?? "").includes("-->|import|"),
    String(graphMermaid.data?.graph ?? "").slice(0, 120),
  );
  const graphTruncated = asEnvelope(
    await call("project_dependency_graph", {
      kind: "files",
      relative_path: dgRoot,
      depth: 5,
      max_nodes: 2,
    }),
  );
  check(
    "dependency_graph_truncation",
    graphTruncated.ok === true &&
      graphTruncated.data?.truncated === true &&
      (graphTruncated.data?.nodes ?? []).length === 2 &&
      !!graphTruncated.hint,
    {
      truncated: graphTruncated.data?.truncated,
      nodes: graphTruncated.data?.nodes,
      hint: graphTruncated.hint,
    },
  );

  // Writing invalidates the 5 s graph index cache: the new file must show up immediately.
  const lateWrite = await call("project_write_file", {
    relative_path: dgPath("src/late.ts"),
    content: "export const late = 1;\n",
    reason: "verify graph cache invalidation",
  });
  const graphAfterWrite = asEnvelope(
    await call("project_dependency_graph", {
      kind: "files",
      relative_path: dgRoot,
      depth: 5,
    }),
  );
  check(
    "dependency_graph_cache_invalidated_on_write",
    asEnvelope(lateWrite).ok === true &&
      (graphAfterWrite.data?.nodes ?? []).some(
        (node: { id: string }) => node.id === dgPath("src/late.ts"),
      ),
    (graphAfterWrite.data?.nodes ?? []).map((node: { id: string }) => node.id),
  );

  const impact = asEnvelope(
    await call("project_change_impact", {
      files: [dgPath("src/lib/util.ts")],
      direction: "dependents",
      depth: 5,
      max_nodes: 50,
    }),
  );
  const impactIds = (impact.data?.affected ?? []).map(
    (entry: { id: string }) => entry.id,
  ) as string[];
  check(
    "change_impact_reverse_closure",
    impact.ok === true &&
      impactIds.includes(dgPath("src/app.ts")) &&
      impactIds.includes(dgPath("src/child.ts")) &&
      impactIds.includes(dgPath("src/lib/index.ts")) &&
      impactIds.includes(dgPath("src/lib/util.test.ts")) &&
      Number(impact.data?.summary?.max_distance) >= 1,
    { affected: impactIds, summary: impact.data?.summary },
  );
  check(
    "change_impact_tests_counted_separately",
    impact.data?.summary?.tests_affected === 1 &&
      Number(impact.data?.summary?.affected_symbols) >= 1,
    impact.data?.summary,
  );
  const impactNoTests = asEnvelope(
    await call("project_change_impact", {
      files: [dgPath("src/lib/util.ts")],
      direction: "dependents",
      depth: 5,
      include_tests: 0,
    }),
  );
  check(
    "change_impact_excludes_tests",
    !(impactNoTests.data?.affected ?? []).some(
      (entry: { id: string }) => entry.id === dgPath("src/lib/util.test.ts"),
    ) && impactNoTests.data?.summary?.tests_affected === 0,
    impactNoTests.data?.summary,
  );
  const impactAmbiguous = asEnvelope(
    await call("project_change_impact", {
      symbols: ["dup"],
      direction: "dependents",
      depth: 3,
    }),
  );
  check(
    "change_impact_ambiguous_symbol_possible",
    impactAmbiguous.ok === true &&
      (impactAmbiguous.data?.unresolved ?? []).some(
        (entry: { symbol?: string; reason?: string }) =>
          entry.symbol === "dup" && /ambiguous/.test(entry.reason ?? ""),
      ) &&
      (impactAmbiguous.data?.affected ?? []).every(
        (entry: { confidence: string }) => entry.confidence === "possible",
      ),
    {
      unresolved: impactAmbiguous.data?.unresolved,
      affected: impactAmbiguous.data?.affected,
    },
  );
  const impactPinned = asEnvelope(
    await call("project_change_impact", {
      symbols: [{ name: "dup", file: dgPath("src/dup-a.ts") }],
      direction: "dependents",
      depth: 3,
    }),
  );
  check(
    "change_impact_symbol_pinned_to_file",
    impactPinned.ok === true &&
      impactPinned.data?.seed?.files?.length === 1 &&
      (impactPinned.data?.affected ?? []).some(
        (entry: { id: string; confidence: string }) =>
          entry.id === dgPath("src/use-dup.ts") && entry.confidence === "exact",
      ),
    {
      seed: impactPinned.data?.seed,
      affected: impactPinned.data?.affected,
      unresolved: impactPinned.data?.unresolved,
    },
  );
  const impactMermaid = asEnvelope(
    await call("project_change_impact", {
      files: [dgPath("src/lib/util.ts")],
      direction: "dependents",
      format: "mermaid",
    }),
  );
  check(
    "change_impact_mermaid",
    impactMermaid.ok === true &&
      String(impactMermaid.data?.graph ?? "").startsWith("graph LR"),
    String(impactMermaid.data?.graph ?? "").slice(0, 120),
  );
  const rustImpact = asEnvelope(
    await call("project_change_impact", {
      files: [dgPath("rust/cli/src/main.rs")],
      direction: "dependencies",
      depth: 5,
      max_nodes: 50,
    }),
  );
  const rustImpactIds = (rustImpact.data?.affected ?? []).map(
    (entry: { id: string }) => entry.id,
  ) as string[];
  check(
    "change_impact_rust_module_dependent",
    rustImpact.ok === true &&
      rustImpactIds.includes(dgPath("rust/cli/src/report.rs")),
    { affected: rustImpactIds, summary: rustImpact.data?.summary },
  );
  const goImpact = asEnvelope(
    await call("project_change_impact", {
      files: [dgPath("pkg/tool/tool.go")],
      direction: "dependents",
      depth: 5,
      max_nodes: 50,
    }),
  );
  const goImpactIds = (goImpact.data?.affected ?? []).map(
    (entry: { id: string }) => entry.id,
  ) as string[];
  check(
    "change_impact_go_package_dependent",
    goImpact.ok === true && goImpactIds.includes(dgPath("main.go")),
    { affected: goImpactIds, summary: goImpact.data?.summary },
  );
  const javaGraphEdges = (graph.data?.edges ?? []).filter(
    (edge: { type: string; from: string }) =>
      edge.type === "import" &&
      edge.from === dgPath("src/main/java/com/demo/Main.java"),
  );
  check(
    "dependency_graph_java_internal_import",
    graph.ok === true &&
      javaGraphEdges.some(
        (edge: { to: string; type: string; confidence: string }) =>
          edge.to === dgPath("src/main/java/com/demo/service/Service.java") &&
          (edge.confidence === "exact" || edge.confidence === "likely"),
      ),
    { edges: javaGraphEdges, external: graph.data?.external },
  );
  check(
    "dependency_graph_java_external_jdk",
    graph.ok === true &&
      Array.isArray(graph.data?.external) &&
      (graph.data.external as { id: string }[]).some(
        (e) => e.id === "jdk:java.util",
      ),
    { external: graph.data?.external },
  );
  const kotlinGraphEdges = (graph.data?.edges ?? []).filter(
    (edge: { type: string; from: string }) =>
      edge.type === "import" &&
      edge.from === dgPath("src/main/kotlin/com/demo/KtService.kt"),
  );
  check(
    "dependency_graph_kotlin_internal_import",
    graph.ok === true && kotlinGraphEdges.length === 0,
    {
      edges: kotlinGraphEdges,
      note: "KtService.kt has no imports, just checks no crash on .kt parsing",
    },
  );
  check(
    "dependency_graph_java_extends_implements",
    graph.ok === true &&
      hasEdge(
        "src/main/java/com/demo/Child.java",
        "src/main/java/com/demo/Base.java",
        "extends",
      ) &&
      hasEdge(
        "src/main/java/com/demo/Child.java",
        "src/main/java/com/demo/Named.java",
        "implements",
      ) &&
      hasEdge(
        "src/main/java/com/demo/Base.java",
        "src/main/java/com/demo/Named.java",
        "implements",
      ),
    graphEdges.filter(
      (edge) =>
        edge.from.includes("com/demo/Child") ||
        edge.from.includes("com/demo/Base"),
    ),
  );
  check(
    "dependency_graph_kotlin_extends_implements",
    graph.ok === true &&
      hasEdge(
        "src/main/kotlin/com/demo/KChild.kt",
        "src/main/kotlin/com/demo/KBase.kt",
        "extends",
      ) &&
      hasEdge(
        "src/main/kotlin/com/demo/KService.kt",
        "src/main/kotlin/com/demo/KBase.kt",
        "extends",
      ) &&
      hasEdge(
        "src/main/kotlin/com/demo/KService.kt",
        "src/main/kotlin/com/demo/KNamed.kt",
        "implements",
      ) &&
      hasEdge(
        "src/main/kotlin/com/demo/KChild2.kt",
        "src/main/kotlin/com/demo/KParent.kt",
        "extends",
      ),
    graphEdges.filter((edge) => edge.from.includes("com/demo/K")),
  );
  const javaImpact = asEnvelope(
    await call("project_change_impact", {
      files: [dgPath("src/main/java/com/demo/service/Service.java")],
      direction: "dependents",
      depth: 5,
      max_nodes: 50,
    }),
  );
  const javaImpactIds = (javaImpact.data?.affected ?? []).map(
    (entry: { id: string }) => entry.id,
  ) as string[];
  check(
    "change_impact_java_package_dependent",
    javaImpact.ok === true &&
      javaImpactIds.includes(dgPath("src/main/java/com/demo/Main.java")),
    { affected: javaImpactIds, summary: javaImpact.data?.summary },
  );

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
  const glCreate = await providerCall(gl, "project_pr_create", {
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
  const glComment = await providerCall(gl, "project_pr_comment", {
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
  const glInline = await providerCall(gl, "project_pr_comment", {
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
  const glList = await providerCall(gl, "project_pr_list", { state: "open" });
  check(
    "gitlab_pr_list",
    glList.ok === true &&
      glList.data?.provider === "gitlab" &&
      glList.data?.prs?.length === 1,
    glList,
  );
  const glClose = await providerCall(gl, "project_pr_close", { pr: 11 });
  check(
    "gitlab_pr_close",
    glClose.ok === true &&
      glClose.data?.state === "closed" &&
      gitlabMock.state.closes === 1,
    glClose,
  );
  const glReopen = await providerCall(gl, "project_pr_reopen", { pr: 11 });
  check(
    "gitlab_pr_reopen",
    glReopen.ok === true &&
      glReopen.data?.state === "open" &&
      gitlabMock.state.reopens === 1,
    glReopen,
  );
  const glMerge = await providerCall(gl, "project_pr_merge", {
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
  const glCi = await providerCall(gl, "project_ci_status", {
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
  const glRun = await providerCall(gl, "project_ci_status", { run_id: 77 });
  check(
    "gitlab_ci_run",
    glRun.ok === true &&
      glRun.data?.run?.id === 77 &&
      glRun.data?.jobs?.length === 2 &&
      glRun.data?.overall === "failure",
    glRun,
  );
  const glTrigger = await providerCall(gl, "project_ci_trigger", {
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
  const glCancel = await providerCall(gl, "project_ci_control", {
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
  const glRetry = await providerCall(gl, "project_ci_control", {
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
  const glBadRun = await providerCall(gl, "project_ci_control", {
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
  const glJobLogs = await providerCall(gl, "project_ci_logs", { job_id: 7 });
  check(
    "gitlab_ci_logs_job",
    glJobLogs.ok === true &&
      String(glJobLogs.data?.text ?? "").includes("FAIL src/demo.test.ts:42"),
    glJobLogs.data?.text,
  );
  const glRunLogs = await providerCall(gl, "project_ci_logs", {
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
    const faulted = await providerCall(gl, "project_ci_status", {
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
  const glRecovered = await providerCall(gl, "project_ci_status", {
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
  const glRedirected = await providerCall(gl, "project_ci_status", {
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
  const glRetriedRead = await providerCall(glRetrying, "project_ci_status", {
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
  const glFailedCancel = await providerCall(glRetrying, "project_ci_control", {
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
  const bbCreate = await providerCall(bb, "project_pr_create", {
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
  const bbComment = await providerCall(bb, "project_pr_comment", {
    pr: 21,
    body: "LGTM from verify",
  });
  check(
    "bitbucket_pr_comment",
    bbComment.ok === true && bbComment.data?.comment_id === 701,
    bbComment,
  );
  const bbInline = await providerCall(bb, "project_pr_comment", {
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
  const bbList = await providerCall(bb, "project_pr_list", { state: "open" });
  check(
    "bitbucket_pr_list",
    bbList.ok === true &&
      bbList.data?.prs?.length === 1 &&
      bbList.data?.provider === "bitbucket",
    bbList,
  );
  const bbClose = await providerCall(bb, "project_pr_close", { pr: 21 });
  check(
    "bitbucket_pr_close",
    bbClose.ok === true &&
      bbClose.data?.state === "closed" &&
      bitbucketMock.state.declines === 1,
    bbClose,
  );
  const bbReopen = await providerCall(bb, "project_pr_reopen", { pr: 21 });
  check(
    "bitbucket_pr_reopen_unsupported",
    bbReopen.ok === false && bbReopen.error?.code === "unsupported",
    bbReopen,
  );
  const bbMerge = await providerCall(bb, "project_pr_merge", {
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
  const bbCi = await providerCall(bb, "project_ci_status", {
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
  const bbRun = await providerCall(bb, "project_ci_status", {
    run_id: "{pipeline-1}",
  });
  check(
    "bitbucket_ci_run",
    bbRun.ok === true &&
      bbRun.data?.jobs?.length === 1 &&
      bbRun.data?.overall === "failure",
    bbRun,
  );
  const bbTrigger = await providerCall(bb, "project_ci_trigger", {
    ref: "main",
  });
  check(
    "bitbucket_ci_trigger",
    bbTrigger.ok === true &&
      bbTrigger.data?.triggered === true &&
      bbTrigger.data?.workflow === "default",
    bbTrigger,
  );
  const bbCancel = await providerCall(bb, "project_ci_control", {
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
  const bbRetryUnsupported = await providerCall(bb, "project_ci_control", {
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
  const bbBadUuid = await providerCall(bb, "project_ci_control", {
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
  const bbLogs = await providerCall(bb, "project_ci_logs", {
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
    const faulted = await providerCall(bb, "project_ci_status", {
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
  const bbRecovered = await providerCall(bb, "project_ci_status", {
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
  const bbPagedRun = await providerCall(bb, "project_ci_status", {
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
  const bbPagedLogs = await providerCall(bb, "project_ci_logs", {
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
  const bbWait = await providerCall(bb, "project_ci_wait", {
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
  const ghPaged = await providerCall(gh, "project_ci_status", {
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
  const ghJobs = await providerCall(gh, "project_ci_status", { run_id: 300 });
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
  const ghEndless = await providerCall(gh, "project_ci_status", {
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
  const ghForeign = await providerCall(gh, "project_ci_status", {
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
  const ghHugeDeclared = await providerCall(gh, "project_ci_logs", {
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
  const ghHugeChunked = await providerCall(gh, "project_ci_logs", {
    run_id: 303,
  });
  check(
    "github_ci_logs_oversized_stream_aborts_early",
    ghHugeChunked.ok === false &&
      ghHugeChunked.error?.code === "resource_limit" &&
      Date.now() - chunkedStart < 4000,
    { ms: Date.now() - chunkedStart, response: ghHugeChunked },
  );
  const ghSkipped = await providerCall(gh, "project_ci_logs", { run_id: 304 });
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
  const explainUnknown = asEnvelope(
    await call("project_explain_error", { error_text: "everything is fine" }),
  );
  check(
    "explain_error_unknown_is_ok",
    explainUnknown.ok === true && explainUnknown.data?.matched === false,
    explainUnknown.data,
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
  return {};
}
