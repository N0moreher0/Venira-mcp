export function editMatchLocations(
  content: string,
  needle: string,
  limit = 5,
): Array<{ line: number; context: string[] }> {
  const lines = content.split("\n");
  const locations: Array<{ line: number; context: string[] }> = [];
  let offset = 0;
  while (locations.length < limit) {
    const index = content.indexOf(needle, offset);
    if (index < 0) break;
    const line = content.slice(0, index).split("\n").length;
    const start = Math.max(0, line - 2);
    const end = Math.min(lines.length, line + 1);
    locations.push({ line, context: lines.slice(start, end).map((value) => value.slice(0, 240)) });
    offset = index + Math.max(needle.length, 1);
  }
  return locations;
}

// ---------------------------------------------------------------------------
// Copy-pasteable guidance for a failed edit (roadmap item 15, P2)
//
// Three traps this closes:
//
//   1. **The line-number trap.** The file content an agent reads comes with
//      line-number prefixes ("130:   if (dryRun) {"). Copying that back into
//      old_text never matches - the second attempt fails the same way. The
//      snippet here carries the numbers only in a header; `text` is the file
//      content itself.
//   2. **The invisible whitespace trap.** Plain text does not show whether a
//      file uses tabs or spaces, so a model that guesses "4 spaces" for a tab
//      file fails again. The detected indentation and the line endings are
//      reported explicitly.
//   3. **The truncated snippet.** A snippet that stops exactly where the
//      agent's old_text ended leaves it guessing. The snippet carries a
//      buffer of lines before and after the nearest region.
// ---------------------------------------------------------------------------

export type EditSnippet = {
  /** "Lines 130-145 of src/app.ts:" - the range the snippet covers. */
  header: string;
  /** The file content of that range, without line numbers: copy this. */
  text: string;
  /** The same lines with their numbers, for orientation only. */
  numbered: string;
  /** "4 spaces" | "tabs" | "mixed" | "none" */
  indentation: string;
  /** "CRLF" | "LF" | "mixed" */
  line_endings: string;
  first_line: number;
  last_line: number;
};

const SNIPPET_BUFFER_LINES = 10;

function bigrams(text: string): Set<string> {
  const clean = text.trim();
  const out = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

/** Jaccard similarity of two bigram sets: cheap and good enough to find the
 *  line an agent meant to edit. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** How the file indents: tabs, a number of spaces, or mixed. */
export function detectIndentation(content: string): string {
  const lines = content.split("\n");
  let tabLines = 0;
  const spaceWidths = new Set<number>();
  for (const line of lines) {
    const match = /^([ \t]+)/.exec(line);
    if (!match) continue;
    const indent = match[1];
    if (indent.includes("\t")) tabLines += 1;
    else spaceWidths.add(indent.length);
  }
  if (tabLines > 0 && spaceWidths.size > 0) return "mixed";
  if (tabLines > 0) return "tabs";
  if (spaceWidths.size === 0) return "none";
  const widths = [...spaceWidths].sort((a, b) => a - b);
  // The most common indent width (the mode of the distinct widths).
  const width = widths[Math.floor(widths.length / 2)];
  return `${width} spaces`;
}

/** The line endings the file uses. */
export function detectLineEndings(content: string): string {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf > 0) return "mixed";
  if (crlf > 0) return "CRLF";
  return "LF";
}

/**
 * The region of the file an agent most likely meant to edit.
 *
 * `needle` is the text it tried to replace. The anchor is the line that
 * resembles it most; the snippet covers that line plus a buffer, so the
 * agent has the whole neighbourhood (and can copy it straight back).
 */
export function buildEditSnippet(
  content: string,
  relativePath: string,
  needle: string,
  buffer = SNIPPET_BUFFER_LINES,
): EditSnippet {
  const lines = content.split("\n");
  const needleLine = needle.split("\n")[0] ?? "";
  const needleGrams = bigrams(needleLine);

  let anchor = 0;
  let best = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const score = similarity(needleGrams, bigrams(lines[i]));
    if (score > best) {
      best = score;
      anchor = i;
    }
  }

  const first = Math.max(0, anchor - buffer);
  const last = Math.min(lines.length, anchor + buffer + 1);
  const slice = lines.slice(first, last);
  const width = String(last).length;
  return {
    header: `Lines ${first + 1}-${last} of ${relativePath}:`,
    text: slice.join("\n"),
    numbered: slice
      .map((value, index) => `${String(first + 1 + index).padStart(width, " ")}| ${value}`)
      .join("\n"),
    indentation: detectIndentation(content),
    line_endings: detectLineEndings(content),
    first_line: first + 1,
    last_line: last,
  };
}

export function normalizeForFuzzy(text: string, ignoreIndentation: boolean, caseInsensitive: boolean): string {
  let value = text;
  if (ignoreIndentation) {
    value = value.replace(/^\s+/, "").replace(/\n/g, "\n").replace(/( +)(\t)/g, "$2");
  } else {
    value = value.replace(/\s+/g, " ").trim();
  }
  if (caseInsensitive) value = value.toLowerCase();
  return value;
}

export function levenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[n][m];
}
