// A standing guard: no sentence or label a person reads is written as a string
// literal in web/src. Complements the JSX scanner (web-i18n-untranslated):
// that one reads markup, this one reads every "string", 'string' and `template`
// in .js and .jsx, plus `label:`/`title:`/`placeholder:` values, which are
// user-visible even when they are a single word.
//
// What it does not see: a lone lowercase word with no accent outside a label
// position (`'todas'`), text built at runtime, and anything only reachable in
// the browser. The manual walk in each language covers those. It is
// Unicode-aware (`\p{L}`), so «Sesión iniciada» and «¿Seguro?» are caught.
//
// Not user-visible, and therefore not flagged: import paths, class lists
// (`className` expressions are removed), identifiers, paths, URLs and anything
// with code punctuation. A literal that must stay (a protocol value, a name the
// same in every language) is marked with `i18n-ok: <reason>` in a comment on
// its line, or listed in ALLOWED.
//
// HFSMON_I18N_AREA=card limits the run to one area (see web-i18n-areas.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesInScope, read } from './web-i18n-areas.mjs';

// Exact, whitespace-collapsed strings that are not the app talking.
const ALLOWED = new Set([
  '(max-width: 780px)', // a media query (useSidePanel.js)
  'hljs language-', // a class prefix (viewer/renderDoc.js)
  'noopener noreferrer', // a link `rel`
  'Escape', // KeyboardEvent.key
]);

const clean = (t) => t.replace(/\s+/g, ' ').trim();

/** Removes `className={...}` with its balanced braces. */
function dropClassExpressions(code) {
  let out = '';
  let i = 0;
  const re = /\b(?:className|classList)=\{/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < code.length && depth > 0) {
      if (code[j] === '{') depth++; else if (code[j] === '}') depth--;
      j++;
    }
    out += code.slice(i, m.index);
    i = j;
    re.lastIndex = j;
  }
  return out + code.slice(i);
}

export function codeOf(src) {
  const code = src
    .split('\n').map((line) => (line.includes('i18n-ok') ? '' : line)).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/\s.*$/gm, '$1')
    .replace(/^\s*(?:import|export)\b[^;\n]*?from\s*['"][^'"]*['"];?/gm, '')
    .replace(/^\s*import\s*['"][^'"]*['"];?/gm, '')
    .replace(/\b(?:className|id|key|htmlFor|name|type|role|href|src|rel|target|data-[\w-]+)="[^"]*"/g, '');
  return dropClassExpressions(code);
}

const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

export function literals(src) {
  return [...codeOf(src).matchAll(STRING)].map((m) => {
    const body = m[0].slice(1, -1);
    return clean(m[0][0] === '`' ? body.replace(/\$\{[^}]*\}/g, ' ') : body);
  });
}

// Words inside a class list, used where a class is chosen outside `className`.
const CODE_SHAPE = /[\\/_@$<>{}]|=>|\(\)|;|::|^#|^\.|^https?:/;

export function looksLikeProse(text) {
  const t = clean(text);
  if (!/\p{L}{2,}/u.test(t) || ALLOWED.has(t) || CODE_SHAPE.test(t)) return false;
  const words = t.split(' ');
  if (words.length === 1) {
    if (/[^\x00-\x7f]/.test(t) && /\p{L}/u.test(t)) return true; // «sí», «más», «Año»
    return /^[¿¡]?\p{Lu}\p{Ll}{2,}[.:…!?]*$/u.test(t); // «Cancelar», «Principal»
  }
  // A kebab or snake list of tokens is a class list, not a sentence.
  if (words.every((w) => /^[a-z][\w]*(?:[-_][\w]+)+$|^[a-z]+\d*$/.test(w)) && words.some((w) => /[-_]/.test(w))) return false;
  return words.filter((w) => /\p{L}{2,}/u.test(w)).length >= 2;
}

// `label: 'Cerrar'` and friends: user-visible by name, whatever they look like.
const LABEL_KEY = /(?:^|[\s{,(])(?:label|title|aria-label|ariaLabel|placeholder|alt|hint|tooltip|caption)\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/gu;

export function labels(src) {
  return [...codeOf(src).matchAll(LABEL_KEY)].map((m) => clean(m[1] ?? m[2] ?? ''));
}

const isLabel = (t) => /\p{L}{2,}/u.test(t) && !/^[\p{Lu}\d]+$/u.test(t) && !ALLOWED.has(t) && !CODE_SHAPE.test(t);

export function untranslatedIn(src) {
  return [...new Set([
    ...literals(src).filter(looksLikeProse),
    ...labels(src).filter(isLabel),
  ])].sort();
}

// ---- the detector tests itself, so a regex typo cannot turn it into a no-op ----

test('detector: sees Spanish with accents, ¿¡ and single words', () => {
  assert.deepEqual(untranslatedIn("const a = 'Sesión iniciada';"), ['Sesión iniciada']);
  assert.deepEqual(untranslatedIn('const a = "¿Seguro que quieres borrarla?";'), ['¿Seguro que quieres borrarla?']);
  assert.deepEqual(untranslatedIn("setNote('Cancelar')"), ['Cancelar']);
  assert.deepEqual(untranslatedIn("x ? 'sí' : 'no'"), ['sí']);
  assert.deepEqual(untranslatedIn('const a = `Hay ${n} tareas pendientes`;'), ['Hay tareas pendientes']);
  assert.deepEqual(untranslatedIn("throw new Error('no se pudo cargar')"), ['no se pudo cargar']);
});

test('detector: sees label-like keys even for one lowercase word', () => {
  assert.deepEqual(untranslatedIn("const o = { label: 'plan', other: 1 };"), ['plan']);
  assert.deepEqual(untranslatedIn("{ 'aria-label': x, title: 'cerrar' }"), ['cerrar']);
  assert.deepEqual(untranslatedIn('const o = { placeholder: "Buscar" };'), ['Buscar']);
});

test('detector: leaves identifiers, paths, class lists and imports alone', () => {
  for (const ok of [
    "const s = 'running';", "const k = 'taskCard';", "fetch('/api/tasks')", "import x from './a.js';",
    "export { y } from './b.js';", "import './c.css';", "const u = 'https://github.com/x';",
    "<div className={a ? 'btn btn-sm' : 'chip'} />", "const c = 'btn btn-sm is-open';", "const t = 'GET';",
    "localStorage.getItem('hfsmon-lang')", "const n = '12';", "x.replace(/a/g, '')", "const e = 'a_b';",
    "const m = { label: x, title: t.card.title };", "{ label: 'OK' }",
    "// 'Hola mundo' in a comment", "/* 'Adiós amigo' */ const a = 1;",
    "const a = 'Nombre del proyecto'; // i18n-ok: a protocol value",
  ]) assert.deepEqual(untranslatedIn(ok), [], ok);
});

test('detector: className expressions with nested braces are removed whole', () => {
  assert.deepEqual(untranslatedIn("<i className={`x ${a ? 'on' : 'off'} ${f({ a: 'b c' })}`} />"), []);
});

// ---- the scan ------------------------------------------------------------

for (const { file, name } of filesInScope()) {
  test(`no untranslated string literal in ${name}`, () => {
    assert.deepEqual({ file: name, untranslated: untranslatedIn(read(file)) }, { file: name, untranslated: [] });
  });
}
