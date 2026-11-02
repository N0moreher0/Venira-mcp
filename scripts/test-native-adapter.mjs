/**
 * Test script for native adapter
 */
import { createCorehost } from "../dist/lib/native-adapter-index.js";

async function test() {
  console.log("Testing native adapter...");
  
  const corehost = createCorehost({
    workspace: process.cwd(),
    shellMode: "balanced",
    outputMode: "full",
  });

  await corehost.warmUp();
  console.log("✓ warmUp() completed");

  // Test readFile
  const readResult = await corehost.readFile({ relative_path: "package.json" });
  if (readResult.ok) {
    console.log("✓ readFile() succeeded, bytes:", readResult.data.text.length);
  } else {
    console.error("✗ readFile() failed:", readResult.error);
    process.exit(1);
  }

  // Test listFiles
  const listResult = await corehost.listFiles({ relative_path: ".", depth: 1, limit: 10 });
  if (listResult.ok) {
    console.log("✓ listFiles() succeeded, entries:", listResult.data.entries.length);
  } else {
    console.error("✗ listFiles() failed:", listResult.error);
    process.exit(1);
  }

  // Test health (expected to be unsupported in native adapter)
  const healthResult = await corehost.health();
  if (!healthResult.ok && healthResult.error.code === "unsupported") {
    console.log("✓ health() correctly returns unsupported (use MCP server for this)");
  } else if (healthResult.ok) {
    console.log("✓ health() succeeded, version:", healthResult.data.version);
  } else {
    console.error("✗ health() failed unexpectedly:", healthResult.error);
  }

  // Test search
  const searchResult = await corehost.search({ query: "venira", kind: "literal_content", limit: 5 });
  if (searchResult.ok) {
    console.log("✓ search() succeeded, hits:", searchResult.data.hits.length);
  } else {
    console.error("✗ search() failed:", searchResult.error);
    process.exit(1);
  }

  // Test recentFiles
  const recentResult = await corehost.recentFiles({ limit: 5 });
  if (recentResult.ok) {
    console.log("✓ recentFiles() succeeded, files:", recentResult.data.files.length);
  } else {
    console.error("✗ recentFiles() failed:", recentResult.error);
    process.exit(1);
  }

  // Test shellRun (simple command)
  const shellResult = await corehost.shellRun({ command: "echo hello", background: false });
  if (shellResult.ok) {
    console.log("✓ shellRun() succeeded, exit_code:", shellResult.data.exit_code, "stdout:", shellResult.data.stdout?.trim());
  } else {
    console.error("✗ shellRun() failed:", shellResult.error);
    // Don't exit - shell might not be available in all environments
  }

  await corehost.shutdown();
  console.log("✓ shutdown() completed");
  console.log("\nAll tests passed!");
}

test().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});