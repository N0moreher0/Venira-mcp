/**
 * Environment registry + configuration matrix tests.
 * Runs: npm run test:env-registry
 *
 * 1. Registry integrity: unique, well-formed, every variable is documented or
 *    carries a reason, defaults are valid for their kind.
 * 2. `checkEnvironment` table: typos, removed variables, flag/enum/int values.
 * 3. Cross-checks against the security-profile table and the legacy startup
 *    boolean list (the registry may only add to it, never silently drop).
 * 4. Configuration matrix: every meaningful combination of security profile,
 *    shell mode and risk switches goes through the pure posture evaluator and
 *    must satisfy its invariants (stable ids, monotonic severity, determinism).
 * 5. Source drift: runtime source and registry list exactly the same variables.
 */
import assert from "node:assert/strict";
import {
  ENV_FLAG_NAMES,
  ENV_REGISTRY,
  checkEnvironment,
  envSpec,
  suggestEnvName,
} from "../lib/env-registry.js";
import {
  evaluateConfigPosture,
  type ConfigPostureInput,
  type ConfigShellMode,
  type PostureSeverity,
} from "../lib/config-posture.js";
import { SECURITY_PROFILES, SECURITY_PROFILE_TABLE } from "../lib/security-profile.js";
import { scanRuntimeEnvNames } from "./env-source-scan.js";

let checks = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// 1. Registry integrity
// ---------------------------------------------------------------------------
check("registry names are unique and well-formed", () => {
  const seen = new Set<string>();
  for (const entry of ENV_REGISTRY) {
    assert.match(entry.name, /^VENIRA_[A-Z0-9]+(?:_[A-Z0-9]+)*$/, entry.name);
    assert.ok(!seen.has(entry.name), `duplicate ${entry.name}`);
    seen.add(entry.name);
  }
});

check("every entry has a description", () => {
  for (const entry of ENV_REGISTRY) assert.ok(entry.description.trim().length >= 8, entry.name);
});

check("every variable is documented or carries a reason", () => {
  for (const entry of ENV_REGISTRY) {
    if (entry.documented) continue;
    assert.ok((entry.reason ?? "").trim().length > 0, `${entry.name} is undocumented without a reason`);
  }
});

check("removed entries explain what to do; test entries are never documented", () => {
  for (const entry of ENV_REGISTRY) {
    if (entry.status === "removed") assert.ok((entry.removedNote ?? "").length > 0, entry.name);
    if (entry.status === "test") {
      assert.equal(entry.documented, false, entry.name);
      assert.equal(entry.area, "test", entry.name);
    }
    if (entry.area === "test") assert.equal(entry.status, "test", entry.name);
  }
});

check("enum entries list choices and their default is one of them", () => {
  for (const entry of ENV_REGISTRY) {
    if (entry.kind !== "enum") {
      assert.equal(entry.choices, undefined, `${entry.name} has choices but is not an enum`);
      continue;
    }
    assert.ok((entry.choices?.length ?? 0) >= 2, `${entry.name} needs choices`);
    if (entry.default !== undefined) assert.ok(entry.choices?.includes(entry.default), `${entry.name} default`);
  }
});

check("flag and int defaults are valid for their kind", () => {
  for (const entry of ENV_REGISTRY) {
    if (entry.default === undefined) continue;
    if (entry.kind === "flag") assert.match(entry.default, /^[01]$/, entry.name);
    if (entry.kind === "int") assert.match(entry.default, /^\d+$/, entry.name);
  }
});

check("envSpec resolves known names and rejects unknown ones", () => {
  assert.equal(envSpec("VENIRA_TOOL_MODE")?.kind, "enum");
  assert.equal(envSpec("VENIRA_DOES_NOT_EXIST"), undefined);
});

// ---------------------------------------------------------------------------
// 2. checkEnvironment table
// ---------------------------------------------------------------------------
type Expect = { code: string; name: string; suggestion?: string }[];
const ENV_CASES: Array<{ id: string; env: Record<string, string | undefined>; expect: Expect }> = [
  { id: "empty environment is clean", env: {}, expect: [] },
  {
    id: "typical valid settings are clean",
    env: {
      VENIRA_SECURITY_PROFILE: "strict",
      VENIRA_ALLOW_JS_EXEC: "1",
      VENIRA_SNAPSHOT_KEEP: "10",
      VENIRA_TOOL_MODE: "expert",
      VENIRA_SHELL_TIMEOUT_POLICY: "hard",
      PATH: "/usr/bin",
    },
    expect: [],
  },
  {
    id: "typo is reported with a suggestion",
    env: { VENIRA_SECURITY_PROFLE: "strict" },
    expect: [{ code: "unknown_name", name: "VENIRA_SECURITY_PROFLE", suggestion: "VENIRA_SECURITY_PROFILE" }],
  },
  {
    id: "transposed letters are still matched",
    env: { VENIRA_ALLOW_JS_EXCE: "1" },
    expect: [{ code: "unknown_name", name: "VENIRA_ALLOW_JS_EXCE", suggestion: "VENIRA_ALLOW_JS_EXEC" }],
  },
  {
    id: "an unrelated unknown name gets no suggestion",
    env: { VENIRA_TOTALLY_UNRELATED_SETTING_NAME: "1" },
    expect: [{ code: "unknown_name", name: "VENIRA_TOTALLY_UNRELATED_SETTING_NAME" }],
  },
  {
    id: "removed variables are flagged",
    env: { VENIRA_NETWORK: "off", VENIRA_SHELL_AUTO_APPROVE_TOKEN: "1" },
    expect: [
      { code: "removed_var", name: "VENIRA_NETWORK" },
      { code: "removed_var", name: "VENIRA_SHELL_AUTO_APPROVE_TOKEN" },
    ],
  },
  {
    id: "flags must be exactly 0 or 1",
    env: { VENIRA_UNRESTRICTED: "true", VENIRA_ALLOW_SELF_INSTALL: "2", VENIRA_TRACE: "1", VENIRA_PRETTY: "0" },
    expect: [
      { code: "invalid_flag", name: "VENIRA_ALLOW_SELF_INSTALL" },
      { code: "invalid_flag", name: "VENIRA_UNRESTRICTED" },
    ],
  },
  {
    id: "enum values are compared trimmed and case-insensitively",
    env: { VENIRA_TOOL_MODE: " EXPERT ", VENIRA_OUTPUT_MODE: "Compact" },
    expect: [],
  },
  {
    id: "an unknown enum value is reported",
    env: { VENIRA_TOOL_MODE: "everything" },
    expect: [{ code: "invalid_enum", name: "VENIRA_TOOL_MODE" }],
  },
  {
    id: "empty enum is accepted only where documented as unset",
    env: { VENIRA_SECURITY_PROFILE: "", VENIRA_TOOL_MODE: "", VENIRA_SHELL_MODE: "" },
    expect: [{ code: "invalid_enum", name: "VENIRA_SHELL_MODE" }],
  },
  {
    id: "integers must be non-negative digits",
    env: {
      VENIRA_SNAPSHOT_KEEP: "12abc",
      VENIRA_LIST_CACHE_MS: "-1",
      VENIRA_SEARCH_CACHE_MS: "",
      VENIRA_RECENT_CACHE_MS: "0",
    },
    expect: [
      { code: "invalid_int", name: "VENIRA_LIST_CACHE_MS" },
      { code: "invalid_int", name: "VENIRA_SEARCH_CACHE_MS" },
      { code: "invalid_int", name: "VENIRA_SNAPSHOT_KEEP" },
    ],
  },
  {
    id: "test-only fixtures never warn",
    env: { VENIRA_TEST_SECRET: "x", VENIRA_TEST_ONLY: "local-fixture", VENIRA_SHELL_SECURITY_DEBUG: "1" },
    expect: [],
  },
  {
    id: "undefined values and non-VENIRA keys are ignored",
    env: { VENIRA_ALLOW_JS_EXEC: undefined, venira_lowercase_thing: "1", OTHER_TOOL_VENIRA_X: "1" },
    expect: [],
  },
];

for (const testCase of ENV_CASES) {
  check(`checkEnvironment: ${testCase.id}`, () => {
    const issues = checkEnvironment(testCase.env);
    assert.deepEqual(
      issues.map((issue) => ({ code: issue.code, name: issue.name })),
      testCase.expect.map(({ code, name }) => ({ code, name })),
    );
    for (const expected of testCase.expect) {
      if (expected.suggestion === undefined) continue;
      assert.equal(issues.find((issue) => issue.name === expected.name)?.suggestion, expected.suggestion);
    }
    for (const issue of issues) assert.ok(issue.message.includes(issue.name), issue.message);
  });
}

check("checkEnvironment: the removed VENIRA_NETWORK message keeps its documented wording", () => {
  const [issue] = checkEnvironment({ VENIRA_NETWORK: "off" });
  assert.equal(
    `[env] WARNING: ${issue.message}`,
    "[env] WARNING: VENIRA_NETWORK was removed and is ignored; Git-provider calls are always allowed. " +
      "Restrict outbound network at the OS, container or firewall level instead.",
  );
});

check("checkEnvironment: output order is deterministic (sorted by name)", () => {
  const env = { VENIRA_ZZZ_TYPO: "1", VENIRA_AAA_TYPO: "1", VENIRA_MMM_TYPO: "1" };
  const names = checkEnvironment(env).map((issue) => issue.name);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(checkEnvironment(env), checkEnvironment(env));
});

check("suggestEnvName never proposes a test-only variable", () => {
  assert.equal(suggestEnvName("VENIRA_TEST_SECRE"), undefined);
});

// ---------------------------------------------------------------------------
// 3. Cross-checks
// ---------------------------------------------------------------------------
check("startup boolean validation never loses a legacy flag", () => {
  const LEGACY_STARTUP_FLAGS = [
    "VENIRA_UNRESTRICTED",
    "VENIRA_ALLOW_JS_EXEC",
    "VENIRA_JS_EXEC_APPROVAL",
    "VENIRA_CACHE_ALL",
    "VENIRA_CACHE_LIST_ONLY",
    "VENIRA_CACHE_SEARCH_ONLY",
    "VENIRA_AUDIT_STRICT",
    "VENIRA_AUDIT_FAST",
    "VENIRA_SHELL_EXIT_EARLY",
    "VENIRA_SHELL_ENV_PASS_ALL",
    "VENIRA_EDIT_FUZZY",
    "VENIRA_SHELL_AUTO_APPROVE_TOKEN",
    "VENIRA_SECRET_ALLOW_REVEAL",
    "VENIRA_SHELL_ELICIT",
    "VENIRA_PRETTY",
    "VENIRA_ALLOW_SELF_INSTALL",
    "VENIRA_GIT_ALLOW_HTTP",
    "VENIRA_GITHUB_ALLOW_HTTP",
    "VENIRA_TRACE",
    "VENIRA_VERIFY_DEBUG",
  ];
  for (const name of LEGACY_STARTUP_FLAGS) assert.ok(ENV_FLAG_NAMES.includes(name), `${name} dropped`);
});

check("flags read through envFlag at runtime are registered as flags", () => {
  for (const name of [
    "VENIRA_USE_RIPGREP",
    "VENIRA_SHELL_CACHE",
    "VENIRA_SHELL_CACHE_READ_ONLY",
    "VENIRA_DYNAMIC_WORKSPACE",
    "VENIRA_EDIT_FUZZY",
    "VENIRA_AUDIT_STRICT",
    "VENIRA_PRETTY",
  ]) {
    assert.equal(envSpec(name)?.kind, "flag", name);
  }
});

check("security profile choices match the profile table", () => {
  assert.deepEqual([...(envSpec("VENIRA_SECURITY_PROFILE")?.choices ?? [])].sort(), [...SECURITY_PROFILES].sort());
  assert.equal(envSpec("VENIRA_SECURITY_PROFILE")?.default, "balanced");
});

check("every shell mode a profile maps to is an accepted VENIRA_SHELL_MODE value", () => {
  const accepted = envSpec("VENIRA_SHELL_MODE")?.choices ?? [];
  for (const profile of SECURITY_PROFILES) {
    assert.ok(accepted.includes(SECURITY_PROFILE_TABLE[profile].shellMode), profile);
  }
});

check("only the `off` profile disables the JS approval gate", () => {
  for (const profile of SECURITY_PROFILES) {
    assert.equal(SECURITY_PROFILE_TABLE[profile].jsExecApproval, profile !== "off", profile);
  }
});

// ---------------------------------------------------------------------------
// 4. Configuration matrix (pure posture evaluator)
// ---------------------------------------------------------------------------
const SHELL_MODES: readonly ConfigShellMode[] = ["strict", "balanced", "permissive", "off"];
const RULE_SETS: readonly string[][] = [[], ["cd_outside_workspace"], ["network_access"]];
const BOOLS = [false, true] as const;
const RANK: Record<PostureSeverity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };

function* matrix(): Generator<ConfigPostureInput> {
  for (const securityProfile of SECURITY_PROFILES)
    for (const shellMode of SHELL_MODES)
      for (const jsExecEnabled of BOOLS)
        for (const jsExecApproval of BOOLS)
          for (const unrestricted of BOOLS)
            for (const allowSelfInstall of BOOLS)
              for (const secretAllowReveal of BOOLS)
                for (const gitAllowHttp of BOOLS)
                  for (const legacyAutoApproveToken of BOOLS)
                    for (const sessionGrantRules of RULE_SETS)
                      yield {
                        securityProfile,
                        securityProfileExplicit: true,
                        shellMode,
                        jsExecEnabled,
                        jsExecApproval,
                        unrestricted,
                        allowSelfInstall,
                        secretAllowReveal,
                        gitAllowHttp,
                        legacyAutoApproveToken,
                        sessionGrantRules: [...sessionGrantRules],
                      };
}

const ALL_INPUTS = [...matrix()];

check(`matrix covers ${ALL_INPUTS.length} combinations`, () => {
  assert.equal(ALL_INPUTS.length, SECURITY_PROFILES.length * SHELL_MODES.length * 2 ** 7 * RULE_SETS.length);
});

check("matrix: the evaluator never throws and never fails closed", () => {
  for (const input of ALL_INPUTS) assert.equal(evaluateConfigPosture(input).fail_closed, false);
});

check("matrix: finding ids are unique and level equals the worst severity", () => {
  for (const input of ALL_INPUTS) {
    const result = evaluateConfigPosture(input);
    const ids = result.findings.map((finding) => finding.id);
    assert.equal(new Set(ids).size, ids.length, JSON.stringify(input));
    const worst = result.findings.reduce<PostureSeverity>(
      (level, finding) => (RANK[finding.severity] > RANK[level] ? finding.severity : level),
      "ok",
    );
    assert.equal(result.level, worst, JSON.stringify(input));
  }
});

check("matrix: each documented condition maps to exactly its finding id", () => {
  for (const input of ALL_INPUTS) {
    const ids = new Set(evaluateConfigPosture(input).findings.map((finding) => finding.id));
    const open = input.shellMode === "off" || input.shellMode === "permissive";
    const unapprovedJs = input.jsExecEnabled && !input.jsExecApproval;
    const expectations: Array<[string, boolean]> = [
      ["workspace.unrestricted", input.unrestricted],
      ["profile.off", input.securityProfile === "off"],
      ["shell.mode_off", input.securityProfile !== "off" && input.shellMode === "off"],
      ["shell.mode_permissive", input.shellMode === "permissive"],
      ["js.exec_without_approval", unapprovedJs],
      ["combo.unrestricted_open_shell", input.unrestricted && open],
      ["combo.unrestricted_unapproved_js", input.unrestricted && unapprovedJs],
      ["self_install.enabled", input.allowSelfInstall],
      ["secret.reveal_enabled", input.secretAllowReveal],
      ["git.plain_http_allowed", input.gitAllowHttp],
      ["approval.legacy_token_ignored", input.legacyAutoApproveToken],
      ["approval.session_grant_risky_rule", input.sessionGrantRules.includes("network_access")],
    ];
    for (const [id, expected] of expectations) assert.equal(ids.has(id), expected, `${id} for ${JSON.stringify(input)}`);
  }
});

check("matrix: turning on any risk switch never lowers the posture level", () => {
  const riskUp: Array<(input: ConfigPostureInput) => ConfigPostureInput> = [
    (input) => ({ ...input, unrestricted: true }),
    (input) => ({ ...input, allowSelfInstall: true }),
    (input) => ({ ...input, secretAllowReveal: true }),
    (input) => ({ ...input, gitAllowHttp: true }),
    (input) => ({ ...input, legacyAutoApproveToken: true }),
    (input) => ({ ...input, jsExecEnabled: true }),
    (input) => ({ ...input, jsExecApproval: false }),
    (input) => ({ ...input, sessionGrantRules: [...input.sessionGrantRules, "network_access"] }),
  ];
  for (const input of ALL_INPUTS) {
    const before = RANK[evaluateConfigPosture(input).level];
    for (const raise of riskUp) {
      const after = RANK[evaluateConfigPosture(raise(input)).level];
      assert.ok(after >= before, `${JSON.stringify(input)} -> ${JSON.stringify(raise(input))}`);
    }
  }
});

check("matrix: evaluation is deterministic", () => {
  for (const input of ALL_INPUTS.filter((_, index) => index % 17 === 0)) {
    assert.deepEqual(evaluateConfigPosture(input), evaluateConfigPosture({ ...input, sessionGrantRules: [...input.sessionGrantRules] }));
  }
});

check("matrix: the documented defaults produce a clean posture", () => {
  const baseline = ALL_INPUTS.find(
    (input) =>
      input.securityProfile === "balanced" &&
      input.shellMode === "balanced" &&
      !input.jsExecEnabled &&
      input.jsExecApproval &&
      !input.unrestricted &&
      !input.allowSelfInstall &&
      !input.secretAllowReveal &&
      !input.gitAllowHttp &&
      !input.legacyAutoApproveToken &&
      input.sessionGrantRules.length === 0,
  );
  assert.ok(baseline);
  const result = evaluateConfigPosture(baseline);
  assert.equal(result.level, "ok");
  assert.deepEqual(result.findings, []);
});

// ---------------------------------------------------------------------------
// 5. Source drift
// ---------------------------------------------------------------------------
check("every VENIRA_* name in runtime source is registered", () => {
  const missing = [...scanRuntimeEnvNames().entries()]
    .filter(([name]) => envSpec(name) === undefined)
    .map(([name, files]) => `${name} (${files.join(", ")})`);
  assert.deepEqual(missing, [], `Register these in lib/env-registry.ts: ${missing.join("; ")}`);
});

check("every registered live variable is still referenced by runtime source", () => {
  const used = scanRuntimeEnvNames();
  const stale = ENV_REGISTRY.filter((entry) => entry.status !== "test" && entry.status !== "removed" && !used.has(entry.name)).map(
    (entry) => entry.name,
  );
  assert.deepEqual(stale, [], `Remove or fix these registry entries: ${stale.join(", ")}`);
});

console.log(`\nEnvironment registry tests passed (${checks} checks).`);
