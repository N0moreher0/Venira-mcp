/**
 * Token benchmark across `VENIRA_TOOL_MODE` presets (ROADMAP_MINIMAL_MODE.md Phase 5).
 *
 * The same five-file refactor is run through a real MCP stdio client in
 * `default`, `core` and `minimal` mode, on an identical fixture workspace. Two
 * things are measured, both reproducible:
 *
 *   1. The surface the model must read once per session: the server
 *      `instructions` plus the whole `tools/list` payload (names, descriptions,
 *      JSON schemas). In `minimal` this payload also carries the `.d.ts` SDK
 *      contract.
 *   2. The reference plan for the task: the arguments the model must emit and
 *      the bytes the server returns, for read -> edit -> verify-shell.
 *
 * Token counts are `bytes / 4`, the same rough ratio `scripts/test-schema-budget.ts`
 * uses. It is an estimate of *context* cost, not a tokenizer run: no model is
 * called here, so the numbers are deterministic and diffable between versions.
 *
 * Standalone: `npm run bench:modes` (prints one JSON object).
 * Also embedded in `npm run bench:mcp` under the `modes` key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ModeName = "default" | "core" | "minimal";

type ModeResult = {
  tool_count: number;
  instructions_bytes: number;
  tools_list_bytes: number;
  /** instructions + tools/list: what the model pays before the first call. */
  surface_bytes: number;
  surface_tokens: number;
  /** Model -> server calls in the reference plan. */
  turns: number;
  call_bytes: number;
  result_bytes: number;
  task_tokens: number;
  /** surface + task, the comparable total. */
  total_tokens: number;
  task_ok: boolean;
  task_ms: number;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURE: Record<string, string> = {
  "src/a.ts": "export const a = (x: number) => x + 1;\n",
  "src/b.ts": "export const b = (x: number) => x + 2;\n",
  "src/c.ts": "export const c = (x: number) => x + 3;\n",
  "src/d.ts": "export const d = (x: number) => x + 4;\n",
  "src/e.ts": "export const e = (x: number) => x + 5;\n",
};

/** The same edit in every mode: add a `// touched` marker line to five files. */
const EDITS = Object.keys(FIXTURE).map((file) => ({
  file,
  old_text: "export const",
  new_text: "// touched\nexport const",
}));

const text = (result: unknown): string => {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return String(content?.[0]?.text ?? "{}");
};

const estimate = (bytes: number): number => Math.ceil(bytes / 4);

async function withModeClient<T>(mode: ModeName, fn: (client: Client, workspace: string) => Promise<T>): Promise<T> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `venira-bench-${mode}-`));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `venira-bench-${mode}-data-`));
  for (const [relative, content] of Object.entries(FIXTURE)) {
    const full = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: repoRoot,
    env: {
      ...process.env,
      VENIRA_UNRESTRICTED: "1",
      VENIRA_TOOL_MODE: mode,
      VENIRA_WORKSPACE: workspace,
      VENIRA_DATA_DIR: dataDir,
      VENIRA_JS_EXEC_MODE: "auto",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: `bench-modes-${mode}`, version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client, workspace);
  } finally {
    await client.close();
    for (const dir of [workspace, dataDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may keep the audit DB open until the child exits.
      }
    }
  }
}

async function benchOne(mode: ModeName): Promise<ModeResult> {
  return withModeClient(mode, async (client) => {
    const listed = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    const toolsListJson = JSON.stringify(listed.tools);
    const surfaceBytes = Buffer.byteLength(instructions, "utf8") + Buffer.byteLength(toolsListJson, "utf8");

    const calls: Array<{ name: string; args: unknown }> = [];
    let resultBytes = 0;
    let taskOk = false;
    const started = performance.now();

    if (mode === "minimal") {
      // One turn, one tool: read the five files, edit them atomically, confirm.
      const code = [
        `const files = ${JSON.stringify(Object.keys(FIXTURE))};`,
        `const read = await venira.read(files);`,
        `const edits = ${JSON.stringify(EDITS)}.map((e) => ({ relative_path: e.file, old_text: e.old_text, new_text: e.new_text }));`,
        `const edit = await venira.edit(edits, "bench modes");`,
        `const shell = await venira.shell("echo refactor-ok");`,
        `console.log("BENCH:" + [read.ok, edit.ok, shell.ok].join(","));`,
      ].join("\n");
      calls.push({ name: "execute_js", args: { code } });
      const response = await client.callTool({ name: "execute_js", arguments: { code, timeout_s: 120 } });
      const body = text(response);
      resultBytes = Buffer.byteLength(body, "utf8");
      const envelope = JSON.parse(body) as { ok?: boolean; data?: { stdout_tail?: string } };
      taskOk = envelope.ok === true && String(envelope.data?.stdout_tail ?? "").includes("BENCH:true,true,true");
    } else {
      const readArgs = { requests: Object.keys(FIXTURE).map((relative_path) => ({ relative_path })) };
      calls.push({ name: "read_file", args: readArgs });
      const read = await client.callTool({ name: "read_file", arguments: readArgs });
      resultBytes += Buffer.byteLength(text(read), "utf8");

      const editArgs = {
        edits: EDITS.map((e) => ({ relative_path: e.file, old_text: e.old_text, new_text: e.new_text })),
        reason: "bench modes",
      };
      calls.push({ name: "edit_file", args: editArgs });
      const edit = await client.callTool({ name: "edit_file", arguments: editArgs });
      resultBytes += Buffer.byteLength(text(edit), "utf8");

      const shellArgs = { command: "echo refactor-ok", background: 0 };
      calls.push({ name: "shell_run", args: shellArgs });
      const shell = await client.callTool({ name: "shell_run", arguments: shellArgs });
      const shellBody = text(shell);
      resultBytes += Buffer.byteLength(shellBody, "utf8");
      taskOk =
        JSON.parse(text(read)).ok === true &&
        JSON.parse(text(edit)).ok === true &&
        String(
          (JSON.parse(shellBody) as { data?: { stdout?: string; stdout_tail?: string } }).data?.stdout ??
            (JSON.parse(shellBody) as { data?: { stdout_tail?: string } }).data?.stdout_tail ??
            "",
        ).includes("refactor-ok");
    }

    const taskMs = +(performance.now() - started).toFixed(1);
    const callBytes = calls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.args), "utf8"), 0);
    const taskTokens = estimate(callBytes + resultBytes);
    return {
      tool_count: listed.tools.length,
      instructions_bytes: Buffer.byteLength(instructions, "utf8"),
      tools_list_bytes: Buffer.byteLength(toolsListJson, "utf8"),
      surface_bytes: surfaceBytes,
      surface_tokens: estimate(surfaceBytes),
      turns: calls.length,
      call_bytes: callBytes,
      result_bytes: resultBytes,
      task_tokens: taskTokens,
      total_tokens: estimate(surfaceBytes + callBytes + resultBytes),
      task_ok: taskOk,
      task_ms: taskMs,
    };
  });
}

export async function benchModes(): Promise<Record<ModeName, ModeResult>> {
  const out = {} as Record<ModeName, ModeResult>;
  for (const mode of ["default", "core", "minimal"] as const) out[mode] = await benchOne(mode);
  return out;
}

/** Markdown table for benchmarks.md / BENCHMARK-*.md. */
export function modesTable(modes: Record<ModeName, ModeResult>): string {
  const row = (name: ModeName, r: ModeResult) =>
    `| \`${name}\` | ${r.tool_count} | ${r.surface_bytes} B (~${r.surface_tokens} tok) | ${r.turns} | ${r.call_bytes + r.result_bytes} B (~${r.task_tokens} tok) | **~${r.total_tokens} tok** | ${r.task_ok ? "MATCH" : "FAIL"} |`;
  return [
    "| Mode | Tools | Surface (instructions + tools/list) | Turns | Task calls + results | Total (est.) | Task |",
    "|---|---:|---:|---:|---:|---:|---|",
    row("default", modes.default),
    row("core", modes.core),
    row("minimal", modes.minimal),
  ].join("\n");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const modes = await benchModes();
  console.log(JSON.stringify(modes, null, 2));
  console.log(modesTable(modes));
}
