/**
 * Dependency graph — indexer: duyệt workspace, đọc file, rút declarations/bases/usages
 * và cache index. Tách khỏi dependency-graph.ts; hành vi giữ nguyên.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { type GraphLanguage, normalizeRel, isInside, relFromRoot, protectedLike } from "./dependency-graph-common.js";
import { type ImportRef, stripTsNonCode, stripPythonNonCode, stripRustNonCode, parseImportsTs, parseImportsPython, parseImportsRust, parseImportsGo, parseImportsJava, splitLines } from "./dependency-graph-parse.js";

export const EXT_LANG: Record<string, GraphLanguage> = {
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

export const IGNORED_DIRS = new Set([
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

export const MAX_FILES = 5000;

export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export const MAX_FILE_BYTES = 1024 * 1024;

export const INDEX_CACHE_TTL_MS = 5000;

export const INDEX_CACHE_MAX = 8;

export type Declaration = {
  name: string;
  kind: string;
  line: number;
  signature?: string;
};

export type BaseRef = {
  name: string;
  type: "extends" | "implements";
  line: number;
};

export type Usage = { line: number; enclosing?: string };

export type FileEntry = {
  rel: string;
  lang: GraphLanguage;
  loc: number;
  bytes: number;
  imports: ImportRef[];
  declarations: Declaration[];
  bases: BaseRef[];
  usage?: Map<string, Usage>;
};

export type Index = {
  rootAbs: string;
  startRel: string;
  files: Map<string, FileEntry>;
  filesScanned: number;
  filesSkipped: number;
  discoveryTruncated: boolean;
  durationMs: number;
};

export type CachedIndex = { at: number; index: Index };

export const indexCache = new Map<string, CachedIndex>();

/** Drop the index after a mutation. Called by the tool layer on every write. */
export function invalidateDependencyGraphCache(): void {
  indexCache.clear();
}

export function languageForFile(rel: string): GraphLanguage | undefined {
  return EXT_LANG[path.extname(rel).toLowerCase()];
}

export function languageAllowed(lang: GraphLanguage, requested: Set<string> | null): boolean {
  if (!requested) return true;
  if (requested.has(lang)) return true;
  if (lang === "tsx" && (requested.has("ts") || requested.has("tsx"))) return true;
  if (lang === "jsx" && (requested.has("js") || requested.has("jsx"))) return true;
  return false;
}

export function collectDeclarations(text: string, lang: GraphLanguage): Declaration[] {
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
        // JVM declaration headers tolerate any run of visibility/semantics
        // modifiers (`public final class`, `open class`, `data class`,
        // `sealed interface`, `internal class`, …) — match modifiers first,
        // then the keyword, so `open class KBase` is not invisible.
        const MODS = "(?:(?:public|private|protected|internal|abstract|final|sealed|open|data|annotation|inner|expect|actual)\\s+)*";
        const candidates: Array<{ re: RegExp; kind: string }> = [
          { re: new RegExp(`^\\s*${MODS}class\\s+([A-Za-z_][\\w]*)`), kind: "class" },
          { re: new RegExp(`^\\s*${MODS}interface\\s+([A-Za-z_][\\w]*)`), kind: "interface" },
          { re: new RegExp(`^\\s*${MODS}(?:enum\\s+class|enum)\\s+([A-Za-z_][\\w]*)`), kind: "enum" },
          { re: /^\s*(?:companion\s+)?object\s+([A-Za-z_][\w]*)/, kind: "class" },
          { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?[A-Za-z_<>\[\],\s]*\s+([A-Za-z_][\w]*)\s*(?:\*|&)?\s*(?:=|;)/, kind: "variable" },
          { re: new RegExp(`^\\s*${MODS}fun\\s+([A-Za-z_][\\w]*)`), kind: "function" },
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

export function normalizeBaseName(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .trim()
    .replace(/^[.*&]+/, "")
    .replace(/\s+as\s+.*$/, "")
    .trim();
}

/** Split a comma list, ignoring commas nested in <>, () and []. */
export function splitTopLevel(rest: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of rest) {
    if (ch === "<" || ch === "(" || ch === "[") depth += 1;
    else if (ch === ">" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (cur.trim()) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Last dotted segment of a possibly package-qualified base name. */
export function lastBaseSegment(name: string): string {
  return name.split(".").pop()?.trim() ?? "";
}

export function collectBases(text: string, lang: GraphLanguage): BaseRef[] {
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
  if (lang === "java" || lang === "kotlin") {
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("@")) continue;
      if (lang === "java") {
        // class/interface/record/enum Foo<T> extends Bar<Z> implements I1, I2 {
        const decl = /(?:^|\s)(?:class|interface|record|enum)\s+[A-Za-z_][\w]*/.exec(line);
        if (!decl) continue;
        const extendsMatch = /\bextends\s+([^{]*?)(?:\bimplements\b|\{|$)/.exec(line);
        if (extendsMatch) {
          for (const part of splitTopLevel(normalizeBaseName(extendsMatch[1]))) {
            const name = lastBaseSegment(part);
            if (name && /^[A-Za-z_]\w*$/.test(name)) bases.push({ name, type: "extends", line: i + 1 });
          }
        }
        const implementsMatch = /\bimplements\s+([^{]*?)(?:\{|$)/.exec(line);
        if (implementsMatch) {
          for (const part of splitTopLevel(normalizeBaseName(implementsMatch[1]))) {
            const name = lastBaseSegment(part);
            if (name && /^[A-Za-z_]\w*$/.test(name)) bases.push({ name, type: "implements", line: i + 1 });
          }
        }
        continue;
      }
      // kotlin: `class Foo : Bar(), I1, I2 {` | `interface I : J` | `object O : Base()`
      const m = /^(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|final\s+|open\s+|sealed\s+|data\s+|annotation\s+|inner\s+|enum\s+)*(class|interface|object)\s+[A-Za-z_][\w]*(?:<[^>]*>)?(?:\s*\([^)]*\))?\s*:\s*([^{]+)/.exec(line);
      if (m) {
        const isInterfaceDecl = m[1] === "interface";
        for (const partRaw of splitTopLevel(normalizeBaseName(m[2]))) {
          const part = partRaw.trim();
          if (!part) continue;
          // A supertype with constructor args is the superclass; a bare name is
          // an interface (Kotlin's `:` list mixes both). Interface supertypes
          // are always `extends`.
          const isSuperclass = part.includes("(");
          const name = lastBaseSegment(part.replace(/\([^)]*\)\s*$/, ""));
          if (name && /^[A-Za-z_]\w*$/.test(name)) {
            bases.push({ name, type: isInterfaceDecl || isSuperclass ? "extends" : "implements", line: i + 1 });
          }
        }
      }
    }
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

export function enclosingDeclaration(declarations: Declaration[], line: number): string | undefined {
  let current: Declaration | undefined;
  for (const decl of declarations) {
    if (decl.line > line) break;
    current = decl;
  }
  return current?.name;
}

export function scanUsages(
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

export type Discovered = {
  rootAbs: string;
  startRel: string;
  files: Array<{ rel: string; abs: string; lang: GraphLanguage; bytes: number; skipped: boolean }>;
  skipped: number;
  truncated: boolean;
};

export async function discover(
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
    throw new Error(`[not_found] Path does not exist: ${relStart}. Hint: check it with list_files.`);
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

export async function readText(abs: string): Promise<string | null> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(abs);
  } catch {
    return null;
  }
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

export async function buildIndex(
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