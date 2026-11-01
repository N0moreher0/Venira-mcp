import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["lib", "scripts", "tools"];
const MIN_BYTES = 2048;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile() && full.endsWith(".ts")) files.push(full);
  }
  return files;
}

const violations: string[] = [];
for (const relativeDir of SCAN_DIRS) {
  const dir = path.join(ROOT, relativeDir);
  const files = await walk(dir);
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MIN_BYTES && !content.includes("\n")) {
      violations.push(`${path.relative(ROOT, file)} (${bytes} bytes, one line)`);
    }
  }
}

if (violations.length > 0) {
  console.error("Source-shape check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Source-shape check passed for ${SCAN_DIRS.join(", ")}.`);
}
