import { escapeHtml, renderInline } from "./markdown.mjs";

// ctx = { base, origin, version, github, npmUrl, langs: { en: t, vi: t } }

export function urlFor(ctx, lang, path) {
  const prefix = lang === "en" ? "" : `/${lang}`;
  return `${ctx.base}${prefix}${path}`;
}

export function formatDate(t, iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(t.dateLocale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

const MARK = `<svg class="mark" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false"><rect x="2.5" y="3.5" width="19" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.5 9h6M6.5 13h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="16.5" cy="14.5" r="3.2" fill="none" stroke="var(--blue)" stroke-width="1.8"/><path d="m15 14.6 1.1 1.1 1.9-2.1" fill="none" stroke="var(--blue)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function header(ctx, t, path) {
  const other = Object.values(ctx.langs).find((l) => l.code !== t.code);
  const home = urlFor(ctx, t.code, "/");
  const altPath = ctx.exists(other.code, path) ? path : "/";
  const link = (p, label) => {
    const href = urlFor(ctx, t.code, p);
    const current = path.startsWith(p) ? ' aria-current="page"' : "";
    return `<a href="${href}"${current}>${escapeHtml(label)}</a>`;
  };
  return `<header class="site-header"><div class="wrap bar">
<a class="brand" href="${home}">${MARK}<span>venira-mcp</span></a>
<nav class="main-nav" aria-label="${escapeHtml(t.ui.mainNav)}">
${link("/docs/", t.ui.docs)}
${link("/blog/", t.ui.blog)}
<a href="${ctx.github}">${escapeHtml(t.ui.github)}</a>
<a href="${ctx.npmUrl}">${escapeHtml(t.ui.npm)}</a>
</nav>
<div class="tools"><span class="version" title="npm">v${escapeHtml(ctx.version)}</span>
<a class="lang" href="${urlFor(ctx, other.code, altPath)}" hreflang="${other.htmlLang}" lang="${other.htmlLang}" aria-label="${escapeHtml(t.ui.language)}: ${escapeHtml(other.name)}">${escapeHtml(other.name)}</a></div>
</div></header>`;
}

function footer(ctx, t) {
  return `<footer class="site-footer"><div class="wrap">
<p>${escapeHtml(t.ui.license)}. <a href="${ctx.github}">${escapeHtml(t.ui.source)}</a>. <a href="${urlFor(ctx, t.code, "/feed.xml")}">${escapeHtml(t.ui.rss)}</a>.</p>
</div></footer>`;
}

export function shell(ctx, t, { path, title, description, body, mainClass = "", type = "website" }) {
  const fullTitle = title ? `${title} | venira-mcp` : t.seo.siteTitle;
  const desc = description || t.seo.siteDescription;
  const canonical = ctx.origin + urlFor(ctx, t.code, path);
  const alts = Object.values(ctx.langs)
    .filter((l) => ctx.exists(l.code, path))
    .map(
      (l) =>
        `<link rel="alternate" hreflang="${l.htmlLang}" href="${ctx.origin}${urlFor(ctx, l.code, path)}">`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<link rel="canonical" href="${canonical}">
${alts}
<link rel="alternate" hreflang="x-default" href="${ctx.origin}${urlFor(ctx, "en", path)}">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${escapeHtml(fullTitle)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="venira-mcp">
<meta name="twitter:card" content="summary">
<link rel="icon" type="image/svg+xml" href="${ctx.base}/assets/favicon.svg">
<link rel="alternate" type="application/rss+xml" title="venira-mcp blog" href="${urlFor(ctx, t.code, "/feed.xml")}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;600;800&amp;family=JetBrains+Mono:wght@400;600&amp;display=swap">
<link rel="stylesheet" href="${ctx.base}/assets/style.css?v=${escapeHtml(ctx.version)}">
<script>document.documentElement.classList.add("js")</script>
<script defer src="${ctx.base}/assets/site.js?v=${escapeHtml(ctx.version)}" data-copy="${escapeHtml(t.ui.copy)}" data-copied="${escapeHtml(t.ui.copied)}"></script>
</head>
<body>
<a class="skip" href="#main">${escapeHtml(t.ui.skip)}</a>
${header(ctx, t, path)}
<main id="main" class="${mainClass}">
${body}
</main>
${footer(ctx, t)}
</body>
</html>
`;
}

export function postRows(ctx, t, posts) {
  if (!posts.length) return `<p>${escapeHtml(t.ui.noPosts)}</p>`;
  const rows = posts
    .map(
      (p) => `<li><time datetime="${p.date}">${escapeHtml(formatDate(t, p.date))}</time>
<div><h3><a href="${urlFor(ctx, t.code, `/blog/${p.slug}/`)}">${escapeHtml(p.title)}</a></h3>
<p>${escapeHtml(p.description || "")}</p></div></li>`,
    )
    .join("\n");
  return `<ol class="posts">\n${rows}\n</ol>`;
}

export function blogIndexBody(ctx, t, posts) {
  return `<div class="wrap page-head"><h1>${escapeHtml(t.ui.blogIndexTitle)}</h1><p class="lede">${escapeHtml(t.ui.blogIndexLead)}</p></div>
<div class="wrap">${postRows(ctx, t, posts)}</div>`;
}

export function postBody(ctx, t, post) {
  return `<div class="wrap narrow"><article class="prose post">
<header><p class="meta"><time datetime="${post.date}">${escapeHtml(t.ui.published)} ${escapeHtml(formatDate(t, post.date))}</time></p>
<h1>${escapeHtml(post.title)}</h1>
<p class="lede">${escapeHtml(post.description || "")}</p></header>
${post.html}
</article>
<p class="back"><a href="${urlFor(ctx, t.code, "/blog/")}">${escapeHtml(t.ui.allPosts)}</a></p></div>`;
}

function docsNav(ctx, t, docs, current) {
  const items = docs
    .map((d) => {
      const href = urlFor(ctx, t.code, `/docs/${d.slug}/`);
      const cur = d.slug === current.slug ? ' aria-current="page"' : "";
      return `<li><a href="${href}"${cur}>${escapeHtml(d.title)}</a></li>`;
    })
    .join("");
  const toc = (current.headings || []).filter((h) => h.level === 2);
  const tocHtml =
    toc.length >= 3
      ? `<p class="nav-label">${escapeHtml(t.ui.onThisPage)}</p><ul class="toc">${toc
          .map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
          .join("")}</ul>`
      : "";
  return `<nav class="docs-nav" aria-label="${escapeHtml(t.ui.docsMenu)}"><ul>${items}</ul>${tocHtml}</nav>`;
}

export function docBody(ctx, t, docs, doc) {
  return `<div class="wrap docs-layout">${docsNav(ctx, t, docs, doc)}<article class="prose">
<h1>${escapeHtml(doc.title)}</h1>
${doc.description ? `<p class="lede">${escapeHtml(doc.description)}</p>` : ""}
${doc.html}
</article></div>`;
}

export function docsIndexBody(ctx, t, docs) {
  const rows = docs
    .map(
      (d) => `<li><h3><a href="${urlFor(ctx, t.code, `/docs/${d.slug}/`)}">${escapeHtml(d.title)}</a></h3><p>${escapeHtml(d.description || "")}</p></li>`,
    )
    .join("\n");
  return `<div class="wrap page-head"><h1>${escapeHtml(t.ui.docsIndexTitle)}</h1><p class="lede">${escapeHtml(t.ui.docsIndexLead)}</p></div>
<div class="wrap"><ol class="posts docs-list">\n${rows}\n</ol></div>`;
}

export function notFoundBody(ctx, t) {
  return `<div class="wrap page-head"><h1>${escapeHtml(t.ui.notFoundTitle)}</h1><p class="lede">${escapeHtml(t.ui.notFoundText)}</p>
<p><a href="${urlFor(ctx, t.code, "/")}">${escapeHtml(t.ui.backHome)}</a></p></div>`;
}

export { renderInline };
