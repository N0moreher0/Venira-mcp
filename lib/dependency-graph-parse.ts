/**
 * Dependency graph — bóc tách import (parser-lite).
 *
 * Gồm các hàm xoá comment/chuỗi theo ngôn ngữ và các hàm parseImports* trả về
 * ImportRef[]. Thuần hàm, không đụng filesystem; tách khỏi dependency-graph.ts
 * để file chính chỉ còn indexer + resolver + builder. Hành vi giữ nguyên.
 */
export type ImportRef = {
  specifier: string;
  line: number;
  via: string;
  dynamic: boolean;
};

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function stripTsNonCode(text: string): string {
  const chars = text.split("");
  let i = 0;
  const n = chars.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < n; j += 1) {
      if (chars[j] !== "\n") chars[j] = " ";
    }
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      let end = text.indexOf("\n", i + 2);
      if (end < 0) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      let end = text.indexOf("*/", i + 2);
      end = end < 0 ? n : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i + 1, Math.max(i + 1, j - 1));
      i = j;
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

export function stripPythonNonCode(text: string): string {
  const chars = text.split("");
  let i = 0;
  const n = chars.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < n; j += 1) {
      if (chars[j] !== "\n") chars[j] = " ";
    }
  };
  while (i < n) {
    const ch = text[i];
    if (ch === "#") {
      let end = text.indexOf("\n", i + 1);
      if (end < 0) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = text.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        let end = text.indexOf(triple, i + 3);
        end = end < 0 ? n : end + 3;
        blank(i + 3, Math.max(i + 3, end - 3));
        i = end;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i + 1, Math.max(i + 1, j - 1));
      i = j;
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

export function stripRustNonCode(text: string): string {
  const chars = text.split("");
  const n = chars.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < n; j += 1) {
      if (chars[j] !== "\n") chars[j] = " ";
    }
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      let end = text.indexOf("\n", i + 2);
      if (end < 0) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      // Rust block comments nest, unlike C/TS.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth += 1;
          j += 2;
          continue;
        }
        if (text[j] === "*" && text[j + 1] === "/") {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      blank(i, Math.min(j, n));
      i = j;
      continue;
    }
    const prev = i > 0 ? text[i - 1] : "";
    const afterWordChar = /[A-Za-z0-9_]/.test(prev);
    if (!afterWordChar && ch === "r") {
      // Raw strings: r"..." / r#"..."# / r##"..."## (the r must not be an
      // identifier suffix such as `for` or `err`).
      let hashes = 0;
      let j = i + 1;
      while (j < n && text[j] === "#") {
        hashes += 1;
        j += 1;
      }
      if (j < n && text[j] === '"') {
        const closing = '"' + "#".repeat(hashes);
        const end = text.indexOf(closing, j + 1);
        const stop = end < 0 ? n : end + closing.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i + 1, Math.max(i + 1, j - 1));
      i = j;
      continue;
    }
    if (ch === "'") {
      // Char literal ('a', '\n', '\'', '\u{1F600}') vs lifetime/label ('a, 'static).
      if (next === "\\") {
        let j = i + 2;
        while (j < n && text[j] !== "'") j += 1;
        if (j < n) {
          blank(i + 1, j);
          i = j + 1;
          continue;
        }
        i += 1;
        continue;
      }
      if (next !== undefined && next !== "'" && text[i + 2] === "'") {
        blank(i + 1, i + 2);
        i = i + 3;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

export function parseImportsTs(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlockComment) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlockComment = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlockComment = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const line = i + 1;
    const via = original.trim().slice(0, 160);

    const staticImport = /^\s*import\s+(?:type\s+)?(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/.exec(original);
    const reExport = /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/.exec(original);
    const requireRef = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/.exec(original);
    const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/.exec(original);

    const push = (specifier: string, dynamic: boolean) => {
      const key = `${specifier}\u0000${line}\u0000${dynamic}`;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({ specifier, line, via, dynamic });
    };
    if (staticImport) push(staticImport[1], false);
    if (reExport) push(reExport[1], false);
    if (requireRef) push(requireRef[1], false);
    if (dynamicImport) push(dynamicImport[1], true);
  }
  return imports;
}

export function parseImportsPython(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let triple: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    const trimmed = original.trim();
    if (triple) {
      if (trimmed.includes(triple)) triple = null;
      continue;
    }
    const tripleStart = /^(?:[rbufRBUF]{0,2})("""|''')/.exec(trimmed);
    if (tripleStart) {
      const quote = tripleStart[1];
      const rest = trimmed.slice(tripleStart[0].length);
      if (!rest.includes(quote)) triple = quote;
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = i + 1;
    const via = trimmed.slice(0, 160);
    const push = (specifier: string, dynamic: boolean) => {
      const key = `${specifier}\u0000${line}\u0000${dynamic}`;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({ specifier, line, via, dynamic });
    };
    const fromImport = /^\s*from\s+([.\w]+)\s+import\b/.exec(original);
    if (fromImport) push(fromImport[1], false);
    const plainImport = /^\s*import\s+(.+)$/.exec(original);
    if (plainImport) {
      for (const part of plainImport[1].split(",")) {
        const moduleName = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (moduleName) push(moduleName, false);
      }
    }
    const dynamicPy =
      /__import__\s*\(\s*["']([^"']+)["']/.exec(original) ??
      /import_module\s*\(\s*["']([^"']+)["']/.exec(original);
    if (dynamicPy) push(dynamicPy[1], true);
  }
  return imports;
}

/**
 * Rust import extraction (parser-lite):
 *   - `mod foo;` / `pub mod foo;`          -> `moddecl:foo` (child module file)
 *   - `use crate::a::b;` / `use ::a::b;`   -> crate-root relative
 *   - `use super::a` / `use self::a`       -> module relative
 *   - `use a::b::{c, d};`                  -> expands group items
 *   - `extern crate foo;`                  -> `externcrate:foo` (always external)
 *   - bare `use a::b;`                     -> uniform path: local module first,
 *                                             then an external crate.
 * Multi-line `use x::{...};` groups are accumulated until the closing brace.
 */
export function parseImportsRust(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlockComment = false;
  let group: { base: string; inner: string; line: number; via: string } | null = null;

  const push = (specifier: string, line: number, via: string) => {
    const key = `${specifier}\u0000${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ specifier, line, via, dynamic: false });
  };

  const expandGroup = (base: string, inner: string, line: number, via: string) => {
    const closing = inner.indexOf("}");
    const body = closing >= 0 ? inner.slice(0, closing) : inner;
    for (const raw of body.split(",")) {
      const item = raw
        .replace(/[{}]/g, "")
        .replace(/\s+as\s+[A-Za-z_]\w*$/, "")
        .trim();
      if (!item) continue;
      if (item === "self" || item === "super") push(base, line, via);
      else push(`${base}::${item}`, line, via);
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlockComment) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlockComment = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlockComment = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (group) {
      group.inner += " " + trimmed;
      if (trimmed.includes("}")) {
        expandGroup(group.base, group.inner, group.line, group.via);
        group = null;
      }
      continue;
    }
    const line = i + 1;
    const via = trimmed.slice(0, 160);

    const externCrate = /^\s*(?:pub\s+)?extern\s+crate\s+([A-Za-z_]\w*)/.exec(original);
    if (externCrate) {
      push(`externcrate:${externCrate[1]}`, line, via);
      continue;
    }
    const modDecl = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(original);
    if (modDecl) {
      push(`moddecl:${modDecl[1]}`, line, via);
      continue;
    }
    // `use path::{items` — group may continue on the following lines.
    const useGroup = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;{]+?)\s*\{(.*)$/.exec(original);
    if (useGroup) {
      const base = useGroup[1].trim().replace(/::\s*$/, "");
      const rest = useGroup[2];
      if (!base) continue;
      if (rest.includes("}")) expandGroup(base, rest, line, via);
      else group = { base, inner: rest, line, via };
      continue;
    }
    const useSingle = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;{]+);/.exec(original);
    if (useSingle) {
      const spec = useSingle[1].trim().replace(/\s+as\s+[A-Za-z_]\w*$/, "").trim();
      if (spec) push(spec.startsWith("::") ? `crate::${spec.replace(/^::+/, "")}` : spec, line, via);
      continue;
    }
  }
  if (group) expandGroup(group.base, group.inner, group.line, group.via);
  return imports;
}

/**
 * Go import parsing, parser-lite.
 *   import "fmt"
 *   import alias "path", import . "path", import _ "path"
 *   import (
 *     "fmt"
 *     x "github.com/acme/demo/pkg/tool"
 *     _ "github.com/lib/sideeffect"
 *   )
 * Specifiers are the import paths as written (module-relative for local
 * modules); resolution against go.mod happens in probeGo.
 */
export function parseImportsGo(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlock = false; // inside a /* */ comment
  let inGroup = false; // inside an import (...) block

  const push = (specifier: string, line: number, via: string) => {
    const key = `${specifier}\u0000${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ specifier, line, via, dynamic: false });
  };

  const importPath = /^"([^"]+)"/;

  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlock) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlock = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlock = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    const line = i + 1;
    const via = trimmed.slice(0, 160);

    if (inGroup) {
      if (trimmed.startsWith(")")) {
        inGroup = false;
        continue;
      }
      // Optional alias: name | . | _ before the quoted path.
      const body = trimmed.replace(/^\.|_/, "").replace(/^[A-Za-z_]\w*\s+/, "").replace(/^\s+/, "");
      const m = importPath.exec(body);
      if (m) push(m[1], line, via);
      continue;
    }

    const groupStart = /^\s*import\s*\(\s*(?:\/\/.*)?$/.exec(original);
    if (groupStart) {
      inGroup = true;
      continue;
    }
    const single = /^\s*import\s+(?:\.|_|[A-Za-z_]\w*\s+)?"([^"]+)"/.exec(original);
    if (single) {
      push(single[1], line, via);
      continue;
    }
    // Single-line aliased or parenthesized one-liner: import ( "fmt" )
    const oneLiner = /^\s*import\s*\(\s*(?:\.|_|[A-Za-z_]\w*\s+)?"([^"]+)"\s*\)/.exec(original);
    if (oneLiner) push(oneLiner[1], line, via);
  }
  return imports;
}

/**
 * Java import parsing, parser-lite.
 *   import foo.bar.Baz;
 *   import static foo.bar.Baz;
 *   import foo.bar.*;   -> wildcard recorded with `possible` confidence
 * Package-qualified paths are resolved against classpath roots in probeJava.
 */
export function parseImportsJava(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlock) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlock = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlock = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    const line = i + 1;
    const via = trimmed.slice(0, 160);
    const push = (specifier: string) => {
      const key = `${specifier}\u0000${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({ specifier, line, via, dynamic: false });
    };
    const m = /^\s*import(?:\s+static)?\s+([A-Za-z_][\w.]*)(?:\s*;|\s*$)/.exec(original);
    if (m) push(m[1]);
  }
  return imports;
}

/**
 * Kotlin import parsing, parser-lite.
 *   import foo.bar.Baz
 *   import foo.bar.*
 *   import foo.bar as br
 */
export function parseImportsKotlin(text: string): ImportRef[] {
  const imports: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(text);
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    let trimmed = original.trim();
    if (inBlock) {
      const close = trimmed.indexOf("*/");
      if (close < 0) continue;
      inBlock = false;
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close < 0) {
        inBlock = true;
        continue;
      }
      trimmed = trimmed.slice(close + 2).trim();
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    const line = i + 1;
    const via = trimmed.slice(0, 160);
    const push = (specifier: string) => {
      const key = `${specifier}\u0000${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({ specifier, line, via, dynamic: false });
    };
    const m = /^\s*import\s+([A-Za-z_][\w.]*)\b/.exec(original);
    if (m) push(m[1]);
  }
  return imports;
}
