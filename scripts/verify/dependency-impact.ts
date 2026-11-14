import { promises as fs } from "node:fs";
import path from "node:path";
import type { Harness } from "./harness.js";

export async function runDependencyImpact($h: Harness): Promise<void> {
  const { call, check, dir, textOf } = $h;
  const asEnvelope = (result: unknown) => JSON.parse(textOf(result) || "{}");
  // 11d-ter. Dependency graph + change impact fixtures (written directly: no tool call needed).
  console.log("[verify] checking dependency graph + change impact...");
  const dgRoot = `${dir}/dg`;
  const dgPath = (rel: string) => `${dgRoot}/${rel}`;
  async function writeFixture(rel: string, text: string): Promise<void> {
    const abs = path.join(process.cwd(), dgRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
  }
  await writeFixture(
    "src/app.ts",
    'import { util } from "./lib/util";\nimport { re } from "./lib";\nconst dyn = () => import("./dynamic");\nimport { nope } from "./nope";\nexport function app() { return util(); }\n',
  );
  await writeFixture(
    "src/lib/util.ts",
    "export function util() { return 1; }\nexport class Base {}\n",
  );
  await writeFixture("src/lib/index.ts", 'export * from "./util";\n');
  await writeFixture("src/dynamic.ts", "export const d = 1;\n");
  await writeFixture(
    "src/cycle-a.ts",
    'import { b } from "./cycle-b";\nexport function a() { return b(); }\n',
  );
  await writeFixture(
    "src/cycle-b.ts",
    'import { a } from "./cycle-a";\nexport function b() { return a(); }\n',
  );
  await writeFixture(
    "src/lib/util.test.ts",
    'import { util } from "./util";\nit("x", () => util());\n',
  );
  await writeFixture(
    "src/child.ts",
    'import { Base } from "./lib/util";\nexport class Child extends Base {}\n',
  );
  await writeFixture("src/dup-a.ts", "export function dup() { return 1; }\n");
  await writeFixture("src/dup-b.ts", "export function dup() { return 2; }\n");
  await writeFixture(
    "src/use-dup.ts",
    'import { dup } from "./dup-a";\nexport const v = dup();\n',
  );
  await writeFixture(
    "src/.env.local.ts",
    'import { util } from "./lib/util";\nexport const secret = util();\n',
  );
  await writeFixture("pkg/__init__.py", "");
  await writeFixture("pkg/mod.py", "def thing():\n    return 1\n");
  await writeFixture(
    "pkg/main.py",
    "from .mod import thing\n\ndef main():\n    return thing()\n",
  );

  await writeFixture(
    "rust/cli/src/main.rs",
    `mod report;

use crate::report::run;

pub fn cli() {
    run();
}
`,
  );
  await writeFixture(
    "rust/cli/src/report.rs",
    `pub fn run() {
    println!("hello");
}
`,
  );
  await writeFixture(
    "rust/svc/src/main.rs",
    `mod util;
pub mod api;
extern crate serde;

use crate::util::fmt;
use super::api::Thing;

pub fn main() {}
`,
  );
  await writeFixture(
    "rust/svc/src/util.rs",
    `pub fn fmt() {}
`,
  );
  await writeFixture(
    "rust/svc/src/api/mod.rs",
    `pub struct Thing {}
`,
  );
  await writeFixture(
    "rust/orphan/src/main.rs",
    `use crate::missing::thing;

pub fn orphan() {}
`,
  );

  await writeFixture(
    "go.mod",
    `module example.com/verifyapp

go 1.21
`,
  );
  await writeFixture(
    "main.go",
    `package main

import (
	"fmt"
	"example.com/verifyapp/pkg/tool"
)

func main() {
	fmt.Println(tool.Primary())
}
`,
  );
  await writeFixture(
    "pkg/tool/tool.go",
    `package tool

func Primary() string {
	return "tool"
}
`,
  );
  await writeFixture(
    "pkg/tool/tool_test.go",
    `package tool

import "testing"

func TestPrimary(t *testing.T) {}
`,
  );

  await writeFixture(
    "src/main/java/com/demo/Main.java",
    `package com.demo;

import java.util.List;
import com.demo.service.Service;

public class Main {
    public static void main(String[] args) {
        Service s = new Service();
        List<String> names = List.of(s.greet());
        System.out.println(names);
    }
}
`,
  );
  await writeFixture(
    "src/main/java/com/demo/service/Service.java",
    `package com.demo.service;

public class Service {
    public String greet() {
        return "hello";
    }
}
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KtService.kt",
    `package com.demo

class KtService {
    fun greet(): String = "kotlin"
}
`,
  );
  await writeFixture(
    "src/main/java/com/demo/Named.java",
    `package com.demo;

public interface Named {
}
`,
  );
  await writeFixture(
    "src/main/java/com/demo/Base.java",
    `package com.demo;

public class Base implements Named {
}
`,
  );
  await writeFixture(
    "src/main/java/com/demo/Child.java",
    `package com.demo;

public class Child extends Base implements Named {
}
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KBase.kt",
    `package com.demo

open class KBase
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KNamed.kt",
    `package com.demo

interface KNamed
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KChild.kt",
    `package com.demo

class KChild : KBase()
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KService.kt",
    `package com.demo

class KService : KBase(), KNamed
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KParent.kt",
    `package com.demo

interface KParent
`,
  );
  await writeFixture(
    "src/main/kotlin/com/demo/KChild2.kt",
    `package com.demo

interface KChild2 : KParent
`,
  );

  const graph = asEnvelope(
    await call("dependency_graph", {
      kind: "both",
      relative_path: dgRoot,
      depth: 5,
      include_external: 1,
      max_nodes: 100,
      max_edges: 200,
    }),
  );
  const graphNodes = (graph.data?.nodes ?? []).map(
    (node: { id: string }) => node.id,
  ) as string[];
  const graphEdges = (graph.data?.edges ?? []) as Array<{
    from: string;
    to: string;
    type: string;
    confidence: string;
  }>;
  const hasEdge = (
    from: string,
    to: string,
    type: string,
    confidence?: string,
  ) =>
    graphEdges.some(
      (edge) =>
        edge.from === dgPath(from) &&
        edge.to === dgPath(to) &&
        edge.type === type &&
        (!confidence || edge.confidence === confidence),
    );
  check(
    "dependency_graph_ts_relative_imports",
    graph.ok === true &&
      graph.data?.kind === "both" &&
      hasEdge("src/app.ts", "src/lib/util.ts", "import", "exact") &&
      hasEdge("src/lib/index.ts", "src/lib/util.ts", "import", "exact"),
    {
      nodes: graphNodes,
      edges: graphEdges.filter((edge) => edge.type === "import"),
    },
  );
  check(
    "dependency_graph_cycle",
    hasEdge("src/cycle-a.ts", "src/cycle-b.ts", "import") &&
      hasEdge("src/cycle-b.ts", "src/cycle-a.ts", "import"),
    graphEdges.filter((edge) => edge.from.startsWith("src/cycle")),
  );
  check(
    "dependency_graph_dynamic_import_possible",
    hasEdge("src/app.ts", "src/dynamic.ts", "import", "possible"),
    graphEdges.filter((edge) => edge.to === "src/dynamic.ts"),
  );
  check(
    "dependency_graph_python_relative_import",
    hasEdge("pkg/main.py", "pkg/mod.py", "import", "exact"),
    graphEdges.filter((edge) => edge.from.startsWith("pkg/")),
  );
  check(
    "dependency_graph_protected_file_excluded",
    !graphNodes.includes(dgPath("src/.env.local.ts")),
    graphNodes,
  );
  check(
    "dependency_graph_extends_edge",
    hasEdge("src/child.ts", "src/lib/util.ts", "extends"),
    graphEdges.filter((edge) => edge.from === "src/child.ts"),
  );
  check(
    "dependency_graph_unresolved_reported",
    (graph.data?.unresolved ?? []).some(
      (entry: { specifier?: string }) => entry.specifier === "./nope",
    ),
    graph.data?.unresolved,
  );
  check(
    "dependency_graph_rust_mod_decl",
    graph.ok === true &&
      hasEdge(
        "rust/cli/src/main.rs",
        "rust/cli/src/report.rs",
        "import",
        "exact",
      ),
    graphEdges.filter((edge) => edge.from.startsWith("rust/")),
  );
  check(
    "dependency_graph_rust_pub_mod_and_crate_use",
    graph.ok === true &&
      hasEdge(
        "rust/svc/src/main.rs",
        "rust/svc/src/api/mod.rs",
        "import",
        "exact",
      ) &&
      hasEdge(
        "rust/svc/src/main.rs",
        "rust/svc/src/util.rs",
        "import",
        "exact",
      ),
    graphEdges.filter((edge) => edge.from.startsWith("rust/")),
  );
  check(
    "dependency_graph_rust_extern_crate_external",
    (graph.data?.external ?? []).some(
      (entry: { id?: string }) => entry.id === "cargo:serde",
    ),
    graph.data?.external,
  );
  check(
    "dependency_graph_rust_unresolved_module",
    (graph.data?.unresolved ?? []).some(
      (entry: { specifier?: string }) =>
        entry.specifier === "crate::missing::thing",
    ),
    graph.data?.unresolved,
  );
  check(
    "dependency_graph_go_internal_import",
    graph.ok === true &&
      hasEdge("main.go", "pkg/tool/tool.go", "import", "exact"),
    graphEdges.filter(
      (edge) =>
        edge.from === dgPath("main.go") || edge.to === dgPath("main.go"),
    ),
  );
  check(
    "dependency_graph_go_stdlib_external",
    (graph.data?.external ?? []).some(
      (entry: { id?: string }) => entry.id === "gomod:stdlib:fmt",
    ),
    graph.data?.external,
  );
  check(
    "dependency_graph_go_references",
    graphEdges.some(
      (edge) =>
        edge.from === dgPath("main.go") &&
        edge.to === dgPath("pkg/tool/tool.go") &&
        edge.type === "references",
    ),
    graphEdges.filter((edge) => edge.type === "references"),
  );

  const graphDot = asEnvelope(
    await call("dependency_graph", {
      kind: "files",
      relative_path: dgRoot,
      depth: 5,
      format: "dot",
    }),
  );
  check(
    "dependency_graph_dot",
    graphDot.ok === true &&
      String(graphDot.data?.graph ?? "").startsWith("digraph dependencies") &&
      String(graphDot.data?.graph ?? "").includes(
        `"${dgPath("src/app.ts")}" -> "${dgPath("src/lib/util.ts")}"`,
      ),
    String(graphDot.data?.graph ?? "").slice(0, 120),
  );
  const graphMermaid = asEnvelope(
    await call("dependency_graph", {
      kind: "files",
      relative_path: dgRoot,
      depth: 5,
      format: "mermaid",
    }),
  );
  check(
    "dependency_graph_mermaid",
    graphMermaid.ok === true &&
      String(graphMermaid.data?.graph ?? "").startsWith("graph LR") &&
      String(graphMermaid.data?.graph ?? "").includes("-->|import|"),
    String(graphMermaid.data?.graph ?? "").slice(0, 120),
  );
  const graphTruncated = asEnvelope(
    await call("dependency_graph", {
      kind: "files",
      relative_path: dgRoot,
      depth: 5,
      max_nodes: 2,
    }),
  );
  check(
    "dependency_graph_truncation",
    graphTruncated.ok === true &&
      graphTruncated.data?.truncated === true &&
      (graphTruncated.data?.nodes ?? []).length === 2 &&
      !!graphTruncated.hint,
    {
      truncated: graphTruncated.data?.truncated,
      nodes: graphTruncated.data?.nodes,
      hint: graphTruncated.hint,
    },
  );

  // Writing invalidates the 5 s graph index cache: the new file must show up immediately.
  const lateWrite = await call("write_file", {
    relative_path: dgPath("src/late.ts"),
    content: "export const late = 1;\n",
    reason: "verify graph cache invalidation",
  });
  const graphAfterWrite = asEnvelope(
    await call("dependency_graph", {
      kind: "files",
      relative_path: dgRoot,
      depth: 5,
    }),
  );
  check(
    "dependency_graph_cache_invalidated_on_write",
    asEnvelope(lateWrite).ok === true &&
      (graphAfterWrite.data?.nodes ?? []).some(
        (node: { id: string }) => node.id === dgPath("src/late.ts"),
      ),
    (graphAfterWrite.data?.nodes ?? []).map((node: { id: string }) => node.id),
  );

  const impact = asEnvelope(
    await call("change_impact", {
      files: [dgPath("src/lib/util.ts")],
      direction: "dependents",
      depth: 5,
      max_nodes: 50,
    }),
  );
  const impactIds = (impact.data?.affected ?? []).map(
    (entry: { id: string }) => entry.id,
  ) as string[];
  check(
    "change_impact_reverse_closure",
    impact.ok === true &&
      impactIds.includes(dgPath("src/app.ts")) &&
      impactIds.includes(dgPath("src/child.ts")) &&
      impactIds.includes(dgPath("src/lib/index.ts")) &&
      impactIds.includes(dgPath("src/lib/util.test.ts")) &&
      Number(impact.data?.summary?.max_distance) >= 1,
    { affected: impactIds, summary: impact.data?.summary },
  );
  check(
    "change_impact_tests_counted_separately",
    impact.data?.summary?.tests_affected === 1 &&
      Number(impact.data?.summary?.affected_symbols) >= 1,
    impact.data?.summary,
  );
  const impactNoTests = asEnvelope(
    await call("change_impact", {
      files: [dgPath("src/lib/util.ts")],
      direction: "dependents",
      depth: 5,
      include_tests: 0,
    }),
  );
  check(
    "change_impact_excludes_tests",
    !(impactNoTests.data?.affected ?? []).some(
      (entry: { id: string }) => entry.id === dgPath("src/lib/util.test.ts"),
    ) && impactNoTests.data?.summary?.tests_affected === 0,
    impactNoTests.data?.summary,
  );
  const impactAmbiguous = asEnvelope(
    await call("change_impact", {
      symbols: ["dup"],
      direction: "dependents",
      depth: 3,
      min_confidence: "possible",
    }),
  );
  check(
    "change_impact_ambiguous_symbol_possible",
    impactAmbiguous.ok === true &&
      (impactAmbiguous.data?.unresolved ?? []).some(
        (entry: { symbol?: string; reason?: string }) =>
          entry.symbol === "dup" && /ambiguous/.test(entry.reason ?? ""),
      ) &&
      (impactAmbiguous.data?.affected ?? []).every(
        (entry: { confidence: string }) => entry.confidence === "possible",
      ),
    {
      unresolved: impactAmbiguous.data?.unresolved,
      affected: impactAmbiguous.data?.affected,
    },
  );
  const impactPinned = asEnvelope(
    await call("change_impact", {
      symbols: [{ name: "dup", file: dgPath("src/dup-a.ts") }],
      direction: "dependents",
      depth: 3,
    }),
  );
  check(
    "change_impact_symbol_pinned_to_file",
    impactPinned.ok === true &&
      impactPinned.data?.seed?.files?.length === 1 &&
      (impactPinned.data?.affected ?? []).some(
        (entry: { id: string; confidence: string }) =>
          entry.id === dgPath("src/use-dup.ts") && entry.confidence === "exact",
      ),
    {
      seed: impactPinned.data?.seed,
      affected: impactPinned.data?.affected,
      unresolved: impactPinned.data?.unresolved,
    },
  );
  const impactMermaid = asEnvelope(
    await call("change_impact", {
      files: [dgPath("src/lib/util.ts")],
      direction: "dependents",
      format: "mermaid",
    }),
  );
  check(
    "change_impact_mermaid",
    impactMermaid.ok === true &&
      String(impactMermaid.data?.graph ?? "").startsWith("graph LR"),
    String(impactMermaid.data?.graph ?? "").slice(0, 120),
  );
  const rustImpact = asEnvelope(
    await call("change_impact", {
      files: [dgPath("rust/cli/src/main.rs")],
      direction: "dependencies",
      depth: 5,
      max_nodes: 50,
    }),
  );
  const rustImpactIds = (rustImpact.data?.affected ?? []).map(
    (entry: { id: string }) => entry.id,
  ) as string[];
  check(
    "change_impact_rust_module_dependent",
    rustImpact.ok === true &&
      rustImpactIds.includes(dgPath("rust/cli/src/report.rs")),
    { affected: rustImpactIds, summary: rustImpact.data?.summary },
  );
  const goImpact = asEnvelope(
    await call("change_impact", {
      files: [dgPath("pkg/tool/tool.go")],
      direction: "dependents",
      depth: 5,
      max_nodes: 50,
    }),
  );
  const goImpactIds = (goImpact.data?.affected ?? []).map(
    (entry: { id: string }) => entry.id,
  ) as string[];
  check(
    "change_impact_go_package_dependent",
    goImpact.ok === true && goImpactIds.includes(dgPath("main.go")),
    { affected: goImpactIds, summary: goImpact.data?.summary },
  );
  const javaGraphEdges = (graph.data?.edges ?? []).filter(
    (edge: { type: string; from: string }) =>
      edge.type === "import" &&
      edge.from === dgPath("src/main/java/com/demo/Main.java"),
  );
  check(
    "dependency_graph_java_internal_import",
    graph.ok === true &&
      javaGraphEdges.some(
        (edge: { to: string; type: string; confidence: string }) =>
          edge.to === dgPath("src/main/java/com/demo/service/Service.java") &&
          (edge.confidence === "exact" || edge.confidence === "likely"),
      ),
    { edges: javaGraphEdges, external: graph.data?.external },
  );
  check(
    "dependency_graph_java_external_jdk",
    graph.ok === true &&
      Array.isArray(graph.data?.external) &&
      (graph.data.external as { id: string }[]).some(
        (e) => e.id === "jdk:java.util",
      ),
    { external: graph.data?.external },
  );
  const kotlinGraphEdges = (graph.data?.edges ?? []).filter(
    (edge: { type: string; from: string }) =>
      edge.type === "import" &&
      edge.from === dgPath("src/main/kotlin/com/demo/KtService.kt"),
  );
  check(
    "dependency_graph_kotlin_internal_import",
    graph.ok === true && kotlinGraphEdges.length === 0,
    {
      edges: kotlinGraphEdges,
      note: "KtService.kt has no imports, just checks no crash on .kt parsing",
    },
  );
  check(
    "dependency_graph_java_extends_implements",
    graph.ok === true &&
      hasEdge(
        "src/main/java/com/demo/Child.java",
        "src/main/java/com/demo/Base.java",
        "extends",
      ) &&
      hasEdge(
        "src/main/java/com/demo/Child.java",
        "src/main/java/com/demo/Named.java",
        "implements",
      ) &&
      hasEdge(
        "src/main/java/com/demo/Base.java",
        "src/main/java/com/demo/Named.java",
        "implements",
      ),
    graphEdges.filter(
      (edge) =>
        edge.from.includes("com/demo/Child") ||
        edge.from.includes("com/demo/Base"),
    ),
  );
  check(
    "dependency_graph_kotlin_extends_implements",
    graph.ok === true &&
      hasEdge(
        "src/main/kotlin/com/demo/KChild.kt",
        "src/main/kotlin/com/demo/KBase.kt",
        "extends",
      ) &&
      hasEdge(
        "src/main/kotlin/com/demo/KService.kt",
        "src/main/kotlin/com/demo/KBase.kt",
        "extends",
      ) &&
      hasEdge(
        "src/main/kotlin/com/demo/KService.kt",
        "src/main/kotlin/com/demo/KNamed.kt",
        "implements",
      ) &&
      hasEdge(
        "src/main/kotlin/com/demo/KChild2.kt",
        "src/main/kotlin/com/demo/KParent.kt",
        "extends",
      ),
    graphEdges.filter((edge) => edge.from.includes("com/demo/K")),
  );
  const javaImpact = asEnvelope(
    await call("change_impact", {
      files: [dgPath("src/main/java/com/demo/service/Service.java")],
      direction: "dependents",
      depth: 5,
      max_nodes: 50,
    }),
  );
  const javaImpactIds = (javaImpact.data?.affected ?? []).map(
    (entry: { id: string }) => entry.id,
  ) as string[];
  check(
    "change_impact_java_package_dependent",
    javaImpact.ok === true &&
      javaImpactIds.includes(dgPath("src/main/java/com/demo/Main.java")),
    { affected: javaImpactIds, summary: javaImpact.data?.summary },
  );

}
