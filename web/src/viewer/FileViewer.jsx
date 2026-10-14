import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon.jsx';
import { FileViewerContext } from './context.js';
import { kindOf, parseRef } from './filerefs.js';
import { authHeaders } from '../token.js';
import { contentUrl, fetchContent, resolveRef, viewUrl } from './fileApi.js';
import { fill, plural, splitAround, strings } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';
import { HtmlPage, PageToggle, isHtmlPath } from './HtmlPage.jsx';
import './doc.css';
import './viewer.css';

/**
 * The file viewer: a big window over the board that opens a file a chat
 * mentions — markdown with its index, code, images — read-only and live
 * (it polls with the last ETag while it is open and the tab is visible).
 *
 * `FileViewerProvider` holds the window and publishes `{ openFile, openPath,
 * scope, setScope }` through `FileViewerContext`; `useOpenFile()` in
 * `context.js` is how the chat reaches it. `StandaloneViewer` is the same
 * viewer, full page, for `?view=<machine>:<path>` in its own tab.
 */

const POLL_MS = 3000;
const FRESH_MS = 2000;

// The renderer (marked, DOMPurify, highlight.js, mermaid on demand) is its own
// chunk: the board pays for it only when a file is opened.
let docModule = null;
function loadDoc() {
  docModule ??= import('./renderDoc.js').catch((err) => { docModule = null; throw err; });
  return docModule;
}

const guessKind = (path) => kindOf(path) ?? 'text';
const baseName = (path) => {
  const p = String(path ?? '');
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1) || p;
};
const KIND_ICON = { md: 'note', text: 'file-text', image: 'image' };
const etagKey = (machine, path) => `${machine}\n${path}`;

/**
 * `href` (relative or absolute) against the directory of `filePath`, with
 * `.` and `..` folded. The separator follows the file's own path: `\` when it
 * uses backslashes, `/` otherwise.
 */
export function joinPath(filePath, href) {
  const file = String(filePath ?? '');
  const sep = file.includes('\\') ? '\\' : '/';
  const rel = String(href ?? '').replace(/\\/g, '/');
  const absolute = /^[a-zA-Z]:\//.test(rel) || rel.startsWith('/');
  const norm = file.replace(/\\/g, '/');
  const dir = norm.slice(0, norm.lastIndexOf('/') + 1);
  const full = absolute ? rel : `${dir}${rel}`;
  const drive = full.match(/^[a-zA-Z]:/)?.[0] ?? '';
  const rest = full.slice(drive.length);
  const rooted = rest.startsWith('/');
  const parts = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!rooted) parts.push('..');
      continue;
    }
    parts.push(seg);
  }
  const joined = `${drive}${rooted ? '/' : ''}${parts.join('/')}`;
  return sep === '\\' ? joined.replace(/\//g, '\\') : joined;
}

/**
 * `resolveLink` for `renderDoc`. `http(s):` and `data:` stay as they are;
 * a file (per `filerefs.js`) is joined to the current file's directory unless
 * it is already absolute, then served (images) or opened here (links);
 * anything else is `null`.
 */
function linkResolver(entry) {
  return (href, { image = false } = {}) => {
    const raw = String(href ?? '').trim();
    if (/^(https?|data):/i.test(raw)) return { href: raw };
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;
    // Any other scheme (mailto:…) is not a file; a drive letter is.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) return null;
    // renderDoc has already decoded `href` once; decoding again would turn `%2520` into a space.
    const path = raw.replace(/[?#].*$/, '');
    const parsed = parseRef(path) ?? (kindOf(path) ? { path } : null);
    if (!parsed?.path) return null;
    const kind = kindOf(parsed.path);
    if (!kind || (image && kind !== 'image')) return null;
    const absolute = /^[a-zA-Z]:[\\/]/.test(parsed.path) || /^[\\/~]/.test(parsed.path);
    const target = absolute ? parsed.path : joinPath(entry.path, parsed.path);
    return image ? { href: contentUrl({ machine: entry.machine, path: target }) } : { openPath: target };
  };
}

const isNarrow = () => window.matchMedia?.('(max-width: 899px)').matches ?? false; // i18n-ok: a media query

/** The mention as the server wants it; tolerates a parsed `{ path, line }`. */
function refText(ref) {
  if (ref && typeof ref === 'object') return ref.line ? `${ref.path}:${ref.line}` : String(ref.path ?? '');
  return String(ref ?? '');
}

function errorText(err, machine) {
  const v = strings().viewer;
  switch (err?.status) {
    case 403: return v.errNotAllowed;
    case 413: return v.errTooLarge;
    case 502: return fill(v.errMachineDown, { machine: machine ?? v.errMachineFallback });
    case 404: return v.errGone;
    case 400: return v.errNotViewable;
    case 0: return v.errOffline;
    default: return err?.data?.error || err?.message || fill(v.errGeneric, { status: err?.status ?? '' }).trim();
  }
}

// What went wrong is kept as data and worded at render, so a language switch reaches it.
const failureText = (f) => (f.imageFailed ? strings().viewer.imageFailed : errorText(f.err, f.machine));

/** Candidates grouped by `rel` (the same file), at most one per machine: the first in server order. */
function groupByRel(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    const key = c.rel || c.path;
    if (!groups.has(key)) groups.set(key, new Map());
    const byMachine = groups.get(key);
    if (!byMachine.has(c.machine)) byMachine.set(c.machine, c);
  }
  return [...groups.values()].map((m) => [...m.values()]);
}

function entryFromGroup(group, line, unreachable) {
  const pick = group.find((c) => c.active) ?? group[0];
  return {
    machine: pick.machine, path: pick.path, kind: pick.kind || guessKind(pick.path), lang: pick.lang ?? null,
    rel: pick.rel ?? null, line: line ?? null, group: group.length > 1 ? group : null, unreachable: unreachable ?? [],
  };
}

/** Where the reader is: the first `[data-line]` still visible, or the scroll ratio. */
function captureAnchor(body) {
  const ratio = body.scrollTop / Math.max(1, body.scrollHeight - body.clientHeight);
  const nodes = body.querySelectorAll('[data-line]');
  if (!nodes.length) return { ratio };
  const top = body.getBoundingClientRect().top;
  let lo = 0;
  let hi = nodes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].getBoundingClientRect().bottom > top) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (found < 0) return { ratio };
  const node = nodes[found];
  return { ratio, line: node.getAttribute('data-line'), offset: node.getBoundingClientRect().top - top };
}

function restoreAnchor(body, anchor) {
  if (!anchor) return;
  if (anchor.line != null) {
    const node = body.querySelector(`[data-line="${CSS.escape(anchor.line)}"]`);
    if (node) {
      body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - anchor.offset;
      return;
    }
  }
  body.scrollTop = anchor.ratio * Math.max(0, body.scrollHeight - body.clientHeight);
}

function agoText(ms) {
  const v = strings().viewer;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return fill(v.agoSeconds, { n: s });
  if (s < 3600) return fill(v.agoMinutes, { n: Math.floor(s / 60) });
  return fill(v.agoHours, { n: Math.floor(s / 3600) });
}

/** «actualizado hace Xs», ticking on its own so the document does not re-render. */
function Ago({ at, fresh }) {
  const v = useStrings().viewer;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (fresh) return <span className="viewer-status fresh">{v.updated}</span>;
  return <span className="viewer-status">{fill(v.updatedAgo, { ago: agoText(Date.now() - at) })}</span>;
}

function Tried({ tried = [], unreachable = [] }) {
  const v = useStrings().viewer;
  if (!tried.length && !unreachable.length) return null;
  const byMachine = new Map();
  for (const t of tried) {
    if (!byMachine.has(t.machine)) byMachine.set(t.machine, []);
    byMachine.get(t.machine).push(t.where);
  }
  return (
    <div className="viewer-tried">
      {byMachine.size > 0 && <p className="viewer-note">{v.searchedIn}</p>}
      {[...byMachine].map(([machine, wheres]) => (
        <div key={machine} className="viewer-tried-machine">
          <span className="chip chip-machine"><Icon name="map-pin"/> {machine}</span>
          <ul>{wheres.map((w, i) => <li key={i}><code>{w}</code></li>)}</ul>
        </div>
      ))}
      {unreachable.map((m) => <p key={m} className="viewer-warn">{fill(v.machineSilent, { machine: m })}</p>)}
    </div>
  );
}

/**
 * The viewer itself, for a `target` of `{ mode: 'ref', project, issue, ref }` (a
 * mention to resolve) or `{ mode: 'path', machine, path, line }`.
 */
export function FileViewer({ target, onClose = null, standalone = false, escRef = null }) {
  const v = useStrings().viewer;
  const [screen, setScreen] = useState({ type: 'resolving', ref: '' });
  const [trail, setTrail] = useState([]);                 // [{ screen, top }] for «← atrás»
  const [content, setContent] = useState({ status: 'idle' });
  const [rendered, setRendered] = useState(null);         // { html, toc, hasMermaid, scroll }
  const [checkedAt, setCheckedAt] = useState(null);
  const [fresh, setFresh] = useState(false);
  const [pollWarn, setPollWarn] = useState(null);
  const [copied, setCopied] = useState(false);
  const [imgFit, setImgFit] = useState(true);
  const [imgVersion, setImgVersion] = useState(0);
  const [toc, setToc] = useState('auto');                 // 'auto' | 'open' | 'closed'
  const [etags, setEtags] = useState({});                 // latest ETag by machine+path
  const gen = useRef(0);                                  // bumps on every screen change; stale async work checks it
  const bodyRef = useRef(null);
  const docRef = useRef(null);
  const sendEtag = useRef(null);                          // what If-None-Match carries
  const shownEtag = useRef(null);                         // the version on screen
  const freshTimer = useRef(null);
  const copyTimer = useRef(null);

  const entry = screen.type === 'file' ? screen.entry : null;

  const go = useCallback((next) => {
    gen.current += 1;
    setScreen(next);
    return gen.current;
  }, []);

  const flashFresh = useCallback(() => {
    setFresh(true);
    clearTimeout(freshTimer.current);
    freshTimer.current = setTimeout(() => setFresh(false), FRESH_MS);
  }, []);
  useEffect(() => () => { clearTimeout(freshTimer.current); clearTimeout(copyTimer.current); }, []);

  const resolve = useCallback(async (project, issue, ref, machine) => {
    const g = go({ type: 'resolving', ref });
    setEtags({});
    try {
      const data = await resolveRef({ project, issue, machine, ref });
      if (g !== gen.current) return;
      const candidates = data.candidates ?? [];
      const unreachable = data.unreachable ?? [];
      if (!candidates.length) {
        go({ type: 'notfound', ref, tried: data.tried ?? [], unreachable });
        return;
      }
      const groups = groupByRel(candidates);
      if (groups.length > 1) go({ type: 'choose', ref, groups, unreachable, line: data.line ?? null });
      else go({ type: 'file', entry: entryFromGroup(groups[0], data.line, unreachable) });
    } catch (err) {
      if (g !== gen.current) return;
      go({
        type: 'notfound', ref, tried: err.data?.tried ?? [], unreachable: err.data?.unreachable ?? [],
        failure: err.status === 404 ? null : { err },
      });
    }
  }, [go]);

  useEffect(() => {
    setTrail([]);
    if (target.mode === 'ref') {
      resolve(target.project, target.issue, refText(target.ref), target.ownerMachine);
    } else {
      go({
        type: 'file',
        entry: {
          machine: target.machine || 'local', path: target.path, kind: guessKind(target.path), lang: null,
          line: Number(target.line) || null, group: null, unreachable: [],
        },
      });
    }
  }, [target, resolve, go]);

  /** Renders fetched text for `e`; false when a newer screen took over meanwhile. */
  const applyText = useCallback(async (res, e, g, scroll) => {
    const doc = await loadDoc();
    const kind = res.kind ?? e.kind;
    const out = await doc.renderDoc(res.text ?? '', { kind, lang: res.lang ?? e.lang ?? null, resolveLink: linkResolver(e) });
    if (g !== gen.current) return false;
    shownEtag.current = res.etag ?? null;
    sendEtag.current = res.headerEtag || res.etag || null;
    setEtags((m) => ({ ...m, [etagKey(e.machine, e.path)]: res.etag }));
    setContent({ status: 'ok', kind });
    setRendered({ ...out, scroll });
    setCheckedAt(Date.now());
    setPollWarn(null);
    return true;
  }, []);

  // Load whatever file the screen shows.
  useEffect(() => {
    setPollWarn(null);
    // A new screen owns no version yet: never revalidate against the previous file's ETag.
    sendEtag.current = null;
    shownEtag.current = null;
    if (screen.type !== 'file') {
      setContent({ status: 'idle' });
      setRendered(null);
      return;
    }
    const e = screen.entry;
    const g = gen.current;
    if (e.kind === 'image') {
      setContent({ status: 'ok', kind: 'image' });
      setRendered(null);
      setCheckedAt(Date.now());
      return;
    }
    const scroll = screen.keepScroll ? { mode: 'keep' }
      : screen.restoreTop != null ? { mode: 'restore', top: screen.restoreTop }
        : e.line ? { mode: 'line', line: e.line } : { mode: 'top' };
    if (!screen.keepScroll) {
      setContent({ status: 'loading' });
      setRendered(null);
    }
    (async () => {
      try {
        const res = await fetchContent({ machine: e.machine, path: e.path });
        if (g !== gen.current) return;
        if (res.kind === 'image') {
          go({ ...screen, entry: { ...e, kind: 'image' } });
          return;
        }
        await applyText(res, e, g, scroll);
      } catch (err) {
        if (g !== gen.current) return;
        setRendered(null);
        setContent({ status: 'error', code: err.status, failure: { err, machine: e.machine }, tried: err.data?.tried ?? [] });
      }
    })();
  }, [screen, go, applyText]);

  // Put the HTML in, draw mermaid, and place the scroll.
  useLayoutEffect(() => {
    const el = docRef.current;
    const body = bodyRef.current;
    if (!rendered || !el || !body) return undefined;
    const { scroll } = rendered;
    const anchor = scroll.mode === 'keep' ? captureAnchor(body) : null;
    el.innerHTML = rendered.html;
    const place = (doc) => {
      if (scroll.mode === 'keep') restoreAnchor(body, anchor);
      else if (scroll.mode === 'restore') body.scrollTop = scroll.top;
      else if (scroll.mode === 'line') doc?.scrollToLine(el, scroll.line);
      else body.scrollTop = 0;
    };
    // Diagrams change heights once drawn, so keep/line wait for them.
    const afterDiagrams = rendered.hasMermaid && (scroll.mode === 'keep' || scroll.mode === 'line');
    if (!afterDiagrams && scroll.mode !== 'line') place(null);
    let alive = true;
    loadDoc().then(async (doc) => {
      if (!alive) return;
      if (rendered.hasMermaid) {
        // The board has only a dark theme.
        try { await doc.renderMermaid(el, { dark: true }); } catch { /* a diagram that fails leaves its source visible */ }
        if (!alive) return;
      }
      if (afterDiagrams || scroll.mode === 'line') place(doc);
    }).catch(() => { /* the renderer chunk failed to load; the error screen already said so */ });
    return () => { alive = false; };
  }, [rendered]);

  // The chooser and the error screens restore their own scroll on «← atrás».
  useLayoutEffect(() => {
    if (screen.type !== 'file' && bodyRef.current) bodyRef.current.scrollTop = screen.restoreTop ?? 0;
  }, [screen]);

  // Live reload.
  const pollable = Boolean(entry) && content.status === 'ok' && content.kind !== 'image';
  useEffect(() => {
    if (!pollable) return undefined;
    const e = screen.entry;
    let busy = false;                                     // per effect: polls never overlap
    const poll = async () => {
      if (document.visibilityState !== 'visible' || busy) return;
      busy = true;
      const g = gen.current;
      try {
        const res = await fetchContent({ machine: e.machine, path: e.path, etag: sendEtag.current });
        if (g !== gen.current) return;
        if (res.status === 304 || res.kind === 'image' || (res.etag && res.etag === shownEtag.current)) {
          setCheckedAt(Date.now());
          setPollWarn(null);
          return;
        }
        if (await applyText(res, e, g, { mode: 'keep' })) flashFresh();
      } catch (err) {
        if (g === gen.current) setPollWarn({ err, machine: e.machine });
      } finally {
        busy = false;
      }
    };
    const id = setInterval(poll, POLL_MS);
    // Back to a visible tab: check at once instead of waiting for the next tick.
    const onVisibility = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollable, screen, applyText, flashFresh]);

  // The standalone tab names itself after the file and keeps its URL current.
  useEffect(() => {
    if (!standalone || !entry) return;
    document.title = fill(v.tabTitle, { name: baseName(entry.path) });
    const url = `?view=${encodeURIComponent(`${entry.machine}:${entry.path}`)}${entry.line ? `&line=${entry.line}` : ''}`;
    window.history.replaceState(null, '', url);
  }, [standalone, entry, v]);

  useEffect(() => { bodyRef.current?.focus({ preventScroll: true }); }, []);

  // Below 900 px the index is an overlay over the body: Esc closes it before the viewer.
  const escOverlay = useRef(null);
  escOverlay.current = () => {
    const nav = bodyRef.current?.parentElement?.querySelector(':scope > .viewer-toc');
    if (!nav || !isNarrow() || getComputedStyle(nav).display === 'none') return false;
    setToc('auto');
    return true;
  };
  useEffect(() => {
    if (escRef) escRef.current = () => escOverlay.current();
  }, [escRef]);
  useEffect(() => {
    if (!standalone) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') escOverlay.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [standalone]);

  const pushTrail = () => setTrail((t) => [...t, { screen, top: bodyRef.current?.scrollTop ?? 0 }]);

  const openInside = (path) => {
    if (!entry) return;
    pushTrail();
    go({
      type: 'file',
      entry: { machine: entry.machine, path, kind: guessKind(path), lang: null, line: null, group: null, unreachable: [] },
    });
  };

  const choose = (group) => {
    pushTrail();
    go({ type: 'file', entry: entryFromGroup(group, screen.line, screen.unreachable) });
  };

  const back = () => {
    const last = trail[trail.length - 1];
    if (!last) return;
    setTrail((t) => t.slice(0, -1));
    go({ ...last.screen, keepScroll: false, restoreTop: last.top });
  };

  const switchTo = (c) => {
    if (!entry || c.machine === entry.machine) return;
    go({
      type: 'file',
      entry: { ...entry, machine: c.machine, path: c.path, kind: c.kind || guessKind(c.path), lang: c.lang ?? entry.lang },
      keepScroll: content.status === 'ok' && entry.kind !== 'image',
    });
  };

  const refresh = () => {
    if (screen.type === 'file') {
      if (entry.kind === 'image') {
        setImgVersion((v) => v + 1);
        setContent({ status: 'ok', kind: 'image' });
        setCheckedAt(Date.now());
        return;
      }
      go({ ...screen, keepScroll: content.status === 'ok', restoreTop: null });
    } else if (target.mode === 'ref') {
      resolve(target.project, target.issue, refText(target.ref), target.ownerMachine);
    }
  };

  const scrollToId = (id) => {
    const body = bodyRef.current;
    const node = docRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!body || !node) return;
    body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
  };

  const onBodyClick = (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t || !docRef.current?.contains(t)) return;
    const link = t.closest('[data-open-path]');
    if (link) {
      ev.preventDefault();
      openInside(link.getAttribute('data-open-path'));
      return;
    }
    const hash = t.closest('a[href^="#"]');
    if (hash) {
      let id = hash.getAttribute('href').slice(1);
      try { id = decodeURIComponent(id); } catch { /* keep it as written */ }
      if (id) {
        ev.preventDefault();
        scrollToId(id);
      }
    }
  };

  const toggleToc = () => setToc((s) => ((s === 'open' || (s === 'auto' && !isNarrow())) ? 'closed' : 'open'));

  const copyPath = async () => {
    const text = entry?.path;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* nothing else to try */ }
      ta.remove();
    }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const onImageError = async () => {
    const e = entry;
    const g = gen.current;
    if (!e) return;
    try {
      const res = await fetch(contentUrl(e), { headers: authHeaders(), cache: 'no-store' });
      if (g !== gen.current) return;
      let data = {};
      try { data = await res.json(); } catch { /* bytes, or nothing */ }
      setContent({
        status: 'error', code: res.status,
        failure: res.ok ? { imageFailed: true } : { err: { status: res.status, data }, machine: e.machine },
        tried: data.tried ?? [],
      });
    } catch (err) {
      if (g === gen.current) setContent({ status: 'error', code: 0, failure: { err: { status: 0, message: err.message } }, tried: [] });
    }
  };

  const group = entry?.group ?? null;
  const differs = Boolean(group) && new Set(group.map((c) => etags[etagKey(c.machine, c.path)] ?? c.etag).filter(Boolean)).size > 1;
  const headUnreachable = screen.type === 'file' ? entry.unreachable : screen.type === 'choose' ? screen.unreachable : [];
  const showToc = Boolean(entry) && content.status === 'ok' && content.kind === 'md' && (rendered?.toc?.length ?? 0) > 0;
  const minLevel = showToc ? Math.min(...rendered.toc.map((t) => t.level || 1)) : 1;
  // An `.html` opens as a page; the mode is per file, so a new file starts on «Página».
  const [pageMode, setPageMode] = useState({ key: null, mode: 'page' });
  const pageKey = entry ? etagKey(entry.machine, entry.path) : null;
  const canPage = Boolean(entry) && entry.kind === 'text' && isHtmlPath(entry.path);
  const showPage = canPage && (pageMode.key === pageKey ? pageMode.mode : 'page') === 'page';
  const imgSrc = entry?.kind === 'image' ? `${contentUrl(entry)}${imgVersion ? `&v=${imgVersion}` : ''}` : null;

  let body;
  if (screen.type === 'resolving') {
    body = <p className="viewer-loading">{v.searching}</p>;
  } else if (screen.type === 'choose') {
    body = (
      <div className="viewer-chooser">
        <p className="viewer-note">{splitAround(plural(screen.groups.length, v.matches), { ref: screen.ref })
          .map((part) => (part.hole ? <code key={part.key}>{part.text}</code> : part.text))}</p>
        <ul>
          {screen.groups.map((g) => {
            const pick = g.find((c) => c.active) ?? g[0];
            return (
              <li key={`${pick.machine}:${pick.path}`}>
                <button onClick={() => choose(g)}>
                  <span className="viewer-kind" aria-hidden="true"><Icon name={KIND_ICON[pick.kind] ?? 'file-text'}/></span>
                  <span className="viewer-chooser-path">{pick.rel || pick.path}</span>
                  {g.map((c) => <span key={c.machine} className="chip chip-machine"><Icon name="map-pin"/> {c.machine}</span>)}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  } else if (screen.type === 'notfound') {
    body = (
      <div className="viewer-error">
        <h3>{splitAround(v.notFound, { ref: screen.ref })
          .map((part) => (part.hole ? <code key={part.key}>{part.text}</code> : part.text))}</h3>
        {screen.failure && <p>{failureText(screen.failure)}</p>}
        <Tried tried={screen.tried} unreachable={screen.unreachable} />
      </div>
    );
  } else if (content.status === 'error') {
    body = (
      <div className="viewer-error">
        <h3>{failureText(content.failure)}</h3>
        <p className="viewer-error-path"><code>{entry.path}</code> <span className="chip chip-machine"><Icon name="map-pin"/> {entry.machine}</span></p>
        <Tried tried={content.tried} />
      </div>
    );
  } else if (content.status === 'ok' && content.kind === 'image') {
    body = (
      <div className={`viewer-image ${imgFit ? 'fit' : 'actual'}`}>
        <img src={imgSrc} alt={baseName(entry.path)} onError={onImageError} />
      </div>
    );
  } else if (content.status === 'ok') {
    // The source stays mounted under the page so «Código» is there at once, and the live reload keeps it current.
    body = (
      <>
        {showPage && <HtmlPage entry={entry} version={etags[pageKey]} />}
        <div className="doc" data-kind={content.kind} ref={docRef} style={showPage ? { display: 'none' } : undefined} />
      </>
    );
  } else {
    body = <p className="viewer-loading">{v.loading}</p>;
  }

  return (
    <div className="viewer-frame">
      <header className="viewer-head">
        <div className="viewer-lead">
          {trail.length > 0 && <button className="viewer-back btn btn-ghost btn-sm" onClick={back} title={v.backTitle}><Icon name="arrow-left"/> {v.back}</button>}
          <div className="viewer-title">
            <span className="viewer-name" title={entry ? baseName(entry.path) : screen.ref}>{entry ? baseName(entry.path) : screen.ref}</span>
            {entry && (
              <span className="viewer-path">
                <code>{entry.path}</code>
                <button className="viewer-copy btn btn-ghost btn-icon btn-sm" onClick={copyPath} title={v.copyPath} aria-label={v.copyPath}>{copied ? v.copied : <Icon name="copy"/>}</button>
              </span>
            )}
          </div>
        </div>
        <div className="viewer-actions">
          {group && (
            <div className="viewer-switch" role="group" aria-label={v.machine}>
              {group.map((c) => (
                <button key={c.machine} className={c.machine === entry.machine ? 'on' : ''} aria-pressed={c.machine === entry.machine}
                  onClick={() => switchTo(c)}>{c.machine}</button>
              ))}
            </div>
          )}
          {differs && <span className="viewer-badge" title={v.differsTitle}>{v.differsBadge}</span>}
          {entry && <span className="chip chip-machine viewer-machine"><Icon name="map-pin"/> {entry.machine}</span>}
          {headUnreachable.map((m) => <span key={m} className="viewer-warn">{fill(v.machineSilent, { machine: m })}</span>)}
          {pollWarn && <span className="viewer-warn viewer-poll-warn" title={v.pollWarnTitle}><Icon name="alert-triangle"/> {failureText(pollWarn)}</span>}
          {entry && checkedAt && content.status === 'ok' && <Ago at={checkedAt} fresh={fresh} />}
          {showToc && <button className="viewer-toc-toggle btn btn-ghost btn-sm" onClick={toggleToc} title={v.tocToggleTitle}><Icon name="menu"/> {v.tocButton}</button>}
          {canPage && content.status === 'ok' && (
            <PageToggle mode={showPage ? 'page' : 'code'} onChange={(mode) => setPageMode({ key: pageKey, mode })} />
          )}
          {entry?.kind === 'image' && content.status === 'ok' && (
            <button className="viewer-fit btn btn-ghost btn-sm" onClick={() => setImgFit((f) => !f)}>{imgFit ? v.actualSize : v.fit}</button>
          )}
          {entry && !standalone && (
            <a className="viewer-btn" href={viewUrl({ machine: entry.machine, path: entry.path, line: entry.line })} target="_blank" rel="noopener noreferrer">
              {v.openInNewTab}
            </a>
          )}
        </div>
        {/* Always on the first row, next to the name, whatever wraps. */}
        <div className="viewer-end">
          <button className="viewer-refresh btn btn-ghost btn-icon btn-sm" onClick={refresh} title={v.refresh} aria-label={v.refresh}><Icon name="refresh"/></button>
          {onClose && <button className="viewer-close btn btn-close" onClick={onClose} title={v.closeTitle} aria-label={v.close}><Icon name="x"/></button>}
        </div>
      </header>
      <div className={`viewer-main toc-${toc}`}>
        {showToc && (
          <nav className="viewer-toc" aria-label={v.tocAria}>
            {rendered.toc.map((t, i) => (
              <a key={`${t.id}-${i}`} href={`#${t.id}`} style={{ paddingLeft: 8 + ((t.level || 1) - minLevel) * 12 }}
                onClick={(ev) => {
                  ev.preventDefault();
                  scrollToId(t.id);
                  if (isNarrow()) setToc('auto');
                }}>{t.text}</a>
            ))}
          </nav>
        )}
        <div className={`viewer-body${entry?.kind === 'image' ? ' is-image' : ''}${showPage && content.status === 'ok' ? ' is-page' : ''}`} ref={bodyRef} tabIndex={-1} onClick={onBodyClick}>
          {body}
        </div>
      </div>
    </div>
  );
}

/**
 * The window over the board. Its own portal rather than `components/Dialog.jsx`,
 * which is capped at 760 px; same reasons for rendering at <body> (a
 * `container-type` ancestor would trap the fixed backdrop).
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'; // i18n-ok: a CSS selector

/** Tab and Shift+Tab cycle through the viewer's own controls and never leave it. */
function trapTab(e, root) {
  if (!root) return;
  e.preventDefault();
  const items = [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
  if (!items.length) return;
  const active = document.activeElement;
  let i = items.indexOf(active);
  if (i < 0) {
    // Focus on a spot that is not tabbable (the scroll body) or outside: go on from its position.
    const after = root.contains(active)
      ? items.findIndex((n) => active.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)
      : -1;
    i = e.shiftKey ? (after < 0 ? items.length : after) : (after < 0 ? items.length : after) - 1;
  }
  const next = e.shiftKey ? (i - 1 + items.length) % items.length : (i + 1) % items.length;
  items[next].focus();
}

function ViewerWindow({ target, onClose }) {
  const v = useStrings().viewer;
  const box = useRef(null);
  const overlayEsc = useRef(null);
  // Focus goes back to whatever opened the viewer (a link in the chat) when it closes.
  const opener = useRef(document.activeElement);
  useEffect(() => () => {
    if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return; // i18n-ok: KeyboardEvent.key
      // A board dialog opened after the viewer (App's `notice`) sits above it and owns the keys.
      if (document.querySelector('.viewer-backdrop ~ .modal-backdrop')) return;
      if (e.key === 'Tab') { // i18n-ok: KeyboardEvent.key
        trapTab(e, box.current);
        return;
      }
      // Capture phase on window, before Dialog.jsx's own listener: the viewer
      // can open from inside a QuestionDialog or PlanReview (both render
      // Markdown), and one Esc must close only the viewer, which sits above them.
      e.stopPropagation();
      if (overlayEsc.current?.()) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal((
    <div className="viewer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="viewer-modal" role="dialog" aria-modal="true" aria-label={v.windowAria} ref={box}>
        <FileViewer target={target} onClose={onClose} escRef={overlayEsc} />
      </div>
    </div>
  ), document.body);
}

export function FileViewerProvider({ children }) {
  // A ref, not state: switching chats must not change the context value and
  // re-render every chat link. `useOpenFile` reads `ctx.scope` when clicked.
  const scopeRef = useRef({ project: null, issue: null, chatId: null, machine: null });
  const [target, setTarget] = useState(null);

  const setScope = useCallback((next) => {
    scopeRef.current = { project: next?.project ?? null, issue: next?.issue ?? null, chatId: next?.chatId ?? null, machine: next?.machine ?? null };
  }, []);
  const openFile = useCallback(({ project = null, issue = null, chatId = null, machine = null, ref }) => setTarget({ mode: 'ref', project, issue, chatId, ownerMachine: machine, ref }), []);
  const openPath = useCallback(({ machine = 'local', path, line = null }) => setTarget({ mode: 'path', machine, path, line }), []);
  const close = useCallback(() => setTarget(null), []);

  const value = useMemo(() => ({
    openFile,
    openPath,
    get scope() { return scopeRef.current; },
    setScope,
  }), [openFile, openPath, setScope]);
  return (
    <FileViewerContext.Provider value={value}>
      {children}
      {target && <ViewerWindow target={target} onClose={close} />}
    </FileViewerContext.Provider>
  );
}

/** Publishes the open chat's `{ project, issue, chatId, machine }` as the viewer's scope. */
export function useFileViewerScope(scope) {
  const setScope = useContext(FileViewerContext)?.setScope;
  const project = scope?.project ?? null;
  const issue = scope?.issue ?? null;
  const chatId = scope?.chatId ?? null;
  const machine = scope?.machine ?? null;
  useEffect(() => { setScope?.({ project, issue, chatId, machine }); }, [setScope, project, issue, chatId, machine]);
}

/**
 * `?view=<machine>:<path>[&line=N]`: the viewer full page. The part before the
 * first colon is the machine when it is longer than one character; otherwise
 * (a drive letter, or no colon) the whole value is a path on `local`.
 */
export function StandaloneViewer() {
  const v = useStrings().viewer;
  const target = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('view') ?? '';
    if (!raw) return null;
    const line = Number(params.get('line')) || null;
    const colon = raw.indexOf(':');
    const [machine, path] = colon > 1 ? [raw.slice(0, colon), raw.slice(colon + 1)] : ['local', raw];
    return { mode: 'path', machine, path, line };
  }, []);

  return (
    <div className="viewer-standalone">
      {target ? <FileViewer target={target} standalone /> : <p className="viewer-loading">{v.missingView}</p>}
    </div>
  );
}
