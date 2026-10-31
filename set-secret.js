import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.GITHUB_TOKEN || process.env.VENIRA_GITHUB_TOKEN;

if (!token) {
  console.error("No GITHUB_TOKEN or VENIRA_GITHUB_TOKEN in environment");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/server.js"],
  cwd: process.cwd(),
  env: { ...process.env, VENIRA_WORKSPACE: process.cwd(), VENIRA_UNRESTRICTED: "0", VENIRA_SESSION_ID: `set-secret-${Date.now()}`, VENIRA_OUTPUT_MODE: "full" },
  stderr: "pipe",
});

const client = new Client({ name: "set-secret", version: "0.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  const r = await client.callTool({ name: "project_secret", arguments: { action: "set", name: "GITHUB_TOKEN", value: token } });
  console.log(JSON.stringify(r, null, 2));
  await client.close();
} catch (error) {
  console.error("Error:", error);
  await client.close();
}