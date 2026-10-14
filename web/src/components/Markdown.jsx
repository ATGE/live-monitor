import React, { useState } from 'react';
import { useOpenFile } from '../viewer/context.js';
import { isFileRef } from '../viewer/filerefs.js';
import Icon from './Icon.jsx';
import { strings } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';
import MachineChips from '../viewer/MachineChips.jsx';
import '../viewer/filerefs.css';

/**
 * Copies text, also where the async clipboard API is withheld. Browsers only
 * offer `navigator.clipboard` in a secure context, and this board is opened
 * as often over plain http — a tailnet address, the LAN — as on localhost, so
 * the old `execCommand` path is the fallback that makes the button work there.
 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall back below */ }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(area);
  return ok;
}

/**
 * A fenced block with its own copy button. Code blocks are where a reply puts
 * what is meant to be pasted somewhere else — a handoff, a script, a command —
 * and selecting a long one by hand in a scrolling bubble is how lines get lost.
 */
function CodeBlock({ text }) {
  const t = useStrings();
  const [state, setState] = useState('idle');   // idle | done | failed
  const copy = async () => {
    setState((await copyText(text)) ? 'done' : 'failed');
    setTimeout(() => setState('idle'), 1500);
  };
  return (
    <div className="code-wrap">
      <button type="button" className={`copy-btn btn btn-ghost btn-sm ${state}`} onClick={copy} title={t.app.markdown.copyToClipboard}>
        {state === 'done' ? <><Icon name="check" /> {t.app.markdown.copied}</> : state === 'failed' ? <><Icon name="x" /> {t.app.markdown.copyFailed}</> : <><Icon name="copy" /> {t.app.markdown.copy}</>}
      </button>
      <pre><code>{text}</code></pre>
    </div>
  );
}

/**
 * Minimal markdown renderer for the demo steps and Claude's chat replies —
 * headings, lists, tables, fenced code (with a copy button) and inline
 * code/bold/links. Builds React nodes (never innerHTML), so model output can't
 * inject markup.
 *
 * Inside a file viewer, code spans and markdown links that name a file become
 * buttons that open it. Fenced blocks and plain prose are never scanned.
 */
export default function Markdown({ text }) {
  useStrings(); // `inline` reads the catalog at call time; this re-renders on a language change
  const openFile = useOpenFile();
  const blocks = [];
  const lines = (text ?? '').split(/\r?\n/);
  let list = null;
  let ordered = false;
  let code = null;
  let table = null;

  const flushList = () => {
    if (!list) return;
    const Tag = ordered ? 'ol' : 'ul';
    blocks.push(<Tag key={blocks.length}>{list}</Tag>);
    list = null;
  };
  const flushTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    blocks.push(
      <div className="table-wrap" key={blocks.length}>
        <table>
          <thead><tr>{head.map((c, i) => <th key={i}>{inline(c, openFile)}</th>)}</tr></thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>{row.map((c, i) => <td key={i}>{inline(c, openFile)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    table = null;
  };
  const flushAll = () => { flushList(); flushTable(); };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code) {
        blocks.push(<CodeBlock key={blocks.length} text={code.join('\n')} />);
        code = null;
      } else {
        flushAll();
        code = [];
      }
      continue;
    }
    if (code) { code.push(line); continue; }

    // Table rows: `| a | b |`. The `|---|---|` separator only opens the body.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      flushList();
      table ??= [];
      table.push(cells);
      continue;
    }
    flushTable();

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList();
      const Tag = `h${Math.min(heading[1].length + 2, 6)}`;
      blocks.push(<Tag key={blocks.length}>{inline(heading[2], openFile)}</Tag>);
      continue;
    }

    const item = line.match(/^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      const isOrdered = !item[1];
      if (list && isOrdered !== ordered) flushList();
      ordered = isOrdered;
      list ??= [];
      // Keep the author's own numbering: prose between two steps closes the
      // list, and without an explicit value every step would restart at 1.
      list.push(
        <li key={list.length} value={isOrdered ? Number(item[2]) : undefined}>
          {inline(item[3], openFile)}
        </li>,
      );
      continue;
    }

    flushList();
    if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line, openFile)}</p>);
  }
  flushAll();
  // An unclosed fence — a reply cut off mid-block — still gets its button.
  if (code) blocks.push(<CodeBlock key={blocks.length} text={code.join('\n')} />);

  return <div className="md">{blocks}</div>;
}

// Inline code, bold, markdown links and bare URLs. URLs become real anchors so
// a demo step can be opened with one click instead of copy-pasted. A link's
// target is either http(s) (group 2, opens a tab) or any other run without
// whitespace (group 3, a file for the viewer or left as the text it was). The
// second is capped at 400 characters — the longest ref `parseRef` accepts —
// so a long unclosed `[a](bbbb…` stays linear instead of quadratic.
const INLINE_SRC = '(`[^`]+`|\\*\\*[^*]+\\*\\*|\\[[^\\]]+\\]\\((?:(https?://[^)\\s]+)|([^)\\s]{1,400}))\\)|https?://[^\\s<>()[\\]"\'`|]+)';

/** `openFile` is the viewer's opener from `useOpenFile()`, or null without a viewer. */
function inline(text, openFile) {
  // A fresh regex per call: `inline` recurses into bold spans, and a shared
  // global regex would have its lastIndex clobbered mid-iteration.
  const re = new RegExp(INLINE_SRC, 'g');
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const token = m[0];
    const webLink = m[2];
    const fileTarget = m[3];
    if (fileTarget !== undefined && !(openFile && isFileRef(fileTarget))) {
      // Neither a web link nor a file: not a token at all. Resume scanning
      // just past the `[`, so whatever is inside (a code span, a URL) is
      // matched exactly as it was before non-http targets were considered.
      re.lastIndex = m.index + 1;
      continue;
    }
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (token.startsWith('`')) {
      const code = token.slice(1, -1);
      parts.push(openFile && isFileRef(code) ? (
        <React.Fragment key={parts.length}>
          <button type="button" className="file-ref" onClick={() => openFile(code)} title={strings().app.markdown.openInViewer}>
            <code>{code}</code>
          </button>
          <MachineChips refText={code} />
        </React.Fragment>
      ) : (
        <code key={parts.length}>{code}</code>
      ));
    } else if (token.startsWith('**')) {
      // Recurse: the model likes to bold its URLs, and those must still link.
      parts.push(<strong key={parts.length}>{inline(token.slice(2, -2), openFile)}</strong>);
    } else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']'));
      parts.push(webLink !== undefined ? (
        <a key={parts.length} href={webLink} target="_blank" rel="noreferrer">{label}</a>
      ) : (
        <React.Fragment key={parts.length}>
          <button type="button" className="file-ref file-ref-link" onClick={() => openFile(fileTarget)} title={strings().app.markdown.openInViewer}>
            {label}
          </button>
          <MachineChips refText={fileTarget} />
        </React.Fragment>
      ));
    } else {
      // Trailing punctuation belongs to the sentence, not to the link.
      const url = token.replace(/[.,;:]+$/, '');
      parts.push(<a key={parts.length} href={url} target="_blank" rel="noreferrer">{url}</a>);
      if (url.length < token.length) parts.push(token.slice(url.length));
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
