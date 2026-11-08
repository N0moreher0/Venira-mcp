import "./clean-env.js"; // must stay first: inherited VENIRA_UNRESTRICTED/SHELL_MODE would skew the policy results
import { evaluateShellCommand } from "../lib/shell-policy.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extraPolicyCorpus, type PolicyCorpusCase } from "./policy-corpus-extra.js";

const corpusPath = path.resolve(process.cwd(), "scripts", "policy-corpus.json");
const baseCorpus = JSON.parse(await readFile(corpusPath, "utf8")) as PolicyCorpusCase[];
const corpus = [...baseCorpus, ...extraPolicyCorpus];

console.log(`Running ${corpus.length} policy corpus tests...\n`);

let passed = 0;
let failed = 0;

for (const test of corpus) {
  const result = evaluateShellCommand(test.command, process.cwd(), { mode: "balanced", shell: test.shell });
  const ok = result.tier === test.expected_tier && result.rule === test.expected_rule;
  if (ok) {
    console.log(`✅ ${test.command}`);
    passed++;
  } else {
    console.log(`❌ ${test.command}`);
    console.log(`   Expected: tier=${test.expected_tier}, rule=${test.expected_rule}`);
    console.log(`   Got:      tier=${result.tier}, rule=${result.rule}`);
    console.log(`   Reason:   ${result.reason}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}