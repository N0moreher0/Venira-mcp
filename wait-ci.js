import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function checkCI() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: { ...process.env, VENIRA_WORKSPACE: process.cwd(), VENIRA_UNRESTRICTED: "0", VENIRA_SESSION_ID: `ci-${Date.now()}`, VENIRA_OUTPUT_MODE: "full", VENIRA_GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    stderr: "pipe",
  });
  const client = new Client({ name: "ci", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const r = await client.callTool({ name: "project_ci_status", arguments: { pr: 11, repo: "N0moreher0/Venira-mcp" } });
  await client.close();
  const text = r.content[0].text;
  return JSON.parse(text);
}

async function waitCI() {
  for (let i = 0; i < 40; i++) {
    const res = await checkCI();
    const overall = res.data?.overall;
    console.log(`[${new Date().toISOString()}] CI overall: ${overall}`);
    if (overall !== "in_progress") {
      console.log("Final:", JSON.stringify(res.data, null, 2));
      return overall === "success";
    }
    await new Promise(r => setTimeout(r, 30000));
  }
  console.log("Timeout waiting for CI");
  return false;
}

waitCI().then(success => {
  console.log("CI success:", success);
  process.exit(success ? 0 : 1);
}).catch(e => {
  console.error(e);
  process.exit(1);
});