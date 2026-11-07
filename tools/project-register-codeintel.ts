import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import type { Args } from "./project-cache.js";
import { runDiffFiles, runOutlineSymbol } from "./project-codeintel.js";
import { config, flag01, path_ } from "./project-schema.js";

// Code-intelligence tool registrations: project_outline_symbol, project_diff_files,
// project_symbol_references, project_selective_search, project_dependency_graph, project_change_impact.
// Extracted from registerProjectTools in tools/project.ts (roadmap item 6, step 5m). Schemas, descriptions
// and registration order are unchanged; handlers that need project.ts state arrive through CodeIntelDeps.

export type CodeIntelDeps = {
  runOne: (operation: string, args: Args) => Promise<ToolResult>;
  runSymbolReferences: (args: Args) => Promise<ToolResult>;
  runSelectiveSearch: (args: Args) => Promise<ToolResult>;
};

export function registerCodeIntelTools(server: McpServer, deps: CodeIntelDeps): void {
  const { runOne, runSymbolReferences, runSelectiveSearch } = deps;
  server.registerTool(
    "project_outline_symbol",
    {
      ...config(
        "Parse a source file and return its symbol outline (functions, classes, types, interfaces) with line numbers.",
        "Outline symbols",
        {
          use_when: "you need to see the structure / top-level symbols of a file before reading or refactoring it.",
          avoid_when: "you need every usage of a symbol (project_symbol_references) or a text-only diff (project_diff_files).",
          speed_profile: "fast; single-file regex scan, no external indexer.",
          output_kind: "outline_symbol: total_symbols, symbols[] {name, kind, line, signature}.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        language: z.string().optional(),
        include_functions: flag01.optional(),
        include_classes: flag01.optional(),
        max_symbols: z.number().int().min(1).max(500).optional(),
      },
    },
    (args) => runOutlineSymbol(args as Args),
  );

  server.registerTool(
    "project_diff_files",
    {
      ...config(
        "Unified (git-style) diff between two workspace files. Reports lines_added/lines_removed and the full hunk text.",
        "Diff files",
        {
          use_when: "comparing two versions of a file, or reviewing changes before/after an edit.",
          avoid_when: "the two files are in different languages or one is binary; large binaries are not supported.",
          speed_profile: "medium; LCS-based diff over the two full texts, bounded by max_lines.",
          output_kind: "diff_files: lines_added, lines_removed, unified_diff, truncated.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path_a: path_,
        relative_path_b: path_,
        context_lines: z.number().int().min(0).max(50).optional(),
        max_lines: z.number().int().min(10).max(10000).optional(),
      },
    },
    (args) => runDiffFiles(args as Args),
  );

  server.registerTool(
    "project_symbol_references",
    {
      ...config(
        "Find every occurrence of a named symbol. scope=file (fast, single file) or scope=workspace (uses content search).",
        "Symbol references",
        {
          use_when: "you need to know where a symbol is used before renaming/refactoring it.",
          avoid_when: "you only need its declaration (project_outline_symbol) or an arbitrary string (project_search).",
          speed_profile: "fast for scope=file; medium for scope=workspace (single search call).",
          output_kind: "symbol_references: count, references[] {relative_path, line_number, context}.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        symbol_name: z.string(),
        scope: z.enum(["file", "workspace"]).optional(),
        relative_path: path_.optional(),
        limit: z.number().int().min(1).max(200).optional(),
        max_references: z.number().int().min(1).max(500).optional(),
      },
    },
    (args) => runSymbolReferences(args as Args),
  );

  server.registerTool(
    "project_selective_search",
    {
      ...config(
        "Smart multi-query search: combine several patterns with AND/OR/NOT + fuzzy scoring. Bounded to a file set you pass in.",
        "Selective search",
        {
          use_when: "you need to rank many files by how well they match several keywords at once (e.g. locating the right module among candidates).",
          avoid_when: "you need a single exact literal (project_search) or to inspect one file's content (project_read_file).",
          speed_profile: "medium; reads a bounded set of files (files_hint or a shallow listing) and scores each line.",
          output_kind: "selective_search: hits[] {relative_path, line_number, text, score, matched}, total_files, total_hits, truncated.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        queries: z.array(z.object({
          pattern: z.string(),
          must: flag01.optional(),
          weight: z.number().int().optional(),
        })).min(1),
        files_hint: z.array(z.string()).optional(),
        relative_path: path_.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    (args) => runSelectiveSearch(args as Args),
  );

  server.registerTool(
    "project_dependency_graph",
    {
      ...config(
        "Build a deterministic file/symbol dependency graph for TypeScript/JavaScript, Python, Rust, Go, Java and Kotlin (module declarations, pub mod, use crate::/super::, extern crate, go.mod module resolution, import (...) blocks, relative imports, require(), dynamic import(), extends/implements, cross-file symbol references). Renders as JSON, DOT or Mermaid.",
        "Dependency graph",
        {
          use_when:
            "you need the import graph, a module map to render, or the files/symbols a change can reach before refactoring.",
          avoid_when:
            "you only need usages of one symbol in one file (project_symbol_references) or a text search (project_search).",
          speed_profile:
            "medium; bounded walk (<=5000 files / 64 MB), parser-lite line scan, 5 s index cache invalidated on writes. No network.",
          output_kind:
            "dependency_graph: nodes[] {id, type, language, loc}, edges[] {from, to, type (import|extends|implements|references), confidence, line, via}, external[] {id, used_by}, unresolved[], stats, truncated; format=dot|mermaid returns data.graph.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        kind: z.enum(["files", "symbols", "both"]).optional().describe("files (imports), symbols (references/extends), or both (default files)."),
        format: z.enum(["json", "dot", "mermaid"]).optional().describe("Output format (default json). dot/mermaid return data.graph."),
        relative_path: path_.optional().describe("Limit the walk to this subtree (default: the workspace root)."),
        depth: z.number().int().min(1).max(10).optional().describe("Directory recursion cap (default 3, max 10)."),
        include_external: flag01.optional().describe("1 aggregates npm/pip/node package nodes in external[]. Default 0."),
        include_tests: flag01.optional().describe("1 includes test files/edges (default); 0 hides them."),
        languages: z.array(z.string().max(20)).max(6).optional().describe('Language filter, e.g. ["ts","py","rs","go","java","kotlin"] (default: all supported).'),
        max_nodes: z.number().int().min(1).max(2000).optional().describe("Max file nodes (default 500)."),
        max_edges: z.number().int().min(1).max(5000).optional().describe("Max edges (default 2000)."),
      },
    },
    (args) => runOne("dependency_graph", args as Args),
  );

  server.registerTool(
    "project_change_impact",
    {
      ...config(
        "Answer \"if I change these files/symbols, what depends on them?\" with a bounded reverse (or forward) closure: affected files, distance, path, reason and confidence, plus affected symbols and a separate test count.",
        "Change impact",
        {
          use_when:
            "before renaming/changing a function or file, to list the dependents you should read/test (direction=dependents), or the dependencies a module relies on.",
          avoid_when:
            "you need the whole graph (project_dependency_graph) or exact textual usages in one file (project_symbol_references).",
          speed_profile:
            "medium; reuses the dependency index (5 s cache, invalidated on writes), BFS bounded by depth. No network.",
          output_kind:
            "change_impact: seed {files, symbols}, affected[] {id, distance, path, reason, confidence, symbols?}, unresolved[], summary {affected_files, affected_symbols, max_distance, tests_affected}, truncated; format=mermaid returns data.graph.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        files: z.array(z.string().max(500)).max(32).optional().describe("Workspace paths you plan to edit."),
        symbols: z
          .array(
            z.union([
              z.string().max(200),
              z.object({
                name: z.string().max(200),
                file: z.string().max(500).optional(),
                relative_path: z.string().max(500).optional(),
              }),
            ]),
          )
          .max(32)
          .optional()
          .describe('Symbols you plan to rename/change; pass a name, or {name, file} when the name is ambiguous.'),
        direction: z.enum(["dependents", "dependencies", "both"]).optional().describe("Traversal direction (default dependents)."),
        depth: z.number().int().min(1).max(10).optional().describe("BFS hop cap (default 5)."),
        include_tests: flag01.optional().describe("1 includes test files (default) and counts them in tests_affected."),
        max_nodes: z.number().int().min(1).max(2000).optional().describe("Max affected files (default 300)."),
        format: z.enum(["json", "mermaid"]).optional().describe("Output format (default json)."),
      },
    },
    (args) => runOne("change_impact", args as Args),
  );
}
