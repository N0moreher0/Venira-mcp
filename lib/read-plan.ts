/**
 * Deterministic "read planner" for `project_plan_read_batch`.
 *
 * The agent knows *what* it wants to change; what costs round-trips is finding
 * the right files and turning that into one batch call. This module does the
 * deterministic half:
 *
 *   1. pull keywords out of the task sentence (quoted terms, identifiers, words),
 *   2. rank the files the caller discovered (search hits, hints, recent edits),
 *   3. emit an ordered plan of *ready-to-send* tool calls with a time estimate.
 *
 * It never reads files, never calls the model and never mutates anything: the
 * tool wrapper does the bounded searches and passes the candidates here.
 */
export type NextAction = {
  tool: string;
  arguments: Record<string, unknown>;
  why: string;
};

export type PlanCandidate = {
  relative_path: string;
  reason: string;
  hits?: number;
  size_bytes?: number;
  /** Ranking score assigned by `rankCandidates` (higher wins). */
  score?: number;
};

export type ReadPlan = {
  keywords: string[];
  steps: NextAction[];
  candidates: PlanCandidate[];
  estimated_ms: number;
  notes: string;
};

/** Words that carry no signal for a code search. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "into", "from", "this", "that", "these", "those", "when", "then",
  "add", "adds", "adds", "make", "makes", "need", "needs", "want", "wants", "should", "could",
  "would", "have", "has", "had", "was", "were", "are", "is", "be", "been", "but", "not", "all",
  "any", "can", "will", "just", "only", "also", "fix", "fixes", "update", "updates", "change",
  "changes", "implement", "support", "tool", "tools", "file", "files", "code", "please", "help",
  "how", "what", "where", "which", "why", "use", "using", "used", "new", "old", "same", "work",
  "working", "works", "there", "here", "it", "its", "you", "your", "we", "our", "they", "their",
  "sao", "cho", "cua", "của", "và", "va", "thì", "thi", "một", "mot", "các", "cac", "này", "nay",
  "làm", "lam", "được", "duoc", "khi", "nhé", "nhe", "với", "voi", "trong", "trên", "tren",
]);

const MAX_KEYWORDS = 5;

/** Quoted phrases first (highest signal), then identifiers, then plain words. */
export function extractKeywords(task: string, max = MAX_KEYWORDS): string[] {
  const text = String(task ?? "").slice(0, 2_000);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const clean = value.trim().replace(/^[_\-./]+|[_\-./]+$/g, "");
    if (clean.length < 3 || clean.length > 60) return;
    const key = clean.toLowerCase();
    if (seen.has(key) || STOPWORDS.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  for (const match of text.matchAll(/["'`]([^"'`]{2,60})["'`]/g)) push(match[1]);
  for (const match of text.matchAll(/\b(?:[A-Z][A-Za-z0-9]{2,}|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9]+)\b/g)) {
    push(match[0]);
  }
  for (const word of text.toLowerCase().split(/[^a-z0-9_$.\-]+/)) push(word);
  return out.slice(0, max);
}

/** Large files are cheaper to outline first than to read whole. */
const OUTLINE_THRESHOLD_BYTES = 256 * 1024;

/** `project_read_batch` accepts at most 8 items per call. */
const BATCH_MAX = 8;

/**
 * Time estimates, calibrated against the live E2E bench (v1.5.1/v1.5.2):
 * a 6-file batch measured 62 ms end-to-end, a cold literal search ~45 ms
 * (p95). The previous flat 6 ms estimate was off by roughly 10x.
 */
const BATCH_BASE_MS = 8;
const BATCH_PER_FILE_MS = 9;
const OUTLINE_MS = 15;
const SEARCH_STEP_MS = 40;
const LIST_STEP_MS = 25;

/**
 * Directories that never contain code worth reading in a first pass (build
 * output, vendored deps, caches). Names are matched per path segment.
 */
const ARTIFACT_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".venv", "venv",
  "__pycache__", ".next", ".cache", "target", ".idea", ".vscode",
]);

/**
 * Binary/data/log extensions. A plan should point at source, not at the audit
 * DB or a lockfile copy: those match keyword searches (the DB literally stores
 * every command) but reading them is useless.
 */
const ARTIFACT_EXT_RE =
  /\.(db|sqlite|sqlite3|db-wal|db-shm|log|lock|map|zip|gz|tgz|tar|png|jpe?g|gif|ico|bmp|webp|pdf|woff2?|ttf|eot|bin|exe|dll|so|dylib|class|jar|pyc|o|a)$/i;

/** Generated dependency manifests: huge, never a read target for a change. */
const LOCKFILE_RE =
  /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|gemfile\.lock|manifest\.lock)$/i;

/** True when a path is a plausible source file to read (not an artifact). */
export function isPlannablePath(relativePath: string): boolean {
  const clean = String(relativePath ?? "").replace(/\\/g, "/").toLowerCase().trim();
  if (!clean) return false;
  const segments = clean.split("/").filter(Boolean);
  if (segments.some((segment) => ARTIFACT_DIRS.has(segment))) return false;
  if (LOCKFILE_RE.test(segments[segments.length - 1] ?? "")) return false;
  return !ARTIFACT_EXT_RE.test(clean);
}

/** Prose files: README, LICENSE, CHANGELOG… (bare name or with extension). */
const DOC_FILE_RE =
  /^(readme|license|licence|changelog|changes|history|contributing|code_of_conduct|security|notice|authors|faq|roadmap)(\.[a-z0-9]+)?$/i;

const DOC_DIRS = new Set(["docs", "doc", "documentation"]);

/** Prose extensions: a code change rarely starts by reading a .md body. */
const DOC_EXT_RE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;

/** True when the path is prose (README/LICENSE/CHANGELOG, *.md or under docs/). */
export function isDocPath(relativePath: string): boolean {
  const clean = String(relativePath ?? "").replace(/\\/g, "/").toLowerCase();
  const segments = clean.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.slice(0, -1).some((segment) => DOC_DIRS.has(segment))) return true;
  const base = segments[segments.length - 1] ?? "";
  return DOC_FILE_RE.test(base) || DOC_EXT_RE.test(base);
}

/**
 * The task is about prose, so docs should keep their hit count. Note that
 * "comment" is deliberately absent: "fix the inline comment" is a code task.
 */
const DOC_INTENT_RE =
  /\b(docs?|documentation|readme|changelog|contributing|licen[cs]e|guide|tutorial|manual|markdown)\b/i;

/** `git-provider`, `git_provider` and `GitProvider` compare equal. */
const normaliseToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** File/dir stems of a path, normalised for loose name matching. */
function pathStems(relativePath: string): string[] {
  const stems: string[] = [];
  for (const segment of String(relativePath ?? "").replace(/\\/g, "/").toLowerCase().split("/")) {
    const stem = segment.replace(/\.[a-z0-9]+$/, "");
    const norm = normaliseToken(stem);
    if (norm.length >= 3) stems.push(norm);
  }
  return stems;
}

/** A hit from a file-name search is worth more than a content hit (it is the target). */
export const NAME_HIT_POINTS = 3;
/** A candidate whose path contains a task keyword is likely the file to edit. */
const PATH_MATCH_POINTS = 4;
const MAX_PAIRS_PER_CANDIDATE = 2;
/** Docs keep only a fraction of their hits unless the task asks for prose. */
const DOC_HIT_WEIGHT = 0.3;
const DOC_PENALTY = 2;

function scoreCandidate(candidate: PlanCandidate, keywords: string[], docsWanted: boolean): number {
  const hits = candidate.hits ?? 0;
  const stems = pathStems(candidate.relative_path);
  let matched = 0;
  for (const keyword of keywords) {
    const norm = normaliseToken(keyword);
    if (norm.length < 4) continue;
    if (stems.some((stem) => stem.includes(norm) || norm.includes(stem))) matched += 1;
    if (matched >= MAX_PAIRS_PER_CANDIDATE) break;
  }
  let score = hits + matched * PATH_MATCH_POINTS;
  if (!docsWanted && isDocPath(candidate.relative_path)) score = score * DOC_HIT_WEIGHT - DOC_PENALTY;
  return Math.round(score * 100) / 100;
}

/**
 * Rank candidates. Content hits alone miss the obvious case: the file *named*
 * after the task (`git-provider` never appears inside lib/git-provider.ts), so a
 * path/name match adds weight. Prose (README/LICENSE/docs) keeps a fraction of
 * its hits unless the task is about documentation, otherwise generic words like
 * "verify" rank CONTRIBUTING.md above the code being changed.
 */
export function rankCandidates(
  candidates: PlanCandidate[],
  keywords: string[],
  task = "",
  limit = Number.POSITIVE_INFINITY,
): PlanCandidate[] {
  const docsWanted = DOC_INTENT_RE.test(String(task ?? ""));
  const scored = candidates.map((candidate) => ({
    ...candidate,
    score: scoreCandidate(candidate, keywords, docsWanted),
  }));
  scored.sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      (b.hits ?? 0) - (a.hits ?? 0) ||
      a.relative_path.localeCompare(b.relative_path),
  );
  return scored.slice(0, limit);
}

/**
 * Turn candidates into an executable plan. `searched` says whether the caller
 * already ran the keyword search (so the plan does not repeat it).
 */
export function buildReadPlan(params: {
  task: string;
  keywords: string[];
  candidates: PlanCandidate[];
  maxFiles: number;
  includeSearch: boolean;
  searched: boolean;
}): ReadPlan {
  const maxFiles = Math.max(1, Math.min(BATCH_MAX, params.maxFiles));
  // Defense in depth: callers already filter, but artifacts (DB/log/build
  // output) must never reach the first read step even if one slips through.
  const candidates = params.candidates.filter((c) => isPlannablePath(c.relative_path)).slice(0, maxFiles);
  const steps: NextAction[] = [];
  let estimated = 0;

  if (candidates.length > 0) {
    steps.push({
      tool: "project_read_batch",
      arguments: {
        requests: candidates.map((c) => ({
          operation: "read_file",
          arguments: { relative_path: c.relative_path },
        })),
        max_response_bytes_per_item: 512 * 1024,
      },
      why: "read the ranked candidates in one round-trip (batch is cached and validated)",
    });
    estimated += BATCH_BASE_MS + BATCH_PER_FILE_MS * candidates.length;
  }

  const large = candidates.filter((c) => (c.size_bytes ?? 0) > OUTLINE_THRESHOLD_BYTES).slice(0, 2);
  if (large.length > 0) {
    steps.push({
      tool: "project_outline_symbol",
      arguments: { relative_path: large[0].relative_path },
      why: "the file is large; outline it first to find the exact symbol, then read ranges",
    });
    estimated += OUTLINE_MS;
  }

  const topKeyword = params.keywords[0];
  if (params.includeSearch && !params.searched && topKeyword) {
    steps.push({
      tool: "project_search",
      arguments: { query: topKeyword, kind: "literal_content", limit: 30 },
      why: "locate the remaining call sites of the task keyword",
    });
    estimated += SEARCH_STEP_MS;
  }

  if (candidates.length === 0) {
    steps.push({
      tool: "project_list_files",
      arguments: { depth: 2, limit: 60 },
      why: "no candidates matched; map the tree before searching again",
    });
    estimated += LIST_STEP_MS;
  }

  const keywords = params.keywords.length > 0 ? params.keywords : [];
  return {
    keywords,
    steps,
    candidates,
    estimated_ms: Math.round(estimated),
    notes:
      candidates.length > 0
        ? "Candidates come from bounded content + file-name searches (top keywords) plus hints/recent edits, " +
          "ranked by hits, path/name match and prose (README/LICENSE/docs) weight; estimated_ms is calibrated from the bench."
        : "No candidate matched the task keywords; the plan starts with a tree map. Add files_hint to skip discovery.",
  };
}
