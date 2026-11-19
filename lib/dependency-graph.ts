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
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { type Declaration, type Index, languageForFile, buildIndex } from "./dependency-graph-index.js";
export { invalidateDependencyGraphCache } from "./dependency-graph-index.js";
import { type GraphLanguage, type EdgeConfidence, isInside, relFromRoot, type EdgeType } from "./dependency-graph-common.js";
import { probeTs, probePython, externalId, isRelativeSpecifier, probeRust, resolveGoImport, resolveJvmImport, type GoImportResolution, type JvmImportResolution } from "./dependency-graph-resolve.js";
export type { GraphLanguage, EdgeConfidence, EdgeType } from "./dependency-graph-common.js";
export type { GoImportResolution } from "./dependency-graph-resolve.js";

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

// Roadmap item 15 (P2): the side lists of the graph are capped and counted.
// The list shows the most useful few; `stats` holds the full count, so a cut
// is visible instead of silent.
const MAX_EXTERNAL_LIST = 50;
const MAX_UNRESOLVED_LIST = 10;

function worseConfidence(a: EdgeConfidence, b: EdgeConfidence): EdgeConfidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
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

  // Roadmap item 15 (P2): the two side lists were the token-heavy part of
  // the payload and neither said when it had cut something. Both are now
  // short, sorted by usefulness, and counted: the list shows the top few,
  // `stats` says how many there really are, and `limited` marks the cut.
  const externalAll = includeExternal
    ? [...built.externals.values()]
        .map((entry) => ({ id: entry.id, used_by: entry.usedBy.size }))
        .sort((a, b) => b.used_by - a.used_by || a.id.localeCompare(b.id))
    : [];
  const external = externalAll.slice(0, MAX_EXTERNAL_LIST);
  const unresolvedAll = built.unresolved;
  const unresolved = unresolvedAll.slice(0, MAX_UNRESOLVED_LIST);
  const limited = external.length < externalAll.length || unresolved.length < unresolvedAll.length;

  const data = {
    root: index.startRel || ".",
    kind,
    generated_at: new Date().toISOString(),
    nodes,
    edges,
    external,
    unresolved,
    stats: {
      files_scanned: index.filesScanned,
      files_skipped: index.filesSkipped,
      edges: edges.length,
      // The full counts: the lists above are the top few, not everything.
      externals: externalAll.length,
      unresolved_imports: unresolvedAll.length,
      duration_ms: Date.now() - started,
      cache,
    },
    ...(limited ? { limited: true } : {}),
    truncated,
    next_cursor: null,
  };
  return {
    data,
    truncated,
    ...(truncated
      ? { hint: "Graph truncated at max_nodes/max_edges/files. Hint: narrow with relative_path, lower depth, or raise max_nodes/max_edges." }
      : {}),
    ...(limited && !truncated
      ? { hint: `The external[] and unresolved[] lists are capped (${MAX_EXTERNAL_LIST} / ${MAX_UNRESOLVED_LIST}); stats.externals and stats.unresolved_imports hold the full counts.` }
      : {}),
  };
}

