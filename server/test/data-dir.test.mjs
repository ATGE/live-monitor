// Ninguna prueba puede tocar los datos del tablero de verdad.
//
// `store.js` no es perezoso: `export const store = new Store()` LEE
// `server/data/tasks.json` al importarse, migra cada tarea y termina con un
// `writeFileSync` síncrono del archivo entero (35 MB en la máquina de Edson).
// Un archivo de prueba que llegue a ese módulo sin haber puesto antes
// `HFSMON_DATA_DIR` se lo hace al tablero vivo — y dos procesos de prueba a la
// vez se pisan: `SyntaxError: Unterminated string in JSON` al cargar el módulo.
//
// Pasó de verdad: al añadir el arco `claude.js → quota.js → store.js`, cinco
// archivos que nunca habían tocado el store pasaron a hacerlo. Esta prueba es
// la que lo habría dicho.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(TEST_DIR, '..', 'src');
const STORE = path.join(SRC_DIR, 'store.js');

/** Modules that write into the data directory. Reaching one is the danger. */
const WRITERS = ['store.js', 'quota.js', 'upgrade.js', 'settings.js', 'projects.js', 'boardtimings.js'].map((n) => path.join(SRC_DIR, n));

/** `from './x.js'`, `import './x.js'`, `await import('./x.js')` — literals only. */
const SPECIFIER = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/**
 * A dynamic import whose specifier is not a literal: `await import(where)`.
 * Nothing static can say where that goes, so it is never a blind spot — a file
 * that writes one is an offender until it isolates itself, full stop.
 */
// No `g`: `.test()` on a global regex carries `lastIndex` between calls and
// would answer differently on the same file twice.
const COMPUTED_IMPORT = /\bimport\s*\(\s*(?!['"])[^)]/;

/**
 * The file with its comments blanked out, character for character so every
 * index still points where it did.
 *
 * Scanning the raw text reads prose as code: this very file documents both
 * regexes above with examples, and used to denounce itself for them. It also
 * matters the other way — a commented-out import is not an import, and the
 * word `HFSMON_DATA_DIR` in a comment is not an assignment.
 *
 * Strings and template literals are respected, so a `//` inside a URL is safe.
 * A regex literal containing a comment opener would still confuse it; none of
 * this codebase has one, and the failure mode is a false alarm, not a miss.
 */
function codeOnly(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      while (i < stop) { out += text[i] === '\n' ? '\n' : ' '; i += 1; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < text.length) {
        out += text[i];
        if (text[i] === '\\') { i += 1; if (i < text.length) out += text[i]; i += 1; continue; }
        if (text[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const sources = new Map();
const sourceOf = (file) => {
  if (!sources.has(file)) sources.set(file, codeOnly(readFileSync(file, 'utf8')));
  return sources.get(file);
};

/** Every relative specifier a file imports, static or dynamic. */
function importsOf(file) {
  const found = new Set();
  for (const m of sourceOf(file).matchAll(SPECIFIER)) found.add(m[1]);
  return [...found];
}

/** Every file reachable from `entry` through relative imports, `entry` included. */
const graphs = new Map();
function reachableFrom(entry) {
  if (graphs.has(entry)) return graphs.get(entry);
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) queue.push(path.resolve(path.dirname(file), spec));
  }
  graphs.set(entry, seen);
  return seen;
}

/** Whether importing this module ends up loading something that writes to disk. */
const reachesWriter = (file) => {
  const seen = reachableFrom(file);
  return WRITERS.some((w) => seen.has(w));
};

/** A specifier nothing static can follow. Treated as «could be anything». */
const hasComputedImport = (file) => COMPUTED_IMPORT.test(sourceOf(file));

/** Whether this file has to prove it isolated itself at all. */
const needsIsolating = (file) => reachesWriter(file) || hasComputedImport(file);

const testFiles = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs')).sort();

/**
 * Whether the file isolates its data directory before the first import that
 * would load a writer. The order is the whole point: a static `import` runs
 * before any statement of the file, so either the writer is pulled in
 * dynamically after `HFSMON_DATA_DIR` is set, or `./isolate.mjs` — which sets
 * it as a side effect of being imported — sits above it. Imports that reach no
 * writer (`phases.js`, say) may sit at the top like any other.
 */
function isolatedFirst(file) {
  const text = sourceOf(file);
  // An *assignment*, not the bare name: mentioning `HFSMON_DATA_DIR` in a
  // comment used to satisfy this, which is a hole in the green direction — the
  // guard would pass while the test rewrote the live tasks.json.
  const assigned = text.search(/process\.env\.HFSMON_DATA_DIR\s*(?:\?\?)?=/);
  const marks = [assigned, text.indexOf('./isolate.mjs')].filter((i) => i >= 0);
  const isolatedAt = marks.length ? Math.min(...marks) : Infinity;

  let firstWriter = Infinity;
  for (const m of text.matchAll(SPECIFIER)) {
    if (m[1].includes('isolate.mjs')) continue;
    if (!reachesWriter(path.resolve(path.dirname(file), m[1]))) continue;
    firstWriter = Math.min(firstWriter, m.index);
  }
  // A computed specifier could be anything, so it counts as a writer wherever
  // it sits: better a false alarm somebody has to answer than a module nobody
  // can see.
  const computed = text.search(COMPUTED_IMPORT);
  if (computed >= 0) firstWriter = Math.min(firstWriter, computed);

  return firstWriter === Infinity || isolatedAt < firstWriter;
}

test('ninguna prueba llega a un módulo que escribe en `data/` sin aislarse antes', () => {
  const offenders = [];
  for (const name of testFiles) {
    const file = path.join(TEST_DIR, name);
    if (!needsIsolating(file)) continue;
    if (!isolatedFirst(file)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    'estos archivos llegan a `store.js`, `quota.js`, `upgrade.js` o `settings.js` — quizá de lejos, '
    + 'por `claude.js` — sin poner antes `process.env.HFSMON_DATA_DIR` ni importar `./isolate.mjs`: '
    + 'escribirían en los datos del tablero vivo');
});

test('`quota.js` no arrastra el store: lo importa `claude.js`, y eso es toda la cadena', () => {
  const reachable = reachableFrom(path.join(SRC_DIR, 'quota.js'));
  assert.equal(reachable.has(STORE), false,
    '`quota.js` no puede depender de `store.js`: `claude.js` lo importa, así que toda sesión lo carga');
});

test('`mode.js` no arrastra el tablero, aunque sí la lista de prefijos del SDK', () => {
  const reachable = reachableFrom(path.join(SRC_DIR, 'mode.js'));
  for (const forbidden of ['store.js', 'pipeline.js', 'machine.js', 'settings.js', 'chats.js']) {
    assert.equal(reachable.has(path.join(SRC_DIR, forbidden)), false, `mode.js no debe importar ${forbidden}`);
  }
});


// ---------------------------------------------------------------------------
// La guarda, contra sí misma.
//
// Una guarda de esta forma solo puede fallar hacia el verde: lo que no ve, lo
// deja pasar. Así que aquí se le plantan los dos casos que se le escapaban y se
// comprueba que ahora los señala.
//
// Las líneas de los archivos plantados se construyen en tiempo de ejecución, no
// como literales: si estuvieran escritas tal cual, el escáner de arriba leería
// los datos de prueba de este archivo como imports suyos — y se denunciaría a sí
// mismo. Es el precio de que una guarda lea código fuente.
const spec = (s) => JSON.stringify(s);
const staticImport = (what, from) => `import ${what} from ${spec(from)};`;
const dynamicImport = (name, from) => `const ${name} = await ${'im' + 'port'}(${spec(from)});`;
const computedImport = (name, varName) => `const ${name} = await ${'im' + 'port'}(${varName});`;

const planted = [];
function plant(name, lines) {
  const file = path.join(TEST_DIR, name);
  writeFileSync(file, lines.join('\n'), 'utf8');
  planted.push(file);
  return file;
}
// No acaban en `.test.mjs`, así que el runner no los recoge; viven en este
// directorio para que sus rutas relativas resuelvan como las de una prueba.
after(() => { for (const f of planted) rmSync(f, { force: true }); });

test('la guarda no se deja engañar por el nombre de la variable en un comentario', () => {
  const file = plant('fixture-comment.mjs', [
    '// Aquí se habla de HFSMON_DATA_DIR sin ponerlo, que es justo lo peligroso.',
    staticImport('{ store }', '../src/store.js'),
    'export const x = store;',
  ]);
  assert.equal(needsIsolating(file), true, 'llega al store');
  assert.equal(isolatedFirst(file), false, 'nombrar la variable no es ponerla');

  // Y las formas buenas sí pasan: `=` y `??=`.
  for (const [tag, line] of [['plain', "process.env.HFSMON_DATA_DIR = d;"], ['nullish', "process.env.HFSMON_DATA_DIR ??= d;"]]) {
    const ok = plant(`fixture-set-${tag}.mjs`, [
      "const d = 'x';", line, dynamicImport('{ store }', '../src/store.js'), 'export default store;',
    ]);
    assert.equal(isolatedFirst(ok), true, line);
  }
});

test('un import calculado no es un punto ciego: es un infractor', () => {
  const file = plant('fixture-computed.mjs', [
    "const where = '../src/store.js';",
    computedImport('mod', 'where'),
    'export default mod;',
  ]);
  // Nada estático puede decir a dónde va, así que antes la guarda ni lo miraba:
  // `reachesWriter` es falso y el archivo se saltaba entero.
  assert.equal(reachesWriter(file), false, 'no hay literal que seguir');
  assert.equal(needsIsolating(file), true, 'y aun así hay que responder por él');
  assert.equal(isolatedFirst(file), false);

  const ok = plant('fixture-computed-ok.mjs', [
    "process.env.HFSMON_DATA_DIR = 'x';",
    "const where = '../src/store.js';",
    computedImport('mod', 'where'),
    'export default mod;',
  ]);
  assert.equal(isolatedFirst(ok), true, 'aislado antes, pasa');
});
