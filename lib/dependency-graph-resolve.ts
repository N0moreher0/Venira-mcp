/**
 * Dependency graph — resolver import → file thật (TS/Python/Rust/Go/JVM).
 * Tách khỏi dependency-graph.ts; hành vi giữ nguyên.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { type GraphLanguage, type EdgeConfidence, TS_EXTENSIONS, isInside, relFromRoot, protectedLike } from "./dependency-graph-common.js";

export function firstExisting(candidates: string[], rootAbs: string): string | null {
  for (const candidate of candidates) {
    if (!isInside(rootAbs, candidate)) continue;
    if (protectedLike(candidate, relFromRoot(rootAbs, candidate))) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function probeTs(fromAbs: string, specifier: string, rootAbs: string): string | null {
  const base = specifier.startsWith("/")
    ? path.resolve(rootAbs, "." + specifier)
    : path.resolve(path.dirname(fromAbs), specifier);
  const hasExtension = path.extname(base) !== "";
  const withoutExtension = hasExtension ? base.slice(0, -path.extname(base).length) : base;
  const candidates = hasExtension
    ? [
        base,
        // TS source is written with `.js`/`.jsx` specifiers under NodeNext.
        ...TS_EXTENSIONS.map((ext) => `${withoutExtension}${ext}`),
        ...TS_EXTENSIONS.map((ext) => path.join(withoutExtension, `index${ext}`)),
      ]
    : [...TS_EXTENSIONS.map((ext) => `${base}${ext}`), ...TS_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)), base];
  return firstExisting(candidates, rootAbs);
}

export function probePython(fromAbs: string, specifier: string, rootAbs: string): string | null {
  if (specifier.startsWith(".")) {
    let dots = 0;
    while (dots < specifier.length && specifier[dots] === ".") dots += 1;
    const rest = specifier.slice(dots);
    let baseDir = path.dirname(fromAbs);
    for (let i = 1; i < dots; i += 1) baseDir = path.dirname(baseDir);
    const parts = rest.split(".").filter(Boolean);
    const modulePath = path.join(baseDir, ...parts);
    const candidates = parts.length === 0
      ? [path.join(baseDir, "__init__.py")]
      : [`${modulePath}.py`, path.join(modulePath, "__init__.py")];
    return firstExisting(candidates, rootAbs);
  }
  const parts = specifier.split(".").filter(Boolean);
  if (parts.length === 0) return null;
  const modulePath = path.join(rootAbs, ...parts);
  return firstExisting([`${modulePath}.py`, path.join(modulePath, "__init__.py")], rootAbs);
}

export function externalId(specifier: string, lang: GraphLanguage): string {
  if (lang === "rs") {
    const raw = specifier.startsWith("externcrate:") ? specifier.slice("externcrate:".length) : specifier;
    const top = raw.split("::")[0]?.trim() || raw;
    if (top === "std" || top === "core" || top === "alloc") return `rust:${top}`;
    return `cargo:${top}`;
  }
  if (lang === "py") {
    const top = specifier.split(".")[0] || specifier;
    return `pip:${top}`;
  }
  if (lang === "go") {
    // Stdlib packages never contain a dot in the first path element; Go
    // module paths do (github.com/..., golang.org/...).
    const first = specifier.split("/")[0] || specifier;
    if (first.includes(".")) {
      const parts = specifier.split("/").filter(Boolean);
      return `gomod:${parts.slice(0, 2).join("/")}`;
    }
    return `gomod:stdlib:${first}`;
  }
  if (lang === "java" || lang === "kotlin") {
    const top = specifier.split(".")[0] || specifier;
    if (top === "java" || top === "javax") return `jdk:${specifier.split(".").slice(0, 2).join(".")}`;
    return `maven:${specifier.split(".").slice(0, 2).join(".")}`;
  }
  if (specifier.startsWith("node:")) {
    const name = specifier.slice(5).split("/")[0];
    return `node:${name}`;
  }
  if (specifier.startsWith("@")) {
    return `npm:${specifier.split("/").slice(0, 2).join("/")}`;
  }
  return `npm:${specifier.split("/")[0]}`;
}

export function isRelativeSpecifier(specifier: string, lang: GraphLanguage): boolean {
  if (lang === "rs") {
    return (
      specifier.startsWith("moddecl:") ||
      specifier.startsWith("crate::") ||
      specifier.startsWith("super::") ||
      specifier.startsWith("self::") ||
      specifier.startsWith("::")
    );
  }
  if (lang === "go") return false; // Go imports are module paths, never file-relative; probeGo handles them.
  if (lang === "java" || lang === "kotlin") return false; // Java/Kotlin imports are package-qualified, never ./ or ../ relative.
  if (lang === "py") return specifier.startsWith(".");
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

// ---------------------------------------------------------------------------
// Rust module resolution (rustc's file layout, parser-lite)
// ---------------------------------------------------------------------------

export const RUST_CRATE_ROOT_FILES = ["main.rs", "lib.rs"];

/**
 * The directory holding main.rs/lib.rs for the crate that owns `abs`,
 * walking up from the file's own directory. Returns null when the file
 * does not belong to any crate inside the workspace (then internal paths
 * stay unresolved instead of guessing against the workspace root).
 */
export function rustCrateRootDir(abs: string): string | null {
  let dir = path.dirname(abs);
  for (let i = 0; i < 24; i += 1) {
    if (RUST_CRATE_ROOT_FILES.some((name) => existsSync(path.join(dir, name)))) return dir;
    if (existsSync(path.join(dir, "Cargo.toml"))) {
      const src = path.join(dir, "src");
      if (RUST_CRATE_ROOT_FILES.some((name) => existsSync(path.join(src, name)))) return src;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Module path of a file relative to its crate root (main.rs/lib.rs => []). */
export function rustModulePath(abs: string, crateDir: string): string[] {
  const rel = path.relative(crateDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
  const noExt = rel.replace(/\.rs$/i, "").split(path.sep).filter(Boolean);
  const base = noExt[noExt.length - 1];
  if (base === "main" || base === "lib" || base === "build") noExt.pop();
  else if (base === "mod") noExt.pop();
  return noExt;
}

/** Directory in which the children of `abs`'s module live. */
export function rustModDir(abs: string): string {
  const base = path.basename(abs).toLowerCase();
  if (base === "mod.rs" || base === "lib.rs" || base === "main.rs" || base === "build.rs") return path.dirname(abs);
  return abs.replace(/\.rs$/i, "");
}

/**
 * Resolve a Rust import specifier to a file, following rustc's rules:
 *   moddecl:X      -> <modDir>/X.rs | <modDir>/X/mod.rs
 *   crate::a::b    -> <crateDir>/a/b.rs (longest existing prefix wins, so
 *                     `use crate::m::item` lands on m.rs when `item` is an item)
 *   self::/super:: -> relative to the current module path
 *   bare a::b      -> uniform path: current module first, then crate root
 * Returns null for `externcrate:` and unresolved internal paths (the caller
 * decides external-vs-unresolved).
 */
export function probeRust(fromAbs: string, specifier: string, rootAbs: string): string | null {
  if (specifier.startsWith("externcrate:")) return null;
  if (specifier.startsWith("moddecl:")) {
    const name = specifier.slice("moddecl:".length);
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    const dir = rustModDir(fromAbs);
    return firstExisting([path.join(dir, `${name}.rs`), path.join(dir, name, "mod.rs")], rootAbs);
  }
  const crateDir = rustCrateRootDir(fromAbs);
  if (!crateDir || !isInside(rootAbs, crateDir)) return null;

  let segs: string[];
  if (specifier.startsWith("crate::") || specifier.startsWith("::")) {
    segs = specifier.replace(/^(?:crate::|:+)/, "").split("::").filter(Boolean);
  } else {
    const modPath = [...rustModulePath(fromAbs, crateDir)];
    let rest = specifier;
    if (rest.startsWith("super::") || rest === "super") {
      let supers = 0;
      while (rest.startsWith("super::")) {
        supers += 1;
        rest = rest.slice("super::".length);
      }
      if (rest === "super") {
        supers += 1;
        rest = "";
      }
      for (let i = 0; i < supers && modPath.length > 0; i += 1) modPath.pop();
    } else if (rest.startsWith("self::")) {
      rest = rest.slice("self::".length);
    }
    // Uniform path: current module first, then (unresolved => caller: extern crate).
    segs = [...modPath, ...rest.split("::").filter(Boolean)];
  }

  if (segs.length === 0) {
    return firstExisting(RUST_CRATE_ROOT_FILES.map((name) => path.join(crateDir, name)), rootAbs);
  }
  // Longest existing prefix wins: `use crate::m::item` lands on m.rs when
  // `item` is a plain item, and on item.rs when it is a module.
  for (let k = segs.length; k >= 1; k -= 1) {
    const target = path.join(crateDir, ...segs.slice(0, k));
    const hit = firstExisting([`${target}.rs`, path.join(target, "mod.rs")], rootAbs);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Go module resolution (parser-lite, via go.mod at the workspace root)
// ---------------------------------------------------------------------------


export type GoImportResolution =
  | { kind: "internal"; file: string; confidence: EdgeConfidence }
  | { kind: "external" }
  | { kind: "unresolved"; reason: string };

/**
 * Resolve a Go import:
 *   - specifier equal/below the module prefix -> internal package on disk;
 *     the edge targets the package's main file (name.go, else the single /
 *     alphabetically-first non-test .go file). no go.mod => unresolvable.
 *   - module-qualified paths under other modules, stdlib -> external.
 */
export function resolveGoImport(
  fromAbs: string,
  specifier: string,
  rootAbs: string,
): GoImportResolution {
  // Walk up from the importing file to find go.mod (mirrors Rust's crate-root
  // walk; a workspace may nest modules).
  let goModDir: string | null = null;
  let dir = path.dirname(fromAbs);
  for (let i = 0; i < 24 && isInside(rootAbs, dir); i += 1) {
    if (existsSync(path.join(dir, "go.mod"))) {
      goModDir = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!goModDir) return { kind: "external" };

  // Read the module path from go.mod.
  let modulePath: string | null = null;
  try {
    const content = readFileSync(path.join(goModDir, "go.mod"), "utf8")
      .replace(/^\uFEFF/, "")
      .replace(/\r/g, "");
    const match = /^module\s+([^\s]+)/m.exec(content);
    if (match) modulePath = match[1].trim();
  } catch {
    return { kind: "external" };
  }
  if (!modulePath) return { kind: "external" };

  const isInternal =
    specifier === modulePath || specifier.startsWith(`${modulePath}/`);
  if (!isInternal) {
    return { kind: "external" };
  }
  const rest = specifier.slice(modulePath.length).replace(/^\/+/, "");
  const dirRel = rest;
  const dirAbs = rest === "" ? goModDir : path.join(goModDir, ...dirRel.split("/"));
  if (!isInside(rootAbs, dirAbs) || !existsSync(dirAbs)) {
    return { kind: "unresolved", reason: "unresolved Go module path" };
  }
  // Package file selection: <basename>.go first, then the single non-test file,
  // else the alphabetically-first Go file (test files only as a last resort).
  const base = rest === "" ? path.basename(goModDir) : path.basename(dirAbs);
  const convention = path.join(dirAbs, `${base}.go`);
  if (existsSync(convention)) return { kind: "internal", file: convention, confidence: "exact" };
  try {
    const goFiles = readdirSync(dirAbs)
      .filter((f: string) => f.endsWith(".go"))
      .sort();
    const nonTest = goFiles.filter((f: string) => !f.endsWith("_test.go"));
    const pick = nonTest[0] ?? goFiles[0];
    if (pick) {
      return {
        kind: "internal",
        file: path.join(dirAbs, pick),
        confidence: nonTest.length === 1 && !existsSync(convention) ? "exact" : "likely",
      };
    }
    return { kind: "unresolved", reason: "Go package has no .go files" };
  } catch {
    return { kind: "unresolved", reason: "unreadable Go package directory" };
  }
}

export type JvmImportResolution =
  | { kind: "internal"; file: string; confidence: EdgeConfidence }
  | { kind: "external" }
  | { kind: "unresolved"; reason: string };

/**
 * Java/Kotlin import resolution, parser-lite.
 * Imports are package-qualified (`com.acme.demo.Service`, `java.util.List`).
 * The package path maps to directories under candidate source roots
 * (`src/main/java`, `src/java`, `src/main/kotlin`, `src/kotlin`, workspace
 * root, or walking up from the importing file); wildcard imports
 * (`foo.bar.*`) are reported as external since no single class can be pinned.
 */
export function resolveJvmImport(
  fromAbs: string,
  specifier: string,
  rootAbs: string,
): JvmImportResolution {
  const trimmed = specifier.trim();
  if (trimmed.endsWith(".*")) return { kind: "external" };
  const parts = trimmed.split(".").filter(Boolean);
  if (parts.length < 2) {
    return { kind: "unresolved", reason: "unresolved Java/Kotlin import path" };
  }
  const className = parts[parts.length - 1]!;
  const pkgParts = parts.slice(0, -1);

  const candidateRoots: string[] = [rootAbs,
    path.join(rootAbs, "src", "main", "java"),
    path.join(rootAbs, "src", "java"),
    path.join(rootAbs, "src", "main", "kotlin"),
    path.join(rootAbs, "src", "kotlin")];
  // Walking up from the importing file's dir catches same-package / sibling
  // package refs that don't follow source-root conventions.
  let dir = path.dirname(fromAbs);
  for (let i = 0; i < 24 && isInside(rootAbs, dir); i += 1) {
    candidateRoots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const root of candidateRoots) {
    for (const ext of [".java", ".kt"]) {
      const candidate = path.join(root, ...pkgParts, `${className}${ext}`);
      if (isInside(rootAbs, candidate) && existsSync(candidate)) {
        const confidence = root === rootAbs || root.startsWith(path.join(rootAbs, "src"))
          ? "exact"
          : "likely";
        return { kind: "internal", file: candidate, confidence };
      }
    }
  }
  // Not found on disk under any candidate source root: treat as an external
  // Maven/JDK dependency rather than unresolved (parser-lite approximation).
  return { kind: "external" };
}
