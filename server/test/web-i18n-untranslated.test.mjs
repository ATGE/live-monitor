// A standing guard: no text a person reads is written into a component. Scans
// the JSX of every .jsx under web/src (the i18n layer and its catalogs are not
// scanned) for text nodes, words standing beside a {hole}, and label
// attributes written as plain strings. Text must come from the catalog
// (`t.area.key`), never from the markup.
//
// It reads source, not the render: it cannot see a label built at runtime or
// a state that is only reachable in the browser. The literal scanner
// (web-i18n-literals.test.mjs) covers string literals, and the manual walk in
// each language covers the rest. Unlike the ASCII scanners it was modelled on,
// this one is Unicode-aware (`\p{L}`): «Año», «Sesión» and «¿Seguro?» count.
//
// A line that must keep a literal (a protocol value, a name that is the same
// in every language) says so with `i18n-ok: <reason>` in a comment on the same
// line; or, for text no comment can sit next to, the ALLOWED set below.
//
// HFSMON_I18N_AREA=card limits the run to one area (see web-i18n-areas.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesInScope, read } from './web-i18n-areas.mjs';

// Exact, whitespace-collapsed strings that are not the app talking.
const ALLOWED = new Set([]);

const clean = (t) => t.replace(/\s+/g, ' ').trim();

/** Source without comments, and without the lines that carry `i18n-ok`. */
export function stripped(src) {
  return src
    .split('\n').map((line) => (line.includes('i18n-ok') ? '' : line)).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/\s.*$/gm, '$1');
}

// A number, a unit, punctuation, or a single acronym is not prose.
const NOT_PROSE = /^[\d\s·,.%×x/:+\-–—…()|]*$/u;
const ACRONYM = /^[\p{Lu}\d]+$/u;

export function looksLikeProse(text) {
  const t = clean(text);
  if (!/\p{L}{2,}/u.test(t) || NOT_PROSE.test(t) || ACRONYM.test(t)) return false;
  return !ALLOWED.has(t);
}

/** JSX text nodes: `>Guardar<`, `>¿Seguro?<`. */
export function textNodes(code) {
  const found = [];
  for (const m of code.matchAll(/>\s*([\p{L}¿¡][^<>]*?)\s*</gu)) {
    const t = clean(m[1].replace(/\{[^{}]*\}/g, ' '));
    // Code that only looks like a node: `a > b && c < d`, an arrow's `=>`.
    if (!/[;(){}[\]=|&]/.test(t)) found.push(t);
  }
  return found;
}

/** Words standing beside an interpolation: `{n} tareas`, `Hecho en {ms} ms`. */
export function fragments(code) {
  const found = [];
  for (const m of code.matchAll(/>\s*([^<>]*\{[^<>]*?)\s*</gu)) {
    const words = clean(m[1].replace(/\{[^{}]*\}/g, ' '));
    if (/[;()=|&{}]/.test(words)) continue;
    if (/\p{L}{2,}/u.test(words) && !ACRONYM.test(words) && !ALLOWED.has(words)) found.push(words);
  }
  return found;
}

const LABEL_ATTR = /(?:aria-label|ariaLabel|aria-description|aria-placeholder|label|title|placeholder|summary|alt)\s*=\s*"([^"]+)"/gu;

/** Label attributes written as a plain string. Expressions (`title={t.x}`) are fine. */
export function labelAttrs(code) {
  return [...code.matchAll(LABEL_ATTR)].map((m) => clean(m[1]));
}

export function untranslatedIn(src) {
  const code = stripped(src);
  return [...new Set([
    ...textNodes(code).filter(looksLikeProse),
    ...labelAttrs(code).filter(looksLikeProse),
    ...fragments(code),
  ])].sort();
}

// ---- the detector tests itself, so a regex typo cannot turn it into a no-op ----

test('detector: sees accented and ¿¡ text a plain-ASCII scanner would miss', () => {
  assert.deepEqual(untranslatedIn('<button>Añadir</button>'), ['Añadir']);
  assert.deepEqual(untranslatedIn('<p>¿Seguro que quieres borrarla?</p>'), ['¿Seguro que quieres borrarla?']);
  assert.deepEqual(untranslatedIn('<h2>Sesión iniciada</h2>'), ['Sesión iniciada']);
  assert.deepEqual(untranslatedIn('<span>¡Listo!</span>'), ['¡Listo!']);
  assert.deepEqual(untranslatedIn('<b>Año</b>'), ['Año']);
});

test('detector: sees words beside an interpolation', () => {
  assert.deepEqual(untranslatedIn('<p>{n} tareas</p>'), ['tareas']);
  assert.deepEqual(untranslatedIn('<p>{done} de {total}</p>'), ['de']);
  assert.deepEqual(untranslatedIn('<span>Hecho en {ms} ms</span>'), ['Hecho en ms']);
});

test('detector: sees label attributes written as plain strings', () => {
  assert.deepEqual(untranslatedIn('<input placeholder="Buscar tareas" />'), ['Buscar tareas']);
  assert.deepEqual(untranslatedIn('<button aria-label="Cerrar" title="Cerrar (Esc)" />'), ['Cerrar', 'Cerrar (Esc)']);
});

test('detector: leaves catalog reads, numbers, acronyms and code alone', () => {
  for (const ok of [
    '<p>{t.board.title}</p>', '<b>{n}</b>', '<span>{n}%</span>', '<i>12 ms</i>', '<span>HFS</span>',
    '<span>PR</span>', '<input title={t.card.title} aria-label={label} />', '<a href="/x" type="button" />',
    'if (a > b && c < d) go();', 'const f = () => <Row />;', '<p>{a} · {b}</p>', '<code>42</code>',
  ]) assert.deepEqual(untranslatedIn(ok), [], ok);
});

test('detector: comments and i18n-ok lines are not user-visible', () => {
  assert.deepEqual(untranslatedIn('{/* Cerrar el panel */}\n<p>{x}</p>'), []);
  assert.deepEqual(untranslatedIn('// <p>Hola mundo</p>\n<p>{x}</p>'), []);
  assert.deepEqual(untranslatedIn('<code>npm run build</code> {/* i18n-ok: a command */}'), []);
});

// ---- the scan ------------------------------------------------------------

for (const { file, name } of filesInScope().filter((f) => f.name.endsWith('.jsx'))) {
  test(`no untranslated JSX text in ${name}`, () => {
    assert.deepEqual({ file: name, untranslated: untranslatedIn(read(file)) }, { file: name, untranslated: [] });
  });
}
