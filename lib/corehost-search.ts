/**
 * corehost content-search op (opSearch + ripgrep fast path + hit ranking).
 * Extracted from corehost.ts; behaviour is unchanged.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveInWorkspace, type RustResponse } from "./corehost-common.js";
import { isProtectedPath } from "./workspace.js";
import { envFlag } from "./env.js";

/** Max files the JS fallback walker collects before it stops and reports
 *  complete=false. Bounds searches rooted at huge trees (e.g. absolute paths
 *  outside the workspace when VENIRA_UNRESTRICTED=1). */
function maxScanFiles(): number {
  const raw = Number(process.env.VENIRA_SEARCH_MAX_FILES ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.min(5_000_000, Math.floor(raw)) : 50_000;
}

/** Reports `relative_path` relative to the workspace when the file is inside it;
 *  falls back to the absolute path otherwise (unrestricted out-of-workspace search). */
function relToRoot(absPath: string, root: string): string {
  const rel = path.relative(root, absPath);
  if (rel === "") return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return absPath;
  return rel.replace(/\\/g, "/");
}


let ripgrepAvailableCache: boolean | null = null;
async function ripgrepInstalled(): Promise<boolean> {
  if (ripgrepAvailableCache !== null) return ripgrepAvailableCache;
  try {
    const result = await new Promise<boolean>((resolve) => {
      const child = spawn("rg", ["--version"], { timeout: 5000 });
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignored */ }
        resolve(false);
      }, 5000);
      child.on("exit", (code: number | null) => {
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(code === 0);
      });
      child.on("error", () => {
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(false);
      });
      child.stdout?.resume();
      child.stderr?.resume();
    });
    ripgrepAvailableCache = result;
  } catch {
    ripgrepAvailableCache = false;
  }
  return ripgrepAvailableCache;
}

function ripgrepExec(args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string; error?: any; }> {
  return new Promise((resolve) => {
    const child = spawn("rg", args, { timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch { /* ignored */ }
      resolve({ status: null, stdout, stderr, error: { code: "ETIMEDOUT" } });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { stdout += d; });
    child.stderr?.on("data", (d: string) => { stderr += d; });
    child.on("error", (e: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: e });
    });
    child.on("exit", (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Score a search hit so the most useful results surface first — agents
 * usually only read the first few hits, so ranking matters more than raw
 * ripgrep order (which is filesystem order).
 *
 * Scoring (higher = better):
 *   - whole-word match      +40   (identifier found as a standalone token)
 *   - prefix match          +20   (line starts with the query)
 *   - file-name match       +30   (query appears in the file name)
 *   - shallow depth         +10   (files closer to workspace root)
 *   - early line            +10   (line number < 10)
 * Case-insensitive matching throughout; `needle` is pre-lowercased and
 * `wordRe` is precompiled by the caller (rankHits) — the query text itself
 * may contain regex metacharacters, so it is never interpolated raw.
 */
function scoreHit(hit: Record<string, unknown>, needle: string, rel: string, wordRe: RegExp): number {
  let score = 0;
  const snippet = String(hit.snippet ?? "").toLowerCase();
  const lineLower = snippet;
  // whole-word: needle bounded by non-identifier chars on both sides
  if (wordRe.test(lineLower)) score += 40;
  else if (lineLower.includes(needle)) score += 15; // substring fallback
  if (lineLower.startsWith(needle)) score += 20; // prefix (definition-like)
  const base = path.basename(rel).toLowerCase();
  if (base.includes(needle)) score += 30;
  else if (rel.toLowerCase().includes(needle)) score += 15;
  const depth = rel.split("/").length;
  score += Math.max(0, 10 - depth); // shallow files first
  const ln = Number(hit.line_number ?? 0);
  if (ln > 0 && ln <= 10) score += 10; // early line
  return score;
}

/**
 * Sort hits so the most relevant are first, then stable by (path, line).
 * Scores are computed once and carried through the sort (no double work).
 */
function rankHits(hits: Array<Record<string, unknown>>, needle: string): void {
  const wordRe = new RegExp(
    `(?:^|[^A-Za-z0-9_$])${escapeRegExpLiteral(needle)}(?:[^A-Za-z0-9_$]|$)`,
    "i",
  );
  const scored = hits.map((hit) => ({
    hit,
    rel: String(hit.relative_path ?? "").toLowerCase(),
    line: Number(hit.line_number ?? 0),
    score: scoreHit(hit, needle, String(hit.relative_path ?? ""), wordRe),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.rel !== b.rel) return a.rel < b.rel ? -1 : 1;
    return a.line - b.line;
  });
  for (let i = 0; i < scored.length; i += 1) hits[i] = scored[i].hit;
}

/**
 * Validate and compile a user-supplied search regex once, before either backend
 * runs. The complexity guard must not be bypassed by the ripgrep fast path.
 */
function compileSearchRegex(query: string, caseSensitive: boolean): RegExp {
  if (query.length > 512 || /(?:\([^)]*[+*][^)]*\)|\[[^\]]+\][+*])[+*{]/.test(query)) {
    throw new Error("[resource_limit] Regex too complex");
  }
  try {
    return new RegExp(query, caseSensitive ? "" : "i");
  } catch (error) {
    throw new Error(`[invalid_request] Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function opSearch(
  args: Record<string, unknown>,
  root: string,
): Promise<RustResponse> {
  if (typeof args.query !== "string") {
    throw new Error("[invalid_request] Search requires a string query. Hint: pass arguments.query in every search item.");
  }
  const query = args.query;
  const kind = (args.kind as string) ?? "literal_content";
  const searchRoot = resolveInWorkspace(args.relative_path as string, root);
  // Roadmap item 15 (P2): a search in a path that does not exist is a
  // mistake, not an empty result. `dependency_graph`, `snapshot create` and
  // `change_impact` already answer not_found; search answers the same way.
  try {
    const stat = await fs.stat(searchRoot);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(
        "[invalid_request] The search path is neither a file nor a directory. " +
          "Hint: pass an existing file or folder.",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[")) throw error;
    throw new Error(
      `[not_found] Path does not exist: ${String(args.relative_path ?? ".")}. ` +
        "Hint: check it with list_files.",
    );
  }
  // Hidden files are searched by default (parity with the JS walker; agents
  // legitimately search `.github/`, `.vscode/`). Pass include_hidden=0 to skip
  // dotfiles (rg-style). Protected secrets are always excluded either way.
  const includeHidden = args.include_hidden === undefined
    ? true
    : args.include_hidden === true || args.include_hidden === 1;
  const wholeWord = args.whole_word === true || args.whole_word === 1;
  if (isProtectedPath(searchRoot)) {
    throw new Error(`[sensitive_result] Path is protected by policy: ${args.relative_path}. Hint: do not search protected files.`);
  }
  const glob = args.glob as string | undefined;
  const excludeGlob = args.exclude_glob as string | undefined;
  const caseSensitive = args.case_sensitive !== false;
  const limit = Math.min(200, (args.limit as number | undefined) ?? 200);
  const contextLines = Math.min(20, (args.context_lines as number | undefined) ?? 0);
  const countOnly = args.count_only === true;

  // Glob-to-regex with rg/gitignore semantics, matched against the workspace-relative path:
  //   *  = any characters except "/"      ?  = one character except "/"      [seq] = character class
  //   ** = anything, "**/" = zero or more directories      {a,b} = alternatives
  //   a pattern without "/" ("*.ts", "corehost-*.ts") matches the file name at any depth.
  function globToRegex(g: string): RegExp {
    if (g.length > 256) {
      throw new Error("[resource_limit] glob is too long; limit it to 256 characters.");
    }
    const anywhere = !g.includes("/");
    let re = "";
    let braceDepth = 0;
    for (let i = 0; i < g.length; i += 1) {
      const ch = g[i] as string;
      if (ch === "*") {
        if (g[i + 1] === "*") {
          const slashAfter = g[i + 2] === "/";
          i += slashAfter ? 2 : 1;
          re += slashAfter ? "(?:.*/)?" : ".*";
        } else re += "[^/]*";
      } else if (ch === "?") re += "[^/]";
      else if (ch === "[" || ch === "]") re += ch;
      else if (ch === "{") { braceDepth += 1; re += "(?:"; }
      else if (ch === "}" && braceDepth > 0) { braceDepth -= 1; re += ")"; }
      else if (ch === "," && braceDepth > 0) re += "|";
      else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    if (braceDepth > 0) re += ")".repeat(braceDepth);
    return new RegExp(anywhere ? `(?:^|/)${re}$` : `^${re}$`);
  }

  const includeRe = glob ? globToRegex(glob) : null;
  const excludeRe = excludeGlob ? globToRegex(excludeGlob) : null;

  const IGNORED = new Set([
    ".git", "node_modules", "target", "dist", "build",
    ".next", ".venv", "__pycache__", ".cache", ".turbo", "coverage",
  ]);

  type Hit = {
    relative_path: string;
    line_number?: number;
    snippet?: string;
    context?: string[];
  };
  const hits: Hit[] = [];
  const diagnostics: string[] = [];
  let complete = true;
  let totalMatchLines = 0;
  let countedFilesMatched = 0;
  /** How many matches the scan collected at most (the rg fast path has a cap). */
  let scanCap: number | undefined;
  /**
   * WHY the result is incomplete, so the hint can say the right thing:
   *   file_cap  - the JS walker / rg fallback stopped at the file cap
   *               (matches in later files are missing entirely)
   *   match_cap - too many matching LINES were collected before ranking
   *   limit     - matches were collected fine, the output was trimmed to `limit`
   */
  let cutReason: "file_cap" | "match_cap" | "limit" | null = null;
  const markCut = (reason: "file_cap" | "match_cap" | "limit", cap?: number) => {
    complete = false;
    if (cutReason === null || reason === "file_cap") cutReason = reason;
    if (cap !== undefined && reason === "match_cap") scanCap = cap;
  };
  /**
   * One hint for the two ways a search can disappoint the caller.
   * Roadmap item 15 (P2): the cut case used to say "see diagnostics" while
   * `diagnostics` was empty, and `total_match_lines` looked like the real
   * number of matches although it stops at the scan cap.
   */
  const searchHint = (): string | undefined => {
    if (!complete && hits.length === 0) {
      return cutReason === "file_cap"
        ? `The file scan stopped at the file cap (${maxScanFiles()} files) before finding any hit; more files were not inspected. Narrow relative_path/glob, or raise VENIRA_SEARCH_MAX_FILES.`
        : "The scan was cut before any hit was found. Narrow relative_path/glob, or raise the limit (max 200).";
    }
    if (hits.length === 0) {
      return "No matches. Broaden the search: drop glob/relative_path, set regex=0, or use kind=file_name.";
    }
    if (!complete) {
      if (cutReason === "file_cap") {
        return `The file scan stopped at the file cap (${maxScanFiles()} files); matching files beyond it are missing (${totalMatchLines} collected match(es) so far). Narrow relative_path/glob, or raise VENIRA_SEARCH_MAX_FILES.`;
      }
      if (cutReason === "match_cap") {
        return (
          `The search collected more than ${scanCap ?? "the cap"} matching lines and stopped before ranking, ` +
          "so this is not the full picture. Narrow it with glob/relative_path."
        );
      }
      return (
        `More matches existed than the limit (${limit}); the best-ranked ${limit} are returned ` +
        `(${totalMatchLines} collected). Raise limit (max 200) or narrow the query.`
      );
    }
    return undefined;
  };
  /** The fields that say what the numbers mean. */
  const searchMeta = () => ({
    limit,
    ...(scanCap !== undefined ? { match_scan_cap: scanCap } : {}),
    ...(cutReason !== null ? { limited_by: cutReason } : {}),
    files_matched_scope: "returned_hits" as const,
  });

  async function collectFiles(dir: string): Promise<{ files: string[]; scanTruncated: boolean }> {
    const files: string[] = [];
    let scanTruncated = false;
    const cap = maxScanFiles();
    async function walk(d: string): Promise<void> {
      if (files.length >= cap) { scanTruncated = true; return; }
      let entries;
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (scanTruncated) return;
        if (entry.isSymbolicLink()) continue;
        // Hidden files/dot-directories are skipped unless include_hidden=1.
        // IGNORED (node_modules/target/…) and isProtectedPath always apply.
        if (!includeHidden && entry.name.startsWith(".")) continue;
        const abs = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED.has(entry.name)) continue;
          await walk(abs);
        } else if (entry.isFile()) {
          if (isProtectedPath(abs)) continue;
          files.push(abs);
          if (files.length >= cap) { scanTruncated = true; return; }
        }
      }
    }
    await walk(dir);
    return { files, scanTruncated };
  }

  const needle = caseSensitive ? query : query.toLowerCase();

  if (kind === "file_name" || kind === "directory_name") {
    const { files, scanTruncated } = await collectFiles(searchRoot);
    if (scanTruncated) markCut("file_cap");
    for (const abs of files) {
      if (hits.length >= limit) { markCut("limit"); break; }
      const basename = path.basename(abs);
      const match = caseSensitive ? basename.includes(query) : basename.toLowerCase().includes(needle);
      if (!match) continue;
      if (kind === "file_name" && (await fs.stat(abs)).isDirectory()) continue;
      if (kind === "directory_name" && !(await fs.stat(abs)).isDirectory()) continue;
      const rel = relToRoot(abs, root);
      hits.push({ relative_path: rel });
      totalMatchLines += 1;
    }
  } else {
    // literal_content, regex, definition — Phase 1 (bounded parallel
    // chunked reads) + Phase 2 (binary-ext + null-byte guards).
    // Ripgrep-backed fast path if available (safe spawn, no shell).
    // Include/exclude globs map to `rg --glob` (a negated glob for exclude);
    // they no longer silently disable this path on huge workspaces.
    // context_lines are NOT taken from rg's `-C` output — context records
    // would need per-file cluster correlation, so instead each hit file is
    // re-read once (bounded, chunked) and the surrounding lines are sliced,
    // exactly matching the JS path's `context` shape.
    // Validate regex complexity/invalid syntax before either backend runs.
    // Without this, rg (which compiles patterns in Rust) would happily serve a
    // query such as `(a+)+$` and the resource guard would never fire.
    if (args.regex === true) compileSearchRegex(query, caseSensitive);

    if (envFlag("VENIRA_USE_RIPGREP", true) && kind === "literal_content" && !countOnly) {
      if (await ripgrepInstalled()) {
        try {
          // Match the JS scanner's view of the tree: rg must not honor
          // .gitignore/global ignore because the JS walker does not.
          // Hidden files follow include_hidden, and the same built-in
          // IGNORED directories are excluded by glob.
          const argList = ["--json", "-n", "--max-filesize=1M", "--color=never", "--no-ignore", "--no-ignore-vcs"];
          for (const ign of [".git","node_modules","target","dist","build",".next",".venv","__pycache__",".cache",".turbo","coverage"]) {
            argList.push("--glob", `!**/${ign}/**`);
          }
          if (!caseSensitive) argList.push("-i");
          if (wholeWord) argList.push("-w");
          if (includeHidden) argList.push("--hidden");
          if (args.regex === true) { argList.push("-e", String(query)); }
          else { argList.push("-F", "-e", String(query)); }
          // rg anchors a glob containing "/" to its own cwd, not the workspace, so those globs are
          // applied to the workspace-relative path below (same includeRe/excludeRe as the JS scanner).
          if (glob && !String(glob).includes("/")) argList.push("--glob", String(glob));
          if (excludeGlob && !String(excludeGlob).includes("/")) argList.push("--glob", `!${excludeGlob}`);
          // Hidden exclusion goes last: rg applies later globs with higher
          // precedence, so a caller glob such as `*.ts` cannot re-include a
          // dotfile when include_hidden=0.
          if (!includeHidden) {
            argList.push("--glob", "!**/.*");
            argList.push("--glob", "!**/.*/**");
          }
          // No per-file --max-count and no early global break before ranking:
          // rg runs multithreaded, so its output order is not stable. Collect
          // a bounded set, rank, then trim to the caller's limit.
          const COLLECT_CAP = Math.max(limit * 10, 1000);
          argList.push(searchRoot);
          const resp = await ripgrepExec(argList, 10000);

          // Only clean exits (0 = matches, 1 = no matches) are served by the
          // fast path. Exit 2 (rg-internal error, e.g. an invalid regex that
          // survived JSON parsing) or any spawn error falls through to the JS
          // scanner, which either serves the query or throws the proper
          // [invalid_request] envelope — never a silent empty "no matches".
          if ((resp.status === 0 || resp.status === 1) && !resp.error) {
            const lines = String(resp.stdout ?? "").split(/\r?\n/).filter(Boolean);
            // Safety cap only: never cut at `limit` before ranking, because
            // rg's multithreaded output order is not stable.
            for (const raw of lines) {
              let rec: any = null;
              try { rec = JSON.parse(raw); } catch { continue; }
              if (rec?.type !== "match") continue;
              const pth = String(rec.data?.path?.text ?? "");
              const abs = path.isAbsolute(pth) ? pth : path.resolve(root, pth);
              if (isProtectedPath(abs)) continue;
              const rel = relToRoot(abs, root);
              // Mirror collectFiles() exactly: hidden segments and built-in
              // IGNORED dirs are dropped even if rg's glob handling lets one
              // through (keeps both backends returning the same hit set).
              const segments = rel.split("/");
              if (!includeHidden && segments.some((seg) => seg.startsWith("."))) continue;
              if (segments.some((seg) => IGNORED.has(seg))) continue;
              if (includeRe && !includeRe.test(rel)) continue;
              if (excludeRe && excludeRe.test(rel)) continue;
              const ln = Number(rec.data?.line_number ?? 0);
              const lineText = String(rec.data?.lines?.text ?? "").replace(/\r?\n$/, "");
              const snippet = lineText.trim().slice(0, 200);
              hits.push({ relative_path: rel, line_number: ln, snippet });
              totalMatchLines += 1;
              if (hits.length >= COLLECT_CAP) { markCut("match_cap", COLLECT_CAP); break; }
            }
            // Rank first, then trim to the caller's limit, so high-ranked hits
            // survive regardless of rg's thread ordering.
            rankHits(hits, needle);
            if (hits.length > limit) {
              hits.length = limit;
              markCut("limit");
            }
            if (contextLines > 0 && hits.length > 0) {
              const hitsByRel = new Map<string, Hit[]>();
              for (const hit of hits) {
                const list = hitsByRel.get(hit.relative_path) ?? [];
                list.push(hit);
                hitsByRel.set(hit.relative_path, list);
              }
              const distinct = [...hitsByRel.keys()];
              for (let ci = 0; ci < distinct.length; ci += 16) {
                const chunk = distinct.slice(ci, ci + 16);
                await Promise.all(chunk.map(async (rel) => {
                  const abs = path.resolve(root, rel);
                  if (isProtectedPath(abs)) return;
                  let content: string;
                  try { content = await fs.readFile(abs, "utf8"); }
                  catch { return; }
                  if (Buffer.byteLength(content, "utf8") > 1_048_576) return;
                  if (content.indexOf("\u0000") >= 0) return;
                  const lines = content.split(/\r?\n/);
                  for (const hit of hitsByRel.get(rel) ?? []) {
                    const idx = (hit.line_number ?? 0) - 1;
                    if (idx < 0 || idx >= lines.length) continue;
                    const start = Math.max(0, idx - contextLines);
                    const end = Math.min(lines.length, idx + contextLines + 1);
                    hit.context = lines.slice(start, end);
                  }
                }));
              }
            }
            return {
              status: "completed",
              truncated: !complete,
              result: {
                kind: "search",
                data: {
                  hits,
                  complete,
                  diagnostics,
                  total_match_lines: totalMatchLines,
                  files_matched: new Set(hits.map((h) => h.relative_path)).size,
                  ...searchMeta(),
                  // Roadmap item 15 (P2): `limited` says "a limit cut the
                  // result", `truncated` is kept for compatibility.
                  limited: !complete,
                  hint: searchHint(),
                },
              },
            };
          }
        } catch {
          // fall through to JS scanning
        }
      }
    }

    const { files, scanTruncated } = await collectFiles(searchRoot);
    if (scanTruncated) markCut("file_cap");
    const useRegex = args.regex === true;
    let wordRe: RegExp | null = null;
    if (wholeWord) {
      wordRe = new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExpLiteral(needle)}(?:[^A-Za-z0-9_$]|$)`, caseSensitive ? "" : "i");
    }
    let contentRe: RegExp | null = null;
    if (useRegex) {
      contentRe = compileSearchRegex(query, caseSensitive);
    }

    const BINARY_EXT = new Set([".png",".jpg",".jpeg",".gif",".webp",".bmp",".ico",".tiff",
      ".woff",".woff2",".ttf",".otf",".eot",".svg",".pdf",".zip",".gz",".tgz",".7z",".rar",".tar",
      ".mp3",".mp4",".mov",".avi",".mkv",".webm",".exe",".dll",".so",".dylib",".o",".a",
      ".wasm",".pyc",".class",".jar"]);

    type FileEntry = { abs: string; rel: string; content: string };
    const entries: Array<FileEntry | null> = [];
    const READ_CHUNK = 16;
    for (let ci = 0; ci < files.length; ci += READ_CHUNK) {
      const chunk = files.slice(ci, ci + READ_CHUNK);
      const results = await Promise.all(chunk.map(async (abs): Promise<FileEntry | null> => {
        const rel = relToRoot(abs, root);
        if (includeRe && !includeRe.test(rel)) return null;
        if (excludeRe && excludeRe.test(rel)) return null;
        if (BINARY_EXT.has(path.extname(rel).toLowerCase())) return null;
        let content: string;
        try { content = await fs.readFile(abs, "utf8"); }
        catch { return null; }
        if (Buffer.byteLength(content, "utf8") > 1_048_576) return null;
        if (content.indexOf("\u0000") >= 0) return null;
        return { abs, rel, content };
      }));
      entries.push(...results);
    }

    const needleConst = needle;
    // When countOnly is true, we don't collect hits at all - just count matches.
    // The limit is ignored for counting (per schema: "limit is then ignored").
    if (!countOnly) {
      for (const entry of entries) {
        if (!entry) continue;
        if (hits.length >= limit) { markCut("limit"); break; }
        const { rel, content } = entry;

        const lines = content.split(/\r?\n/);
        const matchIndices: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineLower = caseSensitive ? line : line.toLowerCase();
          const match = useRegex
            ? (contentRe as RegExp).test(line)
            : kind === "definition"
              ? /^\s*(?:export\s+)?(?:function|class|const|let|var|type|interface|struct|fn|impl|trait|enum)\s+/.test(line) &&
                (wordRe ? wordRe.test(lineLower) : lineLower.includes(needleConst))
              : wordRe
                ? wordRe.test(lineLower)
                : lineLower.includes(needleConst);
          if (match) matchIndices.push(i);
        }
        if (matchIndices.length === 0) continue;
        totalMatchLines += matchIndices.length;

        for (const idx of matchIndices) {
          // Same collection cap as the rg path: collect, rank, then trim so the
          // two backends agree on which hits survive `limit`.
          if (hits.length >= Math.max(limit * 10, 1000)) {
            markCut("match_cap", Math.max(limit * 10, 1000));
            break;
          }
          const snippet = lines[idx].trim().slice(0, 200);
          const hit: Hit = { relative_path: rel, line_number: idx + 1 };
          hit.snippet = snippet;
          if (contextLines > 0) {
            const start = Math.max(0, idx - contextLines);
            const end = Math.min(lines.length, idx + contextLines + 1);
            hit.context = lines.slice(start, end);
          }
          hits.push(hit);
        }
      }
      rankHits(hits, needleConst);
      if (hits.length > limit) {
        hits.length = limit;
        markCut("limit");
      }
    } else {
      // countOnly = true: count all matches without limit, don't collect hits
      for (const entry of entries) {
        if (!entry) continue;
        const { content } = entry;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineLower = caseSensitive ? line : line.toLowerCase();
          const match = useRegex
            ? (contentRe as RegExp).test(line)
            : kind === "definition"
              ? /^\s*(?:export\s+)?(?:function|class|const|let|var|type|interface|struct|fn|impl|trait|enum)\s+/.test(line) &&
                (wordRe ? wordRe.test(lineLower) : lineLower.includes(needleConst))
              : wordRe
                ? wordRe.test(lineLower)
                : lineLower.includes(needleConst);
          if (match) totalMatchLines += 1;
        }
      }
      // Count files that have at least one match
      const filesWithMatches = new Set<string>();
      for (const entry of entries) {
        if (!entry) continue;
        const { rel, content } = entry;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineLower = caseSensitive ? line : line.toLowerCase();
          const match = useRegex
            ? (contentRe as RegExp).test(line)
            : kind === "definition"
              ? /^\s*(?:export\s+)?(?:function|class|const|let|var|type|interface|struct|fn|impl|trait|enum)\s+/.test(line) &&
                (wordRe ? wordRe.test(lineLower) : lineLower.includes(needleConst))
              : wordRe
                ? wordRe.test(lineLower)
                : lineLower.includes(needleConst);
          if (match) {
            filesWithMatches.add(rel);
            break;
          }
        }
      }
      countedFilesMatched = filesWithMatches.size;
      // A file-cap truncation still applies in count-only mode: do not claim
      // the count is complete when the scan stopped early.
      complete = cutReason === null;
    }
  }

  const finalFilesMatched = countOnly ? countedFilesMatched : new Set(hits.map((h) => h.relative_path)).size;

  return {
    status: "completed",
    result: {
      kind: "search",
      data: {
        ...(!countOnly ? { hits } : {}),
        complete,
        diagnostics,
        total_match_lines: totalMatchLines,
        files_matched: finalFilesMatched,
        ...searchMeta(),
        limited: !complete,
        hint: searchHint(),
      },
    },
  };
}
