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
  const candidates = params.candidates.slice(0, maxFiles);
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
    estimated += 6;
  }

  const large = candidates.filter((c) => (c.size_bytes ?? 0) > OUTLINE_THRESHOLD_BYTES).slice(0, 2);
  if (large.length > 0) {
    steps.push({
      tool: "project_outline_symbol",
      arguments: { relative_path: large[0].relative_path },
      why: "the file is large; outline it first to find the exact symbol, then read ranges",
    });
    estimated += 8;
  }

  const topKeyword = params.keywords[0];
  if (params.includeSearch && !params.searched && topKeyword) {
    steps.push({
      tool: "project_search",
      arguments: { query: topKeyword, kind: "literal_content", limit: 30 },
      why: "locate the remaining call sites of the task keyword",
    });
    estimated += 25;
  }

  if (candidates.length === 0) {
    steps.push({
      tool: "project_list_files",
      arguments: { depth: 2, limit: 60 },
      why: "no candidates matched; map the tree before searching again",
    });
    estimated += 20;
  }

  const keywords = params.keywords.length > 0 ? params.keywords : [];
  return {
    keywords,
    steps,
    candidates,
    estimated_ms: estimated,
    notes:
      candidates.length > 0
        ? "Candidates come from bounded content searches (top keywords) plus hints/recent edits, ranked by hit count and path."
        : "No candidate matched the task keywords; the plan starts with a tree map. Add files_hint to skip discovery.",
  };
}
