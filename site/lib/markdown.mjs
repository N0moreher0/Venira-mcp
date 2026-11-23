// Minimal Markdown to HTML for the site's own content. Supports the subset the
// docs and blog use: front matter, headings, paragraphs, fenced code, tables,
// blockquotes, nested lists, rules and inline code/bold/italic/links.
// It escapes all text; raw HTML in content files is not passed through.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function slugify(text) {
  const s = String(text)
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "section";
}

export function parseFrontMatter(src) {
  const text = src.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { data, body: text.slice(m[0].length) };
}

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, label, href) => `<a href="${href}">${label}</a>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

export function renderInline(text) {
  return inline(text);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function parseList(lines, start) {
  const base = /^(\s*)/.exec(lines[start])[1].length;
  const ordered = /^\s*\d+\.\s/.test(lines[start]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    const mm = LIST_ITEM.exec(l);
    if (!mm) {
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nm = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
        if (nm && nm[1].length >= base) {
          i = j;
          continue;
        }
        break;
      }
      if (/^\s{2,}\S/.test(l) && items.length) {
        items[items.length - 1].text += " " + l.trim();
        i++;
        continue;
      }
      break;
    }
    const indent = mm[1].length;
    if (indent < base) break;
    if (indent > base && items.length) {
      const nested = parseList(lines, i);
      items[items.length - 1].nested += nested.html;
      i = nested.next;
      continue;
    }
    items.push({ text: mm[3], nested: "" });
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  const html =
    `<${tag}>` + items.map((it) => `<li>${inline(it.text)}${it.nested}</li>`).join("") + `</${tag}>`;
  return { html, next: i };
}

function startsBlock(line, next) {
  return (
    /^```/.test(line) ||
    /^#{1,4}\s/.test(line) ||
    /^>\s?/.test(line) ||
    LIST_ITEM.test(line) ||
    /^(-{3,}|\*{3,})\s*$/.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next))
  );
}

export function renderMarkdown(src) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const headings = [];
  const usedIds = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m = /^```([\w-]*)\s*$/.exec(line);
    if (m) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const lang = m[1];
      const cls = lang ? ` class="language-${lang}" data-lang="${lang}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    m = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      const level = m[1].length;
      const plain = m[2].replace(/`/g, "");
      let id = slugify(plain);
      const seen = usedIds.get(id) || 0;
      usedIds.set(id, seen + 1);
      if (seen) id += `-${seen + 1}`;
      if (level >= 2 && level <= 3) headings.push({ level, id, text: plain });
      out.push(
        `<h${level} id="${id}">${inline(m[2])}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`,
      );
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const th = head.map((c) => `<th scope="col">${inline(c)}</th>`).join("");
      const tr = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("");
      out.push(
        `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n")).html}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }
    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      buf.push(lines[i++].trim());
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return { html: out.join("\n"), headings };
}
