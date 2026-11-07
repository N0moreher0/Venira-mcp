/** Verify section module: search. Behaviour is unchanged from the original scripts/verify.ts. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Harness } from "./harness.js";
import type { runCore } from "./core.js";
import type { runShellPolicy } from "./shell-policy.js";
import type { runShellEnvAudit } from "./shell-env-audit.js";

export async function runSearch(
  $h: Harness,
  $prior: Awaited<ReturnType<typeof runCore>> &
    Awaited<ReturnType<typeof runShellPolicy>> &
    Awaited<ReturnType<typeof runShellEnvAudit>>,
) {
  const { SESSION_ID, verifyEnv, call, check, dir } = $h;
  const { missing, run, asEnvelope, token } = $prior;
  // 9a. Backend parity: the ripgrep fast path must return the same hit set as
  // the JS scanner for the same query. The fixture lives in a gitignored dir
  // (.verify-tmp/), so rg must run with --no-ignore to agree with the walker.
  const searchJsClient = new Client(
    { name: "verify-js-search", version: "0.0.0" },
    { capabilities: {} },
  );
  const searchJsTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      { VENIRA_SESSION_ID: `${SESSION_ID}-js-search`, VENIRA_USE_RIPGREP: "0" },
      "full",
    ),
    stderr: "pipe",
  });
  await searchJsClient.connect(searchJsTransport);
  const parityArgs = {
    query: token,
    kind: "literal_content",
    relative_path: dir,
    glob: "*.txt",
    limit: 50,
  };
  const rgParity = asEnvelope(await call("project_search", parityArgs));
  const jsParity = asEnvelope(
    await searchJsClient.callTool({
      name: "project_search",
      arguments: parityArgs,
    }),
  );
  await searchJsClient.close();
  const hitKeys = (env: { data?: { hits?: unknown } }) => {
    const hits = Array.isArray(env.data?.hits)
      ? (env.data.hits as Record<string, unknown>[])
      : [];
    return hits
      .map((h) => `${String(h.relative_path)}:${String(h.line_number)}`)
      .sort();
  };
  const rgKeys = hitKeys(rgParity);
  const jsKeys = hitKeys(jsParity);
  check(
    "search_rg_js_backend_parity",
    rgKeys.length > 0 &&
      rgKeys.length === jsKeys.length &&
      rgKeys.every((k, i) => k === jsKeys[i]),
    { rg: rgKeys, js: jsKeys },
  );

  // 10a2. Search relevance ranking — most useful hits surface first:
  // - file name matching the query outranks plain content match
  // - whole-word match outranks substring match
  // - shallow file outranks deep file
  const relRankDir = `${dir}/rel-rank`;
  await fs.mkdir(relRankDir, { recursive: true });
  await fs.writeFile(
    `${relRankDir}/compute_stats.ts`,
    `export function compute_stats() { return 1; }\n`,
  );
  await fs.writeFile(
    `${relRankDir}/util.ts`,
    `const x = compute_stats_helper();\n`,
  );
  await fs.mkdir(`${relRankDir}/deep/nested`, { recursive: true });
  await fs.writeFile(
    `${relRankDir}/deep/nested/other.ts`,
    `const y = compute_stats_helper();\n`,
  );
  const relRank = asEnvelope(
    await call("project_search", {
      query: "compute_stats",
      kind: "literal_content",
      relative_path: relRankDir,
      glob: "*.ts",
      limit: 10,
    }),
  );
  const relRankHits = Array.isArray(relRank.data?.hits)
    ? (relRank.data.hits as Record<string, unknown>[])
    : [];
  check(
    "search_relevance_file_name_first",
    String(relRankHits[0]?.relative_path ?? "").endsWith("compute_stats.ts"),
    relRankHits.map((h) => h.relative_path),
  );
  check(
    "search_relevance_whole_word_before_substring",
    relRankHits.some((h) => h.line_number === 1),
    relRankHits.map((h) => `${h.relative_path}:${h.line_number}`),
  );
  check(
    "search_relevance_shallow_first",
    relRankHits.findIndex((h) =>
      String(h.relative_path ?? "").includes("deep/nested"),
    ) >
      relRankHits.findIndex((h) => String(h.relative_path ?? "") === "util.ts"),
    relRankHits.map((h) => h.relative_path),
  );

  // 10a3. `context_lines` on the ripgrep fast path must return the same `context`
  // arrays as the JS scanner (it used to drop the field silently). This check is
  // path-agnostic: whichever backend serves it must produce the same shape.
  const ctxDir = `${dir}/ctx-check`;
  await fs.mkdir(ctxDir, { recursive: true });
  await fs.writeFile(
    `${ctxDir}/sample.ts`,
    "alpha line\nbeta CTX_MARKER_TOKEN line\ngamma line\ndelta line\n",
  );
  const ctxSearch = asEnvelope(
    await call("project_search", {
      query: "CTX_MARKER_TOKEN",
      kind: "literal_content",
      relative_path: ctxDir,
      glob: "*.ts",
      context_lines: 1,
    }),
  );
  const ctxHits = Array.isArray(ctxSearch.data?.hits)
    ? (ctxSearch.data.hits as Record<string, unknown>[])
    : [];
  const ctxFirst = ctxHits[0] as { context?: unknown } | undefined;
  check(
    "search_context_lines_shape",
    Array.isArray(ctxFirst?.context) &&
      (ctxFirst.context as string[]).length === 3 &&
      (ctxFirst.context as string[])[1].includes("CTX_MARKER_TOKEN"),
    ctxHits,
  );

  // 10a4. Literal query with regex metacharacters must not crash ranking;
  // regex=1 with an invalid pattern must surface [invalid_request] instead of
  // silently returning zero hits from the ripgrep fast path.
  const metaSearch = asEnvelope(
    await call("project_search", {
      query: "compute_stats(",
      kind: "literal_content",
      relative_path: relRankDir,
      glob: "*.ts",
    }),
  );
  check(
    "search_literal_metachar_query_no_crash",
    metaSearch.error?.code === undefined &&
      Array.isArray(metaSearch.data?.hits) &&
      (metaSearch.data.hits as unknown[]).length >= 1,
    metaSearch,
  );
  const invalidRegex = asEnvelope(
    await call("project_search", {
      query: "[",
      kind: "literal_content",
      relative_path: dir,
      regex: 1,
    }),
  );
  check(
    "search_regex_invalid_returns_invalid_request",
    invalidRegex.error?.code === "invalid_request",
    invalidRegex.error,
  );

  // 10a5. whole_word and include_hidden flags are honoured by both search backends.
  const wwDir = `${dir}/whole-word`;
  await fs.mkdir(wwDir, { recursive: true });
  await fs.writeFile(
    `${wwDir}/ww.ts`,
    "const parseThing = 1;\nconst parse = 2;\nconst reparse = 3;\n",
  );
  const ww = asEnvelope(
    await call("project_search", {
      query: "parse",
      kind: "literal_content",
      relative_path: wwDir,
      glob: "*.ts",
      whole_word: 1,
    }),
  );
  const wwHits = Array.isArray(ww.data?.hits)
    ? (ww.data.hits as Record<string, unknown>[])
    : [];
  check(
    "search_whole_word_matches_standalone_only",
    wwHits.length === 1 && Number(wwHits[0].line_number) === 2,
    wwHits,
  );
  const hidDir = `${dir}/hidden-check`;
  await fs.mkdir(hidDir, { recursive: true });
  await fs.writeFile(
    `${hidDir}/.hidden-fixture.ts`,
    "const HIDDEN_TOKEN_MARK = 1;\n",
  );
  const hidDefault = asEnvelope(
    await call("project_search", {
      query: "HIDDEN_TOKEN_MARK",
      kind: "literal_content",
      relative_path: hidDir,
      glob: "*.ts",
    }),
  );
  const hidDefaultHits = Array.isArray(hidDefault.data?.hits)
    ? hidDefault.data.hits
    : [];
  check(
    "search_hidden_included_by_default",
    hidDefaultHits.length >= 1,
    hidDefault.data?.hits,
  );
  const hidOff = asEnvelope(
    await call("project_search", {
      query: "HIDDEN_TOKEN_MARK",
      kind: "literal_content",
      relative_path: hidDir,
      glob: "*.ts",
      include_hidden: 0,
    }),
  );
  const hidOffHits = Array.isArray(hidOff.data?.hits) ? hidOff.data.hits : [];
  check(
    "search_include_hidden_zero_skips_dotfile",
    hidOffHits.length === 0,
    hidOff.data?.hits,
  );
  await call("project_write_file", {
    relative_path: `${dir}/search-token.txt`,
    content: "NEW_TOKEN\n",
  });
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const search3 = await call("project_search", {
    query: token,
    kind: "literal_content",
    relative_path: dir,
    glob: "*.txt",
  });
  const search3Data = JSON.parse(
    (search3 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}",
  );
  check(
    "search_cache_invalidated",
    search3Data.data?.hits?.length === 0,
    search3Data.data?.hits?.length,
  );
  const unsafeRegex = asEnvelope(
    await call("project_search", {
      query: "(a+)+$",
      regex: 1,
      kind: "literal_content",
      relative_path: dir,
    }),
  );
  check(
    "search_regex_complexity_rejected",
    unsafeRegex.error?.code === "resource_limit",
    unsafeRegex.error,
  );
  const longGlob = asEnvelope(
    await call("project_search", {
      query: "x",
      kind: "literal_content",
      relative_path: dir,
      glob: "*".repeat(257),
    }),
  );
  check(
    "search_glob_length_rejected",
    longGlob.error?.code === "resource_limit",
    longGlob.error,
  );

  // 10b. Search + symbol_references workspace cache (Phase B)
  const probe = `VERIFY_CACHE_PROBE_${Date.now()}`;
  await fs.writeFile(`${dir}/cache-probe.txt`, `${probe}\n`);
  await new Promise((resolve) => setTimeout(resolve, 3200)); // search TTL is 3 s
  const probe1 = asEnvelope(
    await call("project_search", {
      query: probe,
      kind: "literal_content",
      relative_path: dir,
      glob: "*.txt",
    }),
  );
  const probe2 = asEnvelope(
    await call("project_search", {
      query: probe,
      kind: "literal_content",
      relative_path: dir,
      glob: "*.txt",
    }),
  );
  check("search_cache_hit", probe2.cached === true && probe1.cached !== true, {
    first: probe1.cached,
    second: probe2.cached,
  });
  const sym1 = asEnvelope(
    await call("project_symbol_references", {
      symbol_name: probe,
      scope: "workspace",
      relative_path: dir,
      limit: 10,
    }),
  );
  const sym2 = asEnvelope(
    await call("project_symbol_references", {
      symbol_name: probe,
      scope: "workspace",
      relative_path: dir,
      limit: 10,
    }),
  );
  check(
    "symbol_references_workspace_cache_hit",
    sym2.cached === true && sym1.cached !== true,
    { first: sym1.cached, second: sym2.cached },
  );
  await call("project_write_file", {
    relative_path: `${dir}/cache-probe.txt`,
    content: `${probe} again\n`,
  });
  const sym3 = asEnvelope(
    await call("project_symbol_references", {
      symbol_name: probe,
      scope: "workspace",
      relative_path: dir,
      limit: 10,
    }),
  );
  check("symbol_references_cache_invalidated_on_write", sym3.cached !== true, {
    cached: sym3.cached,
  });
  await call("project_read_file", {
    relative_path: `${dir}/phase-b-missing.txt`,
  }); // negative cache entry
  const healthCache = asEnvelope(
    await call("project_health", { include_audit: 0 }),
  );
  check(
    "health_negative_cache_reported",
    typeof healthCache.data?.caches?.negative?.entries === "number" &&
      healthCache.data.caches.negative.entries >= 1 &&
      typeof healthCache.data.caches.negative.ttl_ms === "number" &&
      typeof healthCache.data.caches.negative.oldest_age_ms === "number",
    healthCache.data?.caches?.negative,
  );

  // 10c. Hybrid search mode (Phase C)
  const hyb = asEnvelope(
    await call("project_search", {
      query: "CoreHost",
      kind: "literal_content",
      relative_path: ".",
      glob: "*.ts",
      hybrid: 1,
      limit: 8,
    }),
  );
  check(
    "search_hybrid_returns_tagged_hits",
    Array.isArray(hyb.data?.hits) &&
      hyb.data.hits.length > 0 &&
      hyb.data.hits.every(
        (hit: Record<string, unknown>) =>
          typeof hit.source === "string" && typeof hit.confidence === "string",
      ) &&
      hyb.data.hits.some(
        (hit: Record<string, unknown>) => hit.source === "symbol_index",
      ),
    hyb.data?.hits?.slice(0, 4),
  );
  // Item 14 regression: ranking happens before `limit`, so even limit=1 must surface the definition
  // (whichever raw-hit position it has in file-walk order) and agree with the larger-limit result.
  const hybOne = asEnvelope(
    await call("project_search", {
      query: "CoreHost",
      kind: "literal_content",
      relative_path: ".",
      glob: "*.ts",
      hybrid: 1,
      limit: 1,
    }),
  );
  check(
    "search_hybrid_ranks_before_limit",
    Array.isArray(hybOne.data?.hits) &&
      hybOne.data.hits.length === 1 &&
      hybOne.data.hits[0].source === "symbol_index" &&
      hybOne.data.complete === false &&
      hyb.data?.hits?.[0]?.source === "symbol_index" &&
      hyb.data.hits[0].relative_path === hybOne.data.hits[0].relative_path &&
      hyb.data.hits[0].line_number === hybOne.data.hits[0].line_number,
    { one: hybOne.data?.hits, eight: hyb.data?.hits?.slice(0, 2) },
  );
  const scopedMiss = asEnvelope(
    await call("project_search", {
      query: "McpServer",
      kind: "literal_content",
      relative_path: dir,
      hybrid: 1,
      limit: 5,
    }),
  );
  check(
    "search_hybrid_scope_widened_on_empty",
    scopedMiss.data?.scope_widened === true,
    scopedMiss.data,
  );

  const patternBatchSearch = asEnvelope(
    await call("project_read_batch", {
      requests: [{ operation: "search", arguments: { pattern: "function ", scope: "workspace", limit: 10 } }],
    }),
  );
  const patternBatchSearchItem = patternBatchSearch.data?.responses?.[0];
  check(
    "batch_search_pattern_alias_maps_to_query",
    patternBatchSearchItem?.ok === true &&
      Array.isArray(patternBatchSearchItem?.response?.data?.hits) &&
      patternBatchSearchItem.response.data.hits.length > 0,
    patternBatchSearchItem,
  );

  const missingBatchQuery = asEnvelope(
    await call("project_read_batch", {
      requests: [{ operation: "search", arguments: { scope: "workspace" } }],
    }),
  );
  const missingBatchQueryItem = missingBatchQuery.data?.responses?.[0];
  check(
    "batch_search_missing_query_is_invalid_request",
    missingBatchQueryItem?.ok === false &&
      missingBatchQueryItem?.error?.code === "invalid_request" &&
      String(missingBatchQueryItem?.hint ?? "").includes("arguments.query"),
    missingBatchQueryItem,
  );

  // 10c-2. Hybrid search inside project_read_batch (same routing rule as the standalone tool).
  const hybBatch = asEnvelope(
    await call("project_read_batch", {
      requests: [
        {
          operation: "search",
          arguments: {
            query: "CoreHost",
            kind: "literal_content",
            relative_path: ".",
            glob: "*.ts",
            hybrid: 1,
            limit: 8,
          },
        },
        {
          operation: "search",
          arguments: {
            query: "McpServer",
            kind: "literal_content",
            relative_path: dir,
            hybrid: 1,
            limit: 5,
          },
        },
        {
          operation: "search",
          arguments: {
            query: "CoreHost",
            kind: "literal_content",
            relative_path: ".",
            glob: "*.ts",
            hybrid: 0,
            limit: 8,
          },
        },
        {
          operation: "search",
          arguments: {
            query: "project.ts",
            kind: "file_name",
            hybrid: 1,
            limit: 5,
          },
        },
      ],
    }),
  );
  const hybItem = (
    i: number,
  ):
    | {
        hits?: Array<Record<string, unknown>>;
        hybrid?: boolean;
        scope_widened?: boolean;
      }
    | undefined => hybBatch.data?.responses?.[i]?.response?.data;
  check(
    "batch_hybrid_returns_tagged_hits",
    hybBatch.ok === true &&
      hybItem(0)?.hybrid === true &&
      (hybItem(0)?.hits?.length ?? 0) > 0 &&
      (hybItem(0)?.hits ?? []).every(
        (hit) =>
          typeof hit.source === "string" && typeof hit.confidence === "string",
      ) &&
      (hybItem(0)?.hits ?? []).some((hit) => hit.source === "symbol_index"),
    hybItem(0)?.hits?.slice(0, 4),
  );
  check(
    "batch_hybrid_scope_widened_on_empty",
    hybItem(1)?.scope_widened === true,
    hybItem(1),
  );
  check(
    "batch_hybrid_off_stays_untagged",
    (hybItem(2)?.hits?.length ?? 0) > 0 &&
      hybItem(2)?.hybrid === undefined &&
      (hybItem(2)?.hits ?? []).every((hit) => hit.source === undefined),
    hybItem(2)?.hits?.slice(0, 2),
  );
  check(
    "batch_hybrid_ignored_for_non_literal_kind",
    hybBatch.data?.responses?.[3]?.ok === true &&
      hybItem(3)?.hybrid === undefined,
    hybItem(3),
  );

  // 10c-3. Batch hybrid follow-ups: shared per-batch symbol cache + trimming to the per-item byte limit.
  type HybridBatchData = {
    hits?: Array<Record<string, unknown>>;
    complete?: boolean;
    hybrid?: boolean;
    trimmed_to_item_budget?: boolean;
  };
  const hybSharedBatch = asEnvelope(
    await call("project_read_batch", {
      requests: [
        {
          operation: "search",
          arguments: {
            query: "CoreHost",
            kind: "literal_content",
            relative_path: ".",
            glob: "*.ts",
            hybrid: 1,
            limit: 8,
          },
        },
        {
          operation: "search",
          arguments: {
            query: "CoreHost",
            kind: "literal_content",
            relative_path: ".",
            glob: "*.ts",
            hybrid: 1,
            limit: 5,
          },
        },
      ],
    }),
  );
  const hybSharedItem = (i: number): HybridBatchData | undefined =>
    hybSharedBatch.data?.responses?.[i]?.response?.data;
  const hybSharedTags = (i: number): string[] =>
    (hybSharedItem(i)?.hits ?? []).map(
      (hit) =>
        `${hit.relative_path}:${hit.line_number}:${hit.source}:${hit.confidence}`,
    );
  check(
    "batch_hybrid_shared_cache_tags_consistent",
    hybSharedBatch.ok === true &&
      hybSharedTags(1).length === 5 &&
      hybSharedTags(1).join("|") === hybSharedTags(0).slice(0, 5).join("|") &&
      hybSharedTags(0).some((tag) => tag.includes(":symbol_index:")),
    { first: hybSharedTags(0).slice(0, 5), second: hybSharedTags(1) },
  );
  check(
    "batch_hybrid_untrimmed_when_fits",
    hybSharedItem(0)?.trimmed_to_item_budget === undefined &&
      hybSharedItem(1)?.trimmed_to_item_budget === undefined,
    {
      first: hybSharedItem(0)?.trimmed_to_item_budget,
      second: hybSharedItem(1)?.trimmed_to_item_budget,
    },
  );
  const hybTrimBatch = asEnvelope(
    await call("project_read_batch", {
      max_response_bytes_per_item: 4096,
      requests: [
        {
          operation: "search",
          arguments: {
            query: "import",
            kind: "literal_content",
            relative_path: ".",
            glob: "*.ts",
            hybrid: 1,
            limit: 200,
          },
        },
      ],
    }),
  );
  const hybTrimItem = hybTrimBatch.data?.responses?.[0]?.response?.data as
    HybridBatchData | undefined;
  check(
    "batch_hybrid_trims_to_item_budget",
    hybTrimBatch.data?.responses?.[0]?.ok === true &&
      hybTrimItem?.trimmed_to_item_budget === true &&
      hybTrimItem?.complete === false &&
      (hybTrimItem?.hits?.length ?? 0) >= 1 &&
      (hybTrimItem?.hits ?? []).every(
        (hit) =>
          typeof hit.source === "string" && typeof hit.confidence === "string",
      ),
    {
      ok: hybTrimBatch.data?.responses?.[0]?.ok,
      error: hybTrimBatch.data?.responses?.[0]?.error,
      hits: hybTrimItem?.hits?.length,
      complete: hybTrimItem?.complete,
      trimmed: hybTrimItem?.trimmed_to_item_budget,
    },
  );

  // 10d. Hybrid search fixture matrix — definition detection end-to-end per language.
  const hybridFixture = [
    {
      lang: "typescript",
      file: `${dir}/hybrid-matrix.ts`,
      content: "export function hybridMatrixTs(): number {\n  return 2;\n}\n",
      query: "hybridMatrixTs",
      defLine: 1,
      glob: "*.ts",
    },
    {
      lang: "rust",
      file: `${dir}/hybrid-matrix.rs`,
      content: "pub fn hybridMatrixRs() {}\n",
      query: "hybridMatrixRs",
      defLine: 1,
      glob: "*.rs",
    },
    {
      lang: "python",
      file: `${dir}/hybrid-matrix.py`,
      content: "def hybridMatrixPy():\n    return 3\n",
      query: "hybridMatrixPy",
      defLine: 1,
      glob: "*.py",
    },
    {
      lang: "go",
      file: `${dir}/hybrid-matrix.go`,
      content: "package main\n\nfunc hybridMatrixGo() {}\n",
      query: "hybridMatrixGo",
      defLine: 3,
      glob: "*.go",
    },
  ];
  for (const fixture of hybridFixture) {
    await fs.writeFile(fixture.file, fixture.content, "utf8");
  }
  for (const fixture of hybridFixture) {
    const matrixRes = asEnvelope(
      await call("project_search", {
        query: fixture.query,
        kind: "literal_content",
        relative_path: dir,
        glob: fixture.glob,
        hybrid: 1,
        whole_word: 1,
        limit: 5,
      }),
    );
    const matrixHits = Array.isArray(matrixRes.data?.hits)
      ? (matrixRes.data.hits as Record<string, unknown>[])
      : [];
    const defHit = matrixHits.find(
      (h) =>
        h.source === "symbol_index" &&
        Number(h.line_number) === fixture.defLine,
    );
    check(
      `search_hybrid_symbol_index_${fixture.lang}`,
      defHit !== undefined,
      matrixHits.slice(0, 4),
    );
  }
  return {};
}
