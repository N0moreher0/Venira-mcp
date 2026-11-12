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
// A precise diagnosis of a failed edit (roadmap item 15, P2)
//
// The error must be small: a long edit that does not apply used to answer with
// a long error, and the agent paid for every token of it. The answer is now a
// diagnosis - which file, which line, how far off it is - plus three lines of
// context on each side of the wrong spot.
// ---------------------------------------------------------------------------

export type EditMismatch = {
  /** The line in the file where the text stops matching (1-based). */
  line: number;
  /** The line of the edit that did not match (1-based). */
  edit_line: number;
  /** The first character of that line that differs (0-based). */
  char_offset: number;
  /** How many characters the line is off (the length difference). */
  chars_off: number;
  /** The line the edit expected (truncated). */
  expected_line: string;
  /** The line the file has (truncated). */
  actual_line: string;
  /** One sentence: what is wrong. */
  detail: string;
};

/** How many characters of one line the error carries. */
const CONTEXT_LINE_CHARS = 160;
/** How many lines before and after the mismatch the error carries. */
const CONTEXT_RADIUS = 3;

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
  const fileLines = content.split("\n");
  let tabLines = 0;
  const spaceWidths = new Set<number>();
  for (const line of fileLines) {
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

/** The first character where two lines differ, and the length delta. */
function lineDifference(expected: string, actual: string): { char_offset: number; chars_off: number } {
  const limit = Math.min(expected.length, actual.length);
  let offset = 0;
  while (offset < limit && expected[offset] === actual[offset]) offset += 1;
  return { char_offset: offset, chars_off: actual.length - expected.length };
}

const truncateLine = (value: string): string =>
  value.length > CONTEXT_LINE_CHARS ? `${value.slice(0, CONTEXT_LINE_CHARS)}...` : value;

/**
 * Where does the edit stop matching the file?
 *
 * The edit's lines are aligned with the file's lines (longest common
 * subsequence); the first line that has no counterpart is where the edit went
 * wrong. For a normal edit this is exact; for a pathological one (a huge
 * needle against a huge file) it falls back to the closest line.
 */
export function findEditMismatch(content: string, needle: string): EditMismatch | null {
  const fileLines = content.split("\n");
  const needleLines = needle.split("\n");
  if (needleLines.length === 0) return null;

  const m = needleLines.length;
  const n = fileLines.length;
  let aligned: Map<number, number> | null = null;
  if (m * n <= 2_000_000) {
    // LCS table (needle x file).
    const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        table[i][j] =
          needleLines[i] === fileLines[j]
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    aligned = new Map();
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (needleLines[i] === fileLines[j]) {
        aligned.set(i, j);
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }

  // The first needle line without a counterpart is the mismatch.
  let fileIndex = -1;
  let needleIndex = -1;
  if (aligned) {
    let lastNeedle = -1;
    let lastFile = -1;
    for (let i = 0; i < m; i += 1) {
      const match = aligned.get(i);
      if (match === undefined) {
        needleIndex = i;
        // Where the file *should* have that line: the previous aligned line
        // plus the distance between the two needle lines.
        fileIndex = lastFile >= 0 ? lastFile + (i - lastNeedle) : -1;
        break;
      }
      lastNeedle = i;
      lastFile = match;
    }
    if (needleIndex === -1) return null; // the needle is in the file after all
    if (fileIndex >= n) fileIndex = -1;
  } else {
    // Fallback: the file line that resembles the needle's first line most.
    const grams = bigrams(needleLines[0] ?? "");
    let best = -1;
    let bestScore = -1;
    for (let j = 0; j < n; j += 1) {
      const score = similarity(grams, bigrams(fileLines[j] ?? ""));
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    needleIndex = 0;
    fileIndex = best;
  }

  const expected = needleLines[needleIndex] ?? "";
  let actual = fileIndex >= 0 ? fileLines[fileIndex] ?? "" : "";
  if (fileIndex < 0) {
    // No position to compare with: take the file line that resembles the
    // expected one most, so the agent still gets "the file has X".
    const grams = bigrams(expected);
    let best = -1;
    let bestScore = -1;
    for (let j = 0; j < n; j += 1) {
      const score = similarity(grams, bigrams(fileLines[j] ?? ""));
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best >= 0 && bestScore > 0.3) {
      fileIndex = best;
      actual = fileLines[best] ?? "";
    }
  }
  const { char_offset, chars_off } = lineDifference(expected, actual);
  const line = fileIndex >= 0 ? fileIndex + 1 : Math.min(n, Math.max(1, fileIndex + 2));
  const detail =
    fileIndex >= 0
      ? `the file has "${truncateLine(actual)}" where the edit expects "${truncateLine(expected)}"`
      : `the edit expects a line the file does not have: "${truncateLine(expected)}"`;

  return {
    line,
    edit_line: needleIndex + 1,
    char_offset,
    chars_off,
    expected_line: truncateLine(expected),
    actual_line: truncateLine(actual),
    detail,
  };
}

/**
 * The lines around the wrong spot: three before, the line itself, three
 * after. No line numbers in `text` (copy it straight into old_text), the
 * numbers only in `numbered` for orientation.
 */
export function buildEditContext(
  content: string,
  line: number,
  relativePath: string,
  radius = CONTEXT_RADIUS,
): { header: string; text: string; numbered: string; first_line: number; last_line: number } {
  const lines = content.split("\n");
  const first = Math.max(0, line - 1 - radius);
  const last = Math.min(lines.length, line + radius);
  const slice = lines.slice(first, last).map((value) => truncateLine(value));
  const width = String(last).length;
  return {
    header: `Lines ${first + 1}-${last} of ${relativePath}:`,
    text: slice.join("\n"),
    numbered: slice
      .map((value, index) => `${String(first + 1 + index).padStart(width, " ")}| ${value}`)
      .join("\n"),
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
