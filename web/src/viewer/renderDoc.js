// Document renderer for the file viewer: markdown (GFM + highlighted code +
// mermaid placeholders) and plain text/code views with per-line elements.
// Loaded with a dynamic import() so none of this weighs on the board bundle;
// mermaid is a further lazy chunk loaded only by renderMermaid().
import { Lexer, Parser, Renderer, getDefaults } from 'marked';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import rust from 'highlight.js/lib/languages/rust';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import sql from 'highlight.js/lib/languages/sql';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';

const LANGUAGES = { rust, javascript, typescript, json, yaml, ini, bash, powershell, sql, python, css, xml, markdown, diff };
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);
// `toml` is covered by the ini grammar, which does not declare the alias itself.
hljs.registerAliases(['toml'], { languageName: 'ini' });

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Links that leave the viewer: opened in a new tab. */
const EXTERNAL = /^(https?:|mailto:)/i;
/** Image sources used as-is, without resolveLink. */
const ABSOLUTE_IMAGE = /^(https?:|data:)/i;
/** Image sources a raw-HTML <img> may keep. */
const SAFE_IMAGE = /^(https?:|data:|\/api\/files\/content(?:[?#]|$))/i;
/** Heading ids are namespaced so they cannot collide with the board's own ids
 *  or with document properties that DOMPurify's SANITIZE_DOM strips. Any other
 *  id is dropped, so a document cannot hijack getElementById on the board. */
const ID_PREFIX = 'doc-';
/** The only classes that survive sanitization: the ones this module and
 *  highlight.js generate (hljs scopes, including sub-scopes like `function_`). */
const GENERATED_CLASS = /^(?:hljs(?:-[\w-]+)?|[a-z]+_+|language-[\w-]+|code-view|digits-\d|code-line|mermaid-src|link-unresolved|table-wrap|line-mark)$/;
/** A leading YAML front-matter block. */
const FRONT_MATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/;

const FORBID_TAGS = [
  'style', 'script', 'iframe', 'form',
  // image maps navigate the tab; media elements load URLs outside the image allowlist
  'area', 'map', 'video', 'audio', 'source', 'track', 'picture',
];
const FORBID_ATTR = [
  'style', 'name',
  // URL-loading attributes that bypass the <img src> allowlist
  'srcset', 'poster', 'background', 'usemap', 'ping', 'formaction', 'action',
  // attributes that let markup drive board UI
  'popover', 'popovertarget', 'popovertargetaction', 'commandfor', 'command',
];

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const normalizeNewlines = (s) => String(s ?? '').replace(/\r\n|\r/g, '\n');

const countNewlines = (s) => (s.match(/\n/g) ?? []).length;

const fenceName = (lang) => String(lang ?? '').trim().split(/\s+/)[0].toLowerCase();

const lineMark = (line) => `<i class="line-mark" data-line="${line}" aria-hidden="true"></i>`;

function highlight(code, lang) {
  const name = fenceName(lang);
  if (!name || !hljs.getLanguage(name)) return { html: escapeHtml(code), language: null };
  return { html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value, language: name };
}

/** The one place hrefs are decoded before they reach resolveLink. */
function safeDecode(href) {
  try { return decodeURI(href); } catch { return href; }
}

/** Plain text of an inline HTML fragment (DOMParser documents are inert). */
function textOf(html) {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent ?? '';
}

function slugify(text) {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
  return slug || 'section';
}

/**
 * Splits highlight.js output into lines, closing the spans still open at each
 * line break and reopening them on the next line, so every line is valid HTML
 * on its own even inside multi-line comments or strings.
 */
function splitHighlightedLines(html) {
  const lines = [];
  const open = [];
  let current = '';
  let last = 0;
  const re = /<span\b[^>]*>|<\/span>|\n/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    current += html.slice(last, m.index);
    last = re.lastIndex;
    if (m[0] === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else if (m[0] === '</span>') {
      open.pop();
      current += m[0];
    } else {
      open.push(m[0]);
      current += m[0];
    }
  }
  current += html.slice(last);
  lines.push(current + '</span>'.repeat(open.length));
  return lines;
}

/** One DOMPurify instance per render, so hooks see only that render's state. */
function sanitize(html, { nonce = null, imageSrcs = new Set() } = {}) {
  const purify = createDOMPurify(window);
  // Placeholders emitted by this render carry its nonce; attributes the
  // document author wrote cannot guess it.
  const generated = (prefix) => (nonce ? new RegExp(`^${prefix}-${nonce}-\\d+$`) : null);
  const generatedOpenPath = generated('open');
  const generatedCode = generated('mermaid');

  // Raw <img> in the markdown bypasses resolveLink: keep it only when its
  // source is one the viewer can serve safely; otherwise leave the alt text.
  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'img' || !node.parentNode) return;
    const src = node.getAttribute('src') ?? '';
    if (!imageSrcs.has(src) && !SAFE_IMAGE.test(src)) {
      node.parentNode.replaceChild(node.ownerDocument.createTextNode(node.getAttribute('alt') ?? ''), node);
    }
  });

  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const value = data.attrValue ?? '';
    switch (data.attrName) {
      case 'id':
        if (!value.startsWith(ID_PREFIX)) data.keepAttr = false;
        break;
      case 'class': {
        const kept = value.split(/\s+/).filter((c) => GENERATED_CLASS.test(c));
        if (kept.length) data.attrValue = kept.join(' ');
        else data.keepAttr = false;
        break;
      }
      case 'data-open-path':
        if (!generatedOpenPath?.test(value)) data.keepAttr = false;
        break;
      case 'data-code':
        if (!generatedCode?.test(value)) data.keepAttr = false;
        break;
      default:
        break;
    }
  });

  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeType !== 1) return;
    if (node.nodeName !== 'IMG') node.removeAttribute('src');

    // Only HTML <a> may link. SVG <a>, SVG <image> and the like lose every
    // link attribute; the checks above still ran for them.
    const htmlLink = node.localName === 'a' && node.namespaceURI === XHTML_NS;
    node.removeAttribute('target');
    if (!htmlLink) {
      node.removeAttribute('href');
      node.removeAttribute('xlink:href');
      node.removeAttributeNS(XLINK_NS, 'href');
      return;
    }

    node.removeAttribute('rel');
    if (node.hasAttribute('data-open-path')) {
      node.setAttribute('href', '#');
      return;
    }
    const href = node.getAttribute('href');
    if (href === null) return;
    if (EXTERNAL.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else if (href.length > 1 && href.startsWith('#')) {
      node.setAttribute('href', `#${ID_PREFIX}${href.slice(1)}`);
    } else {
      // A bare `#`, or a link that did not go through resolveLink (relative,
      // protocol-relative, data:), would do nothing or navigate the board away.
      node.removeAttribute('href');
    }
  });

  return purify.sanitize(html, {
    ADD_ATTR: ['target', 'data-line', 'data-code', 'data-open-path'],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS,
    FORBID_ATTR,
  });
}

class DocRenderer extends Renderer {
  constructor(options, state) {
    super(options);
    this.state = state;
  }

  heading({ tokens, depth }) {
    const inner = this.parser.parseInline(tokens);
    const text = textOf(inner).trim();
    const { usedIds, toc } = this.state;
    const base = `${ID_PREFIX}${slugify(text)}`;
    let id = base;
    for (let n = 1; usedIds.has(id); n += 1) id = `${base}-${n}`;
    usedIds.add(id);
    if (depth <= 4) toc.push({ id, level: depth, text });
    return `<h${depth} id="${escapeHtml(id)}">${inner}</h${depth}>\n`;
  }

  code({ text, lang }) {
    const name = fenceName(lang);
    if (name === 'mermaid') {
      // DOMPurify's SAFE_FOR_XML check drops any attribute value containing
      // `-->`, which every flowchart has; sanitize a placeholder and put the
      // escaped source back afterwards (see restorePlaceholders).
      this.state.hasMermaid = true;
      const key = `mermaid-${this.state.nonce}-${this.state.mermaid.length}`;
      this.state.mermaid.push(text);
      return `<div class="mermaid-src" data-code="${key}"></div>\n`;
    }
    const { html, language } = highlight(text.replace(/\n$/, ''), name);
    const cls = language ? `hljs language-${language}` : 'hljs';
    return `<pre><code class="${cls}">${html}</code></pre>\n`;
  }

  table(token) {
    return `<div class="table-wrap">${super.table(token)}</div>\n`;
  }

  // `target`/`rel` on external links, the `#doc-` anchor prefix and dropping
  // unusable hrefs happen in the sanitize hook, so raw-HTML links get exactly
  // the same treatment.
  link({ href, title, tokens }) {
    const inner = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    if (EXTERNAL.test(href) || href.startsWith('#')) {
      return `<a href="${escapeHtml(href)}"${titleAttr}>${inner}</a>`;
    }
    const resolved = this.state.resolveLink?.(safeDecode(href), { image: false }) ?? null;
    if (resolved?.openPath) {
      // DOMPurify runs its URI check on data-open-path and drops values such
      // as `C:\...` (read as a `c:` protocol); sanitize a placeholder and put
      // the escaped path back afterwards (see restorePlaceholders).
      const key = `open-${this.state.nonce}-${this.state.openPaths.length}`;
      this.state.openPaths.push(String(resolved.openPath));
      return `<a href="#" data-open-path="${key}"${titleAttr}>${inner}</a>`;
    }
    if (resolved?.href && EXTERNAL.test(resolved.href)) {
      return `<a href="${escapeHtml(resolved.href)}"${titleAttr}>${inner}</a>`;
    }
    return `<span class="link-unresolved">${inner}</span>`;
  }

  image({ href, title, text }) {
    let src = null;
    if (ABSOLUTE_IMAGE.test(href)) {
      src = href;
    } else {
      src = this.state.resolveLink?.(safeDecode(href), { image: true })?.href ?? null;
    }
    if (!src) return escapeHtml(text);
    this.state.imageSrcs.add(src);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${titleAttr}>`;
  }
}

function renderMarkdown(text, resolveLink) {
  const source = normalizeNewlines(text);
  const state = {
    resolveLink,
    toc: [],
    usedIds: new Set(),
    openPaths: [],
    imageSrcs: new Set(),
    hasMermaid: false,
    mermaid: [],
    nonce: Math.random().toString(36).slice(2, 10),
  };

  let line = 1;
  let out = '';
  let body = source;

  // Front matter shows as a YAML block at line 1, never as an <hr> or a heading.
  const frontMatter = FRONT_MATTER.exec(source);
  if (frontMatter) {
    const { html } = highlight(frontMatter[1] ?? '', 'yaml');
    out += `${lineMark(1)}<pre><code class="hljs language-yaml">${html}</code></pre>\n`;
    line += countNewlines(frontMatter[0]);
    body = source.slice(frontMatter[0].length);
  }

  const tokens = new Lexer({ ...getDefaults(), gfm: true }).lex(body);
  const parserOptions = { ...getDefaults(), gfm: true };
  parserOptions.renderer = new DocRenderer(parserOptions, state);
  const parser = new Parser(parserOptions);

  // Each top-level block is parsed on its own and preceded by an empty marker
  // carrying the source line it starts on (a wrapper would break raw HTML that
  // spans several blocks, like <details>). `links` travels along for
  // reference-style links.
  for (const token of tokens) {
    const start = line;
    line += countNewlines(token.raw);
    if (token.type === 'space') continue;
    const piece = parser.parse(Object.assign([token], { links: tokens.links }));
    if (!piece.trim()) continue;
    out += `${lineMark(start)}${piece}`;
  }

  const html = restorePlaceholders(sanitize(out, state), state);
  return { html, toc: state.toc, hasMermaid: state.hasMermaid };
}

/** Writes the escaped mermaid sources and open paths over their sanitized placeholders. */
function restorePlaceholders(html, { nonce, mermaid, openPaths }) {
  const restore = (attr, prefix, values) => {
    if (!values.length) return;
    const placeholder = new RegExp(`${attr}="${prefix}-${nonce}-(\\d+)"`, 'g');
    html = html.replace(placeholder, (_, i) => `${attr}="${escapeHtml(values[Number(i)] ?? '')}"`);
  };
  restore('data-code', 'mermaid', mermaid);
  restore('data-open-path', 'open', openPaths);
  return html;
}

function renderText(text, lang) {
  const source = normalizeNewlines(text);
  const { html, language } = highlight(source, lang);
  const lines = splitHighlightedLines(html);
  if (source.endsWith('\n') && lines.length > 1) lines.pop();
  const digits = Math.min(Math.max(String(lines.length).length, 2), 6);
  const body = lines
    .map((l, i) => `<span class="code-line" data-line="${i + 1}">${l}\n</span>`)
    .join('');
  const cls = language ? `hljs language-${language}` : 'hljs';
  return {
    html: sanitize(`<pre class="code-view digits-${digits}"><code class="${cls}">${body}</code></pre>`),
    toc: [],
    hasMermaid: false,
  };
}

/**
 * @param {string} text
 * @param {{ kind: 'md'|'text', lang?: string|null, resolveLink: (href: string, opts: { image: boolean }) => { href?: string, openPath?: string } | null }} options
 * @returns {Promise<{ html: string, toc: Array<{ id: string, level: number, text: string }>, hasMermaid: boolean }>}
 */
export async function renderDoc(text, options = {}) {
  const { kind = 'md', lang = null, resolveLink = () => null } = options;
  return kind === 'md' ? renderMarkdown(text, resolveLink) : renderText(text, lang);
}

let mermaidModule = null;
let mermaidTheme = null;
let mermaidQueue = Promise.resolve();
let mermaidSeq = 0;

function loadMermaid() {
  mermaidModule ??= import('mermaid').then((m) => m.default).catch((err) => {
    mermaidModule = null;
    throw err;
  });
  return mermaidModule;
}

/**
 * Mermaid's strict mode still emits links (`click A href "…" _self`) and label
 * images. Links may only open http(s)/mailto in a new tab; images may only
 * load http(s)/data URLs.
 */
function tameDiagram(el) {
  for (const a of el.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? a.getAttributeNS(XLINK_NS, 'href');
    a.removeAttribute('href');
    a.removeAttribute('xlink:href');
    a.removeAttributeNS(XLINK_NS, 'href');
    a.removeAttribute('target');
    const url = href?.trim();
    if (url && EXTERNAL.test(url)) {
      a.setAttribute('href', url);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
  for (const img of el.querySelectorAll('img')) {
    if (!ABSOLUTE_IMAGE.test(img.getAttribute('src') ?? '')) img.remove();
  }
  for (const image of el.querySelectorAll('image')) {
    const href = image.getAttribute('href') ?? image.getAttributeNS(XLINK_NS, 'href') ?? '';
    if (!ABSOLUTE_IMAGE.test(href)) image.remove();
  }
}

async function drawAll(root, dark) {
  const nodes = [...root.querySelectorAll('.mermaid-src:not(.is-rendered)')];
  if (!nodes.length) return;
  const mermaid = await loadMermaid();
  const theme = dark ? 'dark' : 'default';
  if (theme !== mermaidTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, suppressErrorRendering: true });
    mermaidTheme = theme;
  }
  for (const el of nodes) {
    if (!el.isConnected) continue;
    const code = el.getAttribute('data-code') ?? '';
    const id = `hfsmon-mermaid-${++mermaidSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      el.innerHTML = svg; // mermaid's strict mode sanitizes its own output...
      tameDiagram(el); // ...but still leaves links and label images
    } catch (err) {
      // A failed render can leave its scratch container behind in <body>.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      const pre = document.createElement('pre');
      pre.className = 'mermaid-error';
      pre.textContent = `${err?.message ?? String(err)}\n\n${code}`;
      el.replaceChildren(pre);
    }
    el.classList.add('is-rendered');
  }
}

/** Draws every `.mermaid-src` element inside `root` (lazy-loads mermaid on first use). */
export async function renderMermaid(root, { dark = true } = {}) {
  if (!root) return;
  // mermaid.render is not re-entrant: serialize calls (e.g. a live reload mid-draw).
  const run = mermaidQueue.then(() => drawAll(root, dark));
  mermaidQueue = run.catch(() => {});
  return run;
}

/** Scrolls `root`'s scroll container to the element that covers source line `line` (1-based). */
export function scrollToLine(root, line) {
  const wanted = Number(line);
  if (!root || !Number.isFinite(wanted)) return null;
  let best = null;
  let bestLine = -Infinity;
  let first = null;
  let firstLine = Infinity;
  for (const el of root.querySelectorAll('[data-line]')) {
    const n = Number(el.getAttribute('data-line'));
    if (!Number.isFinite(n)) continue;
    if (n < firstLine) { first = el; firstLine = n; }
    if (n <= wanted && n > bestLine) { best = el; bestLine = n; }
  }
  const target = best ?? first;
  if (!target) return null;
  target.scrollIntoView({ block: 'start' });
  if (target.classList.contains('code-line')) {
    for (const el of root.querySelectorAll('.code-line.is-target')) el.classList.remove('is-target');
    target.classList.add('is-target');
    setTimeout(() => target.classList.remove('is-target'), 2000);
  }
  return target;
}
