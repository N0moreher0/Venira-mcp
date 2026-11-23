#!/usr/bin/env node
// Static site build for the venira-mcp GitHub Pages site. No dependencies.
//   node site/build.mjs                 -> site/dist, base /Venira-mcp
//   node site/build.mjs --base=/        -> root-served (local preview)
//   env: SITE_BASE, SITE_ORIGIN
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, parseFrontMatter, renderMarkdown } from "./lib/markdown.mjs";
import {
  blogIndexBody,
  docBody,
  docsIndexBody,
  notFoundBody,
  postBody,
  shell,
  urlFor,
} from "./lib/layout.mjs";
import { homeBody } from "./lib/home.mjs";
import en from "./i18n/en.mjs";
import vi from "./i18n/vi.mjs";

const SITE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SITE, "..");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function normBase(b) {
  const s = (b || "").trim();
  if (!s || s === "/") return "";
  return "/" + s.replace(/^\/+|\/+$/g, "");
}

const base = normBase(arg("base", process.env.SITE_BASE ?? "/Venira-mcp"));
const origin = arg("origin", process.env.SITE_ORIGIN ?? "https://n0moreher0.github.io").replace(/\/+$/, "");
const out = path.resolve(SITE, arg("out", "dist"));
if (!out.startsWith(SITE + path.sep)) throw new Error(`--out must be inside ${SITE}`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const langs = { en, vi };

function rewrite(html) {
  if (!base) return html;
  return html.replace(/(href|src)="(\/[^"]*)"/g, (m, attr, url) =>
    url.startsWith("//") || url === base || url.startsWith(base + "/") ? m : `${attr}="${base}${url}"`,
  );
}

function listMd(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
}

function loadLang(code) {
  const dir = path.join(SITE, "content", code);
  const docs = listMd(path.join(dir, "docs")).map((f) => {
    const { data, body } = parseFrontMatter(fs.readFileSync(path.join(dir, "docs", f), "utf8"));
    if (!data.title) throw new Error(`${code}/docs/${f}: missing title`);
    const r = renderMarkdown(body);
    return {
      slug: f.replace(/\.md$/, ""),
      title: data.title,
      description: data.description || "",
      order: Number(data.order ?? 99),
      html: r.html,
      headings: r.headings,
    };
  });
  docs.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
  const posts = listMd(path.join(dir, "blog")).map((f) => {
    const { data, body } = parseFrontMatter(fs.readFileSync(path.join(dir, "blog", f), "utf8"));
    if (!data.title || !/^\d{4}-\d{2}-\d{2}$/.test(data.date || ""))
      throw new Error(`${code}/blog/${f}: needs title and date (YYYY-MM-DD)`);
    const r = renderMarkdown(body);
    return {
      slug: f.replace(/\.md$/, ""),
      title: data.title,
      date: data.date,
      description: data.description || "",
      html: r.html,
    };
  });
  posts.sort((a, b) => b.date.localeCompare(a.date));
  return { docs, posts };
}

const content = Object.fromEntries(Object.keys(langs).map((c) => [c, loadLang(c)]));

// Which paths exist per language, so the language switch never points at a 404.
const existing = { en: new Set(["/"]), vi: new Set(["/"]) };
for (const code of Object.keys(langs)) {
  existing[code].add("/docs/");
  existing[code].add("/blog/");
  for (const d of content[code].docs) existing[code].add(`/docs/${d.slug}/`);
  for (const p of content[code].posts) existing[code].add(`/blog/${p.slug}/`);
}
for (const code of Object.keys(langs)) {
  const other = code === "en" ? "vi" : "en";
  for (const p of existing[code]) {
    if (!existing[other].has(p)) console.warn(`warn: ${p} exists in ${code} but not in ${other}`);
  }
}

const ctx = {
  base,
  origin,
  version: pkg.version,
  github: pkg.homepage,
  npmUrl: `https://www.npmjs.com/package/${pkg.name}`,
  langs,
  exists: (code, p) => existing[code].has(p),
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const sitemap = [];

function write(rel, html) {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

function page(code, p, opts) {
  const t = langs[code];
  const html = rewrite(shell(ctx, t, { path: p, ...opts }));
  const rel = (code === "en" ? "" : code) + p + "index.html";
  write(rel.replace(/^\//, ""), html);
  sitemap.push({ code, path: p });
}

function feed(code) {
  const t = langs[code];
  const items = content[code].posts
    .map((p) => {
      const link = origin + urlFor(ctx, code, `/blog/${p.slug}/`);
      return `<item><title>${escapeHtml(p.title)}</title><link>${link}</link><guid>${link}</guid><pubDate>${new Date(`${p.date}T00:00:00Z`).toUTCString()}</pubDate><description>${escapeHtml(p.description)}</description></item>`;
    })
    .join("\n");
  const self = origin + urlFor(ctx, code, "/blog/");
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
<title>venira-mcp: ${escapeHtml(t.ui.blogIndexTitle)}</title>
<link>${self}</link>
<description>${escapeHtml(t.ui.blogIndexLead)}</description>
<language>${t.htmlLang}</language>
${items}
</channel></rss>
`;
}

for (const code of Object.keys(langs)) {
  const t = langs[code];
  const { docs, posts } = content[code];
  page(code, "/", { body: homeBody(ctx, t, posts.slice(0, 3)), mainClass: "home" });
  page(code, "/docs/", {
    title: t.ui.docsIndexTitle,
    description: t.ui.docsIndexLead,
    body: docsIndexBody(ctx, t, docs),
  });
  for (const d of docs)
    page(code, `/docs/${d.slug}/`, {
      title: d.title,
      description: d.description,
      body: docBody(ctx, t, docs, d),
    });
  page(code, "/blog/", {
    title: t.ui.blogIndexTitle,
    description: t.ui.blogIndexLead,
    body: blogIndexBody(ctx, t, posts),
  });
  for (const p of posts)
    page(code, `/blog/${p.slug}/`, {
      title: p.title,
      description: p.description,
      body: postBody(ctx, t, p),
      type: "article",
    });
  write((code === "en" ? "" : code + "/") + "feed.xml", feed(code));
}

// 404 (English), served by GitHub Pages for unknown paths.
write(
  "404.html",
  rewrite(shell(ctx, en, { path: "/", title: en.ui.notFoundTitle, body: notFoundBody(ctx, en) })),
);

write(
  "sitemap.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap.map((s) => `<url><loc>${origin}${urlFor(ctx, s.code, s.path)}</loc></url>`).join("\n")}
</urlset>
`,
);
write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${origin}${base}/sitemap.xml\n`);
write(".nojekyll", "");
fs.cpSync(path.join(SITE, "assets"), path.join(out, "assets"), { recursive: true });

console.log(`built ${sitemap.length} pages -> ${path.relative(ROOT, out)} (base "${base || "/"}", v${pkg.version})`);
