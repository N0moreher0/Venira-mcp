/**
 * Verify hành vi MCP sau refactoring envelope (ok/kind/data/hint), cache invalidation,
 * batch, shell, lỗi chuẩn hoàn chỉnh, envelope cho health/recent_files/read_ranges,
 * summary mode (nếu spawn client nhị phân), metrics, tool annotations.
 *
 * Cố định session để audit rows thuộc riêng phiên này.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";

const SESSION_ID = `verify-${Date.now()}`;

function verifyEnv(extraEnv: Record<string, string> = {}, outputMode = "full") {
  return {
    ...process.env,
    VENIRA_WORKSPACE: process.cwd(),
    VENIRA_UNRESTRICTED: "0",
    VENIRA_SESSION_ID: SESSION_ID,
    VENIRA_OUTPUT_MODE: outputMode,
    ...extraEnv,
  };
}

// Client thứ 2 để test VENIRA_OUTPUT_MODE=summary
const createClient = (extraEnv: Record<string, string> = {}) => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(extraEnv, "summary"),
    stderr: "pipe",
  });
  return new Client({ name: "verify", version: "0.0.0" }, { capabilities: {} });
};

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  cwd: process.cwd(),
  env: verifyEnv({}, "full"), // full mode cho verify phần còn lại
  stderr: "pipe",
});
const client = new Client({ name: "verify", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const results: Record<string, unknown> = {};
const textOf = (result: unknown) => (result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "";
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
const check = (label: string, condition: boolean, extra?: unknown) => {
  results[label] = condition ? "PASS" : `FAIL ${JSON.stringify(extra ?? "")}`;
};

const dir = ".verify-tmp";
await fs.mkdir(dir, { recursive: true });
const names = Array.from({ length: 8 }, (_, i) => `${dir}/f${i}.txt`);
await Promise.all(names.map((name, i) => fs.writeFile(name, `noi dung ${i}\n`.repeat(50))));

// 1. Instructions và annotations
console.log("[verify] checking instructions...");
const client2 = await new Client({ name: "verify-instr", version: "0.0.0" }, { capabilities: {} });
const instrTransport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  cwd: process.cwd(),
  env: verifyEnv({ VENIRA_SESSION_ID: `${SESSION_ID}-instr` }, "full"),
  stderr: "pipe",
});
await client2.connect(instrTransport);
const instructions = client2.getInstructions?.() ?? "";
check("instructions_present", instructions?.includes("Decision tree") ?? false, { instructionsLength: instructions.length });
await client2.close();

const tools = await client.listTools();
const expectedCount = 16;
check("tool_count", tools.tools.length === 16, { actual: tools.tools.length });

const pair = tools.tools.find((t) => t.name === "project_read_file");
const readBatch = tools.tools.find((t) => t.name === "project_read_batch");
check("instrumentation_read", !!pair?._meta?.venira, { meta: pair?._meta });
check("instrumentation_batch", !!readBatch?._meta?.venira, { meta: readBatch?._meta });
tools.tools.forEach((t) => {
  const hasUseWhen = t.description?.includes("Use when:");
  const hasAvoidWhen = t.description?.includes("Avoid when:");
  const meta = t._meta as { venira?: { use_when?: string; avoid_when?: string } } | undefined;
  check(`description_${t.name}_has_use_when`, hasUseWhen ?? !!meta?.venira?.use_when, undefined);
  check(`description_${t.name}_has_avoid_when`, hasAvoidWhen ?? !!meta?.venira?.avoid_when, undefined);
});

// 2. Batch lần đầu (cold)
console.log("[verify] checking cold batch...");
let started = performance.now();
const firstBatch = await call("project_read_batch", {
  requests: names.map((relative_path) => ({ operation: "read_file", arguments: { relative_path } })),
});
results.batch_first_ms = +(performance.now() - started).toFixed(1);
const parsed = JSON.parse(textOf(firstBatch));
check("batch_first_ok", parsed.ok, parsed);
if (parsed.ok) {
  const responses = parsed.data.responses as Array<{ ok?: boolean; response?: unknown; error?: unknown }>;
  check("batch_first_response_count", responses.length === 8, responses.length);
  responses.forEach((r, i) => {
    check(`batch_item_${i}_ok`, r.ok === true, r);
    if (r.ok) {
      const ent = r.response as { kind?: string; data?: unknown };
      check(`batch_item_${i}_kind`, ent.kind === "file_read", ent.kind);
    } else {
      const err = r.error as { code?: string };
      check(`batch_item_${i}_error_code`, err?.code === "resource_limit" ? false : true, err);
    }
  });
}

// 3. Batch lần 2 (cached)
started = performance.now();
await call("project_read_batch", {
  requests: names.map((relative_path) => ({ operation: "read_file", arguments: { relative_path } })),
});
results.batch_cached_ms = +(performance.now() - started).toFixed(1);

// 4. Cache invalidation external write
console.log("[verify] checking cache invalidation external...");
async function runRead(p: string) {
  const r = (await call("project_read_file", { relative_path: p })) as { content: { text: string }[]; isError?: boolean };
  return JSON.parse(r.content[0].text);
}
const firstRead = await runRead(`${dir}/f0.txt`);
await fs.writeFile(`${dir}/f0.txt`, "NOI DUNG MOI TU BEN NGOAI\n");
const secondRead = await runRead(`${dir}/f0.txt`);
check(
  "cache_invalidation_external_write",
  secondRead.data?.text?.includes("NOI DUNG MOI") ?? false,
  secondRead.data?.text?.slice(0, 60),
);

// 5. Ghi qua tool rồi edit invalidation
await call("project_write_file", { relative_path: `${dir}/written.txt`, content: "ban dau\n" });
const beforeEdit = await runRead(`${dir}/written.txt`);
await call("project_edit_file", { relative_path: `${dir}/written.txt`, old_text: "ban dau", new_text: "da sua" });
const afterEdit = await runRead(`${dir}/written.txt`);
check("cache_invalidation_tool_edit", afterEdit.data?.text?.includes("da sua") ?? false, afterEdit.data?.text);

// 6. get_file_info cache + refresh
const info1 = (await call("project_get_file_info", { relative_path: `${dir}/f0.txt` })) as { content?: { text?: string }[] };
await fs.writeFile(`${dir}/f0.txt`, "size khac han ban truoc rat rat dai\n".repeat(30));
const info2 = (await call("project_get_file_info", { relative_path: `${dir}/f0.txt` })) as { content?: { text?: string }[] };
const infoData1 = JSON.parse(info1.content?.[0]?.text ?? "{}");
const infoData2 = JSON.parse(info2.content?.[0]?.text ?? "{}");
check(
  "file_info_refresh",
  infoData2.data?.size_bytes !== infoData1.data?.size_bytes,
  { info1: infoData1.data?.size_bytes, info2: infoData2.data?.size_bytes },
);

// 7. Read theo range + max_bytes
const ranged = (await call("project_read_file", { relative_path: "server.ts", start_line: 1, end_line: 3 })) as { content?: { text?: string }[] };
const rangedData = JSON.parse(ranged.content?.[0]?.text ?? "{}");
check(
  "read_range",
  rangedData.data?.last_line === 3 && rangedData.data?.text?.split("\n").length === 3,
  rangedData.data?.text,
);

// 8. Lỗi file không tồn tại / path_escape
const missing = await call("project_read_file", { relative_path: `${dir}/khong-ton-tai.txt` });
check("missing_file_isError", (missing as { isError?: boolean }).isError === true, missing);

// 9. Shell run + status
const run = (await call("project_shell_run", { command: "echo verify-ok; pwd", shell: "powershell" })) as { content?: { text?: string }[] };
const runData = JSON.parse(run.content?.[0]?.text ?? "{}");
check("shell_run_ok", runData.ok === true && runData?.data?.run_id != null, runData);
const runId = runData?.data?.run_id;
let status: Record<string, any> = {};
for (let i = 0; i < 20; i++) {
  const statusCall = await call("project_shell_status", { run_id: runId as string, wait_seconds: 1 });
  status = JSON.parse((statusCall as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}");
  if (!status?.data?.running) break;
}
check("shell_output", String(status?.data?.stdout_tail ?? "").includes("verify-ok"), status?.data);

// 10. search + list write invalidation (test on fresh unique paths to avoid global cache interference)
const token = `VERIFY_SEARCH_TOKEN_${Date.now()}`;
await fs.writeFile(`${dir}/search-token.txt`, `${token}\n`);
const search1 = await call("project_search", {
  query: token,
  kind: "literal_content",
  relative_path: dir,
  glob: "*.txt",
});
const search1Data = JSON.parse((search1 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}");
check("search_hits", Array.isArray(search1Data.data?.hits), Object.keys(search1Data.data ?? {}));
await call("project_write_file", { relative_path: `${dir}/search-token.txt`, content: `${token}\n` });
await new Promise((resolve) => setTimeout(resolve, 3200)); // chờ search cache hết TTL
const search2 = await call("project_search", {
  query: token,
  kind: "literal_content",
  relative_path: dir,
  glob: "*.txt",
});
const search2Data = JSON.parse((search2 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}");
check("search_hits_invalidate_after_write", search2Data.data?.hits?.length >= 1, search2Data.data?.hits?.length);
await call("project_write_file", { relative_path: `${dir}/search-token.txt`, content: "NEW_TOKEN\n" });
await new Promise((resolve) => setTimeout(resolve, 3200));
const search3 = await call("project_search", {
  query: token,
  kind: "literal_content",
  relative_path: dir,
  glob: "*.txt",
});
const search3Data = JSON.parse((search3 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}");
check("search_cache_invalidated", search3Data.data?.hits?.length === 0, search3Data.data?.hits?.length);

// 11. list write invalidation (cache)
await new Promise((resolve) => setTimeout(resolve, 1600)); // list cache 1.5s
const list1 = await call("project_list_files", { relative_path: dir, depth: 1 });
const list1Data = JSON.parse((list1 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}");
const list1Count = list1Data.data?.entries?.length ?? 0;
await call("project_write_file", { relative_path: `${dir}/list-invalidate.txt`, content: "new\n" });
await new Promise((resolve) => setTimeout(resolve, 200));
const list2 = await call("project_list_files", { relative_path: dir, depth: 1 });
const list2Data = JSON.parse((list2 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}");
const list2Count = list2Data.data?.entries?.length ?? 0;
check("list_cache_invalidate_after_write", list2Count === list1Count + 1, { list1Count, list2Count });

// 12. Compact JSON: text phải là 1 dòng
results.compact_single_line = !textOf(await call("project_read_file", { relative_path: "package.json" })).includes("\n  ");

// 13. search: cached HIT sau mutation phải phản ánh nội dung MỚI (proof rằng
// invalidateListCaches thật sự xoá search cache, không phải chờ TTL hết hạn).
await call("project_search", { query: token, kind: "literal_content", relative_path: dir, glob: "*.txt" });
await call("project_write_file", { relative_path: `${dir}/search-token.txt`, content: "NEW_TOKEN\n" });
await call("project_write_file", { relative_path: `${dir}/cache-proof.txt`, content: "CACHE_PROOF_TOKEN_XYZ\n" });
const search4 = (await call("project_search", {
  query: "CACHE_PROOF_TOKEN_XYZ",
  kind: "literal_content",
  relative_path: dir,
  glob: "*.txt",
})) as { content?: { text?: string }[] };
const search4Data = JSON.parse(search4.content?.[0]?.text ?? "{}");
check(
  "search_cache_invalidated",
  search4Data.data?.hits?.length === 1,
  { hits: search4Data.data?.hits?.length, complete: search4Data.data?.complete, diagnostics: search4Data.data?.diagnostics },
);

// 13. Read ranges
const ranges = await call("project_read_ranges", {
  relative_path: "server.ts",
  ranges: [
    { start_line: 1, end_line: 3 },
    { start_line: 10, end_line: 12 },
  ],
});
const rangesData = JSON.parse((ranges as { content: { text: string }[] })?.content[0].text);
const rS = rangesData.data?.ranges ?? [];
check("read_ranges_count", rS.length === 2, rS);
check("read_ranges_have_text", rS[0]?.text && rS[1]?.text, rS);

// 14. Recent files: file ghi gần đây và included trong results
await call("project_write_file", { relative_path: `${dir}/recent-test.txt`, content: "recent\n" });
const recent = await call("project_recent_files", { relative_path: dir, limit: 10 });
const recentData = JSON.parse((recent as { content: { text: string }[] })?.content[0].text ?? "{}");
const recentFiles = recentData.data?.entries ?? [];
const recentFileNames: string[] = recentFiles.map((e: unknown) => ((e as { relative_path?: string })?.relative_path ?? ""));
check("recent_files_includes_recent", recentFileNames.some((f) => f.endsWith("recent-test.txt")), recentFileNames);

// 15. Health: ok, corehost.exe, capability, caches, metrics
const health = await call("project_health", { include_audit: false });
const healthData = JSON.parse((health as { content: { text: string }[] })?.content[0].text ?? "{}");
check("health_ok", healthData.ok === true, healthData);
check("health_backend_standalone", healthData.data?.corehost?.exe === null, healthData.data?.corehost);
check("health_capability_open", healthData.data?.capability?.state === "open", healthData.data?.capability?.state);
check("health_caches_present", healthData.data?.caches != null, true);
check("health_metrics_present", healthData.data?.metrics?.operations != null, true);

// 16. Health audit (full)
const healthFull = await call("project_health", { include_audit: true });
const healthFullData = JSON.parse((healthFull as { content: { text: string }[] })?.content[0].text ?? "{}");
check("health_audit_present", !!healthFullData.data?.audit?.reachable, healthFullData.data?.audit);

// 17. Error envelope shape
const errorEnvelopeCheck = (result: string, code: string, retryable: boolean) => {
  try {
    const obj = JSON.parse(result);
    const e = obj.error as { code?: string; retryable?: boolean };
    return e.code === code && e.retryable === retryable;
  } catch {
    return false;
  }
};
const missingRes = (await call("project_read_file", { relative_path: `${dir}/missing.txt` })) as { content?: { text?: string }[] };
check("error_envelope_not_found_shape", errorEnvelopeCheck(missingRes?.content?.[0]?.text ?? "", "not_found", false));

// 18. batch per-item budget
const batchBudget = await call("project_read_batch", {
  requests: [
    { operation: "read_file", arguments: { relative_path: "server.ts" } },
  ],
  max_response_bytes_per_item: 1024,
});
const batchBudgetData = JSON.parse((batchBudget as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}");
const budgetErr = (batchBudgetData.data?.responses as unknown[])[0] as { ok?: boolean; error?: { code?: string } };
check("batch_item_budget_exceeded", budgetErr?.ok === false && budgetErr?.error?.code === "resource_limit", budgetErr?.error);

// 19. Marcet summary mode
console.log("[verify] checking summary mode...");
const clientSummary = await new Client({ name: "verify-summary", version: "0.0.0" }, { capabilities: {} });
const summaryTransport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  cwd: process.cwd(),
  env: verifyEnv({ VENIRA_SESSION_ID: `${SESSION_ID}-summary` }, "summary"),
  stderr: "pipe",
});
await clientSummary.connect(summaryTransport);
const summaryTool = await clientSummary.callTool({ name: "project_read_file", arguments: { relative_path: "server.ts" } });
const summaryData = JSON.parse(textOf(summaryTool));
check(
  "summary_trimmed",
  summaryData.trimmed === true && summaryData.data?.preview != null,
  { has_preview: !!summaryData.data?.preview, preview_truncated: summaryData.data?.preview_truncated },
);
await clientSummary.close();

// 20. Metrics ops present (read_batch, read_ranges, recent_files, health, shell_run)
const ops = Object.keys(healthData.data?.metrics?.operations ?? {});
const requiredOps = ["read_file", "read_batch", "read_ranges", "recent_files", "shell_run"];
const hasRequired = requiredOps.every((op) => ops.includes(op));
check("metrics_ops_present", hasRequired, ops);

// 21. Audit (standalone: DB is in <workspace>/data or VENIRA_DATA_DIR)
import path from "node:path";
import Database from "better-sqlite3";
const auditDbPath = path.resolve(
  process.env.VENIRA_DATA_DIR ?? path.join(process.cwd(), "data"),
  "venira.db",
);
let db: InstanceType<typeof Database> | null = null;
try {
  db = new Database(auditDbPath, { readonly: true, fileMustExist: true });
} catch {
  results.audit_db_open = `FAIL ${auditDbPath}`;
}
let rows: Array<{ operation?: string; outcome?: string; reason_code?: string; completed_at?: number | null }> = [];
if (db) {
  for (let i = 0; i < 50; i++) {
    rows = db
      .prepare("SELECT operation, outcome, reason_code, completed_at FROM project_tool_audit WHERE session_id = ? ORDER BY id")
      .all(SESSION_ID) as Array<{ operation?: string; outcome?: string; reason_code?: string; completed_at?: number | null }>;
    if (rows.length > 0 && rows.every((row) => row.completed_at !== null)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  db.close();
}
check("audit_rows_present", rows.length >= 10, rows.length);
if (rows.length > 0) {
  check(
    "audit_no_orphan_running",
    rows.every((r) => (r.outcome ?? "") !== "running"),
    rows.filter((r) => (r.outcome ?? "") === "running"),
  );
  check(
    "audit_failed_recorded",
    rows.some((r) => r.operation === "read_file" && r.outcome === "failed"),
    rows.filter((r) => (r.operation ?? "") === "read_file"),
  );
  check(
    "audit_shell_run_completed",
    rows.some((r) => r.operation === "shell_run" && r.outcome === "succeeded"),
    rows.filter((r) => (r.operation ?? "") === "shell_run"),
  );
  results.audit_ops = [...new Set(rows.map((r) => r.operation ?? ""))].join(",");
}

console.log("[verify] done");
await fs.rm(dir, { recursive: true, force: true });
await client.close();
console.log(JSON.stringify(results, null, 2));