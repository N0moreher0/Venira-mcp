// Tests for `execute_js` containment and the VENIRA_JS_EXEC_MODE resolution table.
//   semi-auto: no approval, contained (workspace-only fs, scrubbed env, no child processes; network always open)
//   auto:      no approval, nothing contained
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { executeJs } from "../lib/js-executor.js";

let n = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  n += 1;
  if (ok) {
    console.log(`ok ${n} - ${name}`);
  } else {
    failed += 1;
    console.log(`not ok ${n} - ${name}`);
    if (detail !== undefined) console.log(`  detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

const cwd = process.cwd();
const marker = "venira-js-test-marker";
process.env.VENIRA_TEST_JS_MARKER = marker;

// A file outside the workspace, to probe the fs permission model.
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "venira-js-exec-"));
const outsideFile = path.join(outsideDir, "outside.txt");
fs.writeFileSync(outsideFile, "outside-content");

const probe = `
const out = {};
try { require("node:https"); out.https = "ok"; } catch (e) { out.https = e.code || "error"; }
try { require("node:net"); out.net = "ok"; } catch (e) { out.net = e.code || "error"; }
out.fetch = typeof fetch;
out.websocket = typeof WebSocket;
out.marker = process.env.VENIRA_TEST_JS_MARKER || "";
out.home = process.env.USERPROFILE || process.env.HOME || "";
try { out.outside = require("node:fs").readFileSync(${JSON.stringify(outsideFile)}, "utf8"); } catch (e) { out.outside = e.code || "error"; }
console.log(JSON.stringify(out));
`;

function run(options: Parameters<typeof executeJs>[1]): Record<string, string> {
  const r = executeJs(probe, { cwd, ...options });
  if (!r.ok) throw new Error(`probe failed: ${r.error ?? ""} ${r.stderr_tail}`);
  return JSON.parse(r.stdout_tail.trim()) as Record<string, string>;
}

try {
  // --- containment (default and explicit) ---
  for (const [label, options] of [
    ["default", {}],
    ["contained: true", { contained: true }],
  ] as const) {
    const r = run(options);
    check(`${label}: network modules load`, r.https === "ok" && r.net === "ok", r);
    check(`${label}: fetch is available`, r.fetch === "function", r);
    // Global WebSocket landed in Node 22; on Node 20 it does not exist,
    // so both modes must simply not pretend it does.
    if (typeof WebSocket === "function") {
      check(`${label}: WebSocket is available`, r.websocket === "function", r);
    } else {
      check(`${label}: WebSocket is absent on Node < 22 as expected`, r.websocket === "undefined", r);
    }
    check(`${label}: environment is scrubbed`, r.marker === "" && r.home === "", r);
    check(`${label}: reads outside the workspace are denied`, r.outside === "ERR_ACCESS_DENIED", r);
  }

  // --- no containment ---
  const open = run({ contained: false });
  check("contained: false: network modules load", open.https === "ok" && open.net === "ok", open);
  check("contained: false: fetch is available", open.fetch === "function", open);
  check("contained: false: environment is inherited", open.marker === marker, open);
  check("contained: false: reads outside the workspace work", open.outside === "outside-content", open);

  // --- errors keep working in both shapes ---
  const boomContained = executeJs('throw new Error("boom-contained")', { cwd, contained: true });
  check(
    "contained: an uncaught error is reported",
    !boomContained.ok && boomContained.stderr_tail.includes("boom-contained") && !boomContained.stderr_tail.includes("Module._load"),
    boomContained.stderr_tail,
  );
  const boomOpen = executeJs('throw new Error("boom-open")', { cwd, contained: false });
  check("uncontained: an uncaught error is reported", !boomOpen.ok && boomOpen.stderr_tail.includes("boom-open"), boomOpen.stderr_tail);
  const timeoutOpen = executeJs("while (true) {}", { cwd, contained: false, timeout: 300 });
  check("uncontained: the timeout still applies", !timeoutOpen.ok && timeoutOpen.timed_out, timeoutOpen);

  // --- VENIRA_JS_EXEC_MODE resolution ---
  const workspaceUrl = pathToFileURL(path.resolve(cwd, "lib", "workspace.ts")).href;
  const resolveScript =
    `import(${JSON.stringify(workspaceUrl)})` +
    `.then(m => console.log(JSON.stringify({ mode: m.JS_EXEC_MODE, allow: m.ALLOW_JS_EXEC, approval: m.JS_EXEC_APPROVAL, contained: m.JS_EXEC_CONTAINED })))` +
    `.catch(e => { console.log(JSON.stringify({ error: String(e && e.message || e) })); });`;
  function resolveMode(value: string | undefined, permissionMode?: string): Record<string, unknown> {
    const env: NodeJS.ProcessEnv = { ...process.env, VENIRA_WORKSPACE: cwd };
    delete env.VENIRA_JS_EXEC_MODE;
    if (value !== undefined) env.VENIRA_JS_EXEC_MODE = value;
    delete env.VENIRA_PERMISSION_MODE;
    if (permissionMode !== undefined) env.VENIRA_PERMISSION_MODE = permissionMode;
    const r = spawnSync(process.execPath, ["--import", "tsx", "-e", resolveScript], { cwd, env, encoding: "utf8", timeout: 60_000 });
    const lines = (r.stdout ?? "").trim().split(/\r?\n/);
    try {
      return JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
    } catch {
      return { error: `unparseable: ${r.stdout} ${r.stderr}` };
    }
  }

  const table: Array<[string | undefined, string | undefined, string, boolean, boolean, boolean]> = [
    // value, permissionMode, mode, allow, approval, contained
    [undefined, undefined, "off", false, false, true],
    ["", undefined, "off", false, false, true],
    ["off", undefined, "off", false, false, true],
    ["ask", undefined, "ask", true, false, true],
    ["ask", "manual", "ask", true, true, true],
    ["ask", "best_effort", "ask", true, true, true],
    ["ask", "allow_all", "ask", true, false, true],
    ["semi-auto", undefined, "semi-auto", true, false, true],
    ["auto", undefined, "auto", true, false, false],
    ["  SEMI-AUTO ", undefined, "semi-auto", true, false, true],
    ["AUTO", undefined, "auto", true, false, false],
  ];
  for (const [value, permissionMode, mode, allow, approval, contained] of table) {
    const r = resolveMode(value, permissionMode);
    check(
      `mode ${value === undefined ? "(unset)" : JSON.stringify(value)}${permissionMode ? ` perm=${permissionMode}` : ""} -> ${mode} (allow=${allow}, approval=${approval}, contained=${contained})`,
      r.mode === mode && r.allow === allow && r.approval === approval && r.contained === contained,
      r,
    );
  }
  const bogus = resolveMode("semi_auto");
  check(
    "an unknown mode fails closed and names every valid mode",
    typeof bogus.error === "string" && bogus.error.includes("[config_invalid]") && bogus.error.includes("semi-auto"),
    bogus,
  );

  // --- roadmap item 15 (P2): a snippet the agent can actually use ---
  const esmRequire = executeJs(
    'const fs = require("node:fs"); const names = fs.readdirSync(".").length; await Promise.resolve(); console.log(names >= 0);',
    { cwd, contained: true },
  );
  check(
    "a snippet with top-level await still has require",
    esmRequire.ok && esmRequire.stdout_tail.includes("true"),
    { error: esmRequire.error, stderr: esmRequire.stderr_tail },
  );

  const topLevelReturn = executeJs("return 42;", { cwd, contained: true });
  check(
    "a top-level return explains how to return a value",
    !topLevelReturn.ok &&
      /top-level `return` is not allowed/i.test(topLevelReturn.stderr_tail + (topLevelReturn.error ?? "")),
    { error: topLevelReturn.error, stderr: topLevelReturn.stderr_tail.slice(0, 300) },
  );

  const timedOut = executeJs("while (true) {}", { cwd, contained: true, timeout: 400 });
  check(
    "a timeout is reported as a timeout, not as a spawn error",
    !timedOut.ok &&
      timedOut.timed_out &&
      /did not finish within/.test(timedOut.error ?? "") &&
      !/ETIMEDOUT/.test(timedOut.error ?? ""),
    { error: timedOut.error, timed_out: timedOut.timed_out },
  );

  const netImport = executeJs('import https from "node:https"; console.log(typeof https);', {
    cwd,
    contained: true,
  });
  check(
    "a static import of a network module runs in every mode (network is always open)",
    netImport.ok && netImport.stdout_tail.includes("object"),
    { error: netImport.error, stdout: netImport.stdout_tail },
  );
  const netImportOpen = executeJs('import https from "node:https"; console.log(typeof https);', {
    cwd,
    contained: false,
  });
  check(
    "uncontained: the same import runs (the operator opted out)",
    netImportOpen.ok && netImportOpen.stdout_tail.includes("object"),
    { error: netImportOpen.error, stdout: netImportOpen.stdout_tail },
  );
} finally {
  fs.rmSync(outsideDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nJS executor tests FAILED (${failed} of ${n} checks).`);
  process.exit(1);
}
console.log(`\nJS executor tests passed (${n} checks).`);
