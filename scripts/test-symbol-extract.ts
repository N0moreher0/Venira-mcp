/**
 * Regression tests for symbol extraction (`extractSymbols` / `buildOutline`,
 * the engine behind `outline_symbol`, `file_symbols` and hybrid search).
 *
 *   1. It used to list every `const x = ...` inside a function body: the brace
 *      depth was counted but never used, and the line was trimmed before the
 *      match, so indentation was lost (49 "symbols" for an 8-symbol file).
 *   2. Braces inside strings, comments and template literals skewed the depth.
 *   3. Regex literals such as /[^{=]+\{/ hold unbalanced braces and hid every
 *      declaration that followed them (a file with 13 symbols answered 2).
 *   4. Python has no braces: members of a class must still be listed, nested
 *      functions and defs under `if __name__` must not.
 *   5. Rust lifetimes ('a) look like an opening quote.
 *
 * Run with: npm run test:symbol-extract
 */
import assert from "node:assert/strict";
import { buildOutline, extractSymbols } from "../lib/symbol-diff.js";

let checks = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  checks += 1;
  try {
    fn();
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    console.log(`not ok ${checks} - ${name} (${error instanceof Error ? error.message : String(error)})`);
    failures.push(name);
  }
}

/** "kind:name" for every symbol, in file order. */
function kinds(text: string, includeFunctions = true, includeClasses = true): string[] {
  return extractSymbols(text, undefined, includeFunctions, includeClasses).map((s) => `${s.kind}:${s.name}`);
}

const TS_LOCALS = [
  "export async function outer(a: number) {",
  "  const inner = 1;",
  "  let counter = 0;",
  "  function nested() {}",
  "  return inner + counter;",
  "}",
  "const TOP = 1;",
  "",
].join("\n");

const TS_CLASS = [
  "export class Foo {",
  "  private x = 1;",
  "  async bar(a: number) {",
  "    const inner = 5;",
  "    return inner;",
  "  }",
  "  static baz() {",
  "    const s = 1;",
  "  }",
  "}",
  "export function after() {",
  "  const local = 1;",
  "}",
  "",
].join("\n");

const NOISE = [
  'const A = "{ not a brace";',
  "const B = '}}}';",
  'const C = "`" + \'x\';',
  "// } stray comment brace {{{",
  "/* { */",
  "/*",
  " * multi { line",
  " */",
  "const T = `{",
  "  still { template",
  "`;",
  "export function afterNoise() {}",
  "",
].join("\n");

const REGEX_LITERALS = [
  "const PATTERNS = [",
  String.raw`  { re: /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^{=]+)?\{\s*$/, kind: "method" },`,
  String.raw`  { re: /^extern\s+"[^"]*"\s+fn/ },`,
  "];",
  "const half = total / 2;",
  "const quarter = (total + 1) / 4;",
  "export function afterRegex() {}",
  "",
].join("\n");

const PY = [
  "import os",
  "",
  "class A:",
  "    def m1(self):",
  "        x = 1",
  "    async def m2(self):",
  "        pass",
  "",
  "def top():",
  "    def nested():",
  "        pass",
  "",
  'if __name__ == "__main__":',
  "    def late():",
  "        pass",
  "",
].join("\n");

// A lone apostrophe and brace inside a docstring: the lexer cannot know it is
// prose, so the depth drifts - the column-0 `def b` must still be found.
const PY_DRIFT = [
  "def a():",
  '    """',
  "    it's a lone { brace in a docstring",
  '    """',
  "    return 1",
  "",
  "def b():",
  "    pass",
  "",
].join("\n");

const RUST = [
  "pub struct S<'a> { x: &'a str }",
  "impl<'a> S<'a> {",
  "    pub fn new(x: &'a str) -> Self {",
  "        let y = 1;",
  "        S { x }",
  "    }",
  "    const MAX: u32 = 4;",
  "}",
  "fn free<'a, 'b>(a: &'a str, b: &'b str) {",
  "    let z = 2;",
  "}",
  "",
].join("\n");

check("locals inside a function body are not symbols", () => {
  assert.deepEqual(kinds(TS_LOCALS), ["function:outer", "constant:TOP"]);
});

check("total_symbols counts the same symbols that are listed", () => {
  const outline = buildOutline(TS_LOCALS);
  assert.equal(outline.total_symbols, 2);
  assert.equal(outline.symbols.length, 2);
});

check("class members are listed, locals inside them are not, and the file goes on after the class", () => {
  assert.deepEqual(kinds(TS_CLASS), ["class:Foo", "method:bar", "method:baz", "function:after"]);
});

check("line numbers point at the declaration", () => {
  const lines = extractSymbols(TS_CLASS).map((s) => `${s.name}@${s.line}`);
  assert.deepEqual(lines, ["Foo@1", "bar@3", "baz@7", "after@11"]);
});

check("braces in strings, comments and template literals do not skew the depth", () => {
  assert.deepEqual(kinds(NOISE), [
    "constant:A",
    "constant:B",
    "constant:C",
    "constant:T",
    "function:afterNoise",
  ]);
});

check("regex literals with unbalanced braces do not hide what follows; division is not a regex", () => {
  assert.deepEqual(kinds(REGEX_LITERALS), [
    "constant:PATTERNS",
    "constant:half",
    "constant:quarter",
    "function:afterRegex",
  ]);
});

check("python: methods are listed, nested functions and defs under `if` are not", () => {
  assert.deepEqual(kinds(PY), ["class:A", "function:m1", "function:m2", "function:top"]);
});

check("depth drift is repaired by the next column-0 declaration", () => {
  assert.deepEqual(kinds(PY_DRIFT), ["function:a", "function:b"]);
});

check("rust: lifetimes do not break the depth, impl members are listed, locals are not", () => {
  assert.deepEqual(kinds(RUST), ["struct:S", "class:S", "function:new", "constant:MAX", "function:free"]);
});

check("include_functions=false drops functions but keeps classes and methods", () => {
  assert.deepEqual(kinds(TS_CLASS, false, true), ["class:Foo", "method:bar", "method:baz"]);
});

check("windows line endings give the same symbols", () => {
  assert.deepEqual(kinds(TS_CLASS.replace(/\n/g, "\r\n")), kinds(TS_CLASS));
});

check("a file without declarations has no symbols", () => {
  assert.deepEqual(kinds("just some notes\nnothing structured\n"), []);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} symbol extraction checks failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nSymbol extraction tests passed (${checks} checks).`);
