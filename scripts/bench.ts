/** Bench the standalone corehost (pure Node): ping, read throughput, batch, capability. */
import { CoreHost } from "../lib/corehost.js";
import { WORKSPACE, toHostPath } from "../lib/workspace.js";

process.env.VENIRA_WORKSPACE ??= WORKSPACE;

const host = new CoreHost();
const session = "bench-" + process.pid;
const runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let seqId = 0;
function request(name: string, args: Record<string, unknown>) {
  return {
    contract_version: 1,
    request_id: `bench-${runTag}-${seqId++}`,
    session_id: session,
    project_id: "chat-terminal",
    operation: { name, arguments: args },
  };
}

// Open a long-lived capability once, then use direct execute for speed.
const opened = (await host.call(
  "project_tool.scope.open",
  { session_id: session, project_id: null, permission_mode: "allow_all" },
  15_000,
)) as { capability_id: string; project_id: string };

const direct = (name: string, args: Record<string, unknown>) =>
  host.call(
    "project_tool.execute",
    {
      contract_version: 1,
      request_id: `bench-direct-${runTag}-${seqId++}`,
      session_id: session,
      project_id: opened.project_id,
      capability_id: opened.capability_id,
      operation: { name, arguments: args },
    },
    30_000,
  );

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    avg: +avg.toFixed(2),
    p50: +p(0.5).toFixed(2),
    p95: +p(0.95).toFixed(2),
    min: +sorted[0].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
  };
}

async function timeIt(fn: () => Promise<unknown>) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

const results: Record<string, unknown> = { workspace: WORKSPACE, backend: "standalone-node" };
const step = (label: string) => console.error(`[bench] ${label}`);

try {
  step("ping x100");
  const pings: number[] = [];
  for (let i = 0; i < 100; i++) pings.push(await timeIt(() => host.call("ping", {})));
  results.ping = stats(pings);

  step("direct read_file first");
  results.direct_first_ms = +(await timeIt(() => direct("read_file", { relative_path: toHostPath("package.json") }))).toFixed(2);

  step("direct read_file seq x50");
  const dReads: number[] = [];
  for (let i = 0; i < 50; i++) dReads.push(await timeIt(() => direct("read_file", { relative_path: toHostPath("package.json") })));
  results.direct_read_seq = stats(dReads);

  const files = ["server.ts", "package.json", "tsconfig.json", "lib/workspace.ts", "lib/corehost.ts", "lib/output.ts", "lib/metrics.ts", "lib/version.ts"].map(toHostPath);

  step("direct 8 file tuần tự");
  const dBatchStart = performance.now();
  for (const f of files) await direct("read_file", { relative_path: f });
  results.direct_batch8_seq_ms = +(performance.now() - dBatchStart).toFixed(1);

  step("direct parallel x8");
  results.direct_parallel_8_ms = +(await timeIt(() =>
    Promise.all(Array.from({ length: 8 }, () => direct("read_file", { relative_path: files[0] }))),
  )).toFixed(1);

  step("direct get_file_info x50");
  const infos: number[] = [];
  for (let i = 0; i < 50; i++) infos.push(await timeIt(() => direct("get_file_info", { relative_path: toHostPath("package.json") })));
  results.direct_info_seq = stats(infos);

  step("direct list_files");
  results.list_ms = +(await timeIt(() => direct("list_files", { relative_path: toHostPath("."), depth: 1, limit: 50 }))).toFixed(1);

  step("direct search");
  results.search_ms = +(await timeIt(() => direct("search", { query: "CoreHost", kind: "literal_content", relative_path: toHostPath("."), glob: "*.ts", limit: 20 }))).toFixed(1);

  step("direct shell_run + status");
  const shellStart = performance.now();
  const run = (await direct("shell_run", { command: "echo bench-ok", shell: process.platform === "win32" ? "powershell" : "bash" })) as { result: { data: { run_id: string; running: boolean } } };
  const runId = run.result.data.run_id;
  await new Promise((r) => setTimeout(r, 500));
  await direct("shell_status", { run_id: runId, wait_seconds: 2 });
  results.shell_roundtrip_ms = +(performance.now() - shellStart).toFixed(1);

  step("done");
} catch (error) {
  console.error("[bench] FAILED:", error instanceof Error ? error.message : String(error));
  results.failed = true;
} finally {
  await host.call("project_tool.scope.close", {
    session_id: session,
    project_id: opened.project_id,
    capability_id: opened.capability_id,
  }).catch(() => {});
  host.close();
}

console.log(JSON.stringify(results, null, 2));
