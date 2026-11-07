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

  const external = includeExternal
    ? [...built.externals.values()]
        .map((entry) => ({ id: entry.id, used_by: entry.usedBy.size }))
        .sort((a, b) => b.used_by - a.used_by || a.id.localeCompare(b.id))
        .slice(0, 200)
    : [];

  const data = {
    root: index.startRel || ".",
    kind,
    generated_at: new Date().toISOString(),
    nodes,
    edges,
    external,
    unresolved: built.unresolved.slice(0, 50),
    stats: {
      files_scanned: index.filesScanned,
      files_skipped: index.filesSkipped,
      edges: edges.length,
      duration_ms: Date.now() - started,
      cache,
    },
    truncated,
    next_cursor: null,
  };
  return {
    data,
    truncated,
    ...(truncated
      ? { hint: "Graph truncated at max_nodes/max_edges/files. Hint: narrow with relative_path, lower depth, or raise max_nodes/max_edges." }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Change impact
// ---------------------------------------------------------------------------

type SymbolSeed = { name: string; file?: string };

function parseSymbolSeeds(value: unknown): SymbolSeed[] {
  if (!Array.isArray(value)) return [];
  const seeds: SymbolSeed[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (name) seeds.push({ name });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) continue;
      const file =
        typeof record.relative_path === "string"
          ? record.relative_path
          : typeof record.file === "string"
            ? record.file
            : undefined;
      seeds.push({ name, ...(file ? { file } : {}) });
    }
  }
  return seeds;
}

function parsePathSeeds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

export type ImpactBuildResult = {
  data: Record<string, unknown>;
  truncated: boolean;
  hint?: string;
};

export async function buildChangeImpact(
  args: Record<string, unknown>,
  rootAbs: string,
): Promise<ImpactBuildResult> {
  const started = Date.now();
  const fileSeeds = parsePathSeeds(args.files);
  const rawSymbolSeeds = Array.isArray(args.symbols) ? args.symbols : [];
  const symbolSeeds = parseSymbolSeeds(rawSymbolSeeds);
  if (fileSeeds.length === 0 && symbolSeeds.length === 0) {
    throw new Error("[invalid_request] Pass at least one of `files` or `symbols`. Hint: files=[\"src/lib/util.ts\"] or symbols=[\"parseConfig\"].");
  }
  const directionRaw = String(args.direction ?? "dependents").toLowerCase();
  if (!["dependents", "dependencies", "both"].includes(directionRaw)) {
    throw new Error('[invalid_request] `direction` must be "dependents", "dependencies" or "both".');
  }
  const direction = directionRaw as "dependents" | "dependencies" | "both";
  const depth = numberArg(args.depth, 5, 1, 10);
  const includeTests = !(args.include_tests === false || args.include_tests === 0);
  const maxNodes = numberArg(args.max_nodes, 300, 1, 2000);
  const formatRaw = String(args.format ?? "json").toLowerCase();
  if (!["json", "mermaid"].includes(formatRaw)) {
    throw new Error('[invalid_request] `format` must be "json" or "mermaid".');
  }
  const format = formatRaw as "json" | "mermaid";

  const { index, cache } = await buildIndex(rootAbs, "", 20, null, true);
  const unresolved: Unresolved[] = [];
  const seedFiles = new Set<string>();
  const seedSymbols = new Set<string>();

  for (const raw of fileSeeds) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(rootAbs, raw);
    if (!isInside(rootAbs, abs)) {
      throw new Error(`[path_escape] Seed file is outside the workspace: ${raw}.`);
    }
    if (!existsSync(abs)) {
      throw new Error(`[not_found] Seed file does not exist: ${raw}. Hint: check it with project_list_files.`);
    }
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`[not_found] Seed file does not exist: ${raw}.`);
    }
    if (!stat.isFile()) {
      throw new Error(`[invalid_request] Seed path is not a file: ${raw}.`);
    }
    seedFiles.add(relFromRoot(rootAbs, abs));
  }

  const declarationsByName = new Map<string, Array<{ file: string; decl: Declaration }>>();
  for (const file of index.files.values()) {
    for (const decl of file.declarations) {
      const list = declarationsByName.get(decl.name) ?? [];
      list.push({ file: file.rel, decl });
      declarationsByName.set(decl.name, list);
    }
  }

  // A bare symbol name declared in more than one file cannot be pinned down:
  // seed every declaring file, but mark the traversal as "possible" so callers
  // do not treat the closure as exact.
  const possibleSeedFiles = new Set<string>();

  for (const seed of symbolSeeds) {
    let declared = declarationsByName.get(seed.name) ?? [];
    if (seed.file) {
      const abs = path.isAbsolute(seed.file) ? seed.file : path.resolve(rootAbs, seed.file);
      if (!isInside(rootAbs, abs)) {
        throw new Error(`[path_escape] Symbol seed file is outside the workspace: ${seed.file}.`);
      }
      const rel = relFromRoot(rootAbs, abs);
      declared = declared.filter((entry) => entry.file === rel);
      if (declared.length === 0) {
        unresolved.push({ from: rel, symbol: seed.name, reason: "symbol is not declared in this file" });
        continue;
      }
    }
    if (declared.length === 0) {
      unresolved.push({ from: "", symbol: seed.name, reason: "symbol is not declared in the workspace (it may be external)" });
      continue;
    }
    const files = [...new Set(declared.map((entry) => entry.file))].sort();
    if (files.length > 1) {
      unresolved.push({
        from: "",
        symbol: seed.name,
        reason: `ambiguous: declared in ${files.length} files; pass {name, file} to disambiguate`,
        files,
      });
      if (!seed.file) files.forEach((file) => possibleSeedFiles.add(file));
    }
    seedSymbols.add(seed.name);
    for (const file of files) seedFiles.add(file);
  }

  const built = buildEdges(index, true);
  unresolved.push(...built.unresolved.slice(0, 50));

  if (seedFiles.size === 0) {
    return {
      data: {
        root: ".",
        seed: { files: [], symbols: [...seedSymbols].sort() },
        direction,
        affected: [],
        unresolved,
        summary: { affected_files: 0, affected_symbols: 0, max_distance: 0, tests_affected: 0 },
        truncated: false,
      },
      truncated: false,
      hint: "No seed file resolved. Hint: pass files=[...] or a symbol declared in the workspace.",
    };
  }

  const forward = new Map<string, Edge[]>();
  const reverse = new Map<string, Edge[]>();
  for (const edge of built.edges) {
    const f = forward.get(edge.from) ?? [];
    f.push(edge);
    forward.set(edge.from, f);
    const r = reverse.get(edge.to) ?? [];
    r.push(edge);
    reverse.set(edge.to, r);
  }

  type Reached = {
    distance: number;
    path: string[];
    reason: string;
    confidence: EdgeConfidence;
    symbols: Set<string>;
  };
  const reached = new Map<string, Reached>();
  const queue: Array<{ file: string; distance: number; path: string[]; confidence: EdgeConfidence }> = [];
  for (const seed of seedFiles) {
    const seedConfidence: EdgeConfidence = possibleSeedFiles.has(seed) ? "possible" : "exact";
    reached.set(seed, { distance: 0, path: [seed], reason: "seed", confidence: seedConfidence, symbols: new Set() });
    queue.push({ file: seed, distance: 0, path: [seed], confidence: seedConfidence });
  }
  const affectedSymbols = new Set<string>();
  const impactEdges: Array<{ from: string; to: string; type: EdgeType; confidence: EdgeConfidence }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.distance >= depth) continue;
    const next: Edge[] = [];
    if (direction === "dependents" || direction === "both") {
      for (const edge of reverse.get(current.file) ?? []) next.push(edge);
    }
    if (direction === "dependencies" || direction === "both") {
      for (const edge of forward.get(current.file) ?? []) next.push(edge);
    }
    for (const edge of next) {
      const isReverse = direction === "dependents" || (direction === "both" && reverse.get(current.file)?.includes(edge));
      const target = isReverse ? edge.from : edge.to;
      if (seedFiles.has(target)) continue;
      const distance = current.distance + 1;
      const confidence = worseConfidence(current.confidence, edge.confidence);
      const previous = reached.get(target);
      // Parallel edges (an import + a reference, extends + reference) still
      // contribute their enclosing symbol even when the file was already hit.
      if (edge.fromSymbol) {
        affectedSymbols.add(edge.fromSymbol);
        previous?.symbols.add(edge.fromSymbol);
      }
      if (previous && previous.distance <= distance) {
        if (previous.distance === distance && CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[previous.confidence]) {
          previous.confidence = confidence;
        }
        continue;
      }
      const reasonEdgeFile = isReverse ? current.file : edge.to;
      const reason = edge.fromSymbol
        ? `${edge.type === "references" ? "references" : edge.type} ${edge.fromSymbol}`
        : `${edge.type === "import" ? "imports" : edge.type} ${reasonEdgeFile}`;
      const symbols = new Set<string>();
      if (edge.fromSymbol) symbols.add(edge.fromSymbol);
      reached.set(target, {
        distance,
        path: [...current.path, target],
        reason,
        confidence,
        symbols,
      });
      if (edge.fromSymbol) impactEdges.push({ from: edge.from, to: edge.to, type: edge.type, confidence: edge.confidence });
      queue.push({ file: target, distance, path: [...current.path, target], confidence });
    }
  }

  const affectedAll = [...reached.entries()]
    .filter(([id]) => !seedFiles.has(id))
    .map(([id, entry]) => ({
      id,
      type: "file",
      distance: entry.distance,
      path: entry.path,
      reason: entry.reason,
      confidence: entry.confidence,
      ...(entry.symbols.size > 0 ? { symbols: [...entry.symbols].sort() } : {}),
    }))
    .filter((entry) => includeTests || !looksTestFile(entry.id))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));

  const truncated = affectedAll.length > maxNodes;
  const affected = affectedAll.slice(0, maxNodes);
  const testsAffected = affected.filter((entry) => looksTestFile(entry.id)).length;
  const maxDistance = affected.reduce((max, entry) => Math.max(max, entry.distance), 0);
  const summary = {
    affected_files: affected.length,
    affected_symbols: affectedSymbols.size,
    max_distance: maxDistance,
    tests_affected: testsAffected,
  };
  const seed = { files: [...seedFiles].sort(), symbols: [...seedSymbols].sort() };

  if (format === "mermaid") {
    const nodes = [seed.files, affected.map((entry) => entry.id)].flat();
    const uniqueNodes = [...new Set(nodes)];
    const edges = affected.flatMap((entry) =>
      entry.path.length >= 2
        ? [{ from: entry.path[entry.path.length - 2], to: entry.id, type: "depends" as const, confidence: entry.confidence }]
        : [],
    );
    return {
      data: {
        root: ".",
        seed,
        direction,
        graph: renderMermaid(
          edges.map((edge) => ({ from: edge.from, to: edge.to, type: "import" as EdgeType, confidence: edge.confidence, line: 0, via: "" })),
          uniqueNodes,
        ),
        summary,
        unresolved,
        truncated,
      },
      truncated,
      hint: truncated ? "Impact list truncated at max_nodes. Hint: narrow the seeds or raise max_nodes." : undefined,
    };
  }

  return {
    data: {
      root: ".",
      seed,
      direction,
      affected,
      unresolved,
      summary,
      truncated,
      cache,
      duration_ms: Date.now() - started,
    },
    truncated,
    ...(truncated
      ? { hint: "Impact list truncated at max_nodes. Hint: narrow the seeds, lower depth, or raise max_nodes." }
      : {}),
  };
}
