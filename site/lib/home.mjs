import { escapeHtml, renderInline } from "./markdown.mjs";
import { postRows, urlFor } from "./layout.mjs";

const INSTALL = "npx --yes venira-mcp@latest --install auto --workspace .";

const TABS = [
  {
    id: "opencode",
    label: "OpenCode",
    file: "~/.config/opencode/opencode.jsonc",
    lang: "jsonc",
    code: `{
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["npx", "--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "enabled": true,
      "environment": {
        "VENIRA_WORKSPACE": "/absolute/path/to/project",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}`,
  },
  {
    id: "vscode",
    label: "VS Code",
    file: "<workspace>/.vscode/mcp.json",
    lang: "json",
    code: `{
  "servers": {
    "venira": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "\${workspaceFolder}",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}`,
  },
  {
    id: "claude",
    label: "Claude Desktop / Cursor",
    file: "claude_desktop_config.json, ~/.cursor/mcp.json",
    lang: "json",
    code: `{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "/absolute/path/to/project",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}`,
  },
  {
    id: "codex",
    label: "Codex",
    file: "~/.codex/config.toml",
    lang: "toml",
    code: `[m[m[ mcp_servers.venira ]
command = "npx"
args = ["--yes", "--package=venira-mcp@latest", "venira-mcp"]

[m[m[ mcp_servers.venira.env ]
VENIRA_WORKSPACE = "C:\\\\path\\\\to\\\\project"
VENIRA_TOOL_MODE = "expert"`,
  },
];

function dataTable(cols, rows, { caption, numeric = [] } = {}) {
  const head = cols.map((c) => `<th scope="col">${renderInline(c)}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map((c, i) => `<td${numeric.includes(i) ? ' class="num"' : ""}>${renderInline(c)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  const cap = caption ? `<caption class="sr-only">${escapeHtml(caption)}</caption>` : "";
  return `<div class="table-wrap"><table>${cap}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function ledger(h) {
  const rows = h.ledgerRows
    .map(
      (r, i) => `<tr style="--i:${i}"><td class="n">${i + 1}</td><td class="tool"><code>${escapeHtml(r.tool)}</code></td><td>${renderInline(r.text)}</td><td class="verdict"><span class="stamp stamp-${r.verdict}">${escapeHtml(h.verdicts[r.verdict])}</span></td></tr>`,
    )
    .join("\n");
  const c = h.ledgerCols;
  return `<figure class="ledger">
<figcaption>${escapeHtml(h.ledgerCaption)}</figcaption>
<div class="table-wrap"><table>
<thead><tr><th scope="col" class="n">${escapeHtml(c.n)}</th><th scope="col">${escapeHtml(c.tool)}</th><th scope="col">${escapeHtml(c.detail)}</th><th scope="col">${escapeHtml(c.verdict)}</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<p class="ledger-note">${renderInline(h.ledgerNote)}</p>
</figure>`;
}

function tabs(t) {
  const list = TABS.map(
    (tab, i) =>
      `<button type="button" role="tab" id="tab-${tab.id}" aria-controls="panel-${tab.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${escapeHtml(tab.label)}</button>`,
  ).join("");
  const panels = TABS.map(
    (tab, i) => `<div role="tabpanel" id="panel-${tab.id}" aria-labelledby="tab-${tab.id}"${i === 0 ? "" : " hidden"}>
<h3 class="tab-title">${escapeHtml(tab.label)}</h3>
<p class="file"><code>${escapeHtml(tab.file)}</code></p>
<pre><code class="language-${tab.lang}" data-lang="${tab.lang}">${escapeHtml(tab.code)}</code></pre>
</div>`,
  ).join("\n");
  return `<div class="tabs" data-tabs><div class="tablist" role="tablist" aria-label="${escapeHtml(t.home.setupTitle)}">${list}</div>
${panels}</div>`;
}

export function homeBody(ctx, t, latestPosts) {
  const h = t.home;
  const facts = h.trustItems
    .map((f) => `<section><h3>${escapeHtml(f.title)}</h3><p>${renderInline(f.text)}</p></section>`)
    .join("\n");
  return `<div class="hero"><div class="wrap hero-grid">
<div class="hero-copy">
<h1>${escapeHtml(h.heroTitle)}</h1>
<p class="lede">${escapeHtml(h.heroLead)}</p>
<p class="install-label" id="install-label">${escapeHtml(h.installLabel)}</p>
<div class="install"><code aria-labelledby="install-label">${escapeHtml(INSTALL)}</code><button type="button" class="copy" data-copy-text="${escapeHtml(INSTALL)}">${escapeHtml(t.ui.copy)}</button></div>
<p class="small">${escapeHtml(h.worksWith)}</p>
</div>
${ledger(h)}
</div></div>

<section class="band"><div class="wrap">
<h2>${escapeHtml(h.trustTitle)}</h2>
<p class="lede">${escapeHtml(h.trustLead)}</p>
<div class="facts">
${facts}
</div>
</div></section>

<section class="band"><div class="wrap">
<aside class="limits"><h2>${escapeHtml(h.limitsTitle)}</h2><p>${renderInline(h.limitsText)}</p></aside>
</div></section>

<section class="band"><div class="wrap">
<h2>${escapeHtml(h.modesTitle)}</h2>
<p class="lede">${renderInline(h.modesLead)}</p>
${dataTable(h.modesCols, h.modesRows, { numeric: [1] })}
<p class="small">${renderInline(h.modesNote)}</p>
</div></section>

<section class="band"><div class="wrap">
<h2>${escapeHtml(h.speedTitle)}</h2>
<p class="lede">${renderInline(h.speedLead)}</p>
${dataTable(h.speedCols, h.speedRows, { numeric: [2, 3, 4] })}
<p class="small">${renderInline(h.speedNote)}</p>
</div></section>

<section class="band"><div class="wrap">
<h2>${escapeHtml(h.setupTitle)}</h2>
<p class="lede">${renderInline(h.setupLead)}</p>
${tabs(t)}
<p class="small">${renderInline(h.setupNote)}</p>
</div></section>

<section class="band"><div class="wrap">
<h2>${escapeHtml(t.ui.latestPosts)}</h2>
${postRows(ctx, t, latestPosts)}
<p class="small"><a href="${urlFor(ctx, t.code, "/blog/")}">${escapeHtml(t.ui.allPosts)}</a></p>
</div></section>`;
}
