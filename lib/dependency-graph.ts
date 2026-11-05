/**
 * Dependency graph + change impact analysis.
 *
 * Parser-lite by design: no new runtime dependencies, no language server. The
 * indexer walks the workspace with the same bounded rules as `list_files`,
 * extracts imports/declarations line by line for TypeScript/JavaScript,
 * Python, Rust (mod/use/extern crate, resolved through the rustc module
 * file layout: foo.rs vs foo/mod.rs, crate root via main.rs/lib.rs) and
 * Go (import blocks, resolved through go.mod at the workspace root:
 * the module prefix maps to directories; the package's main file is chosen
 * as <basename>.go, then the alphabetically-first non-test .go),
 * resolves relative specifiers against the real filesystem, and turns the
 * result into a deterministic graph (JSON, DOT or Mermaid).
 *
 * Security:
 *   - protected paths (`.env*`, keys, `secrets.*`, the data dir) are skipped
 *     before their contents are read;
 *   - symlinks are never followed;
 *   - every resolved target must stay inside the workspace;
 *   - the output contains file paths, line numbers and short import lines only.
 */
import { existsSync, promises as fs, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isProtectedPath } from "./workspace.js";

export type GraphLanguage = "ts" | "js" | "tsx" | "jsx" | "py" | "rs" | "go" | "java" | "kotlin";
export type EdgeConfidence = "exact" | "likely" | "possible";
export type EdgeType = "import" | "extends" | "implements" | "references";

const EXT_LANG: Record<string, GraphLanguage> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".py": "py",
  ".rs": "rs",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
};

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "vendor",
  "__pycache__",
  ".cache",
  ".turbo",
  "coverage",
  ".idea",
  ".vscode",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".eggs",
  ".gradle",
  ".m2",
]);

const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const INDEX_CACHE_TTL_MS = 5000;
const INDEX_CACHE_MAX = 8;

type ImportRef = {
  specifier: string;
  line: number;
  via: string;
  dynamic: boolean;
};

type Declaration = {
  name: string;
  kind: string;
  line: number;
  signature?: string;
};

type BaseRef = {
  name: string;
  type: "extends" | "implements";
  line: number;
};

type Usage = { line: number; enclosing?: string };

type FileEntry = {
  rel: string;
  lang: GraphLanguage;
  loc: number;
  bytes: number;
  imports: ImportRef[];
  declarations: Declaration[];
  bases: BaseRef[];
  usage?: Map<string, Usage>;
};

type Index = {
  rootAbs: string;
  startRel: string;
  files: Map<string, FileEntry>;
  filesScanned: number;
  filesSkipped: number;
  discoveryTruncated: boolean;
  durationMs: number;
};

type CachedIndex = { at: number; index: Index };
const indexCache = new Map<string, CachedIndex>();

/** Drop the index after a mutation. Called by the tool layer on every write. */
export function invalidateDependencyGraphCache(): void {
  indexCache.clear();
}

type Edge = {
  from: string;
  to: string;
  type: EdgeType;
  confidence: EdgeConfidence;
  line: number;
  via: string;
  fromSymbol?: string;
};

type Unresolved = {
  from: string;
  specifier?: string;
  symbol?: string;
  reason: string;
  files?: string[];
};

type ExternalUse = { id: string; usedBy: Set<string> };

type BuiltEdges = {
  edges: Edge[];
  externals: Map<string, ExternalUse>;
  unresolved: Unresolved[];
};

const CONFIDENCE_RANK: Record<EdgeConfidence, number> = { exact: 0, likely: 1, possible: 2 };

function worseConfidence(a: EdgeConfidence, b: EdgeConfidence): EdgeConfidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

function normalizeRel(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === "" ? "." : normalized;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function looksTestFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  const base = path.basename(lower);
  return (
    /(^|\/)(__tests__|tests?|specs?|benches)\//.test(lower) ||
    /\.(test|spec)\.[^.]+$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base) ||
    /_test\.rs$/.test(base) ||
    /_test\.go$/.test(base) ||
    /(test|_test)\.kt$/.test(base) ||
    /test\.java$/.test(base)
  );
}

function languageForFile(rel: string): GraphLanguage | undefined {
  return EXT_LANG[path.extname(rel).toLowerCase()];
}

function languageAllowed(lang: GraphLanguage, requested: Set<string> | null): boolean {
  if (!requested) return true;
  if (requested.has(lang)) return true;
  if (lang === "tsx" && (requested.has("ts") || requested.has("tsx"))) return true;
  if (lang === "jsx" && (requested.has("js") || requested.has("jsx"))) return true;
  return false;
}

function parseLanguages(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = new Set<string>();
  for (const raw of value) {
    const item = String(raw).trim().toLowerCase();
    if (item === "typescript" || item === "ts" || item === "tsx") out.add(item === "tsx" ? "tsx" : "ts");
    else if (item === "javascript" || item === "js" || item === "jsx") out.add(item === "jsx" ? "jsx" : "js");
    else if (item === "python" || item === "py") out.add("py");
    else if (item === "rust" || item === "rs") out.add("rs");
    else if (item === "go" || item === "golang") out.add("go");
  }
  return out.size > 0 ? out : null;
}

function isInside(rootAbs: string, abs: string): boolean {
  const rel = path.relative(rootAbs, abs);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

function relFromRoot(rootAbs: string, abs: string): string {
  if (!isInside(rootAbs, abs)) {
    throw new Error(`[path_escape] Path is outside the workspace: ${abs}. Hint: use a workspace-relative path.`);
  }
  return normalizeRel(path.relative(rootAbs, abs));
}

function protectedLike(absPath: string, rel: string): boolean {
  if (isProtectedPath(absPath)) return true;
  // The shared guard covers secrets.json/secrets.key; also skip other data
  // files named `secrets.*`, but never a source module such as secrets.ts.
  const base = path.basename(rel).toLowerCase();
  const ext = path.extname(base);
  const sourceExt = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs"]);
  return /^secrets\./.test(base) && !sourceExt.has(ext);
}

function stripTsNonCode(text: string): string {
  const chars = text.split("");
  let i = 0;
  const n = chars.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < n; j += 1) {
      if (chars[j] !== "\n") chars[j] = " ";
    }
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      let end = text.indexOf("\n", i + 2);
      if (end < 0) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      let end = text.indexOf("*/", i + 2);
      end = end < 0 ? n : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i + 1, Math.max(i + 1, j - 1));
      i = j;
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

function stripPythonNonCode(text: string): string {
  const chars = text.split("");
  let i = 0;
  const n = chars.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < n; j += 1) {
      if (chars[j] !== "\n") chars[j] = " ";
    }
  };
  while (i < n) {
    const ch = text[i];
    if (ch === "#") {
      let end = text.indexOf("\n", i + 1);
      if (end < 0) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = text.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        let end = text.indexOf(triple, i + 3);
        end = end < 0 ? n : end + 3;
        blank(i + 3, Math.max(i + 3, end - 3));
        i = end;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i + 1, Math.max(i + 1, j - 1));
      i = j;
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

function stripRustNonCode(text: string): string {
  const chars = text.split("");
  const n = chars.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < n; j += 1) {
      if (chars[j] !== "\n") chars[j] = " ";
    }
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      let end = text.indexOf("\n", i + 2);
      if (end < 0) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      // Rust block comments nest, unlike C/TS.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth += 1;
          j += 2;
          continue;
        }
        if (text[j] === "*" && text[j + 1] === "/") {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      blank(i, Math.min(j, n));
      i = j;
      continue;
    }
    const prev = i > 0 ? text[i - 1] : "";
    const afterWordChar = /[A-Za-z0-9_]/.test(prev);
    if (!afterWordChar && ch === "r") {
      // Raw strings: r"..." / r#"..."# / r##"..."## (the r must not be an
      // identifier suffix such as `for` or `err`).
      let hashes = 0;
      let j = i + 1;
      while (j < n && text[j] === "#") {
        hashes += 1;
        j += 1;
      }
      if (j < n && text[j] === '"') {
        const closing = '"' + "#".repeat(hashes);
        const end = text.indexOf(closing, j + 1);
        const stop = end < 0 ? n : end + closing.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i + 1, Math.max(i + 1, j - 1));
      i = j;
      continue;
    }
    if (ch === "'") {
      // Char literal ('a', '\n', '\'', '\u{1F600}') vs lifetime/label ('a, 'static).
      if (next === "\\") {
        let j = i + 2;
        while (j < n && text[j] !== "'") j += 1;
        if (j < n) {
          blank(i + 1, j);
          i = j + 1;
          continue;
        }
        i += 1;
        continue;
      }
      if (next !== undefined && next !== "'" && text[i + 2] === "'") {
        blank(i + 1, i + 2);
        i = i + 3;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

function parseImportsTs(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlockComment) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlockComment = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlockComment = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const line = i + 1;
    const via = original.trim().slice(0, 160);

    const staticImport = /^\s*import\s+(?:type\s+)?(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/.exec(original);
    const reExport = /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/.exec(original);
    const requireRef = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/.exec(original);
    const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/.exec(original);

    const push = (specifier: string, dynamic: boolean) => {
      const key = `${specifier}\u0000${line}\u0000${dynamic}`;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({ specifier, line, via, dynamic });
    };
    if (staticImport) push(staticImport[1], false);
    if (reExport) push(reExport[1], false);
    if (requireRef) push(requireRef[1], false);
    if (dynamicImport) push(dynamicImport[1], true);
  }
  return imports;
}

function parseImportsPython(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let triple: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    const trimmed = original.trim();
    if (triple) {
      if (trimmed.includes(triple)) triple = null;
      continue;
    }
    const tripleStart = /^(?:[rbufRBUF]{0,2})("""|''')/.exec(trimmed);
    if (tripleStart) {
      const quote = tripleStart[1];
      const rest = trimmed.slice(tripleStart[0].length);
      if (!rest.includes(quote)) triple = quote;
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = i + 1;
    const via = trimmed.slice(0, 160);
    const push = (specifier: string, dynamic: boolean) => {
      const key = `${specifier}\u0000${line}\u0000${dynamic}`;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({ specifier, line, via, dynamic });
    };
    const fromImport = /^\s*from\s+([.\w]+)\s+import\b/.exec(original);
    if (fromImport) push(fromImport[1], false);
    const plainImport = /^\s*import\s+(.+)$/.exec(original);
    if (plainImport) {
      for (const part of plainImport[1].split(",")) {
        const moduleName = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (moduleName) push(moduleName, false);
      }
    }
    const dynamicPy =
      /__import__\s*\(\s*["']([^"']+)["']/.exec(original) ??
      /import_module\s*\(\s*["']([^"']+)["']/.exec(original);
    if (dynamicPy) push(dynamicPy[1], true);
  }
  return imports;
}

/**
 * Rust import extraction (parser-lite):
 *   - `mod foo;` / `pub mod foo;`          -> `moddecl:foo` (child module file)
 *   - `use crate::a::b;` / `use ::a::b;`   -> crate-root relative
 *   - `use super::a` / `use self::a`       -> module relative
 *   - `use a::b::{c, d};`                  -> expands group items
 *   - `extern crate foo;`                  -> `externcrate:foo` (always external)
 *   - bare `use a::b;`                     -> uniform path: local module first,
 *                                             then an external crate.
 * Multi-line `use x::{...};` groups are accumulated until the closing brace.
 */
function parseImportsRust(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlockComment = false;
  let group: { base: string; inner: string; line: number; via: string } | null = null;

  const push = (specifier: string, line: number, via: string) => {
    const key = `${specifier}\u0000${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ specifier, line, via, dynamic: false });
  };

  const expandGroup = (base: string, inner: string, line: number, via: string) => {
    const closing = inner.indexOf("}");
    const body = closing >= 0 ? inner.slice(0, closing) : inner;
    for (const raw of body.split(",")) {
      const item = raw
        .replace(/[{}]/g, "")
        .replace(/\s+as\s+[A-Za-z_]\w*$/, "")
        .trim();
      if (!item) continue;
      if (item === "self" || item === "super") push(base, line, via);
      else push(`${base}::${item}`, line, via);
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlockComment) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlockComment = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlockComment = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (group) {
      group.inner += " " + trimmed;
      if (trimmed.includes("}")) {
        expandGroup(group.base, group.inner, group.line, group.via);
        group = null;
      }
      continue;
    }
    const line = i + 1;
    const via = trimmed.slice(0, 160);

    const externCrate = /^\s*(?:pub\s+)?extern\s+crate\s+([A-Za-z_]\w*)/.exec(original);
    if (externCrate) {
      push(`externcrate:${externCrate[1]}`, line, via);
      continue;
    }
    const modDecl = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(original);
    if (modDecl) {
      push(`moddecl:${modDecl[1]}`, line, via);
      continue;
    }
    // `use path::{items` — group may continue on the following lines.
    const useGroup = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;{]+?)\s*\{(.*)$/.exec(original);
    if (useGroup) {
      const base = useGroup[1].trim().replace(/::\s*$/, "");
      const rest = useGroup[2];
      if (!base) continue;
      if (rest.includes("}")) expandGroup(base, rest, line, via);
      else group = { base, inner: rest, line, via };
      continue;
    }
    const useSingle = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;{]+);/.exec(original);
    if (useSingle) {
      const spec = useSingle[1].trim().replace(/\s+as\s+[A-Za-z_]\w*$/, "").trim();
      if (spec) push(spec.startsWith("::") ? `crate::${spec.replace(/^::+/, "")}` : spec, line, via);
      continue;
    }
  }
  if (group) expandGroup(group.base, group.inner, group.line, group.via);
  return imports;
}

/**
 * Go import parsing, parser-lite.
 *   import "fmt"
 *   import alias "path", import . "path", import _ "path"
 *   import (
 *     "fmt"
 *     x "github.com/acme/demo/pkg/tool"
 *     _ "github.com/lib/sideeffect"
 *   )
 * Specifiers are the import paths as written (module-relative for local
 * modules); resolution against go.mod happens in probeGo.
 */
function parseImportsGo(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlock = false; // inside a /* */ comment
  let inGroup = false; // inside an import (...) block

  const push = (specifier: string, line: number, via: string) => {
    const key = `${specifier}\u0000${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ specifier, line, via, dynamic: false });
  };

  const importPath = /^"([^"]+)"/;

  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlock) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlock = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlock = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    const line = i + 1;
    const via = trimmed.slice(0, 160);

    if (inGroup) {
      if (trimmed.startsWith(")")) {
        inGroup = false;
        continue;
      }
      // Optional alias: name | . | _ before the quoted path.
      const body = trimmed.replace(/^\.|_/, "").replace(/^[A-Za-z_]\w*\s+/, "").replace(/^\s+/, "");
      const m = importPath.exec(body);
      if (m) push(m[1], line, via);
      continue;
    }

    const groupStart = /^\s*import\s*\(\s*(?:\/\/.*)?$/.exec(original);
    if (groupStart) {
      inGroup = true;
      continue;
    }
    const single = /^\s*import\s+(?:\.|_|[A-Za-z_]\w*\s+)?"([^"]+)"/.exec(original);
    if (single) {
      push(single[1], line, via);
      continue;
    }
    // Single-line aliased or parenthesized one-liner: import ( "fmt" )
    const oneLiner = /^\s*import\s*\(\s*(?:\.|_|[A-Za-z_]\w*\s+)?"([^"]+)"\s*\)/.exec(original);
    if (oneLiner) push(oneLiner[1], line, via);
  }
  return imports;
}

/**
 * Java import parsing, parser-lite.
 *   import foo.bar.Baz;
 *   import static foo.bar.Baz;
 *   import foo.bar.*;   -> wildcard recorded with `possible` confidence
 * Package-qualified paths are resolved against classpath roots in probeJava.
 */
function parseImportsJava(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlock) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlock = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlock = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    const line = i + 1;
    const via = trimmed.slice(0, 160);
    const push = (specifier: string) => {
      const key = `${specifier}\u0000${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({ specifier, line, via, dynamic: false });
    };
    const m = /^\s*import(?:\s+static)?\s+([A-Za-z_][\w.]*)(?:\s*;|\s*$)/.exec(original);
    if (m) push(m[1]);
  }
  return imports;
}

/**
 * Kotlin import parsing, parser-lite.
 *   import foo.bar.Baz
 *   import foo.bar.*
 *   import foo.bar as br
 */
function parseImportsKotlin(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlock) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlock = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlock = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    const line = i + 1;
    const via = trimmed.slice(0, 160);
    const push = (specifier: string) => {
      const key = `${specifier}\u0000${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({ specifier, line, via, dynamic: false });
    };
    const m = /^\s*import\s+([A-Za-z_][\w.]*)\b/.exec(original);
    if (m) push(m[1]);
  }
  return imports;
}

function collectDeclarations(text: string, lang: GraphLanguage): Declaration[] {
  const declarations: Declaration[] = [];
  if (lang === "rs") {
    // Brace depth over comment/string-stripped text: only depth-0 items are
    // module-level (mirrors the TS strategy; `impl` bodies stay at depth 1).
    const stripped = stripRustNonCode(text);
    const lines = splitLines(stripped);
    let depth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (depth === 0) {
        const candidates: Array<{ re: RegExp; kind: string }> = [
          { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
          { re: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
          { re: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
          { re: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
          { re: /^(?:pub(?:\([^)]*\))?\s+)?union\s+([A-Za-z_]\w*)/, kind: "union" },
          { re: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: "module" },
          { re: /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)\s*=/, kind: "type" },
          { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:static|const)\s+([A-Za-z_]\w*)/, kind: "constant" },
        ];
        for (const candidate of candidates) {
          const match = candidate.re.exec(line);
          if (!match) continue;
          declarations.push({
            name: match[1],
            kind: candidate.kind,
            line: i + 1,
            signature: lines[i].trim().slice(0, 160),
          });
          break;
        }
      }
      for (const ch of line) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth = Math.max(0, depth - 1);
      }
    }
    return declarations;
  }
  if (lang === "go") {
    const stripped = stripTsNonCode(text); // Go's lexer subset maps onto the TS stripper
    const lines = splitLines(stripped);
    let depth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (depth === 0) {
        const candidates: Array<{ re: RegExp; kind: string }> = [
          { re: /^\s*func\s+\([^)]*\)\s+([A-Za-z_]\w*)\s*\(/, kind: "method" },
          { re: /^\s*func\s+([A-Za-z_]\w*)(?:\s*\[[^\]]*\]\s*)?\(/, kind: "function" },
          { re: /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/, kind: "struct" },
          { re: /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/, kind: "interface" },
          { re: /^\s*type\s+([A-Za-z_]\w*)\b/, kind: "type" },
          { re: /^\s*const\s+([A-Za-z_]\w*)\b/, kind: "constant" },
          { re: /^\s*var\s+([A-Za-z_]\w*)\b/, kind: "variable" },
        ];
        for (const candidate of candidates) {
          const match = candidate.re.exec(line);
          if (!match) continue;
          declarations.push({
            name: match[1],
            kind: candidate.kind,
            line: i + 1,
            signature: line.trim().slice(0, 160),
          });
          break;
        }
      }
      for (const ch of line) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth = Math.max(0, depth - 1);
      }
    }
    return declarations;
  }
  if (lang === "java" || lang === "kotlin") {
    const stripped = stripTsNonCode(text); // JVM lexer subset maps onto the TS stripper
    const lines = splitLines(stripped);
    let depth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const topLevel = depth === 0;
      if (topLevel) {
        const candidates: Array<{ re: RegExp; kind: string }> = [
          // `public final class Foo extends Bar implements Baz {`
          { re: /^\s*(?:public|abstract|final|sealed|interface)?\s*(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/, kind: "class" },
          { re: /^\s*(?:public|abstract|final|sealed)?\s*interface\s+([A-Za-z_][\w]*)/, kind: "interface" },
          { re: /^\s*(?:public|final|abstract)?\s*enum\s+([A-Za-z_][\w]*)/, kind: "enum" },
          { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?[A-Za-z_<>\[\],\s]*\s+([A-Za-z_][\w]*)\s*(?:\*|&)?\s*(?:=|;)/, kind: "variable" },
          { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?[A-Za-z_<>\[\],\s]*\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{?\s*$/, kind: "function" },
        ];
        let matched = false;
        for (const candidate of candidates) {
          const match = candidate.re.exec(line);
          if (!match) continue;
          declarations.push({
            name: match[1],
            kind: candidate.kind,
            line: i + 1,
            signature: lines[i].trim().slice(0, 160),
          });
          matched = true;
          break;
        }
        // Kotlin: `fun`, `object`, `companion object`, `data class` fall through
        if (!matched) {
          const fun = /^\s*(?:suspend\s+)?fun\s+([A-Za-z_][\w]*)/.exec(line);
          if (fun) {
            declarations.push({ name: fun[1], kind: "function", line: i + 1, signature: lines[i].trim().slice(0, 160) });
            matched = true;
          }
          const obj = /^\s*(?:companion\s+)?object\s+([A-Za-z_][\w]*)/.exec(line);
          if (obj && !matched) {
            declarations.push({ name: obj[1], kind: "class", line: i + 1, signature: lines[i].trim().slice(0, 160) });
            matched = true;
          }
          const dataClass = /^\s*(?:data\s+)?class\s+([A-Za-z_][\w]*)/.exec(line);
          if (dataClass && !matched) {
            declarations.push({ name: dataClass[1], kind: "class", line: i + 1, signature: lines[i].trim().slice(0, 160) });
            matched = true;
          }
        }
      }
      for (const ch of line) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth = Math.max(0, depth - 1);
      }
    }
    return declarations;
  }
  if (lang === "py") {
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // Python has no braces: only column-0 definitions are module-level.
      if (/^[ \t]/.test(line)) continue;
      const def = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/.exec(line);
      if (def) {
        declarations.push({ name: def[1], kind: "function", line: i + 1, signature: line.trim().slice(0, 160) });
        continue;
      }
      const cls = /^class\s+([A-Za-z_][\w]*)/.exec(line);
      if (cls) {
        declarations.push({ name: cls[1], kind: "class", line: i + 1, signature: line.trim().slice(0, 160) });
        continue;
      }
      const constant = /^([A-Za-z_][\w]*)\s*(?::[^=]+)?=/.exec(line);
      if (constant) {
        declarations.push({ name: constant[1], kind: "constant", line: i + 1, signature: line.trim().slice(0, 160) });
      }
    }
    return declarations;
  }

  // Count top-level declarations only. The stripped text keeps newlines and
  // removes comments/strings, so brace depth is reliable enough for a
  // parser-lite index and never records a local `const` as a module symbol.
  const stripped = stripTsNonCode(text);
  const lines = splitLines(stripped);
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const topLevel = depth === 0;
    if (topLevel) {
      const candidates: Array<{ re: RegExp; kind: string }> = [
        { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
        { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
        { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
        { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
        { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
        { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "variable" },
      ];
      for (const candidate of candidates) {
        const match = candidate.re.exec(line);
        if (!match) continue;
        declarations.push({
          name: match[1],
          kind: candidate.kind,
          line: i + 1,
          signature: lines[i].trim().slice(0, 160),
        });
        break;
      }
    }
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return declarations;
}

function normalizeBaseName(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .trim()
    .replace(/^[.*&]+/, "")
    .replace(/\s+as\s+.*$/, "")
    .trim();
}

function collectBases(text: string, lang: GraphLanguage): BaseRef[] {
  const bases: BaseRef[] = [];
  if (lang === "rs") {
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line || line.startsWith("//") || line.startsWith("*")) continue;
      // `impl<..> Trait for Type` -> implements edge on the trait path's last
      // segment (inherent `impl Type { }` has no `for` and never matches).
      const implFor = /^(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(.+?)\s+for\s+[A-Za-z_][\w:]*/.exec(line);
      if (implFor) {
        const traitPath = implFor[1].trim().replace(/[+]*\s*$/, "");
        const name = traitPath.split("::").pop()?.trim() ?? "";
        if (/^[A-Za-z_]\w*$/.test(name)) bases.push({ name, type: "implements", line: i + 1 });
        continue;
      }
      // `trait Foo: Bar + Baz` -> supertrait extends edges.
      const traitBounds = /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+[A-Za-z_]\w*\s*:\s*(.+)$/.exec(line);
      if (traitBounds) {
        for (const part of traitBounds[1].split("+")) {
          const name = part
            .replace(/where\b.*$/, "")
            .split("::")
            .pop()
            ?.replace(/<[^>]*>/g, "")
            .trim();
          if (name && /^[A-Za-z_]\w*$/.test(name)) bases.push({ name, type: "extends", line: i + 1 });
        }
      }
    }
    return bases;
  }
  if (lang === "go") {
    // Go has no extends/implements keywords; interface embedding and struct
    // embedding are not attributed (yet) — leaving edges out beats guessing.
    return bases;
  }
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;
    if (lang === "py") {
      const m = /^class\s+[A-Za-z_][\w]*\s*\(([^)]*)\)/.exec(line);
      if (m) {
        for (const part of m[1].split(",")) {
          const name = normalizeBaseName(part.split("=")[0] ?? "");
          if (name && name !== "object") bases.push({ name, type: "extends", line: i + 1 });
        }
      }
      continue;
    }
    const extendsMatch = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*\s+extends\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (extendsMatch) bases.push({ name: extendsMatch[1], type: "extends", line: i + 1 });
    const implementsMatch = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*[^{]*\bimplements\s+([^{]+)/.exec(line);
    if (implementsMatch) {
      for (const part of implementsMatch[1].split(",")) {
        const name = normalizeBaseName(part);
        if (name) bases.push({ name, type: "implements", line: i + 1 });
      }
    }
    const interfaceMatch = /^(?:export\s+)?interface\s+[A-Za-z_$][\w$]*\s+extends\s+([^{]+)/.exec(line);
    if (interfaceMatch) {
      for (const part of interfaceMatch[1].split(",")) {
        const name = normalizeBaseName(part);
        if (name) bases.push({ name, type: "extends", line: i + 1 });
      }
    }
  }
  return bases;
}

function enclosingDeclaration(declarations: Declaration[], line: number): string | undefined {
  let current: Declaration | undefined;
  for (const decl of declarations) {
    if (decl.line > line) break;
    current = decl;
  }
  return current?.name;
}

function scanUsages(
  text: string,
  lang: GraphLanguage,
  declarations: Declaration[],
  declaredNames: Set<string>,
): Map<string, Usage> {
  const cleaned = lang === "py" ? stripPythonNonCode(text) : lang === "rs" ? stripRustNonCode(text) : stripTsNonCode(text);
  const lines = splitLines(cleaned);
  const usage = new Map<string, Usage>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Import/export-from lines say where a name comes from, not that the file
    // depends on its behaviour. Skip them; the import edge already covers it.
    if (/^\s*(?:import\b|from\s+\S+\s+import\b|export\b.*\bfrom\b)/.test(line)) continue;
    if (/^\s*require\s*\(/.test(line)) continue;
    if (/^\s*(?:use\s|extern\s+crate\b)/.test(line)) continue;
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_]\w*\s*[;{]/.test(line)) continue;
    const lineNumber = i + 1;
    const enclosing = enclosingDeclaration(declarations, lineNumber);
    const tokenRe = /[A-Za-z_$][\w$]*/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(line)) !== null) {
      const name = match[0];
      if (!declaredNames.has(name)) continue;
      if (enclosing && usage.has(name)) continue;
      if (declarations.some((d) => d.line === lineNumber && d.name === name)) continue;
      if (!usage.has(name)) usage.set(name, { line: lineNumber, ...(enclosing ? { enclosing } : {}) });
    }
  }
  return usage;
}

type Discovered = {
  rootAbs: string;
  startRel: string;
  files: Array<{ rel: string; abs: string; lang: GraphLanguage; bytes: number; skipped: boolean }>;
  skipped: number;
  truncated: boolean;
};

async function discover(
  rootAbs: string,
  startRel: string,
  depth: number,
  languages: Set<string> | null,
): Promise<Discovered> {
  const startAbs = path.isAbsolute(startRel) ? startRel : path.resolve(rootAbs, startRel || ".");
  if (!isInside(rootAbs, startAbs)) {
    throw new Error(`[path_escape] Path is outside the workspace: ${startRel}. Hint: use a workspace-relative path.`);
  }
  const relStart = relFromRoot(rootAbs, startAbs);
  const files: Discovered["files"] = [];
  let skipped = 0;
  let truncated = false;
  let totalBytes = 0;

  const considerFile = async (abs: string, rel: string): Promise<void> => {
    const lang = languageForFile(rel);
    if (!lang || !languageAllowed(lang, languages)) return;
    if (protectedLike(abs, rel)) {
      skipped += 1;
      return;
    }
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      skipped += 1;
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > MAX_FILE_BYTES) {
      skipped += 1;
      return;
    }
    if (files.length >= MAX_FILES || totalBytes + stat.size > MAX_TOTAL_BYTES) {
      truncated = true;
      return;
    }
    totalBytes += stat.size;
    files.push({ rel, abs, lang, bytes: stat.size, skipped: false });
  };

  const walk = async (absDir: string, relDir: string, currentDepth: number): Promise<void> => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      const abs = path.join(absDir, entry.name);
      const rel = normalizeRel(path.join(relDir, entry.name));
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
        if (currentDepth >= depth) continue;
        await walk(abs, rel, currentDepth + 1);
      } else if (entry.isFile()) {
        await considerFile(abs, rel);
      }
    }
  };

  let startStat;
  try {
    startStat = await fs.stat(startAbs);
  } catch {
    throw new Error(`[not_found] Path does not exist: ${relStart}. Hint: check it with project_list_files.`);
  }
  if (startStat.isFile()) {
    await considerFile(startAbs, relStart);
  } else if (startStat.isDirectory()) {
    await walk(startAbs, relStart === "." ? "" : relStart, 0);
  } else {
    throw new Error(`[invalid_request] Path is not a regular file or directory: ${relStart}.`);
  }
  return { rootAbs, startRel: relStart === "." ? "" : relStart, files, skipped, truncated };
}

async function readText(abs: string): Promise<string | null> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(abs);
  } catch {
    return null;
  }
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

async function buildIndex(
  rootAbs: string,
  startRel: string,
  depth: number,
  languages: Set<string> | null,
  withSymbols: boolean,
): Promise<{ index: Index; cache: "hit" | "miss" }> {
  const key = JSON.stringify({
    rootAbs,
    startRel,
    depth,
    languages: languages ? [...languages].sort() : null,
    withSymbols,
  });
  const cached = indexCache.get(key);
  if (cached && Date.now() - cached.at <= INDEX_CACHE_TTL_MS) {
    return { index: cached.index, cache: "hit" };
  }
  const started = Date.now();
  const found = await discover(rootAbs, startRel, depth, languages);
  const files = new Map<string, FileEntry>();
  let filesSkipped = found.skipped;
  let discoveryTruncated = found.truncated;

  for (const item of found.files) {
    const text = await readText(item.abs);
    if (text === null) {
      filesSkipped += 1;
      continue;
    }
    const declarations = collectDeclarations(text, item.lang);
    files.set(item.rel, {
      rel: item.rel,
      lang: item.lang,
      loc: text.split("\n").length,
      bytes: item.bytes,
      imports:
        item.lang === "rs"
          ? parseImportsRust(text)
          : item.lang === "py"
            ? parseImportsPython(text)
            : item.lang === "go"
              ? parseImportsGo(text)
              : item.lang === "java" || item.lang === "kotlin"
                ? parseImportsJava(text)  // Kotlin uses the same `import pkg.Path` grammar
                : parseImportsTs(text),
      declarations,
      bases: collectBases(text, item.lang),
    });
  }

  const baseIndex: Index = {
    rootAbs,
    startRel: found.startRel,
    files,
    filesScanned: files.size,
    filesSkipped,
    discoveryTruncated,
    durationMs: 0,
  };

  if (withSymbols && files.size > 0) {
    const declaredNames = new Set<string>();
    for (const file of files.values()) for (const decl of file.declarations) declaredNames.add(decl.name);
    for (const file of files.values()) {
      const abs = path.resolve(rootAbs, file.rel);
      const text = await readText(abs);
      if (text === null) continue;
      file.usage = scanUsages(text, file.lang, file.declarations, declaredNames);
    }
  }

  baseIndex.durationMs = Date.now() - started;
  indexCache.set(key, { at: Date.now(), index: baseIndex });
  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value;
    if (oldest === undefined) break;
    indexCache.delete(oldest);
  }
  return { index: baseIndex, cache: "miss" };
}

function firstExisting(candidates: string[], rootAbs: string): string | null {
  for (const candidate of candidates) {
    if (!isInside(rootAbs, candidate)) continue;
    if (protectedLike(candidate, relFromRoot(rootAbs, candidate))) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function probeTs(fromAbs: string, specifier: string, rootAbs: string): string | null {
  const base = specifier.startsWith("/")
    ? path.resolve(rootAbs, "." + specifier)
    : path.resolve(path.dirname(fromAbs), specifier);
  const hasExtension = path.extname(base) !== "";
  const withoutExtension = hasExtension ? base.slice(0, -path.extname(base).length) : base;
  const candidates = hasExtension
    ? [
        base,
        // TS source is written with `.js`/`.jsx` specifiers under NodeNext.
        ...TS_EXTENSIONS.map((ext) => `${withoutExtension}${ext}`),
        ...TS_EXTENSIONS.map((ext) => path.join(withoutExtension, `index${ext}`)),
      ]
    : [...TS_EXTENSIONS.map((ext) => `${base}${ext}`), ...TS_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)), base];
  return firstExisting(candidates, rootAbs);
}

function probePython(fromAbs: string, specifier: string, rootAbs: string): string | null {
  if (specifier.startsWith(".")) {
    let dots = 0;
    while (dots < specifier.length && specifier[dots] === ".") dots += 1;
    const rest = specifier.slice(dots);
    let baseDir = path.dirname(fromAbs);
    for (let i = 1; i < dots; i += 1) baseDir = path.dirname(baseDir);
    const parts = rest.split(".").filter(Boolean);
    const modulePath = path.join(baseDir, ...parts);
    const candidates = parts.length === 0
      ? [path.join(baseDir, "__init__.py")]
      : [`${modulePath}.py`, path.join(modulePath, "__init__.py")];
    return firstExisting(candidates, rootAbs);
  }
  const parts = specifier.split(".").filter(Boolean);
  if (parts.length === 0) return null;
  const modulePath = path.join(rootAbs, ...parts);
  return firstExisting([`${modulePath}.py`, path.join(modulePath, "__init__.py")], rootAbs);
}

function externalId(specifier: string, lang: GraphLanguage): string {
  if (lang === "rs") {
    const raw = specifier.startsWith("externcrate:") ? specifier.slice("externcrate:".length) : specifier;
    const top = raw.split("::")[0]?.trim() || raw;
    if (top === "std" || top === "core" || top === "alloc") return `rust:${top}`;
    return `cargo:${top}`;
  }
  if (lang === "py") {
    const top = specifier.split(".")[0] || specifier;
    return `pip:${top}`;
  }
  if (lang === "go") {
    // Stdlib packages never contain a dot in the first path element; Go
    // module paths do (github.com/..., golang.org/...).
    const first = specifier.split("/")[0] || specifier;
    if (first.includes(".")) {
      const parts = specifier.split("/").filter(Boolean);
      return `gomod:${parts.slice(0, 2).join("/")}`;
    }
    return `gomod:stdlib:${first}`;
  }
  if (lang === "java" || lang === "kotlin") {
    const top = specifier.split(".")[0] || specifier;
    if (top === "java" || top === "javax") return `jdk:${specifier.split(".").slice(0, 2).join(".")}`;
    return `maven:${specifier.split(".").slice(0, 2).join(".")}`;
  }
  if (specifier.startsWith("node:")) {
    const name = specifier.slice(5).split("/")[0];
    return `node:${name}`;
  }
  if (specifier.startsWith("@")) {
    return `npm:${specifier.split("/").slice(0, 2).join("/")}`;
  }
  return `npm:${specifier.split("/")[0]}`;
}

function isRelativeSpecifier(specifier: string, lang: GraphLanguage): boolean {
  if (lang === "rs") {
    return (
      specifier.startsWith("moddecl:") ||
      specifier.startsWith("crate::") ||
      specifier.startsWith("super::") ||
      specifier.startsWith("self::") ||
      specifier.startsWith("::")
    );
  }
  if (lang === "go") return false; // Go imports are module paths, never file-relative; probeGo handles them.
  if (lang === "java" || lang === "kotlin") return false; // Java/Kotlin imports are package-qualified, never ./ or ../ relative.
  if (lang === "py") return specifier.startsWith(".");
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

// ---------------------------------------------------------------------------
// Rust module resolution (rustc's file layout, parser-lite)
// ---------------------------------------------------------------------------

const RUST_CRATE_ROOT_FILES = ["main.rs", "lib.rs"];

/**
 * The directory holding main.rs/lib.rs for the crate that owns `abs`,
 * walking up from the file's own directory. Returns null when the file
 * does not belong to any crate inside the workspace (then internal paths
 * stay unresolved instead of guessing against the workspace root).
 */
function rustCrateRootDir(abs: string): string | null {
  let dir = path.dirname(abs);
  for (let i = 0; i < 24; i += 1) {
    if (RUST_CRATE_ROOT_FILES.some((name) => existsSync(path.join(dir, name)))) return dir;
    if (existsSync(path.join(dir, "Cargo.toml"))) {
      const src = path.join(dir, "src");
      if (RUST_CRATE_ROOT_FILES.some((name) => existsSync(path.join(src, name)))) return src;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Module path of a file relative to its crate root (main.rs/lib.rs => []). */
function rustModulePath(abs: string, crateDir: string): string[] {
  const rel = path.relative(crateDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
  const noExt = rel.replace(/\.rs$/i, "").split(path.sep).filter(Boolean);
  const base = noExt[noExt.length - 1];
  if (base === "main" || base === "lib" || base === "build") noExt.pop();
  else if (base === "mod") noExt.pop();
  return noExt;
}

/** Directory in which the children of `abs`'s module live. */
function rustModDir(abs: string): string {
  const base = path.basename(abs).toLowerCase();
  if (base === "mod.rs" || base === "lib.rs" || base === "main.rs" || base === "build.rs") return path.dirname(abs);
  return abs.replace(/\.rs$/i, "");
}

/**
 * Resolve a Rust import specifier to a file, following rustc's rules:
 *   moddecl:X      -> <modDir>/X.rs | <modDir>/X/mod.rs
 *   crate::a::b    -> <crateDir>/a/b.rs (longest existing prefix wins, so
 *                     `use crate::m::item` lands on m.rs when `item` is an item)
 *   self::/super:: -> relative to the current module path
 *   bare a::b      -> uniform path: current module first, then crate root
 * Returns null for `externcrate:` and unresolved internal paths (the caller
 * decides external-vs-unresolved).
 */
function probeRust(fromAbs: string, specifier: string, rootAbs: string): string | null {
  if (specifier.startsWith("externcrate:")) return null;
  if (specifier.startsWith("moddecl:")) {
    const name = specifier.slice("moddecl:".length);
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    const dir = rustModDir(fromAbs);
    return firstExisting([path.join(dir, `${name}.rs`), path.join(dir, name, "mod.rs")], rootAbs);
  }
  const crateDir = rustCrateRootDir(fromAbs);
  if (!crateDir || !isInside(rootAbs, crateDir)) return null;

  let segs: string[];
  if (specifier.startsWith("crate::") || specifier.startsWith("::")) {
    segs = specifier.replace(/^(?:crate::|:+)/, "").split("::").filter(Boolean);
  } else {
    const modPath = [...rustModulePath(fromAbs, crateDir)];
    let rest = specifier;
    if (rest.startsWith("super::") || rest === "super") {
      let supers = 0;
      while (rest.startsWith("super::")) {
        supers += 1;
        rest = rest.slice("super::".length);
      }
      if (rest === "super") {
        supers += 1;
        rest = "";
      }
      for (let i = 0; i < supers && modPath.length > 0; i += 1) modPath.pop();
    } else if (rest.startsWith("self::")) {
      rest = rest.slice("self::".length);
    }
    // Uniform path: current module first, then (unresolved => caller: extern crate).
    segs = [...modPath, ...rest.split("::").filter(Boolean)];
  }

  if (segs.length === 0) {
    return firstExisting(RUST_CRATE_ROOT_FILES.map((name) => path.join(crateDir, name)), rootAbs);
  }
  // Longest existing prefix wins: `use crate::m::item` lands on m.rs when
  // `item` is a plain item, and on item.rs when it is a module.
  for (let k = segs.length; k >= 1; k -= 1) {
    const target = path.join(crateDir, ...segs.slice(0, k));
    const hit = firstExisting([`${target}.rs`, path.join(target, "mod.rs")], rootAbs);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Go module resolution (parser-lite, via go.mod at the workspace root)
// ---------------------------------------------------------------------------


export type GoImportResolution =
  | { kind: "internal"; file: string; confidence: EdgeConfidence }
  | { kind: "external" }
  | { kind: "unresolved"; reason: string };

/**
 * Resolve a Go import:
 *   - specifier equal/below the module prefix -> internal package on disk;
 *     the edge targets the package's main file (name.go, else the single /
 *     alphabetically-first non-test .go file). no go.mod => unresolvable.
 *   - module-qualified paths under other modules, stdlib -> external.
 */
function resolveGoImport(
  fromAbs: string,
  specifier: string,
  rootAbs: string,
): GoImportResolution {
  // Walk up from the importing file to find go.mod (mirrors Rust's crate-root
  // walk; a workspace may nest modules).
  let goModDir: string | null = null;
  let dir = path.dirname(fromAbs);
  for (let i = 0; i < 24 && isInside(rootAbs, dir); i += 1) {
    if (existsSync(path.join(dir, "go.mod"))) {
      goModDir = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!goModDir) return { kind: "external" };

  // Read the module path from go.mod.
  let modulePath: string | null = null;
  try {
    const content = readFileSync(path.join(goModDir, "go.mod"), "utf8")
      .replace(/^\uFEFF/, "")
      .replace(/\r/g, "");
    const match = /^module\s+([^\s]+)/m.exec(content);
    if (match) modulePath = match[1].trim();
  } catch {
    return { kind: "external" };
  }
  if (!modulePath) return { kind: "external" };

  const isInternal =
    specifier === modulePath || specifier.startsWith(`${modulePath}/`);
  if (!isInternal) {
    return { kind: "external" };
  }
  const rest = specifier.slice(modulePath.length).replace(/^\/+/, "");
  const dirRel = rest;
  const dirAbs = rest === "" ? goModDir : path.join(goModDir, ...dirRel.split("/"));
  if (!isInside(rootAbs, dirAbs) || !existsSync(dirAbs)) {
    return { kind: "unresolved", reason: "unresolved Go module path" };
  }
  // Package file selection: <basename>.go first, then the single non-test file,
  // else the alphabetically-first Go file (test files only as a last resort).
  const base = rest === "" ? path.basename(goModDir) : path.basename(dirAbs);
  const convention = path.join(dirAbs, `${base}.go`);
  if (existsSync(convention)) return { kind: "internal", file: convention, confidence: "exact" };
  try {
    const goFiles = readdirSync(dirAbs)
      .filter((f: string) => f.endsWith(".go"))
      .sort();
    const nonTest = goFiles.filter((f: string) => !f.endsWith("_test.go"));
    const pick = nonTest[0] ?? goFiles[0];
    if (pick) {
      return {
        kind: "internal",
        file: path.join(dirAbs, pick),
        confidence: nonTest.length === 1 && !existsSync(convention) ? "exact" : "likely",
      };
    }
    return { kind: "unresolved", reason: "Go package has no .go files" };
  } catch {
    return { kind: "unresolved", reason: "unreadable Go package directory" };
  }
}

type JvmImportResolution =
  | { kind: "internal"; file: string; confidence: EdgeConfidence }
  | { kind: "external" }
  | { kind: "unresolved"; reason: string };

/**
 * Java/Kotlin import resolution, parser-lite.
 * Imports are package-qualified (`com.acme.demo.Service`, `java.util.List`).
 * The package path maps to directories under candidate source roots
 * (`src/main/java`, `src/java`, `src/main/kotlin`, `src/kotlin`, workspace
 * root, or walking up from the importing file); wildcard imports
 * (`foo.bar.*`) are reported as external since no single class can be pinned.
 */
function resolveJvmImport(
  fromAbs: string,
  specifier: string,
  rootAbs: string,
): JvmImportResolution {
  const trimmed = specifier.trim();
  if (trimmed.endsWith(".*")) return { kind: "external" };
  const parts = trimmed.split(".").filter(Boolean);
  if (parts.length < 2) {
    return { kind: "unresolved", reason: "unresolved Java/Kotlin import path" };
  }
  const className = parts[parts.length - 1]!;
  const pkgParts = parts.slice(0, -1);

  const candidateRoots: string[] = [rootAbs,
    path.join(rootAbs, "src", "main", "java"),
    path.join(rootAbs, "src", "java"),
    path.join(rootAbs, "src", "main", "kotlin"),
    path.join(rootAbs, "src", "kotlin")];
  // Walking up from the importing file's dir catches same-package / sibling
  // package refs that don't follow source-root conventions.
  let dir = path.dirname(fromAbs);
  for (let i = 0; i < 24 && isInside(rootAbs, dir); i += 1) {
    candidateRoots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const root of candidateRoots) {
    for (const ext of [".java", ".kt"]) {
      const candidate = path.join(root, ...pkgParts, `${className}${ext}`);
      if (isInside(rootAbs, candidate) && existsSync(candidate)) {
        const confidence = root === rootAbs || root.startsWith(path.join(rootAbs, "src"))
          ? "exact"
          : "likely";
        return { kind: "internal", file: candidate, confidence };
      }
    }
  }
  // Not found on disk under any candidate source root: treat as an external
  // Maven/JDK dependency rather than unresolved (parser-lite approximation).
  return { kind: "external" };
}

function buildEdges(index: Index, withSymbols: boolean): BuiltEdges {
  const edgeMap = new Map<string, Edge>();
  const externals = new Map<string, ExternalUse>();
  const unresolved: Unresolved[] = [];

  const addEdge = (edge: Edge) => {
    if (edge.from === edge.to) return;
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
    const previous = edgeMap.get(key);
    if (!previous) {
      edgeMap.set(key, edge);
      return;
    }
    const keep = previous.line <= edge.line ? previous : edge;
    edgeMap.set(key, {
      ...keep,
      confidence: worseConfidence(previous.confidence, edge.confidence),
      ...(previous.fromSymbol || edge.fromSymbol ? { fromSymbol: keep.fromSymbol ?? previous.fromSymbol ?? edge.fromSymbol } : {}),
    });
  };

  for (const file of index.files.values()) {
    const fromAbs = path.resolve(index.rootAbs, file.rel);
    for (const ref of file.imports) {
      const specifier = ref.specifier;
      if (file.lang === "rs") {
        // Internal-first: moddecl/crate/super/self AND bare uniform paths that
        // resolve to a local module; only what stays unresolved goes external.
        const resolved = probeRust(fromAbs, specifier, index.rootAbs);
        if (resolved) {
          addEdge({
            from: file.rel,
            to: relFromRoot(index.rootAbs, resolved),
            type: "import",
            confidence: ref.dynamic ? "possible" : "exact",
            line: ref.line,
            via: ref.via,
          });
        } else if (isRelativeSpecifier(specifier, file.lang)) {
          if (unresolved.length < 200) {
            unresolved.push({
              from: file.rel,
              specifier: specifier.replace(/^moddecl:/, "mod "),
              reason: "unresolved Rust module path",
            });
          }
        } else {
          const id = externalId(specifier, file.lang);
          const entry = externals.get(id) ?? { id, usedBy: new Set<string>() };
          entry.usedBy.add(file.rel);
          externals.set(id, entry);
        }
        continue;
      }
      if (file.lang === "go") {
        const resolution = resolveGoImport(fromAbs, specifier, index.rootAbs);
        if (resolution.kind === "internal") {
          addEdge({
            from: file.rel,
            to: relFromRoot(index.rootAbs, resolution.file),
            type: "import",
            confidence: resolution.confidence,
            line: ref.line,
            via: ref.via,
          });
        } else if (resolution.kind === "unresolved") {
          if (unresolved.length < 200) {
            unresolved.push({ from: file.rel, specifier, reason: resolution.reason });
          }
        } else {
          const id = externalId(specifier, file.lang);
          const entry = externals.get(id) ?? { id, usedBy: new Set<string>() };
          entry.usedBy.add(file.rel);
          externals.set(id, entry);
        }
        continue;
      }
      if (file.lang === "java" || file.lang === "kotlin") {
        const resolution = resolveJvmImport(fromAbs, specifier, index.rootAbs);
        if (resolution.kind === "internal") {
          addEdge({
            from: file.rel,
            to: relFromRoot(index.rootAbs, resolution.file),
            type: "import",
            confidence: resolution.confidence,
            line: ref.line,
            via: ref.via,
          });
        } else if (resolution.kind === "unresolved") {
          if (unresolved.length < 200) {
            unresolved.push({ from: file.rel, specifier, reason: resolution.reason });
          }
        } else {
          const id = externalId(specifier, file.lang);
          const entry = externals.get(id) ?? { id, usedBy: new Set<string>() };
          entry.usedBy.add(file.rel);
          externals.set(id, entry);
        }
        continue;
      }
      if (isRelativeSpecifier(specifier, file.lang)) {
        const resolved =
          file.lang === "py" ? probePython(fromAbs, specifier, index.rootAbs) : probeTs(fromAbs, specifier, index.rootAbs);
        if (resolved) {
          addEdge({
            from: file.rel,
            to: relFromRoot(index.rootAbs, resolved),
            type: "import",
            confidence: ref.dynamic ? "possible" : "exact",
            line: ref.line,
            via: ref.via,
          });
        } else if (unresolved.length < 200) {
          unresolved.push({
            from: file.rel,
            specifier,
            reason: ref.dynamic ? "unresolved dynamic import" : "unresolved relative import",
          });
        }
        continue;
      }
      if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
        if (unresolved.length < 200) {
          unresolved.push({ from: file.rel, specifier, reason: "workspace alias is not resolved in v1" });
        }
        continue;
      }
      const id = externalId(specifier, file.lang);
      const entry = externals.get(id) ?? { id, usedBy: new Set<string>() };
      entry.usedBy.add(file.rel);
      externals.set(id, entry);
    }
  }

  if (!withSymbols) {
    return { edges: [...edgeMap.values()], externals, unresolved };
  }

  const declarationsByName = new Map<string, Array<{ file: string; decl: Declaration }>>();
  for (const file of index.files.values()) {
    for (const decl of file.declarations) {
      const list = declarationsByName.get(decl.name) ?? [];
      list.push({ file: file.rel, decl });
      declarationsByName.set(decl.name, list);
    }
  }

  for (const file of index.files.values()) {
    if (file.usage) {
      for (const [name, usage] of file.usage) {
        const declared = declarationsByName.get(name);
        if (!declared) continue;
        const targets = [...new Set(declared.map((entry) => entry.file))].filter((target) => target !== file.rel);
        if (targets.length === 0) continue;
        const confidence: EdgeConfidence = targets.length === 1 ? "likely" : "possible";
        for (const target of targets) {
          addEdge({
            from: file.rel,
            to: target,
            type: "references",
            confidence,
            line: usage.line,
            via: `references ${name}`,
            ...(usage.enclosing ? { fromSymbol: usage.enclosing } : {}),
          });
        }
      }
    }
    for (const base of file.bases) {
      const declared = declarationsByName.get(base.name);
      if (!declared) continue;
      const targets = [...new Set(declared.map((entry) => entry.file))].filter((target) => target !== file.rel);
      if (targets.length === 0) continue;
      const confidence: EdgeConfidence = targets.length === 1 ? "likely" : "possible";
      for (const target of targets) {
        addEdge({
          from: file.rel,
          to: target,
          type: base.type,
          confidence,
          line: base.line,
          via: `${base.type} ${base.name}`,
        });
      }
    }
  }

  return { edges: [...edgeMap.values()], externals, unresolved };
}

function sortEdges(edges: Edge[]): Edge[] {
  return edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.type.localeCompare(b.type) ||
      a.line - b.line ||
      a.via.localeCompare(b.via),
  );
}

function escapeDot(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeMermaid(value: string): string {
  return value.replace(/"/g, "'").replace(/\r?\n/g, " ");
}

function renderDot(edges: Edge[], nodes: string[]): string {
  const lines = ["digraph dependencies {", "  rankdir=LR;", '  node [shape=box, fontname="Helvetica"];'];
  for (const id of nodes) lines.push(`  "${escapeDot(id)}";`);
  for (const edge of edges) {
    lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${escapeDot(edge.type)}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function renderMermaid(edges: Edge[], nodes: string[]): string {
  const ids = new Map<string, string>();
  nodes.forEach((id, index) => ids.set(id, `n${index}`));
  const lines = ["graph LR"];
  for (const id of nodes) lines.push(`  ${ids.get(id)}["${escapeMermaid(id)}"]`);
  for (const edge of edges) {
    lines.push(`  ${ids.get(edge.from)} -->|${escapeMermaid(edge.type)}| ${ids.get(edge.to)}`);
  }
  return lines.join("\n");
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export type GraphBuildResult = {
  data: Record<string, unknown>;
  truncated: boolean;
  hint?: string;
};

export async function buildDependencyGraph(
  args: Record<string, unknown>,
  rootAbs: string,
): Promise<GraphBuildResult> {
  const started = Date.now();
  const kindRaw = String(args.kind ?? "files").toLowerCase();
  if (!["files", "symbols", "both"].includes(kindRaw)) {
    throw new Error('[invalid_request] `kind` must be "files", "symbols" or "both".');
  }
  const kind = kindRaw as "files" | "symbols" | "both";
  const formatRaw = String(args.format ?? "json").toLowerCase();
  if (!["json", "dot", "mermaid"].includes(formatRaw)) {
    throw new Error('[invalid_request] `format` must be "json", "dot" or "mermaid".');
  }
  const format = formatRaw as "json" | "dot" | "mermaid";
  const depth = numberArg(args.depth, 3, 1, 10);
  const languages = parseLanguages(args.languages);
  const includeExternal = args.include_external === true || args.include_external === 1;
  const includeTests = !(args.include_tests === false || args.include_tests === 0);
  const maxNodes = numberArg(args.max_nodes, 500, 1, 2000);
  const maxEdges = numberArg(args.max_edges, 2000, 1, 5000);
  const startRel = typeof args.relative_path === "string" ? args.relative_path : "";
  const withSymbols = kind !== "files";

  const { index, cache } = await buildIndex(rootAbs, startRel, depth, languages, withSymbols);
  if (index.files.size === 0) {
    const label = index.startRel || ".";
    return {
      data: {
        root: label,
        kind,
        generated_at: new Date().toISOString(),
        nodes: [],
        edges: [],
        external: [],
        stats: {
          files_scanned: 0,
          files_skipped: index.filesSkipped,
          edges: 0,
          duration_ms: Date.now() - started,
          cache,
        },
        truncated: index.discoveryTruncated,
        next_cursor: null,
      },
      truncated: index.discoveryTruncated,
      hint: `No supported files (TS/JS/Python/Rust) under ${label}. Hint: pass relative_path to a source directory, or set languages=${JSON.stringify(["ts", "py", "rs"])}.`,
    };
  }

  const built = buildEdges(index, withSymbols);
  let edges = built.edges.filter((edge) => {
    if (!includeTests && (looksTestFile(edge.from) || looksTestFile(edge.to))) return false;
    if (kind === "files") return edge.type === "import";
    if (kind === "symbols") return edge.type !== "import";
    return true;
  });
  const truncatedEdges = edges.length > maxEdges;
  edges = sortEdges(edges).slice(0, maxEdges);

  const nodeIds = new Map<string, { id: string; language: GraphLanguage }>();
  for (const file of index.files.values()) {
    if (!includeTests && looksTestFile(file.rel)) continue;
    nodeIds.set(file.rel, { id: file.rel, language: file.lang });
  }
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) {
      if (!nodeIds.has(id)) {
        const lang = languageForFile(id);
        if (lang) nodeIds.set(id, { id, language: lang });
      }
    }
  }
  const sortedNodeIds = [...nodeIds.keys()].sort();
  const truncatedNodes = sortedNodeIds.length > maxNodes;
  const keptNodes = sortedNodeIds.slice(0, maxNodes);
  const kept = new Set(keptNodes);
  const beforeFilter = edges.length;
  edges = edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  const truncated = index.discoveryTruncated || truncatedEdges || truncatedNodes || edges.length < beforeFilter;

  if (format !== "json") {
    const graph = format === "dot" ? renderDot(edges, keptNodes) : renderMermaid(edges, keptNodes);
    return {
      data: {
        root: index.startRel || ".",
        kind,
        format,
        graph,
        stats: {
          files_scanned: index.filesScanned,
          files_skipped: index.filesSkipped,
          edges: edges.length,
          duration_ms: Date.now() - started,
          cache,
        },
        truncated,
        next_cursor: null,
      },
      truncated,
      ...(truncated
        ? { hint: "Graph truncated at max_nodes/max_edges/files. Hint: narrow with relative_path, lower depth, or raise max_nodes/max_edges." }
        : {}),
    };
  }

  const nodes = keptNodes.map((id) => {
    const entry = index.files.get(id);
    return {
      id,
      type: "file",
      language: nodeIds.get(id)?.language ?? "ts",
      loc: entry?.loc ?? 0,
    };
  });

  const external = includeExternal
    ? [...built.externals.values()]
        .map((entry) => ({ id: entry.id, used_by: entry.usedBy.size }))
        .sort((a, b) => b.used_by - a.used_by || a.id.localeCompare(b.id))
        .slice(0, 200)
    : [];

  const data = {
    root: index.startRel || ".",
    kind,
    generated_at: new Date().toISOString(),
    nodes,
    edges,
    external,
    unresolved: built.unresolved.slice(0, 50),
    stats: {
      files_scanned: index.filesScanned,
      files_skipped: index.filesSkipped,
      edges: edges.length,
      duration_ms: Date.now() - started,
      cache,
    },
    truncated,
    next_cursor: null,
  };
  return {
    data,
    truncated,
    ...(truncated
      ? { hint: "Graph truncated at max_nodes/max_edges/files. Hint: narrow with relative_path, lower depth, or raise max_nodes/max_edges." }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Change impact
// ---------------------------------------------------------------------------

type SymbolSeed = { name: string; file?: string };

function parseSymbolSeeds(value: unknown): SymbolSeed[] {
  if (!Array.isArray(value)) return [];
  const seeds: SymbolSeed[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (name) seeds.push({ name });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) continue;
      const file =
        typeof record.relative_path === "string"
          ? record.relative_path
          : typeof record.file === "string"
            ? record.file
            : undefined;
      seeds.push({ name, ...(file ? { file } : {}) });
    }
  }
  return seeds;
}

function parsePathSeeds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

export type ImpactBuildResult = {
  data: Record<string, unknown>;
  truncated: boolean;
  hint?: string;
};

export async function buildChangeImpact(
  args: Record<string, unknown>,
  rootAbs: string,
): Promise<ImpactBuildResult> {
  const started = Date.now();
  const fileSeeds = parsePathSeeds(args.files);
  const rawSymbolSeeds = Array.isArray(args.symbols) ? args.symbols : [];
  const symbolSeeds = parseSymbolSeeds(rawSymbolSeeds);
  if (fileSeeds.length === 0 && symbolSeeds.length === 0) {
    throw new Error("[invalid_request] Pass at least one of `files` or `symbols`. Hint: files=[\"src/lib/util.ts\"] or symbols=[\"parseConfig\"].");
  }
  const directionRaw = String(args.direction ?? "dependents").toLowerCase();
  if (!["dependents", "dependencies", "both"].includes(directionRaw)) {
    throw new Error('[invalid_request] `direction` must be "dependents", "dependencies" or "both".');
  }
  const direction = directionRaw as "dependents" | "dependencies" | "both";
  const depth = numberArg(args.depth, 5, 1, 10);
  const includeTests = !(args.include_tests === false || args.include_tests === 0);
  const maxNodes = numberArg(args.max_nodes, 300, 1, 2000);
  const formatRaw = String(args.format ?? "json").toLowerCase();
  if (!["json", "mermaid"].includes(formatRaw)) {
    throw new Error('[invalid_request] `format` must be "json" or "mermaid".');
  }
  const format = formatRaw as "json" | "mermaid";

  const { index, cache } = await buildIndex(rootAbs, "", 20, null, true);
  const unresolved: Unresolved[] = [];
  const seedFiles = new Set<string>();
  const seedSymbols = new Set<string>();

  for (const raw of fileSeeds) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(rootAbs, raw);
    if (!isInside(rootAbs, abs)) {
      throw new Error(`[path_escape] Seed file is outside the workspace: ${raw}.`);
    }
    if (!existsSync(abs)) {
      throw new Error(`[not_found] Seed file does not exist: ${raw}. Hint: check it with project_list_files.`);
    }
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`[not_found] Seed file does not exist: ${raw}.`);
    }
    if (!stat.isFile()) {
      throw new Error(`[invalid_request] Seed path is not a file: ${raw}.`);
    }
    seedFiles.add(relFromRoot(rootAbs, abs));
  }

  const declarationsByName = new Map<string, Array<{ file: string; decl: Declaration }>>();
  for (const file of index.files.values()) {
    for (const decl of file.declarations) {
      const list = declarationsByName.get(decl.name) ?? [];
      list.push({ file: file.rel, decl });
      declarationsByName.set(decl.name, list);
    }
  }

  // A bare symbol name declared in more than one file cannot be pinned down:
  // seed every declaring file, but mark the traversal as "possible" so callers
  // do not treat the closure as exact.
  const possibleSeedFiles = new Set<string>();

  for (const seed of symbolSeeds) {
    let declared = declarationsByName.get(seed.name) ?? [];
    if (seed.file) {
      const abs = path.isAbsolute(seed.file) ? seed.file : path.resolve(rootAbs, seed.file);
      if (!isInside(rootAbs, abs)) {
        throw new Error(`[path_escape] Symbol seed file is outside the workspace: ${seed.file}.`);
      }
      const rel = relFromRoot(rootAbs, abs);
      declared = declared.filter((entry) => entry.file === rel);
      if (declared.length === 0) {
        unresolved.push({ from: rel, symbol: seed.name, reason: "symbol is not declared in this file" });
        continue;
      }
    }
    if (declared.length === 0) {
      unresolved.push({ from: "", symbol: seed.name, reason: "symbol is not declared in the workspace (it may be external)" });
      continue;
    }
    const files = [...new Set(declared.map((entry) => entry.file))].sort();
    if (files.length > 1) {
      unresolved.push({
        from: "",
        symbol: seed.name,
        reason: `ambiguous: declared in ${files.length} files; pass {name, file} to disambiguate`,
        files,
      });
      if (!seed.file) files.forEach((file) => possibleSeedFiles.add(file));
    }
    seedSymbols.add(seed.name);
    for (const file of files) seedFiles.add(file);
  }

  const built = buildEdges(index, true);
  unresolved.push(...built.unresolved.slice(0, 50));

  if (seedFiles.size === 0) {
    return {
      data: {
        root: ".",
        seed: { files: [], symbols: [...seedSymbols].sort() },
        direction,
        affected: [],
        unresolved,
        summary: { affected_files: 0, affected_symbols: 0, max_distance: 0, tests_affected: 0 },
        truncated: false,
      },
      truncated: false,
      hint: "No seed file resolved. Hint: pass files=[...] or a symbol declared in the workspace.",
    };
  }

  const forward = new Map<string, Edge[]>();
  const reverse = new Map<string, Edge[]>();
  for (const edge of built.edges) {
    const f = forward.get(edge.from) ?? [];
    f.push(edge);
    forward.set(edge.from, f);
    const r = reverse.get(edge.to) ?? [];
    r.push(edge);
    reverse.set(edge.to, r);
  }

  type Reached = {
    distance: number;
    path: string[];
    reason: string;
    confidence: EdgeConfidence;
    symbols: Set<string>;
  };
  const reached = new Map<string, Reached>();
  const queue: Array<{ file: string; distance: number; path: string[]; confidence: EdgeConfidence }> = [];
  for (const seed of seedFiles) {
    const seedConfidence: EdgeConfidence = possibleSeedFiles.has(seed) ? "possible" : "exact";
    reached.set(seed, { distance: 0, path: [seed], reason: "seed", confidence: seedConfidence, symbols: new Set() });
    queue.push({ file: seed, distance: 0, path: [seed], confidence: seedConfidence });
  }
  const affectedSymbols = new Set<string>();
  const impactEdges: Array<{ from: string; to: string; type: EdgeType; confidence: EdgeConfidence }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.distance >= depth) continue;
    const next: Edge[] = [];
    if (direction === "dependents" || direction === "both") {
      for (const edge of reverse.get(current.file) ?? []) next.push(edge);
    }
    if (direction === "dependencies" || direction === "both") {
      for (const edge of forward.get(current.file) ?? []) next.push(edge);
    }
    for (const edge of next) {
      const isReverse = direction === "dependents" || (direction === "both" && reverse.get(current.file)?.includes(edge));
      const target = isReverse ? edge.from : edge.to;
      if (seedFiles.has(target)) continue;
      const distance = current.distance + 1;
      const confidence = worseConfidence(current.confidence, edge.confidence);
      const previous = reached.get(target);
      // Parallel edges (an import + a reference, extends + reference) still
      // contribute their enclosing symbol even when the file was already hit.
      if (edge.fromSymbol) {
        affectedSymbols.add(edge.fromSymbol);
        previous?.symbols.add(edge.fromSymbol);
      }
      if (previous && previous.distance <= distance) {
        if (previous.distance === distance && CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[previous.confidence]) {
          previous.confidence = confidence;
        }
        continue;
      }
      const reasonEdgeFile = isReverse ? current.file : edge.to;
      const reason = edge.fromSymbol
        ? `${edge.type === "references" ? "references" : edge.type} ${edge.fromSymbol}`
        : `${edge.type === "import" ? "imports" : edge.type} ${reasonEdgeFile}`;
      const symbols = new Set<string>();
      if (edge.fromSymbol) symbols.add(edge.fromSymbol);
      reached.set(target, {
        distance,
        path: [...current.path, target],
        reason,
        confidence,
        symbols,
      });
      if (edge.fromSymbol) impactEdges.push({ from: edge.from, to: edge.to, type: edge.type, confidence: edge.confidence });
      queue.push({ file: target, distance, path: [...current.path, target], confidence });
    }
  }

  const affectedAll = [...reached.entries()]
    .filter(([id]) => !seedFiles.has(id))
    .map(([id, entry]) => ({
      id,
      type: "file",
      distance: entry.distance,
      path: entry.path,
      reason: entry.reason,
      confidence: entry.confidence,
      ...(entry.symbols.size > 0 ? { symbols: [...entry.symbols].sort() } : {}),
    }))
    .filter((entry) => includeTests || !looksTestFile(entry.id))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));

  const truncated = affectedAll.length > maxNodes;
  const affected = affectedAll.slice(0, maxNodes);
  const testsAffected = affected.filter((entry) => looksTestFile(entry.id)).length;
  const maxDistance = affected.reduce((max, entry) => Math.max(max, entry.distance), 0);
  const summary = {
    affected_files: affected.length,
    affected_symbols: affectedSymbols.size,
    max_distance: maxDistance,
    tests_affected: testsAffected,
  };
  const seed = { files: [...seedFiles].sort(), symbols: [...seedSymbols].sort() };

  if (format === "mermaid") {
    const nodes = [seed.files, affected.map((entry) => entry.id)].flat();
    const uniqueNodes = [...new Set(nodes)];
    const edges = affected.flatMap((entry) =>
      entry.path.length >= 2
        ? [{ from: entry.path[entry.path.length - 2], to: entry.id, type: "depends" as const, confidence: entry.confidence }]
        : [],
    );
    return {
      data: {
        root: ".",
        seed,
        direction,
        graph: renderMermaid(
          edges.map((edge) => ({ from: edge.from, to: edge.to, type: "import" as EdgeType, confidence: edge.confidence, line: 0, via: "" })),
          uniqueNodes,
        ),
        summary,
        unresolved,
        truncated,
      },
      truncated,
      hint: truncated ? "Impact list truncated at max_nodes. Hint: narrow the seeds or raise max_nodes." : undefined,
    };
  }

  return {
    data: {
      root: ".",
      seed,
      direction,
      affected,
      unresolved,
      summary,
      truncated,
      cache,
      duration_ms: Date.now() - started,
    },
    truncated,
    ...(truncated
      ? { hint: "Impact list truncated at max_nodes. Hint: narrow the seeds, lower depth, or raise max_nodes." }
      : {}),
  };
}
