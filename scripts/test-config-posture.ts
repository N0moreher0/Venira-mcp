/**
 * Configuration posture regressions.
 *
 * The evaluator is pure and table-tested so every risky flag combination keeps
 * a stable finding id and severity. The final checks exercise the thin env
 * adapter used by `project_health`.
 *
 * Run with: npm run test:config-posture
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { evaluateConfigPosture, computeConfigPosture } = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "config-posture.ts")).href
)) as typeof import("../lib/config-posture.js");

type Input = import("../lib/config-posture.js").ConfigPostureInput;

const base: Input = {
  securityProfile: "balanced",
  securityProfileExplicit: false,
  shellMode: "balanced",
  jsExecEnabled: false,
  jsExecApproval: true,
  unrestricted: false,
  allowSelfInstall: false,
  secretAllowReveal: false,
  gitAllowHttp: false,
  legacyAutoApproveToken: false,
  sessionGrantRules: ["cd_outside_workspace"],
};

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

const ids = (input: Partial<Input>) => evaluateConfigPosture({ ...base, ...input }).findings.map((f) => f.id);
const finding = (input: Partial<Input>, id: string) =>
  evaluateConfigPosture({ ...base, ...input }).findings.find((f) => f.id === id);

try {
  check("recommended defaults have no findings", () => {
    const posture = evaluateConfigPosture(base);
    assert.equal(posture.level, "ok");
    assert.deepEqual(posture.findings, []);
    assert.equal(posture.fail_closed, false);
    assert.match(posture.summary, /recommended defaults/);
  });

  check("security profile off is critical", () => {
    const posture = evaluateConfigPosture({ ...base, securityProfile: "off", shellMode: "off" });
    assert.equal(posture.level, "critical");
    assert.deepEqual(ids({ securityProfile: "off", shellMode: "off" }), ["profile.off"]);
    assert.equal(finding({ securityProfile: "off", shellMode: "off" }, "profile.off")?.severity, "critical");
  });

  check("shell mode off is critical only when the profile is not off", () => {
    assert.deepEqual(ids({ shellMode: "off" }), ["shell.mode_off"]);
    assert.equal(evaluateConfigPosture({ ...base, shellMode: "off" }).level, "critical");
  });

  check("permissive shell mode is a warning, not critical", () => {
    const posture = evaluateConfigPosture({ ...base, shellMode: "permissive" });
    assert.equal(posture.level, "warning");
    assert.deepEqual(ids({ shellMode: "permissive" }), ["shell.mode_permissive"]);
  });

  check("unapproved JS execution is a warning", () => {
    assert.deepEqual(ids({ jsExecEnabled: true, jsExecApproval: false }), ["js.exec_without_approval"]);
    assert.deepEqual(ids({ jsExecEnabled: true, jsExecApproval: true }), []);
  });

  check("unrestricted workspace is critical", () => {
    assert.deepEqual(ids({ unrestricted: true }), ["workspace.unrestricted"]);
    assert.equal(evaluateConfigPosture({ ...base, unrestricted: true }).level, "critical");
  });

  check("unrestricted plus an open shell is a critical combination", () => {
    const open = evaluateConfigPosture({ ...base, unrestricted: true, shellMode: "permissive" });
    assert.ok(open.findings.some((f) => f.id === "combo.unrestricted_open_shell"));
    assert.equal(open.level, "critical");
    // strict/balanced do not raise the combination finding
    assert.equal(finding({ unrestricted: true }, "combo.unrestricted_open_shell"), undefined);
  });

  check("unrestricted plus unapproved JS is a critical combination", () => {
    const post = evaluateConfigPosture({
      ...base,
      unrestricted: true,
      jsExecEnabled: true,
      jsExecApproval: false,
    });
    assert.ok(post.findings.some((f) => f.id === "combo.unrestricted_unapproved_js"));
    assert.equal(post.level, "critical");
  });

  check("risky session-grant rules are detected", () => {
    assert.deepEqual(ids({ sessionGrantRules: ["cd_outside_workspace", "ask.network_access"] }), [
      "approval.session_grant_risky_rule",
    ]);
    assert.deepEqual(ids({ sessionGrantRules: ["cd_outside_workspace"] }), []);
  });

  check("self-install, secret reveal and plain HTTP are warnings", () => {
    assert.deepEqual(ids({ allowSelfInstall: true }), ["self_install.enabled"]);
    assert.deepEqual(ids({ secretAllowReveal: true }), ["secret.reveal_enabled"]);
    assert.deepEqual(ids({ gitAllowHttp: true }), ["git.plain_http_allowed"]);
    assert.equal(evaluateConfigPosture({ ...base, allowSelfInstall: true }).level, "warning");
  });

  check("the removed approval token is informational only", () => {
    const posture = evaluateConfigPosture({ ...base, legacyAutoApproveToken: true });
    assert.deepEqual(posture.findings.map((f) => f.id), ["approval.legacy_token_ignored"]);
    assert.equal(posture.level, "info");
  });

  check("findings are stable and ordered by consequence", () => {
    const posture = evaluateConfigPosture({
      ...base,
      unrestricted: true,
      securityProfile: "off",
      shellMode: "off",
      jsExecEnabled: true,
      jsExecApproval: false,
      legacyAutoApproveToken: true,
    });
    assert.deepEqual(posture.findings.map((f) => f.id), [
      "workspace.unrestricted",
      "profile.off",
      "js.exec_without_approval",
      "combo.unrestricted_open_shell",
      "combo.unrestricted_unapproved_js",
      "approval.legacy_token_ignored",
    ]);
    assert.equal(posture.level, "critical");
  });

  check("posture never fails closed", () => {
    for (const input of [
      { ...base, securityProfile: "off" as const, shellMode: "off" as const },
      { ...base, unrestricted: true, shellMode: "permissive" as const },
      { ...base, legacyAutoApproveToken: true },
    ]) {
      const posture = evaluateConfigPosture(input);
      assert.equal(posture.fail_closed, false);
      assert.match(posture.notes, /never refuse a call/);
    }
  });

  check("the env adapter reads risky flags and profile mapping", () => {
    const saved = {
      profile: process.env.VENIRA_SECURITY_PROFILE,
      unrestricted: process.env.VENIRA_UNRESTRICTED,
      jsApproval: process.env.VENIRA_JS_EXEC_APPROVAL,
    };
    try {
      process.env.VENIRA_SECURITY_PROFILE = "trusted";
      process.env.VENIRA_UNRESTRICTED = "1";
      delete process.env.VENIRA_JS_EXEC_APPROVAL;
      const posture = computeConfigPosture({ shellMode: "permissive", sessionGrantRules: [] });
      const found = posture.findings.map((f) => f.id);
      assert.ok(found.includes("workspace.unrestricted"));
      assert.ok(found.includes("shell.mode_permissive"));
      assert.ok(found.includes("combo.unrestricted_open_shell"));
      assert.equal(posture.level, "critical");
    } finally {
      if (saved.profile === undefined) delete process.env.VENIRA_SECURITY_PROFILE;
      else process.env.VENIRA_SECURITY_PROFILE = saved.profile;
      if (saved.unrestricted === undefined) delete process.env.VENIRA_UNRESTRICTED;
      else process.env.VENIRA_UNRESTRICTED = saved.unrestricted;
      if (saved.jsApproval === undefined) delete process.env.VENIRA_JS_EXEC_APPROVAL;
      else process.env.VENIRA_JS_EXEC_APPROVAL = saved.jsApproval;
    }
  });

  console.log(`\nConfiguration posture tests passed (${checks} checks).`);
} catch (error) {
  console.error("Configuration posture tests FAILED");
  throw error;
}
