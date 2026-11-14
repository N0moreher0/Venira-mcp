import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolResult } from "../lib/output.js";
import type { Args } from "./project-cache.js";
import { runDiffFiles, runOutlineSymbol } from "./project-codeintel.js";
import { config, flag01, path_ } from "./project-schema.js";

// Code-intelligence tool registrations: outline_symbol, diff_files,
// symbol_references, dependency_graph, change_impact.
// Extracted from registerProjectTools in tools/project.ts (roadmap item 6, step 5m). Schemas, descriptions
// and registration order are unchanged; handlers that need project.ts state arrive through CodeIntelDeps.

export type CodeIntelDeps = {
  runOne: (operation: string, args: Args) => Promise<ToolResult>;
  runSymbolReferences: (args: Args) => Promise<ToolResult>;
};

export function registerCodeIntelTools(server: McpServer, deps: CodeIntelDeps): void {
  const { runOne, runSymbolReferences } = deps;
  server.registerTool(
    "outline_symbol",
    {
      ...config(
        "Outline symbols",
        {
          speed_profile: "fast; single-file regex scan, no external indexer.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path: path_,
        language: z.string().optional().describe("Optional language hint (e.g. 'ts', 'py'); the parser auto-detects from the file extension when omitted. The hint is advisory."),
        include_functions: flag01.optional().describe("1 includes function symbols (default 1)."),
        include_classes: flag01.optional().describe("1 includes class/interface symbols (default 1)."),
        max_symbols: z.number().int().min(1).max(500).optional().describe("Max symbols returned (default 200, max 500)."),
      },
    },
    (args) => runOutlineSymbol(args as Args),
  );

  server.registerTool(
    "diff_files",
    {
      ...config(
        "Diff files",
        {
          speed_profile: "medium; LCS-based diff over the two full texts, bounded by max_lines.",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        relative_path_a: path_,
        relative_path_b: path_,
        context_lines: z.number().int().min(0).max(50).optional().describe("Unchanged context lines around each hunk (default 3, max 50)."),
        max_lines: z.number().int().min(10).max(10000).optional().describe("Max diff lines returned (default 500, max 10000)."),
      },
    },
    (args) => runDiffFiles(args as Args),
  );

  server.registerTool(
    "symbol_references",
    {
      ...config(
        "Symbol references",
        {
          speed_profile: "fast for scope=file; medium for scope=workspace (single search call).",
          batch_safe: true,
        },
        { readOnlyHint: true, openWorldHint: false },
      ),
      inputSchema: {
        symbol_name: z.string().describe("Symbol name to find (matched as a whole word)."),
        scope: z.enum(["file", "workspace"]).optional().describe("workspace = search all files (default); file = search one file. scope=file requires relative_path."),
        relative_path: path_.optional().describe("Required when scope=file; with scope=workspace it narrows the search to this subtree."),
        limit: z.number().int().min(1).max(200).optional().describe("scope=workspace only: how many workspace hits to SCAN (default: max_references, max 200). Not used for scope=file."),
        max_references: z.number().int().min(1).max(500).optional().describe("How many references come BACK (default 100, max 500). Applies in both scopes; this is the token bill."),
      },
    },
    (args) => runSymbolReferences(args as Args),
  );

  server.registerTool(
    "dependency_graph",
    {
      ...config(
        "Dependency graph",
        {
          speed_profile:
            "medium; bounded walk (<=5000 files / 64 MB), parser-lite line scan, 5 s index cache invalidated on writes. No network.",
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
        max_edges: z.number().int().min(1).max(5000).optional().describe("Max edges kept; more sets truncated (default 2000)."),
      },
    },
    (args) => runOne("dependency_graph", args as Args),
  );

  server.registerTool(
    "change_impact",
    {
      ...config(
        "Change impact",
        {
          speed_profile:
            "medium; reuses the dependency index (5 s cache, invalidated on writes), BFS bounded by depth. No network.",
          batch_safe: true,
        },
        { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ),
      inputSchema: {
        files: z.array(z.string().max(500)).max(32).optional().describe("Workspace paths you plan to edit. At least one of files/symbols is required."),
        symbols: z
          .array(
            z.union([
              z.string().max(200),
              z.object({
                name: z.string().max(200).describe("Symbol name."),
                file: z.string().max(500).optional().describe("Alias of relative_path (relative_path wins when both are given)."),
                relative_path: z.string().max(500).optional().describe("File the symbol is declared in; preferred over file."),
              }),
            ]),
          )
          .max(32)
          .optional()
          .describe('Symbols you plan to rename/change; pass a name, or {name, relative_path} (or {name, file}) when the name is ambiguous. At least one of files/symbols is required.'),
        direction: z.enum(["dependents", "dependencies", "both"]).optional().describe("Traversal direction (default dependents)."),
        depth: z.number().int().min(1).max(10).optional().describe("Max hops from the seeds (default 5)."),
        include_tests: flag01.optional().describe("1 includes test files (default) and counts them in tests_affected."),
        max_nodes: z.number().int().min(1).max(2000).optional().describe("Max affected files (default 300)."),
        min_confidence: z.enum(["exact", "likely", "possible"]).optional().describe('Only traverse edges at or above this confidence (default "likely"). "exact" = import/declared-in-one-file ties; "likely" = unique name match; "possible" = name matched several declarations (noisy at distance >= 2). Skipped edges are counted in stats.filtered_possible.'),
        format: z.enum(["json", "mermaid"]).optional().describe("Output format (default json)."),
      },
    },
    (args) => runOne("change_impact", args as Args),
  );
}
