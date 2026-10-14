#!/usr/bin/env node
// Anchor audit for the PRD/FSD/ADR citations: does a `path:line` still land on
// the symbol the prose names next to it?
//
// Why this exists. `server/test/docs.test.mjs` checks that a cited file exists
// and that the line falls inside it — and nothing more, on purpose: a content
// check would turn the suite red on any commit by anybody. So a citation that
// drifts onto the wrong line passes every check and misleads every reader. It
// is not hypothetical: the G chapter was re-anchored by hand with 253 of its
// 384 citations pointing at the wrong line, and the suite was green throughout.
// The drift is not a uniform offset (within one file, blocks moved +233, +211,
// +139 and +776 lines), so nothing can repair it from line numbers alone.
//
// What it measures. Most citations are written next to the identifier they are
// about: `` `draftPrPhase` (`server/src/pipeline.js:3713`) ``. When a citation
// carries such an ANCHOR — a code span that is a bare identifier, glued to the
// citation by punctuation only — the anchor can be looked for around the cited
// line. Three verdicts:
//
//   · `cerca`   — the identifier appears within the window around the citation;
//   · `lejos`   — it appears in the file, but far from the cited line (drift,
//                 and the nearest occurrence is the line to write instead);
//   · `ausente` — it is not in the cited file at all (wrong file, renamed
//                 symbol, or an import alias the prose uses and the file does
//                 not).
//
// A citation with no anchor next to it cannot be judged at all, and is counted
// as such rather than assumed innocent. Three quarters of the corpus is in
// that bucket today: this report says how much it can see, never that what it
// cannot see is fine.
//
// A `path#symbol` citation (see below) is the way out of that bucket: it is
// counted apart, as `simbolos`, and never judged here, because the verifier
// already resolves it and fails hard when it cannot.
//
// Why it is INFORMATIVE and not a rule of the suite. Measured over the whole
// corpus the honest count is upward of a hundred (`--list` prints them), and
// a check that fails a hundred times is a check people learn to skip — exactly what
// the verifier's own comment warns against. So this never breaks `npm test`
// and its exit code is 0 unless `--fail-over N` is given. What IS pinned in
// the suite is this tool's own logic, on synthetic trees, in
// `server/test/docs.test.mjs`.
//
// The window is asymmetric (40 lines above, 5 below) and that is not a
// nicety: prose routinely names the enclosing function and cites a block
// inside its body, which is correct and reads as a backwards distance. The
// value was calibrated against `docs/fsd/G-pr-y-merge.md` on the day it was
// re-anchored by hand — 88 judgeable citations, 0 flagged — so the window is
// the widest one that still costs no false positive on a chapter known good.
//
// Imports nothing from `server/src`: this is a tool, not part of the server.
//
//   node tools/docs/anchors.mjs                 # per-document table
//   node tools/docs/anchors.mjs --list          # every finding, with the line to write
//   node tools/docs/anchors.mjs --json
//   node tools/docs/anchors.mjs --fail-over 20  # exit 1 if a document has >= 20 findings
//   node tools/docs/anchors.mjs --root <dir>    # another tree (tests)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { structuralLines } from '../decisions/core.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Chapters: `A-intake.md` … `O-conocimiento.md`, under `docs/prd/` and `docs/fsd/`. */
export const CHAPTER_NAME_RE = /^[A-O]-[a-z0-9-]+\.md$/;
/** An ADR file. `_plantilla.md` is not one, exactly as in the verifier. */
export const ADR_NAME_RE = /^\d{4}-[a-z0-9-]{1,40}\.md$/;

/** Lines above / below the citation where the anchor still counts as near. */
export const DEFAULT_WINDOW = Object.freeze({ back: 40, fwd: 5 });

// COPIED from `server/test/docs.test.mjs` (CODE_SPAN_RE, CITA_RE, looksLikePath
// and the open-span handling of `checkCitas`), as `tools/docs/stale.mjs`
// already copies them: that file is a test, it does not export these, and a
// tool must not import a test. If the recognition rules change there, change
// them here too.
const CODE_SPAN_RE = /`([^`]+)`/g;
const CITA_RE = /^([^:\s]*?):(\d+)(?:-(\d+))?$/;
const looksLikePath = (p) => p.includes('/') || /^[\w.-]+\.[A-Za-z0-9]+$/.test(p);

/** A bare identifier, long enough to be worth looking for. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/;
/**
 * What may sit between the anchor and its citation: punctuation and space, and
 * nothing else. Allowing connector words («sobre», «en») or anchors written
 * AFTER the citation was measured and rejected: it bought 20 more judgeable
 * citations and cost three false positives on the chapter known to be correct.
 */
const GLUE_RE = /^[\s(,;·—-]*$/;

// ---------------------------------------------------------------------------
// Symbol citations: `server/src/pipeline.js#completeOnIssueClosed`
//
// A `path:line` citation decays by construction — every commit above the line
// moves it, and this very audit measured 110 drifted citations one morning and
// 137 that afternoon, three commits later. A `path#symbol` citation names the
// declaration instead of its position, so it survives any edit that does not
// rename or remove the symbol, and when it does break it breaks loudly: the
// verifier (`server/test/docs.test.mjs`) resolves every one and fails hard.
// That is why this audit never judges them: they are verified by construction,
// and are counted apart (`simbolos`), never as «sin ancla».
//
// The resolver lives HERE and the verifier imports it (as it already imports
// `audit`), so the two cannot disagree about what a declaration is.
// ---------------------------------------------------------------------------

/** Files whose declarations the resolver understands. Anything else is left alone. */
export const SYMBOL_FILE_RE = /\.(?:js|jsx|mjs|cjs)$/;
/** `path.js#whatever`: the symbol part is validated later, so a typo is a failure and not a silence. */
const SYMBOL_CITA_RE = /^([^#\s:]+)#(.*)$/;
/** A JavaScript identifier. */
export const JS_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * The symbol citation a code span carries, `{ ruta, symbol }`, or `null`.
 *
 * Only a path that ends in a JS extension counts: `` `adr.md#adr-nnnn` `` is
 * a markdown anchor, not a citation, and stays out. The symbol is returned as
 * written, even when it is not an identifier: the verifier reports that.
 */
export function symbolCitationOf(spanText) {
  const m = SYMBOL_CITA_RE.exec(String(spanText ?? '').trim());
  if (!m) return null;
  const [, ruta, symbol] = m;
  if (!looksLikePath(ruta) || !SYMBOL_FILE_RE.test(ruta)) return null;
  return { ruta, symbol };
}

const ID = '[A-Za-z_$][\\w$]*';
/** Words that look like `name(…) {` at the start of a line and never declare a method. */
const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try', 'typeof', 'await', 'new', 'super', 'import',
]);

/**
 * The declaration shapes the resolver recognises, one line each. What these
 * cover was decided by reading `server/src/` and `web/src/`:
 *
 *   · `function f(` — plain, `async`, generator, `export`, `export default`;
 *   · `class C` — plain, `export`, `export default`;
 *   · `const|let|var x =`, and `let|var x;` without initialiser, `export`ed or not;
 *   · a method on ONE line: `name(…) {`, with `static` / `async` / `get` /
 *     `set` / `*` — class bodies and object-literal shorthand alike;
 *   · an object property holding a function: `name: (…) =>`, `name: x =>`,
 *     `name: function`, `name: async (…) =>`;
 *   · a local `export { a, b as c }` list, which declares the EXPORTED name —
 *     but only counts when nothing else in the file declares that name, so
 *     `function f` + `export { f }` is one declaration.
 *
 * Only CODE is looked at: a line inside a comment, a string or a template
 * literal is never a declaration (`maskNonCode`). And a re-export,
 * `export { f } from './x.js'`, is NOT one: like an import, it forwards a
 * symbol declared elsewhere, so it is reported as `mencionado` with the module
 * it comes from.
 *
 * Knowingly NOT covered: destructuring (`const { a } = x`), a second name in
 * one statement (`const a = 1, b = 2`), a method whose parameter list spans
 * several lines, class fields (`name = …` inside a class body) and anything
 * built at runtime (`module[name] = …`). Cite those with `archivo:línea`.
 */
const DECL_RES = [
  new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})\\s*\\(`),
  new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?class\\s+(${ID})(?![\\w$])`),
  new RegExp(`^(\\s*)(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?:=|;|$)`),
  new RegExp(`^(\\s+)(?:(?:static|async|get|set)\\s+)*\\*?\\s*(${ID})\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\{`),
  new RegExp(`^(\\s+)(${ID})\\s*:\\s*(?:async\\s+)?(?:function(?![\\w$])|\\([^)]*\\)\\s*=>|${ID}\\s*=>)`),
];
// `export { a, b as c }` with an optional `from '…'` tail. `from` is read off
// the MASKED line (so a `from` inside a comment is not one); the module
// specifier is read off the raw line, at the same offsets.
const EXPORT_LIST_RE = /^\s*export\s*\{([^}]*)\}(\s*from\s*)?/;

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
/** After one of these a `/` starts a regular expression; after anything else it divides. */
const PUNCT_BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%~^}', '=>']);

/**
 * Decide, once, which characters of a source text are CODE. Returns
 * `{ masked, clean }`: `masked` is the text with every character of a comment,
 * a string, a template-literal text and a regular-expression literal replaced
 * by a space — newlines (and `\r`) are kept, so `masked` has the same length
 * and the same line structure as the input and a line number found in it is the
 * real one. The declaration patterns run over `masked` only.
 *
 * A small state machine, no dependency. Handled:
 *   · line comments and block comments (and a leading `#!` line);
 *   · '…' and "…" strings, with backslash escapes and line continuations — a
 *     `\` before LF and before CRLF alike, so one text gets the same verdict
 *     whatever the platform's line ending; an unterminated one ends at its
 *     line, so a stray apostrophe in JSX text costs one line and not the file;
 *   · template literals, including NESTED `${ … }` expressions: the text
 *     outside the braces is masked, the code inside them is kept — and may
 *     itself contain strings, templates and comments;
 *   · regular-expression literals (`/…/flags`, with `[…]` classes, so
 *     `/['"`]/` does not open a string), told from division by the previous
 *     token (including `=>`: `x => /re/`); a candidate with no closing `/` on
 *     its line is division.
 *
 * Knowingly NOT handled: a regex after `)` (`if (x) /re/.test(s)`) is read as
 * a division, and `}` is always assumed to be followed by a regex; a regex
 * after a bare `>` (`a > /re/`) is read as a division — `>` is deliberately
 * NOT in the set, because it also ends a JSX tag and `<code>/api/x</code>`
 * would then mask its text as a regex (`=>` is, and is the case that occurs);
 * a lone CR as line ending (classic Mac) is not a line end for the scanner;
 * JSX text is treated as code (only a quote or backtick in it can hurt, see
 * above).
 * These fail SAFE: when they derail the scan, the file usually ends inside an
 * unterminated comment or template (`clean: false`), and `resolveSymbol` then
 * rejects every citation into it with reason `ilegible`, which the author
 * sees, instead of trusting a scan it cannot vouch for. A derailment that
 * still ends clean can only hide code (a rejected citation) or reveal text
 * (an accepted one) on the lines it touched; that residue is small and unproven.
 */
export function maskNonCode(text) {
  const src = String(text ?? '');
  const n = src.length;
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const idChar = (c) => c !== undefined && /[\w$]/.test(c);
  // How many characters a backslash at `k` swallows: itself and the next one —
  // or, before a Windows line ending, all three (`\`, CR, LF). A continuation
  // must behave the same whatever the platform's line ending is.
  const escLen = (k) => (src[k + 1] === '\r' && src[k + 2] === '\n' ? 3 : 2);
  const exprDepths = []; // one entry per open `${`: how many `{` are open inside it
  let clean = true;
  let prev = null; // previous significant token: an identifier/number, or one punctuation char

  // Template text from `from`, scanning at `scan`. Returns the index where CODE resumes.
  const templateText = (from, scan) => {
    let k = scan;
    while (k < n) {
      const c = src[k];
      if (c === '\\') k += 2; // template text spans lines anyway: a CR LF after `\` is plain text either way
      else if (c === '`') { blank(from, k + 1); return k + 1; }
      else if (c === '$' && src[k + 1] === '{') { blank(from, k + 2); exprDepths.push(0); return k + 2; }
      else k += 1;
    }
    blank(from, n);
    clean = false;
    return n;
  };

  let i = 0;
  if (src.startsWith('#!')) {
    while (i < n && src[i] !== '\n') i += 1;
    blank(0, i);
  }
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let k = i;
      while (k < n && src[k] !== '\n') k += 1;
      blank(i, k);
      i = k;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) { blank(i, n); clean = false; i = n; } else { blank(i, end + 2); i = end + 2; }
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? escLen(k) : 1;
      if (src[k] === c) k += 1;
      blank(i, Math.min(k, n));
      i = Math.min(k, n);
      prev = '"';
    } else if (c === '`') {
      i = templateText(i, i + 1);
      prev = '`';
    } else if (c === '/' && (prev === null || PUNCT_BEFORE_REGEX.has(prev) || KEYWORDS_BEFORE_REGEX.has(prev))) {
      let k = i + 1;
      let inClass = false;
      while (k < n && src[k] !== '\n') {
        const d = src[k];
        if (d === '\\') { k += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        k += 1;
      }
      if (k < n && src[k] === '/') {
        k += 1;
        while (idChar(src[k])) k += 1;
        blank(i, k);
        i = k;
        prev = '/re/';
      } else {
        prev = '/'; // no closing slash on this line: it was a division
        i += 1;
      }
    } else if (idChar(c)) {
      let k = i;
      while (idChar(src[k])) k += 1;
      prev = src.slice(i, k);
      i = k;
    } else {
      if (c === '{' && exprDepths.length) exprDepths[exprDepths.length - 1] += 1;
      if (c === '}' && exprDepths.length) {
        if (exprDepths[exprDepths.length - 1] === 0) {
          exprDepths.pop();
          i = templateText(i, i + 1); // back into the template text; blanks the `}`
          prev = '`';
          continue;
        }
        exprDepths[exprDepths.length - 1] -= 1;
      }
      // `=>` (and only that: a bare `>` may end a JSX tag, whose text is not a regex) is followed by an expression
      if (c === '>' && src[i - 1] === '=') prev = '=>';
      else if (!/\s/.test(c)) prev = c;
      i += 1;
    }
  }
  if (exprDepths.length) clean = false;
  return { masked: out.join(''), clean };
}

/**
 * Scan a source text for `name`: `{ found, exported, reexported, clean }`.
 * `found` are real declarations, `exported` the names a local `export { … }`
 * list makes public, `reexported` those a `export { … } from '…'` list forwards
 * from another module (`[{ line, from }]`) — a re-export declares nothing here,
 * exactly like an import.
 */
function scanFor(text, name) {
  const raw = String(text ?? '');
  const { masked, clean } = maskNonCode(raw);
  const rawLines = raw.split(/\r?\n/);
  const found = [];
  const exported = [];
  const reexported = [];
  masked.split(/\r?\n/).forEach((l, i) => {
    for (const re of DECL_RES) {
      const m = re.exec(l);
      if (!m || m[2] !== name || NOT_A_METHOD.has(m[2])) continue;
      found.push({ line: i + 1, topLevel: m[1] === '' });
      break;
    }
    const list = EXPORT_LIST_RE.exec(l);
    if (!list) return;
    for (const part of list[1].split(',')) {
      const names = part.trim().split(/\s+as\s+/);
      if (names[names.length - 1] !== name) continue;
      if (list[2] === undefined) {
        exported.push({ line: i + 1, topLevel: true });
      } else {
        // The masked `from` tail is blank where the specifier is: read it off the raw line.
        const spec = /^\s*from\s*(['"])([^'"]*)\1/.exec(rawLines[i].slice(l.indexOf('}', l.indexOf('{')) + 1));
        reexported.push({ line: i + 1, from: spec ? spec[2] : null });
      }
    }
  });
  return { found, exported, reexported, clean };
}

/**
 * Every declaration of `name` in a source text: `[{ line, topLevel }]`.
 * `topLevel` means column 0 — a module-level declaration, not a local.
 * Comments, strings and template-literal text hold none (`maskNonCode`).
 */
export function declarationsOf(text, name) {
  const { found, exported } = scanFor(text, name);
  return found.length ? found : exported;
}

/**
 * Resolve `name` in a source text. One verdict:
 *
 *   · `{ ok: true, line }` — exactly one declaration at module level, or, when
 *     there is none at module level, exactly one declaration at all (a method,
 *     an inner function). A module-level `const token` is what `file#token`
 *     means even if some function has a local `const token` too;
 *   · `{ ok: false, reason: 'ambiguo', lines }` — two or more at module level,
 *     or none there and two or more nested (a `close()` method in two
 *     classes). The citation cannot say which: cite `archivo:línea`;
 *   · `{ ok: false, reason: 'mencionado', lines }` — the file uses the name
 *     but does not declare it (an import, a call, a comment). For a re-export
 *     it also carries `reexport: [{ line, from }]`, `from` being the module
 *     that declares it (`null` when it cannot be read);
 *   · `{ ok: false, reason: 'ilegible' }` — the scan of the file ended inside
 *     an unterminated comment or template literal (`maskNonCode` `clean:
 *     false`), so no verdict about it can be trusted;
 *   · `{ ok: false, reason: 'ausente' }` — not in the file at all.
 */
export function resolveSymbol(text, name) {
  const { found, exported, reexported, clean } = scanFor(text, name);
  if (!clean) return { ok: false, reason: 'ilegible' };
  const decls = found.length ? found : exported;
  const top = decls.filter((d) => d.topLevel);
  const pick = top.length ? top : decls;
  if (pick.length === 1) return { ok: true, line: pick[0].line };
  if (pick.length > 1) return { ok: false, reason: 'ambiguo', lines: pick.map((d) => d.line) };
  if (reexported.length) {
    return { ok: false, reason: 'mencionado', lines: reexported.map((r) => r.line), reexport: reexported };
  }
  const mentions = occurrences(String(text ?? '').split(/\r?\n/), name);
  if (mentions.length) return { ok: false, reason: 'mencionado', lines: mentions };
  return { ok: false, reason: 'ausente' };
}

/** The citation a code span carries, or `null`. Paths escaping the root are not citations. */
export function citationOf(spanText) {
  const m = CITA_RE.exec(String(spanText ?? '').trim());
  if (!m) return null;
  const [, ruta, desde, hasta] = m;
  if (ruta === '' || !looksLikePath(ruta) || path.isAbsolute(ruta)) return null;
  return { ruta, desde: Number(desde), hasta: Number(hasta ?? desde) };
}

/**
 * The identifier a code span names, or `null`. `` `PR_TITLE_MAX = 256` ``
 * names `PR_TITLE_MAX`; `` `restart.ps1` `` and `` `server/src/qa.js` `` name
 * files, not symbols, and `` `npm run restart` `` is a command.
 *
 * The three are turned away by `IDENT_RE` alone — a dot, a slash and a space
 * are none of them identifier characters —, so there is no separate path check
 * here on purpose: a guard that cannot be made to fire is a guard nobody can
 * test.
 */
export function anchorOf(spanText) {
  const head = String(spanText ?? '').trim().split(/\s*=\s*/)[0].trim();
  return IDENT_RE.test(head) ? head : null;
}

/**
 * The code spans of each structural line of a document: `[index, line, spans]`.
 * Fenced bodies are stepped over and an unclosed span is carried to the next
 * line, both as the verifier does.
 */
function* spanLines(text) {
  let openTail = false;
  for (const [i, rawLine] of structuralLines(String(text ?? ''))) {
    let line = rawLine;
    if (openTail) {
      const closeAt = line.indexOf('`');
      if (closeAt === -1) continue;
      line = line.slice(closeAt + 1);
      openTail = false;
    }
    if ((line.match(/`/g) ?? []).length % 2 === 1) {
      line = line.slice(0, line.lastIndexOf('`'));
      openTail = true;
    }
    const spans = [];
    for (const m of line.matchAll(CODE_SPAN_RE)) {
      spans.push({ text: m[1], start: m.index, end: m.index + m[0].length });
    }
    yield [i, line, spans];
  }
}

/** Every `path#symbol` citation of a document: `[{ line, raw, ruta, symbol }]`. */
export function symbolCitationsOf(text) {
  const out = [];
  for (const [i, , spans] of spanLines(text)) {
    for (const span of spans) {
      const cita = symbolCitationOf(span.text);
      if (cita) out.push({ line: i + 1, raw: span.text, ...cita });
    }
  }
  return out;
}

/**
 * Every `path:line` citation of a document, with the anchor glued to its left
 * (or `null`). `path#symbol` citations are not here: see `symbolCitationsOf`.
 */
export function citationsOf(text) {
  const out = [];
  for (const [i, line, spans] of spanLines(text)) {
    for (let k = 0; k < spans.length; k += 1) {
      const cita = citationOf(spans[k].text);
      if (!cita) continue;
      // The anchor is the nearest span to the left that names a symbol. A run
      // of citations is stepped over («(`a.js:1`, `b.js:2`, sobre `foo`)»
      // keeps looking left), anything else stops the search.
      let anchor = null;
      for (let j = k - 1; j >= 0; j -= 1) {
        if (!GLUE_RE.test(line.slice(spans[j].end, spans[k].start))) break;
        if (citationOf(spans[j].text)) continue;
        anchor = anchorOf(spans[j].text);
        break;
      }
      out.push({ line: i + 1, raw: spans[k].text, cita, anchor });
    }
  }
  return out;
}

/** Whole-word occurrences of `name` in `lines` (1-based line numbers). */
function occurrences(lines, name) {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[$]/g, '\\$&')}(?![A-Za-z0-9_$])`);
  const hits = [];
  for (let n = 1; n <= lines.length; n += 1) if (re.test(lines[n - 1])) hits.push(n);
  return hits;
}

/** Signed distance from a cited range to a line: 0 inside, negative above, positive below. */
const distance = ({ desde, hasta }, n) => (n < desde ? n - desde : (n > hasta ? n - hasta : 0));

/**
 * The audit of a tree: `{ rows, findings, totals }`. Never throws.
 *
 * `rows` is one per document (`{ doc, citas, juzgables, cerca, lejos,
 * ausentes, sinAncla, sinArchivo, simbolos }`); `findings` is one per `lejos` /
 * `ausente` citation, carrying `sugerida`: the nearest line where the
 * identifier really is, which is what a human would write instead.
 *
 * `citas` and everything after it count `path:line` citations only, exactly
 * as before the symbol form existed. `simbolos` counts `path#symbol`
 * citations, which are never judged here: the verifier resolves each one and
 * fails the suite when it cannot, so they are right by construction.
 */
export function audit(root, { window: win = DEFAULT_WINDOW } = {}) {
  root = path.resolve(root);
  const back = Number.isInteger(win?.back) ? win.back : DEFAULT_WINDOW.back;
  const fwd = Number.isInteger(win?.fwd) ? win.fwd : DEFAULT_WINDOW.fwd;

  const codeCache = new Map();
  const codeLines = (abs) => {
    if (!codeCache.has(abs)) {
      let lines = null;
      try {
        lines = fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8').split(/\r?\n/) : null;
      } catch {
        lines = null;
      }
      codeCache.set(abs, lines);
    }
    return codeCache.get(abs);
  };

  const docs = [];
  const collect = (dir, nameRe) => {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, dir)).filter((n) => nameRe.test(n)).sort();
    } catch {
      names = [];
    }
    for (const n of names) docs.push(`${dir}/${n}`);
  };
  collect('docs/prd', CHAPTER_NAME_RE);
  collect('docs/fsd', CHAPTER_NAME_RE);
  collect('docs/adr', ADR_NAME_RE);

  const rows = [];
  const findings = [];
  for (const doc of docs) {
    let text = null;
    try {
      text = fs.readFileSync(path.join(root, ...doc.split('/')), 'utf8');
    } catch {
      text = null;
    }
    const row = { doc, citas: 0, juzgables: 0, cerca: 0, lejos: 0, ausentes: 0, sinAncla: 0, sinArchivo: 0, simbolos: 0 };
    rows.push(row);
    if (text === null) continue;
    row.simbolos = symbolCitationsOf(text).length;
    for (const { line, raw, cita, anchor } of citationsOf(text)) {
      row.citas += 1;
      const dest = path.resolve(root, cita.ruta);
      // Never reach outside the tree under audit: a fixture must not read the
      // real repository.
      if (path.relative(root, dest).startsWith('..')) {
        row.sinArchivo += 1;
        continue;
      }
      const lines = codeLines(dest);
      if (lines === null) {
        // The verifier already fails on this one; here it is only a citation
        // that cannot be judged.
        row.sinArchivo += 1;
        continue;
      }
      if (!anchor) {
        row.sinAncla += 1;
        continue;
      }
      row.juzgables += 1;
      const hits = occurrences(lines, anchor);
      if (hits.length === 0) {
        row.ausentes += 1;
        findings.push({ doc, line, raw, anchor, veredicto: 'ausente', sugerida: null, distancia: null });
        continue;
      }
      let best = hits[0];
      for (const n of hits) if (Math.abs(distance(cita, n)) < Math.abs(distance(cita, best))) best = n;
      const d = distance(cita, best);
      if (d >= -back && d <= fwd) {
        row.cerca += 1;
        continue;
      }
      row.lejos += 1;
      findings.push({ doc, line, raw, anchor, veredicto: 'lejos', sugerida: best, distancia: d });
    }
  }

  const totals = rows.reduce(
    (acc, r) => {
      for (const k of Object.keys(acc)) acc[k] += r[k];
      return acc;
    },
    { citas: 0, juzgables: 0, cerca: 0, lejos: 0, ausentes: 0, sinAncla: 0, sinArchivo: 0, simbolos: 0 },
  );
  findings.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);
  rows.sort((a, b) => (b.lejos + b.ausentes) - (a.lejos + a.ausentes) || a.doc.localeCompare(b.doc));
  return { rows, findings, totals, window: { back, fwd } };
}

const HEADERS = ['documento', 'citas', 'juzgables', 'cerca', 'lejos', 'ausentes', 'sin ancla', 'por símbolo'];

/** The text table of an audit. `list` adds one line per finding. */
export function renderText({ rows, findings, totals, window: win }, { list = false } = {}) {
  const cells = rows
    .filter((r) => r.citas > 0 || r.simbolos > 0)
    .map((r) => [r.doc, r.citas, r.juzgables, r.cerca, r.lejos, r.ausentes, r.sinAncla, r.simbolos].map(String));
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length), 1));
  const fmt = (c) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  const out = [fmt(HEADERS), fmt(widths.map((w) => '-'.repeat(w))), ...cells.map(fmt)];

  if (list) {
    out.push('', 'Hallazgos (la línea sugerida es la ocurrencia más cercana del identificador):');
    for (const f of findings) {
      out.push(
        f.veredicto === 'ausente'
          ? `  ${f.doc}:${f.line}  \`${f.raw}\` — \`${f.anchor}\` no está en ese archivo`
          : `  ${f.doc}:${f.line}  \`${f.raw}\` — \`${f.anchor}\` está en la línea ${f.sugerida} (${f.distancia > 0 ? '+' : ''}${f.distancia})`,
      );
    }
    if (findings.length === 0) out.push('  (ninguno)');
  }

  const pct = totals.juzgables ? ((100 * (totals.lejos + totals.ausentes)) / totals.juzgables).toFixed(1) : '0.0';
  out.push(
    '',
    `${totals.citas} citas · ${totals.juzgables} juzgables (con identificador al lado) · `
      + `${totals.lejos} lejos · ${totals.ausentes} ausentes · ${pct}% de las juzgables`,
    `${totals.sinAncla} citas no llevan identificador al lado y NO se juzgan: que no salgan aquí no dice que estén bien.`,
    `${totals.simbolos} citas por símbolo (\`archivo#símbolo\`): fuera de esta cuenta, las resuelve el verificador y rompe la suite si no puede.`,
    `Ventana: ${win.back} líneas arriba, ${win.fwd} abajo. Informativo: no rompe la suite ni npm test.`,
  );
  return out.join('\n');
}

/** CLI entry. Returns the exit code; never throws on bad input. */
export function main(argv = process.argv.slice(2)) {
  let root = REPO_ROOT;
  let json = false;
  let list = false;
  let failOver = null;
  const win = { ...DEFAULT_WINDOW };
  const entero = (raw, nombre) => {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
    console.error(`${nombre} espera un entero no negativo`);
    return null;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--list') list = true;
    else if (a === '--root') root = path.resolve(argv[(i += 1)] ?? root);
    else if (a === '--back' || a === '--fwd') {
      const n = entero(argv[(i += 1)], a);
      if (n === null) return 2;
      win[a === '--back' ? 'back' : 'fwd'] = n;
    } else if (a === '--fail-over') {
      const n = Number(argv[(i += 1)]);
      if (Number.isInteger(n) && n > 0) failOver = n;
      else {
        console.error('--fail-over espera un entero positivo');
        return 2;
      }
    } else {
      console.error(`argumento desconocido: ${a}`);
      return 2;
    }
  }
  const result = audit(root, { window: win });
  console.log(json ? JSON.stringify(result, null, 2) : renderText(result, { list }));
  if (failOver !== null && result.rows.some((r) => r.lejos + r.ausentes >= failOver)) return 1;
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
