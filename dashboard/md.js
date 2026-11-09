// Chat markdown. GitHub-flavoured markdown (marked) -> sanitised HTML (DOMPurify), with code highlighted
// by highlight.js. Everything under ./vendor/ is an unmodified upstream build; versions and licences are in
// vendor/VERSIONS.txt and vendor/LICENSES.txt.
//
// render(text) returns an HTML string that is safe to assign to innerHTML:
//  - the model's raw HTML is limited to a short tag allowlist, with no style, id, name, on* or other attributes
//  - links: only http(s) and mailto keep an href (they open in a new tab); any other link becomes its text
//  - images: only https: and inline base64 raster data: URIs render (as img.md-img); anything else becomes its alt text
//  - tables are wrapped in div.table-wrap; a column whose body cells are all numeric, currency or percent is right-aligned
//  - fenced code is pre > code.hljs.language-<name>; call enhance(container) after inserting the HTML to add the
//    language label and the Copy button
// render() never throws: on any internal failure it returns the escaped text as one paragraph.

import { Marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";
import hljs from "./vendor/highlight/core.min.js";
import bashLang from "./vendor/highlight/languages/bash.min.js";
import shellLang from "./vendor/highlight/languages/shell.min.js";
import pythonLang from "./vendor/highlight/languages/python.min.js";
import javascriptLang from "./vendor/highlight/languages/javascript.min.js";
import typescriptLang from "./vendor/highlight/languages/typescript.min.js";
import jsonLang from "./vendor/highlight/languages/json.min.js";
import yamlLang from "./vendor/highlight/languages/yaml.min.js";
import sqlLang from "./vendor/highlight/languages/sql.min.js";
import xmlLang from "./vendor/highlight/languages/xml.min.js";
import cssLang from "./vendor/highlight/languages/css.min.js";
import diffLang from "./vendor/highlight/languages/diff.min.js";
import markdownLang from "./vendor/highlight/languages/markdown.min.js";
import goLang from "./vendor/highlight/languages/go.min.js";
import rustLang from "./vendor/highlight/languages/rust.min.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

// ---------- syntax highlighting ----------

const LANGUAGES = {
  bash: bashLang,
  shell: shellLang,
  python: pythonLang,
  javascript: javascriptLang,
  typescript: typescriptLang,
  json: jsonLang,
  yaml: yamlLang,
  sql: sqlLang,
  xml: xmlLang,
  css: cssLang,
  diff: diffLang,
  markdown: markdownLang,
  go: goLang,
  rust: rustLang,
};
for (const [name, grammar] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, grammar);

// The first word of a fence info string, lower-cased and reduced to safe characters ("```Python title=x" -> "python").
function languageName(info) {
  const word = String(info || "").trim().split(/\s+/)[0] || "";
  return word.toLowerCase().replace(/[^a-z0-9+#.-]/g, "");
}

function highlightCode(text, name) {
  if (!name || !hljs.getLanguage(name)) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

// ---------- numeric table columns ----------

// Markup characters that can surround a value in a cell (**$1,234**, `12`).
const MARKUP = /[*_`~]/g;
// Cells that stand for "no value" do not decide whether a column is numeric.
const PLACEHOLDER = /^(?:[-–—]|n\/?a)$/i;
const SIGN = /^[+\-−–±]/;
const CURRENCY = /^[$€£¥₱₩₹]/;

// "$1,234.56", "−$266.45", "+23.03%", "1.428", "16", "(12.50)", "2.1M": one number with optional sign, currency, % or K/M/B.
function isAmount(text) {
  let s = text.replace(/\s+/g, "");
  if (/^\(.*\)$/.test(s)) s = s.slice(1, -1);
  s = s.replace(SIGN, "").replace(CURRENCY, "").replace(SIGN, "");
  s = s.replace(/%$/, "").replace(/[KMBkmb]$/, "");
  return /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s);
}

// A cell is numeric when it is one amount, or "amount (percent)" as in "$0.85 (0.01%)".
function isNumericCell(raw) {
  const text = raw.replace(MARKUP, "").replace(/ /g, " ").trim();
  const pair = text.match(/^(.+?)\s*\((.+)\)$/);
  if (pair) return isAmount(pair[1]) && isAmount(pair[2]);
  return isAmount(text);
}

function isNumericColumn(rows, index) {
  let values = 0;
  for (const row of rows) {
    const cell = row[index];
    if (!cell) continue;
    const plain = cell.text.replace(MARKUP, "").trim();
    if (!plain || PLACEHOLDER.test(plain)) continue;
    if (!isNumericCell(cell.text)) return false;
    values += 1;
  }
  return values > 0;
}

// ---------- marked: GFM with our renderers ----------

const marked = new Marked({
  gfm: true,
  breaks: true, // chat style: a single newline is a line break
  async: false,
  renderer: {
    code({ text, lang }) {
      const name = languageName(lang);
      const body = highlightCode(text.replace(/\n$/, ""), name);
      return `<pre><code class="hljs${name ? ` language-${name}` : ""}">${body}</code></pre>\n`;
    },
    table(token) {
      const parser = this.parser;
      const align = token.header.map((_, i) => token.align[i] || (isNumericColumn(token.rows, i) ? "right" : null));
      const cell = (c, i, header) => {
        const tag = header ? "th" : "td";
        const a = align[i];
        return `<${tag}${a ? ` align="${a}"` : ""}>${parser.parseInline(c.tokens)}</${tag}>`;
      };
      const head = `<tr>${token.header.map((c, i) => cell(c, i, true)).join("")}</tr>`;
      const body = token.rows.map((row) => `<tr>${row.map((c, i) => cell(c, i, false)).join("")}</tr>`).join("");
      return `<div class="table-wrap"><table><thead>${head}</thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>\n`;
    },
  },
});

// Strikethrough is double tilde only (~~gone~~). marked's GFM rule also takes a single pair (~12% ... ~24%) and
// crosses out everything between them, which prose's "approximately" tildes trigger. This override accepts the
// double form and nothing else; a lone "~" stays literal text. Code spans and fenced code never reach the inline rules.
const DOUBLE_TILDE_DEL = /^(~~)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
marked.use({
  tokenizer: {
    del(src) {
      const match = DOUBLE_TILDE_DEL.exec(src);
      if (!match) return undefined;
      return { type: "del", raw: match[0], text: match[2], tokens: this.lexer.inlineTokens(match[2]) };
    },
  },
});

// ---------- DOMPurify: the model's HTML is untrusted ----------

const SANITIZE = {
  RETURN_DOM: true,
  ALLOW_DATA_ATTR: false,
  ALLOWED_TAGS: [
    "a", "abbr", "b", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "i", "img", "input", "ins", "kbd", "li", "mark", "ol", "p", "pre", "s", "small", "span", "strong",
    "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
  ],
  ALLOWED_ATTR: ["href", "src", "alt", "title", "align", "start", "type", "checked", "disabled", "class", "colspan", "rowspan"],
};

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;
const SAFE_SRC = /^(?:https:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,)/i;
// Spans carry highlight.js token classes (hljs-keyword, function_); other elements keep only the classes listed here.
const SPAN_CLASS = /^(?:hljs-[\w-]+|[a-z]+_+)$/;
const ELEMENT_CLASS = new Set(["hljs", "table-wrap", "contains-task-list", "task-list-item"]);

function keepClasses(node) {
  const kept = (node.getAttribute("class") || "")
    .split(/\s+/)
    .filter((name) => {
      if (!name) return false;
      if (node.localName === "span") return SPAN_CLASS.test(name);
      return ELEMENT_CLASS.has(name) || /^language-[a-z0-9+#.-]+$/.test(name);
    });
  if (kept.length) node.setAttribute("class", kept.join(" "));
  else node.removeAttribute("class");
}

// URL policy and link/image/checkbox shaping on the sanitised tree. Returns the HTML string.
function harden(body) {
  for (const node of [...body.querySelectorAll("*")]) {
    keepClasses(node);
    const tag = node.localName;
    if (tag === "a") {
      const href = (node.getAttribute("href") || "").trim();
      if (SAFE_HREF.test(href)) {
        node.setAttribute("href", href);
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      } else {
        node.replaceWith(...node.childNodes);
      }
    } else if (tag === "img") {
      const src = (node.getAttribute("src") || "").trim();
      if (SAFE_SRC.test(src)) {
        node.setAttribute("src", src);
        node.setAttribute("alt", node.getAttribute("alt") || "");
        node.setAttribute("loading", "lazy");
        node.setAttribute("referrerpolicy", "no-referrer");
        node.classList.add("md-img");
      } else {
        node.replaceWith(document.createTextNode(node.getAttribute("alt") || ""));
      }
    } else if (tag === "input") {
      // Only the disabled checkboxes that task lists produce; any other input is dropped.
      if ((node.getAttribute("type") || "").toLowerCase() === "checkbox") {
        node.setAttribute("type", "checkbox");
        node.setAttribute("disabled", "");
      } else {
        node.remove();
      }
    }
  }
  return body.innerHTML;
}

// ---------- public API ----------

export function render(source) {
  const text = String(source ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
  try {
    const dirty = marked.parse(text);
    return harden(DOMPurify.sanitize(dirty, SANITIZE));
  } catch {
    return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  }
}

// Adds the language label and a Copy button to every code block under `root`. Idempotent. Call after innerHTML.
export function enhance(root) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.parentElement && pre.parentElement.classList.contains("code-block")) continue;
    const code = pre.querySelector("code");
    const lang = [...(code ? code.classList : [])].find((name) => name.startsWith("language-"));

    const wrap = document.createElement("div");
    wrap.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    const label = document.createElement("span");
    label.className = "code-lang";
    label.textContent = lang ? lang.slice("language-".length) : "";
    const button = makeCopyButton("code-copy", () => copyText(pre.textContent));
    head.append(label, button);
    pre.before(wrap);
    wrap.append(head, pre);
  }
}

import { showToast } from "./toast.js";

// Clipboard write with a fallback for browsers or contexts without navigator.clipboard. Resolves to true on success.
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      showToast("Copied");
      return true;
    }
  } catch {
    /* fall through to the selection-based copy */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;height:1px;width:1px";
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    area.remove();
    if (ok) showToast("Copied");
    return ok;
  } catch {
    return false;
  }
}

// Icon-only copy button shared by the code-block header and the reply action row. `copy()` resolves to true on
// success; the icon then swaps to a checkmark (or a cross on failure) for 1.5 s before returning to the copy icon.
const SVG_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
export const COPY_ICON = `${SVG_OPEN}<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const DONE_ICON = `${SVG_OPEN}<polyline points="20 6 9 17 4 12"/></svg>`;
const FAIL_ICON = `${SVG_OPEN}<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

export function makeCopyButton(className, copy) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = "Copy";
  button.setAttribute("aria-label", "Copy");
  button.innerHTML = COPY_ICON;
  button.addEventListener("click", async () => {
    const ok = await copy();
    button.innerHTML = ok ? DONE_ICON : FAIL_ICON;
    setTimeout(() => {
      button.innerHTML = COPY_ICON;
    }, 1500);
  });
  return button;
}

export default render;
