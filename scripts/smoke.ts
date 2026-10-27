/**
 * Run: npm run smoke
 * Verifies the standalone corehost (pure Node, no Rust binary):
 *   1. Spawns the in-process CoreHost
 *   2. Opens a scope
 *   3. Lists a directory
 *   4. Reads a file
 *   5. Confirms path-escape is blocked
 */
import { CoreHost } from "../lib/corehost.js";
import { WORKSPACE, toHostPath } from "../lib/workspace.js";
import crypto from "node:crypto";

const host = new CoreHost();
const session = `smoke-${process.pid}`;

async function run(name: string, args: Record<string, unknown>) {
  const scope = (await host.call("project_tool.scope.open", {
    session_id: session,
    project_id: null,
    permission_mode: "allow_all",
  })) as { capability_id: string; project_id: string };

  const request = {
    contract_version: 1,
    request_id: crypto.randomUUID(),
    session_id: session,
    project_id: scope.project_id,
    capability_id: scope.capability_id,
    operation: { name, arguments: args },
  };
  const result = await host.call("project_tool.execute", request, 30_000);

  await host.call("project_tool.scope.close", {
    session_id: session,
    project_id: scope.project_id,
    capability_id: scope.capability_id,
  });
  return result;
}

try {
  console.log("backend  :", "standalone (pure Node, no external binary)");
  console.log("workspace:", WORKSPACE);

  const list = (await run("list_files", { relative_path: toHostPath("."), limit: 10 })) as any;
  console.log("list_files OK:", JSON.stringify(list).slice(0, 300));

  const read = (await run("read_file", { relative_path: toHostPath("package.json") })) as any;
  console.log("read_file OK:", JSON.stringify(read).slice(0, 200));

  try {
    toHostPath("../../etc");
    console.log("!! escape NOT blocked — bug!");
    process.exitCode = 1;
  } catch (e) {
    console.log("escape blocked correctly:", (e as Error).message);
  }
} catch (e) {
  console.error("FAIL:", (e as Error).message);
  process.exitCode = 1;
} finally {
  host.close();
}
