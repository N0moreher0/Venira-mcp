/**
 * Compare selected Venira MCP read tools with equivalent PowerShell commands.
 * The PowerShell process is a native-command proxy, not Codex exec_command: it
 * includes child-process startup but not Codex's tool orchestration layer.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const workspace = process.cwd();
const defaultRuns = 100;
const runsArg = process.argv.find((arg) => arg.startsWith("--runs="));
const runs = runsArg ? Number(runsArg.slice("--runs=".length)) : defaultRuns;
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg?.slice("--only=".length);

if (process.platform !== "win32") {
  throw new Error("bench:tools currently requires Windows PowerShell.");
}
if (!Number.isInteger(runs) || runs < 3 || runs > 200) {
  throw new Error("--runs must be an integer from 3 to 200.");
}

type Envelope = {
  ok?: boolean;
  kind?: string;
  elapsed_ms?: number;
  cached?: boolean;
  truncated?: boolean;
  data?: unknown;
  summary?: unknown;
  hint?: string;
  error?: { code?: string; message?: string };
};

type Sample = {
  tool_ms: number;
  end_to_end_ms: number;
  output_bytes: number;
  cache_hit?: boolean;
  signature: unknown;
};

type Spec = {
  id: string;
  mcp_tool: string;
  cache: "read" | "info" | "list" | "search";
  args: Record<string, unknown>;
  powershell_body: string;
  mcpSignature: (envelope: Envelope) => unknown;
  nativeSignature: (result: Record<string, unknown>) => unknown;
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const normalizeText = (value: unknown): string =>
  String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/g, "");

const basename = (value: unknown): string =>
  String(value ?? "").replace(/\\/g, "/").split("/").pop() ?? "";

const json = (value: unknown): string => JSON.stringify(value);
const ps = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const specs: Spec[] = [
  {
    id: "read_file",
    mcp_tool: "project_read_file",
    cache: "read",
    args: { relative_path: "package.json", start_line: 1, end_line: 25 },
    powershell_body: `
  $lines = @(Get-Content -LiteralPath ${ps("package.json")} -TotalCount 25)
  [pscustomobject]@{ text = [string]::Join([Environment]::NewLine, [string[]]$lines) }
`,
    mcpSignature: (envelope) => normalizeText(asObject(envelope.data).text),
    nativeSignature: (result) => normalizeText(result.text),
  },
  {
    id: "read_batch_3_files",
    mcp_tool: "project_read_batch",
    cache: "read",
    args: {
      max_response_bytes_per_item: 30_000,
      requests: [
        { operation: "read_file", arguments: { relative_path: "package.json", start_line: 1, end_line: 25 } },
        { operation: "read_file", arguments: { relative_path: "README.md", start_line: 1, end_line: 20 } },
        { operation: "read_file", arguments: { relative_path: "lib/corehost.ts", start_line: 1, end_line: 35 } },
      ],
    },
    powershell_body: `
  $files = @(
    @{ path = 'package.json'; lines = 25 },
    @{ path = 'README.md'; lines = 20 },
    @{ path = 'lib/corehost.ts'; lines = 35 }
  )
  $rows = @()
  foreach ($file in $files) {
    $content = @(Get-Content -LiteralPath $file.path -TotalCount $file.lines)
    $rows += [pscustomobject]@{ path = $file.path; text = [string]::Join([Environment]::NewLine, [string[]]$content) }
  }
  [pscustomobject]@{ files = $rows }
`,
    mcpSignature: (envelope) => {
      const data = asObject(envelope.data);
      const responses = Array.isArray(data.responses) ? data.responses : [];
      return responses.map((item) => {
        const response = asObject(asObject(item).response);
        const responseData = asObject(response.data);
        return { path: basename(responseData.relative_path), text: normalizeText(responseData.text) };
      });
    },
    nativeSignature: (result) => {
      const files = result.files;
      return (Array.isArray(files) ? files : []).map((item) => {
        const file = asObject(item);
        return { path: basename(file.path), text: normalizeText(file.text) };
      });
    },
  },
  {
    id: "get_file_info",
    mcp_tool: "project_get_file_info",
    cache: "info",
    args: { relative_path: "lib/corehost.ts" },
    powershell_body: `
  $item = Get-Item -LiteralPath ${ps("lib/corehost.ts")}
  [pscustomobject]@{ name = $item.Name; size_bytes = $item.Length; modified_utc = $item.LastWriteTimeUtc.ToString('o') }
`,
    mcpSignature: (envelope) => {
      const data = asObject(envelope.data);
      return { name: basename(data.relative_path), size_bytes: data.size_bytes };
    },
    nativeSignature: (result) => {
      const data = result;
      return { name: data.name, size_bytes: data.size_bytes };
    },
  },
  {
    id: "list_files_lib",
    mcp_tool: "project_list_files",
    cache: "list",
    args: { relative_path: "lib", depth: 1, limit: 100 },
    powershell_body: `
  $items = @(Get-ChildItem -LiteralPath ${ps("lib")} -Force)
  [pscustomobject]@{ names = @($items | ForEach-Object { $_.Name }); count = $items.Count }
`,
    mcpSignature: (envelope) => {
      const entries = asObject(envelope.data).entries;
      return (Array.isArray(entries) ? entries : []).map((entry) => basename(asObject(entry).relative_path)).sort();
    },
    nativeSignature: (result) => {
      const names = result.names;
      return (Array.isArray(names) ? names : names ? [names] : []).map(String).sort();
    },
  },
  {
    id: "search_literal",
    mcp_tool: "project_search",
    cache: "search",
    args: { kind: "literal_content", query: "VENIRA_USE_RIPGREP", relative_path: "lib/corehost.ts", limit: 20 },
    powershell_body: `
  $file = 'lib/corehost.ts'
  $query = 'VENIRA_USE_RIPGREP'
  $rg = Get-Command rg -ErrorAction SilentlyContinue
  if ($rg) {
    $lines = @(& rg -n -F --no-heading --color never $query $file)
  } else {
    $lines = @(Select-String -LiteralPath $file -SimpleMatch -Pattern $query | ForEach-Object { '{0}:{1}:{2}' -f $file, $_.LineNumber, $_.Line.Trim() })
  }
  [pscustomobject]@{ lines = $lines }
`,
    mcpSignature: (envelope) => {
      const hits = asObject(envelope.data).hits;
      return (Array.isArray(hits) ? hits : []).map((hit) => {
        const value = asObject(hit);
        return { line: value.line_number, snippet: normalizeText(value.snippet).trim() };
      }).sort((a, b) => Number(a.line) - Number(b.line));
    },
    nativeSignature: (result) => {
      const lines = result.lines;
      return (Array.isArray(lines) ? lines : lines ? [lines] : []).flatMap((line) => {
        const match = String(line).match(/^(?:[^:]+:)?(\d+):(.*)$/);
        return match ? [{ line: Number(match[1]), snippet: normalizeText(match[2]).trim() }] : [];
      }).sort((a, b) => a.line - b.line);
    },
  },
];

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  const round = (n: number) => Number(n.toFixed(2));
  return {
    median: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
};

const parseEnvelope = (result: unknown): { envelope: Envelope; text: string } => {
  const content = asObject(result).content;
  const text = Array.isArray(content)
    ? String(content.find((item) => asObject(item).type === "text") && asObject(content.find((item) => asObject(item).type === "text")).text || "")
    : "";
  const envelope = JSON.parse(text) as Envelope;
  if (asObject(result).isError || envelope.ok === false) {
    throw new Error(`${envelope.kind ?? "MCP call"}: ${envelope.error?.message ?? envelope.hint ?? text}`);
  }
  return { envelope, text };
};

const runPowerShellSuite = async (selected: Spec[]) => {
  const repetitions = selected.map((spec) => `
for ($i = 0; $i -lt ${runs}; $i++) {
  $sw.Restart()
  $nativeResult = & {
${spec.powershell_body}
  }
  $sw.Stop()
  $samples.Add([pscustomobject]@{ id = ${ps(spec.id)}; operation_ms = [Math]::Round($sw.Elapsed.TotalMilliseconds, 2); result = $nativeResult })
}
`).join("\n");
  const script = `
$ErrorActionPreference = 'Stop'
$sw = [Diagnostics.Stopwatch]::new()
$samples = [System.Collections.Generic.List[object]]::new()
${repetitions}
[pscustomobject]@{ samples = $samples.ToArray() } | ConvertTo-Json -Depth 8 -Compress
`;
  const started = performance.now();
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { cwd: workspace, windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
  );
  const endToEnd = performance.now() - started;
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const samples = Array.isArray(parsed.samples) ? parsed.samples : [];
  return samples.map((sample) => {
    const row = asObject(sample);
    const result = asObject(row.result);
    return {
      id: String(row.id ?? ""),
      operation_ms: Number(row.operation_ms),
      output_bytes: Buffer.byteLength(json(result)),
      result,
    };
  }).map((sample) => ({ ...sample, suite_end_to_end_ms: Number(endToEnd.toFixed(2)) }));
};

const runMcp = async (client: Client, spec: Spec): Promise<Sample> => {
  const started = performance.now();
  const result = await client.callTool({ name: spec.mcp_tool, arguments: spec.args });
  const endToEnd = performance.now() - started;
  const { envelope, text } = parseEnvelope(result);
  return {
    tool_ms: Number(envelope.elapsed_ms ?? endToEnd),
    end_to_end_ms: endToEnd,
    output_bytes: Buffer.byteLength(text),
    cache_hit: envelope.cached === true,
    signature: spec.mcpSignature(envelope),
  };
};

const measureMcpPhase = async (client: Client, spec: Spec, phase: "cache_miss" | "warm", nativeSamples: Array<{ signature: unknown; operation_ms: number; output_bytes: number; suite_end_to_end_ms: number }>) => {
  const mcp: Sample[] = [];

  if (phase === "warm") {
    await runMcp(client, spec);
  }

  for (let i = 0; i < runs; i++) {
    if (phase === "cache_miss") {
      const cleared = await client.callTool({ name: "project_cache_clear", arguments: { type: spec.cache } });
      parseEnvelope(cleared);
    }

    mcp.push(await runMcp(client, spec));
  }

  const parity = json(mcp[0]?.signature) === json(nativeSamples[0]?.signature);
  const veniraSignature = json(mcp[0]?.signature);
  const nativeSignature = json(nativeSamples[0]?.signature);
  return {
    venira: {
      server_ms: stats(mcp.map((sample) => sample.tool_ms)),
      end_to_end_ms: stats(mcp.map((sample) => sample.end_to_end_ms)),
      payload_bytes: stats(mcp.map((sample) => sample.output_bytes)),
      cache_hits: mcp.filter((sample) => sample.cache_hit).length,
    },
    powershell_proxy: {
      operation_ms: stats(nativeSamples.map((sample) => sample.operation_ms)),
      suite_end_to_end_ms: nativeSamples[0]?.suite_end_to_end_ms,
      payload_bytes: stats(nativeSamples.map((sample) => sample.output_bytes)),
    },
    parity: parity ? "MATCH" : "DIFF",
    parity_detail: parity ? undefined : {
      venira_chars: veniraSignature.length,
      powershell_chars: nativeSignature.length,
      venira_preview: veniraSignature.slice(0, 250),
      powershell_preview: nativeSignature.slice(0, 250),
    },
  };
};

const main = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "venira-tool-compare-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: workspace,
    stderr: "pipe",
    env: {
      ...process.env,
      VENIRA_WORKSPACE: workspace,
      VENIRA_DATA_DIR: dataDir,
      VENIRA_SESSION_ID: `bench-tools-${process.pid}`,
      VENIRA_OUTPUT_MODE: "full",
      VENIRA_PRETTY: "0",
      VENIRA_NETWORK: "0",
      VENIRA_UNRESTRICTED: "0",
      VENIRA_ALLOW_JS_EXEC: "0",
      VENIRA_TOOL_MODE: "expert",
      VENIRA_SECRET_KEYCHAIN: "off",
    },
  });
  const client = new Client({ name: "venira-tool-comparison", version: "1.0.0" }, { capabilities: {} });
  let connected = false;

  try {
    await client.connect(transport);
    connected = true;
    const available = await client.listTools();
    const availableNames = new Set(available.tools.map((tool) => tool.name));
    const selected = only ? specs.filter((spec) => spec.id === only) : specs;
    if (selected.length === 0) throw new Error(`Unknown --only scenario: ${only}`);
    const nativeSamples = await runPowerShellSuite(selected);
    const results = [];
    for (const spec of selected) {
      if (!availableNames.has(spec.mcp_tool)) throw new Error(`Server does not expose ${spec.mcp_tool}`);
      const nativeForSpec = nativeSamples.filter((sample) => sample.id === spec.id).map((sample) => ({
        ...sample,
        signature: spec.nativeSignature(sample.result),
      }));
      if (nativeForSpec.length !== runs) throw new Error(`PowerShell samples missing for ${spec.id}`);
      const cacheMiss = await measureMcpPhase(client, spec, "cache_miss", nativeForSpec);
      const warm = await measureMcpPhase(client, spec, "warm", nativeForSpec);
      results.push({ id: spec.id, runs_per_phase: runs, cache_miss: cacheMiss, warm });
      console.error(`[bench:tools] ${spec.id}: ${cacheMiss.parity}/${warm.parity}`);
    }

    const report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      workspace,
      node: process.version,
      platform: `${process.platform} ${os.release()}`,
      native_tool_proxy: "One PowerShell process loops over each selected native operation; not the Codex exec_command wrapper",
      cache_note: "Venira cache_miss clears only the relevant in-process tool cache. OS filesystem cache remains warm.",
      runs_per_phase: runs,
      results,
    };

    console.log("\n| Task | Cache phase | Venira server p50 | Venira MCP p50 | PowerShell op p50 | PowerShell suite total | Match | Payload bytes V / PS |");
    console.log("|---|---|---:|---:|---:|---:|---|---:|");
    for (const result of results) {
      const row = asObject(result);
      for (const phase of ["cache_miss", "warm"] as const) {
        const values = asObject(row[phase]);
        const venira = asObject(values.venira);
        const powershell = asObject(values.powershell_proxy);
        const vServer = asObject(venira.server_ms);
        const vE2e = asObject(venira.end_to_end_ms);
        const pOp = asObject(powershell.operation_ms);
        const pSuite = powershell.suite_end_to_end_ms;
        const vBytes = asObject(venira.payload_bytes);
        const pBytes = asObject(powershell.payload_bytes);
        console.log(`| ${String(row.id)} | ${phase} | ${vServer.median} ms | ${vE2e.median} ms | ${pOp.median} ms | ${pSuite} ms (shared suite) | ${values.parity} | ${vBytes.median} / ${pBytes.median} |`);
      }
    }
    console.log("\nRaw JSON:");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (connected) await client.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
};

void main().catch((error: unknown) => {
  console.error("[bench:tools] FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
