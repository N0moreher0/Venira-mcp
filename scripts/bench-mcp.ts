/**
 * Bench end-to-end qua MCP stdio: node dist/server.js.
 * Mở rộng với read_ranges, recent_files, health (dễ đo).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    VENIRA_UNRESTRICTED: "1",
  },
  stderr: "pipe",
});

const client = new Client({ name: "bench", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>) => {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args });
  return { ms: performance.now() - started, result };
};

const text = (result: unknown) => JSON.stringify(result);
const stats = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2);
  return {
    avg: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
    p50: at(0.5),
    p95: at(0.95),
    max: at(1),
  };
};

const out: Record<string, unknown> = {};

const tools = await client.listTools();
out.tool_count = tools.tools.length;

// Warmup vài lần để cache gắn với một session
for (let i = 0; i < 3; i++) await client.callTool({ name: "project_read_file", arguments: { relative_path: "package.json" } });

const first = await call("project_read_file", { relative_path: "server.ts" });
out.first_call_ms = +first.ms.toFixed(1);
out.first_bytes = text(first.result).length;
out.first_ok = !(first.result as { isError?: boolean }).isError;

const reads: number[] = [];
for (let i = 0; i < 50; i++) reads.push((await call("project_read_file", { relative_path: "server.ts", max_bytes: 8192 })).ms);
out.read_same_file_50 = stats(reads);

const files = ["server.ts", "package.json", "tsconfig.json", "opencode.example.json", "lib/workspace.ts", "lib/corehost.ts", "tools/project.ts", "scripts/smoke.ts"];
const distinct: number[] = [];
for (const file of files) distinct.push((await call("project_read_file", { relative_path: file, max_bytes: 8192 })).ms);
out.read_distinct_8 = stats(distinct);

const batch: number[] = [];
for (let i = 0; i < 3; i++) {
  batch.push((await call("project_read_batch", { requests: files.map((file) => ({ operation: "read_file", arguments: { relative_path: file, max_bytes: 8192 } })) })).ms);
}
out.read_batch_8_of_8 = stats(batch);

const infos: number[] = [];
for (let i = 0; i < 30; i++) infos.push((await call("project_get_file_info", { relative_path: "server.ts" })).ms);
out.get_file_info_30 = stats(infos);

const searches: number[] = [];
for (let i = 0; i < 10; i++) searches.push((await call("project_search", { query: "project_read_file", kind: "literal_content" })).ms);
out.search_10 = stats(searches);

const listRun = await call("project_list_files", { depth: 2, limit: 50 });
out.list_ok = !(JSON.parse(String((listRun.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}")).error?.code);
out.list_bytes = String(
  (listRun.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}",
).length;

const health = await call("project_health", { include_audit: false });
out.health = health.ms.toFixed(1);
out.health_bytes = String(
  (health.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}",
).length;
out.health_ok = JSON.parse(String(
  (health.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}",
)).ok === true;

const ranges = await call("project_read_ranges", {
  relative_path: "server.ts",
  ranges: [{ start_line: 1, end_line: 10 }, { start_line: 20, end_line: 30 }],
});
out.read_ranges_ms = ranges.ms.toFixed(1);
out.read_ranges_bytes = text(ranges.result).length;
out.read_ranges_ok = ((ranges.result as { content?: { text?: string }[] })?.content?.[0]?.text?.includes('"ok":true') ?? false);

const recent = await call("project_recent_files", { relative_path: ".", limit: 20 });
out.recent_files_ms = recent.ms.toFixed(1);
out.recent_files_bytes = text(recent.result).length;
out.recent_files_ok = ((recent.result as { content?: { text?: string }[] })?.content?.[0]?.text?.includes('"ok":true') ?? false);

await client.close();
console.log(JSON.stringify(out, null, 2));