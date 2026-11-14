/**
 * P2/P3 code-intelligence helpers: language-aware symbol extraction,
 * outline, unified diff, and selective multi-query search.
 *
 * All of these run over plain UTF-8 text (no external indexer), so they are
 * safe to call against any workspace file.
 */

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

export type SymbolInfo = {
  name: string;
  kind: "function" | "class" | "method" | "macro" | "variable" | "constant" | "interface" | "type" | "struct" | "enum" | "constructor" | "property" | "unknown";
  line: number;
  signature?: string;
};

const SYMBOL_REGEX: ReadonlyArray<{ re: RegExp; kind?: SymbolInfo["kind"] }> = [
  // TypeScript / JavaScript
  { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { re: /^(?:export\s+)?(?:default\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
  // TS/JS class methods (async/static/get/set/constructor), only when the line
  // clearly opens a body: `name(...) {`. Calls like `fetch("/api")` are excluded.
  { re: /^(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^()]*\)\s*(?::[^{=]+)?\{\s*$/, kind: "method" },
  // Rust (async/unsafe/extern fn, visibility qualifiers like pub(crate), const/static,
  // impl blocks incl. generics and `impl Trait for Target` — target type is captured)
  { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_][\w]*)/ },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_][\w]*)/ },
  { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_][\w]*)\s*:/ },
  { re: /^(?:unsafe\s+)?impl(?:\s*<[^>]*>)?(?:\s+[^\s<]+(?:<[^>]*>)?\s+for)?\s+([A-Za-z_][\w]*)/ },
  // Rust macros
  { re: /^macro_rules!\s*([a-z_][\w]*)/, kind: "macro" },
  // Python (async def included)
  { re: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  { re: /^class\s+([A-Za-z_][\w]*)/ },
  // Go (receiver methods and generics included)
  { re: /^func\s*(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/ },
  { re: /^(?:type|const|var)\s+([A-Za-z_][\w]*)/ },
];

// Words that may look like TS/JS method names but are control-flow keywords.
const METHOD_BLOCKLIST = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "class", "const", "let", "var",
  "do", "else", "new", "typeof", "await", "of", "in", "instanceof",
]);

function detectKind(match: RegExpMatchArray): SymbolInfo["kind"] {
  const full = match[0].toLowerCase();
  if (/\b(interface|trait)\b/.test(full)) return "interface";
  if (/\btype\b/.test(full)) return "type";
  if (/\benum\b/.test(full)) return "enum";
  if (/\bstruct\b/.test(full)) return "struct";
  if (/\b(class|impl|abstract)\b/.test(full)) return "class";
  if (/\b(fn|func|def|function)\b/.test(full)) return "function";
  if (/\bconst\b/.test(full) || /\bstatic\b/.test(full)) return "constant";
  if (/\b(let|var)\b/.test(full)) return "variable";
  return "unknown";
}

function findSymbolOnLine(line: string): SymbolInfo | null {
  for (const entry of SYMBOL_REGEX) {
    const match = line.match(entry.re);
    if (match) {
      const name = match[1];
      if (!name) continue;
      if (entry.kind === "method" && METHOD_BLOCKLIST.has(name.toLowerCase())) continue;
      return {
        name: String(name).trim(),
        kind: entry.kind ?? detectKind(match),
        line: 0, // set by caller
        signature: line.trim().slice(0, 160),
      };
    }
  }
  return null;
}

/**
 * Extract top-level symbols from a source file.
 * @param text - full file text
 * @param language - optional language hint; defaults to auto-detect from extensions
 * @param includeFunctions
 * @param includeClasses
 */
export function extractSymbols(
  text: string,
  language?: string,
  includeFunctions = true,
  includeClasses = true,
): SymbolInfo[] {
  const lines = text.split("\n");
  const symbols: SymbolInfo[] = [];
  const noise = { block: false, tpl: false };
  let braceDepth = 0;
  // Kind of the most recent top-level symbol, so members of a class / impl /
  // trait can be listed while locals inside plain functions are not.
  let enclosing: SymbolInfo["kind"] | null = null;
  // Python-style files have no braces: members share one indentation level.
  let memberIndent: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    let startDepth = braceDepth;
    const continuesNoise = noise.block || noise.tpl;
    // Count braces outside strings, comments and regex literals only.
    let delta = 0;
    for (const ch of stripNoise(raw, noise)) {
      if (ch === "{") delta++;
      else if (ch === "}") delta--;
    }
    braceDepth = Math.max(0, braceDepth + delta);
    // Continuation of a block comment / template literal: never a declaration.
    if (continuesNoise) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const indent = raw.length - raw.trimStart().length;

    const sym = findSymbolOnLine(trimmed);
    // Drift guard: this is a cheap lexer, so an exotic literal can leave the
    // depth too high. A declaration in column 0 is top-level by convention,
    // so trust the indentation and resynchronise from this line.
    if (sym && indent === 0 && startDepth > 0) {
      startDepth = 0;
      braceDepth = Math.max(0, delta);
    }
    if (!sym) {
      // A plain top-level statement ends the previous class scope
      // (comments, closing brackets and decorators do not).
      if (indent === 0 && startDepth === 0 && !/^(?:[})\]@#*]|\/[/*])/.test(trimmed)) {
        enclosing = null;
        memberIndent = null;
      }
      continue;
    }

    const topLevel = startDepth === 0 && indent === 0;
    let accept = topLevel;
    if (!accept && (enclosing === "class" || enclosing === "interface")) {
      if (startDepth === 1) {
        accept = true; // C-like: members sit exactly one brace deep
      } else if (startDepth === 0 && indent > 0) {
        if (memberIndent === null) memberIndent = indent; // Python-like
        accept = indent === memberIndent;
      }
    }
    if (!accept) continue;
    if (topLevel) {
      enclosing = sym.kind;
      memberIndent = null;
    }

    if (!includeFunctions && sym.kind === "function") continue;
    if (!includeClasses && (sym.kind === "class" || sym.kind === "type" || sym.kind === "interface")) continue;
    sym.line = i + 1;
    symbols.push(sym);
  }
  void language;
  return symbols;
}

/**
 * Remove string literals and comments from one line so that braces inside
 * them do not skew the depth count. `noise` carries multi-line state
 * (block comments, template literals) from line to line.
 */
function stripNoise(line: string, noise: { block: boolean; tpl: boolean }): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (noise.block) {
      if (ch === "*" && line[i + 1] === "/") {
        noise.block = false;
        i++;
      }
      continue;
    }
    if (noise.tpl) {
      if (ch === "\\") i++;
      else if (ch === "`") noise.tpl = false;
      continue;
    }
    if (ch === "/" && line[i + 1] === "*") {
      noise.block = true;
      i++;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "`") {
      noise.tpl = true;
      continue;
    }
    // Regex literal: `/` where an expression (not a division) may start.
    // Needed because patterns like /[^{=]+\{/ hold unbalanced braces.
    if (ch === "/" && (/(?:^|[(,=:[!&|?{};]|\breturn)\s*$/.test(out))) {
      let j = i + 1;
      let inClass = false;
      while (j < line.length) {
        const c = line[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j++;
      }
      if (j < line.length) {
        i = j; // skip the whole literal (flags are harmless to keep)
        continue;
      }
      // No closing slash on this line: it was a division, keep scanning.
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      if (j < line.length) {
        i = j; // skip the whole literal
        continue;
      }
      // Unmatched quote (e.g. a Rust lifetime like `'a`): keep scanning normally.
    }
    out += ch;
  }
  return out;
}

/**
 * Build an outline (symbols + rough nesting) for a single file.
 * Used by outline_symbol.
 */
export function buildOutline(text: string): { symbols: SymbolInfo[]; total_symbols: number } {
  const symbols = extractSymbols(text);
  return { symbols, total_symbols: symbols.length };
}

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

export type DiffResult = {
  lines_added: number;
  lines_removed: number;
  unified_diff: string;
  truncated: boolean;
  /** Roadmap item 15 (P2): the two files are byte-identical. */
  identical: boolean;
};

/**
 * Compute a simple unified (LCS-based) diff between two file contents.
 * @param a - original text
 * @param b - revised text
 * @param contextLines - context around changes (default 3, git-style)
 * @param maxLines - cap the diff length before truncating
 */
export function diffUnified(a: string, b: string, contextLines = 3, maxLines = 500): DiffResult {
  if (a === b) {
    return { lines_added: 0, lines_removed: 0, unified_diff: "", truncated: false, identical: true };
  }
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;

  // LCS table
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Walk to produce the unified diff
  const out: string[] = [];
  let i = 0, j = 0;
  let added = 0, removed = 0;
  let truncated = false;

  // Prepend file headers
  out.push("--- a/file");
  out.push("+++ b/file");

  const chunk: string[] = [];
  function flushChunk() {
    if (chunk.length === 0) return;
    // Count old/new lines
    const oldLines = chunk.filter((l) => l.startsWith("-") || l.startsWith("@")).filter((l) => !l.startsWith("@")).length;
    const newLines = chunk.filter((l) => l.startsWith("+") || l.startsWith("@")).filter((l) => !l.startsWith("@")).length;
    // Find a representative start
    let startOld = 0, startNew = 0;
    const lines = chunk;
    for (const l of lines) {
      if (l.startsWith("-")) startOld++;
      if (l.startsWith("+")) startNew++;
    }
    const hunkHeader = `@@ -${startOld},${oldLines} +${startNew},${newLines} @@`;
    out.push(hunkHeader);
    out.push(...chunk);
    chunk.length = 0;
  }

  while (i < n && j < m) {
    if (A[i] === B[j]) {
      chunk.push(` ${A[i]}`);
      i++; j++;
    } else if (i < n && j < m && lcs[i + 1][j] >= lcs[i][j + 1]) {
      // Remove A[i]
      chunk.push(`-${A[i]}`);
      removed++;
      i++;
    } else {
      // Add B[j]
      chunk.push(`+${B[j]}`);
      added++;
      j++;
    }
    if (out.length + chunk.length > maxLines) {
      truncated = true;
      break;
    }
  }
  if (!truncated) {
    while (i < n) {
      chunk.push(`-${A[i]}`);
      removed++;
      i++;
      if (chunk.length > maxLines) { truncated = true; break; }
    }
    while (j < m) {
      chunk.push(`+${B[j]}`);
      added++;
      j++;
      if (chunk.length > maxLines) { truncated = true; break; }
    }
  }
  flushChunk();
  if (truncated) out.push("\\ No newline at end of file");

  return { lines_added: added, lines_removed: removed, unified_diff: out.join("\n"), truncated, identical: false };
}

// ---------------------------------------------------------------------------
// Selective multi-query search
// ---------------------------------------------------------------------------

export type SelectiveQuery = {
  pattern: string;
  must?: boolean;
  weight?: number;
};

export type SelectiveResult = {
  hits: Array<{ relative_path: string; line_number: number; text: string; score: number; matched: string[] }>;
  total_files: number;
  total_hits: number;
  truncated: boolean;
};

/**
 * "Smart" search: combine multiple queries (AND/OR/NOT), fuzzy-ish, scoring.
 * @param files - map of relative_path -> text content
 * @param queries - list of patterns
 * @param limit - max number of hits
 */
export function selectiveSearch(
  files: Map<string, string>,
  queries: SelectiveQuery[],
  limit = 200,
): SelectiveResult {
  const hits: SelectiveResult["hits"] = [];
  let totalHits = 0;

  for (const [rel, text] of files.entries()) {
    const lines = text.split("\n");
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      let score = 0;
      const matched: string[] = [];
      let allMust = true;
      for (const q of queries) {
        const needle = q.pattern.toLowerCase();
        const found = line.toLowerCase().includes(needle);
        if (found) {
          score += (q.weight ?? 1);
          matched.push(q.pattern);
        }
        if (q.must && !found) {
          allMust = false;
        }
      }
      if (allMust && matched.length > 0) {
        totalHits++;
        const candidate = {
          relative_path: rel,
          line_number: idx + 1,
          text: line.trim().slice(0, 200),
          score,
          matched,
        };
        // Keep only the best `limit` candidates while scanning every line.
        // Returning as soon as the list fills makes later, higher-scoring hits
        // invisible and renders the score sort below ineffective.
        let low = 0;
        let high = hits.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (hits[middle].score >= candidate.score) low = middle + 1;
          else high = middle;
        }
        if (low < limit) {
          hits.splice(low, 0, candidate);
          if (hits.length > limit) hits.pop();
        }
      }
    }
  }
  return { hits, total_files: files.size, total_hits: totalHits, truncated: totalHits > limit };
}
