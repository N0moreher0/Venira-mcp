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
