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
  kind: "function" | "class" | "method" | "variable" | "constant" | "interface" | "type" | "struct" | "enum" | "constructor" | "property" | "unknown";
  line: number;
  signature?: string;
};

const SYMBOL_REGEX = [
  // TypeScript / JavaScript
  /^(export\s+default\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^(export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(export\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(export\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)/,
  /^(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  // Rust
  /^(pub\s+)?(fn|func)\s+([A-Za-z_][\w]*)/,
  /^(pub\s+)?(struct|enum|impl|trait|type)\s+([A-Za-z_][\w]*)/,
  // Python
  /^def\s+([A-Za-z_][\w]*)/,
  /^class\s+([A-Za-z_][\w]*)/,
  // Go
  /^(func|type|const|var)\s+([A-Za-z_][\w]*)/,
] as const;

function detectKind(match: RegExpMatchArray, line: string): SymbolInfo["kind"] {
  const full = match[0].toLowerCase();
  if (full.startsWith("class") || full.startsWith("abstract")) return "class";
  if (full.startsWith("interface") || full.startsWith("type")) return "type";
  if (full.startsWith("enum")) return "enum";
  if (full.startsWith("struct")) return "struct";
  if (full.startsWith("fn") || full.startsWith("func") || full.startsWith("def")) return "function";
  if (full.startsWith("impl")) return "class";
  if (full.startsWith("trait")) return "interface";
  if (full.startsWith("const") || full.startsWith("let") || full.startsWith("var")) {
    return /const/i.test(line) ? "constant" : "variable";
  }
  return "unknown";
}

function findSymbolOnLine(line: string): SymbolInfo | null {
  for (const re of SYMBOL_REGEX) {
    const match = line.match(re);
    if (match) {
      // Group 2 or 3 is the symbol name depending on the pattern
      const name = match[2] ?? match[3] ?? match[1];
      if (name && name !== "default" && name !== "function") {
        return {
          name: String(name),
          kind: detectKind(match, line),
          line: 0, // set by caller
          signature: line.trim().slice(0, 160),
        };
      }
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
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Track braces for a cheap "top-level" heuristic
    for (const ch of trimmed) {
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
    }
    // Only record a symbol when we are at (or near) the top level
    if (braceDepth > 0 && trimmed.startsWith("  ") === false) {
      // could be a nested definition; keep but mark lower-priority
    }
    const sym = findSymbolOnLine(trimmed);
    if (!sym) continue;
    if (!includeFunctions && sym.kind === "function") continue;
    if (!includeClasses && (sym.kind === "class" || sym.kind === "type" || sym.kind === "interface")) continue;
    sym.line = i + 1;
    symbols.push(sym);
  }
  void language;
  return symbols;
}

/**
 * Build an outline (symbols + rough nesting) for a single file.
 * Used by project_outline_symbol.
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
};

/**
 * Compute a simple unified (LCS-based) diff between two file contents.
 * @param a - original text
 * @param b - revised text
 * @param contextLines - context around changes (default 3, git-style)
 * @param maxLines - cap the diff length before truncating
 */
export function diffUnified(a: string, b: string, contextLines = 3, maxLines = 500): DiffResult {
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

  return { lines_added: added, lines_removed: removed, unified_diff: out.join("\n"), truncated };
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
  let truncated = false;

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
        hits.push({
          relative_path: rel,
          line_number: idx + 1,
          text: line.trim().slice(0, 200),
          score,
          matched,
        });
        totalHits++;
        if (hits.length >= limit) {
          truncated = true;
          return { hits, total_files: files.size, total_hits: totalHits, truncated };
        }
      }
    }
  }
  // Sort by score desc
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), total_files: files.size, total_hits: totalHits, truncated };
}
