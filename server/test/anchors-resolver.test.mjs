// El resolvedor de `archivo#símbolo` (`tools/docs/anchors.mjs`): qué es una
// declaración y qué no. `docs.test.mjs` lo usa para las citas reales; aquí se
// prueba con texto sintético, para que cada forma y cada falso positivo tenga
// su propio caso y su propia línea esperada.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSymbol, maskNonCode } from '../../tools/docs/anchors.mjs';

const lineOf = (text, name) => {
  const r = resolveSymbol(text, name);
  return r.ok ? r.line : r;
};

// ---------------------------------------------------------------------------
// Las once formas reales, cada una con su línea
// ---------------------------------------------------------------------------

const REAL = [
  ['una función simple', 'function plain(a) {\n  return a;\n}\n', 'plain', 1],
  ['export async function', '\nexport async function loud(a) {\n}\n', 'loud', 2],
  ['un const con flecha', 'const x = 1;\nconst arrow = (a) => a;\n', 'arrow', 2],
  ['una clase', '\n\nclass Thing {\n}\n', 'Thing', 3],
  ['un método de clase', 'class A {\n  run(fn) {\n    return fn;\n  }\n}\n', 'run', 2],
  ['un método estático async de clase', 'class A {\n  x() {}\n  static async build(o) {\n  }\n}\n', 'build', 3],
  ['una propiedad de objeto con flecha', 'const o = {\n  pick: (a) => a,\n};\n', 'pick', 2],
  ['una propiedad de objeto con function', 'const o = {\n  a: 1,\n  wrap: function (a) {\n  },\n};\n', 'wrap', 3],
  ['un componente JSX como función', 'function Panel({ a }) {\n  return <div>{a}</div>;\n}\n', 'Panel', 1],
  ['un componente JSX como const', 'import x from "y";\nexport const Card = ({ a }) => (\n  <div>{a}</div>\n);\n', 'Card', 2],
  ['un const que además se exporta por nombre', 'const shared = 1;\nexport { shared };\n', 'shared', 1],
];

for (const [nombre, texto, simbolo, linea] of REAL) {
  test(`resolvedor: ${nombre} sigue resolviendo a su línea`, () => {
    assert.deepEqual(
      resolveSymbol(texto, simbolo),
      { ok: true, line: linea },
      `«${nombre}» es una declaración real y debe resolver a la línea ${linea}, la de verdad`,
    );
  });
}

test('resolvedor: un export local de algo declarado en el mismo archivo resuelve a la declaración', () => {
  const t = 'export { a };\n\nfunction a() {}\n';
  assert.deepEqual(
    resolveSymbol(t, 'a'),
    { ok: true, line: 3 },
    'el `export { a }` local no es una segunda declaración: manda la función, en la línea 3',
  );
});

test('resolvedor: un export local sin otra declaración cuenta como declaración', () => {
  assert.deepEqual(
    resolveSymbol('export { hidden as shown };\n', 'shown'),
    { ok: true, line: 1 },
    'un `export { x as y }` local declara el nombre exportado cuando nada más lo declara',
  );
});

// ---------------------------------------------------------------------------
// Falso positivo 1: la reexportación
// ---------------------------------------------------------------------------

test('resolvedor: una reexportación no es una declaración y dice de dónde viene', () => {
  const r = resolveSymbol("export { parseTaggedJson } from './tagged.js';\n", 'parseTaggedJson');
  assert.equal(r.ok, false, 'una reexportación reenvía un símbolo declarado en otro módulo, como un import: no declara nada aquí');
  assert.equal(r.reason, 'mencionado', 'el motivo es «aparece pero no se declara ahí», el mismo que el de un import');
  assert.deepEqual(r.reexport, [{ line: 1, from: './tagged.js' }], 'el resultado dice en qué módulo se declara de verdad, para que el autor cite ese');
});

test('resolvedor: una reexportación con `as` se rechaza por el nombre exportado', () => {
  const r = resolveSymbol('export { a as b, c } from "./x.mjs";\n', 'b');
  assert.equal(r.ok, false, 'el nombre exportado `b` viene de otro módulo aunque se renombre');
  assert.equal(r.reexport?.[0]?.from, './x.mjs', 'con comillas dobles también se lee el módulo de origen');
});

test('resolvedor: una reexportación cuyo nombre también se declara aquí resuelve a la declaración local', () => {
  const t = "function a() {}\nexport { a } from './other.js';\n";
  assert.deepEqual(
    resolveSymbol(t, 'a'),
    { ok: true, line: 1 },
    'si el archivo declara `a` de verdad, la reexportación no le quita la declaración',
  );
});

test('resolvedor: un `from` dentro de un comentario no hace de reexportación una lista local', () => {
  const r = resolveSymbol("export { z }; // from './nowhere.js'\n", 'z');
  assert.deepEqual(r, { ok: true, line: 1 }, 'el `from` de un comentario no cuenta: es un export local y declara `z`');
});

// ---------------------------------------------------------------------------
// Falsos positivos 2 y 3: comentarios de bloque y plantillas
// ---------------------------------------------------------------------------

test('resolvedor: una línea de JSDoc con forma de método no es una declaración', () => {
  const t = 'class A {\n  /**\n   * run(fn) {\n   */\n  other() {}\n}\n';
  const r = resolveSymbol(t, 'run');
  assert.equal(r.ok, false, '` * run(fn) {` dentro de un `/** … */` es texto de comentario, no un método');
  assert.equal(r.reason, 'mencionado', 'sigue apareciendo en el archivo, así que el motivo es «mencionado» y no «ausente»');
});

test('resolvedor: una línea de una plantilla con forma de función no es una declaración', () => {
  const t = 'const s = `\n  function foo(x) {\n  run(fn) {\n`;\n';
  assert.equal(resolveSymbol(t, 'foo').ok, false, 'una línea dentro de una plantilla de varias líneas es texto, no código (function)');
  assert.equal(resolveSymbol(t, 'run').ok, false, 'lo mismo para la forma de método `run(fn) {`');
});

test('resolvedor: un comentario de línea con forma de declaración no es una declaración', () => {
  const t = '// function foo(x) {\nclass A {\n  // run(fn) {\n}\n';
  assert.equal(resolveSymbol(t, 'foo').ok, false, 'lo que sigue a `//` es comentario');
  assert.equal(resolveSymbol(t, 'run').ok, false, 'también con sangría, en un cuerpo de clase');
});

test('resolvedor: un comentario de bloque de varias líneas con una declaración dentro no es una declaración', () => {
  const t = '/* function one(x) {} */\n/*\nfunction two(x) {\n  helper(y) {\n*/\nfunction real() {}\n';
  assert.equal(resolveSymbol(t, 'one').ok, false, 'un comentario de bloque de una línea no declara');
  assert.equal(resolveSymbol(t, 'two').ok, false, 'las líneas del medio de un bloque de varias líneas tampoco');
  assert.equal(resolveSymbol(t, 'helper').ok, false, 'ni una forma de método dentro del bloque');
  assert.deepEqual(resolveSymbol(t, 'real'), { ok: true, line: 6 }, 'tras cerrar el bloque el código vuelve a contar, en su línea real');
});

test('resolvedor: una cadena, también con continuación de línea, no declara nada', () => {
  const t = "const a = 'function foo(x) {';\nconst b = \"\\\n  run(fn) {\";\n";
  assert.equal(resolveSymbol(t, 'foo').ok, false, 'el interior de una cadena no es código');
  assert.equal(resolveSymbol(t, 'run').ok, false, 'una cadena con `\\` al final de línea sigue siendo cadena en la línea siguiente');
});

test('resolvedor: una plantilla con `${ … }` que contiene una función real la declara en su línea', () => {
  const t = 'const s = `a ${ (() => {\n  function inner(x) {\n    return 1;\n  }\n  return inner;\n})() } b`;\n';
  assert.deepEqual(
    resolveSymbol(t, 'inner'),
    { ok: true, line: 2 },
    'lo de dentro de `${ … }` es código: la función declarada ahí cuenta y con su línea real',
  );
});

test('resolvedor: el texto de una plantilla que rodea a un `${ … }` sigue enmascarado', () => {
  const t = 'const s = `\n  function fake(x) {\n  ${ compute(1) }\n  function fake2(x) {\n`;\nfunction after() {}\n';
  assert.equal(resolveSymbol(t, 'fake').ok, false, 'el texto antes de la expresión es plantilla');
  assert.equal(resolveSymbol(t, 'fake2').ok, false, 'el texto después de la expresión también');
  assert.deepEqual(resolveSymbol(t, 'after'), { ok: true, line: 6 }, 'y al cerrar la plantilla el código vuelve, sin perder la cuenta de líneas');
});

test('resolvedor: llaves anidadas dentro de un `${ … }` no cierran la plantilla antes de tiempo', () => {
  const t = 'const s = `${ { a: 1 }.a } function fake(x) {`;\nfunction real() {}\n';
  assert.equal(resolveSymbol(t, 'fake').ok, false, 'el `}` del objeto interior no es el cierre de la expresión: lo que sigue sigue siendo plantilla');
  assert.deepEqual(resolveSymbol(t, 'real'), { ok: true, line: 2 }, 'y el código posterior se lee normal');
});

test('resolvedor: las llaves propias de un `${ … }` se cuentan, y el código tras ellas sigue siendo código', () => {
  const t = 'const s = `${ {}\nfunction inner(x) {}\n}`;\n';
  assert.deepEqual(resolveSymbol(t, 'inner'), { ok: true, line: 2 }, 'el `}` de `{}` cierra el objeto y no la expresión: la línea 2 sigue dentro de `${ … }`, es código');
});

test('resolvedor: una regex con comilla o acento grave no abre una cadena o plantilla', () => {
  const t = "const re = /['\"`]/g;\nconst tick = /`/;\nfunction after() {}\n";
  assert.deepEqual(resolveSymbol(t, 'after'), { ok: true, line: 3 }, 'el acento grave de una regex es de la regex: si abriera una plantilla, el archivo quedaría ilegible y `after` no resolvería');
});

test('resolvedor: una división no se toma por regex', () => {
  const t = 'const half = total / 2;\nfunction after(a) { return a / 3 / 4; }\n';
  assert.deepEqual(resolveSymbol(t, 'after'), { ok: true, line: 2 }, 'tras un identificador `/` divide; no debe enmascarar la línea');
});

// ---------------------------------------------------------------------------
// El enmascarado en sí, y el fallo seguro
// ---------------------------------------------------------------------------

test('enmascarado: conserva la longitud y cada salto de línea', () => {
  const t = 'a /* x\ny */ b `p\n${ q }\nr` c // z\n"s\\\nt" d\r\ne';
  const { masked } = maskNonCode(t);
  assert.equal(masked.length, t.length, 'el texto enmascarado mide lo mismo que el original');
  assert.deepEqual(
    [...masked].map((c, i) => (c === '\n' || c === '\r' ? i : -1)).filter((i) => i >= 0),
    [...t].map((c, i) => (c === '\n' || c === '\r' ? i : -1)).filter((i) => i >= 0),
    'los saltos de línea están en las mismas posiciones: una línea resuelta es la real',
  );
});

test('enmascarado: el código sigue visible y lo demás en blanco', () => {
  const { masked, clean } = maskNonCode("f('x') // c\n");
  assert.equal(masked, "f(   )     \n", 'la cadena y el comentario quedan en blanco; `f(` y `)` intactos');
  assert.equal(clean, true, 'un archivo bien formado se lee limpio');
});

test('fallo seguro: un comentario de bloque sin cerrar rechaza la cita con «ilegible»', () => {
  const t = 'function real() {}\n/* never closed\n';
  const r = resolveSymbol(t, 'real');
  assert.deepEqual(r, { ok: false, reason: 'ilegible' }, 'si el archivo no se puede leer con fiabilidad, ninguna cita a él se acepta en silencio');
});

test('fallo seguro: una plantilla sin cerrar rechaza la cita con «ilegible»', () => {
  const t = 'function real() {}\nconst s = `abierta\nfunction other() {}\n';
  assert.deepEqual(resolveSymbol(t, 'real'), { ok: false, reason: 'ilegible' }, 'una plantilla sin cierre se traga el resto del archivo: se rechaza, no se adivina');
  assert.deepEqual(resolveSymbol(t, 'other'), { ok: false, reason: 'ilegible' }, 'también lo que quedó dentro de ella');
});

test('fallo seguro: una `${` sin cerrar rechaza la cita con «ilegible»', () => {
  assert.equal(resolveSymbol('function real() {}\nconst s = `a ${ b\n', 'real').reason, 'ilegible', 'una expresión de plantilla sin `}` deja el archivo ilegible');
});

test('fallo seguro: una comilla suelta en texto JSX cuesta una línea, no el archivo', () => {
  const t = "function A() {\n  return <p>it's fine</p>;\n}\nfunction B() {}\n";
  assert.deepEqual(resolveSymbol(t, 'B'), { ok: true, line: 4 }, 'una cadena sin cerrar termina en su línea: el apóstrofo del JSX no se traga lo que sigue');
});

test('resolvedor: un nombre que solo está en un comentario es «mencionado», y uno que no está es «ausente»', () => {
  assert.equal(resolveSymbol('// ghost\n', 'ghost').reason, 'mencionado', 'aparece en el archivo, aunque sea en un comentario');
  assert.equal(resolveSymbol('function x() {}\n', 'ghost').reason, 'ausente', 'no aparece en ningún sitio');
});

test('resolvedor: dos declaraciones al mismo nivel siguen siendo ambiguas', () => {
  const r = resolveSymbol('class A {\n  close() {}\n}\nclass B {\n  close() {}\n}\n', 'close');
  assert.deepEqual(r, { ok: false, reason: 'ambiguo', lines: [2, 5] }, 'el enmascarado no cambia la regla de ambigüedad');
});

// ---------------------------------------------------------------------------
// Fail-safe: el mismo texto da el mismo veredicto con LF y con CRLF, y una regex
// tras `=>` no desincroniza el escáner
// ---------------------------------------------------------------------------

const CRLF = (t) => t.split('\n').join('\r\n');

test('resolvedor: una continuación de línea con barra invertida ante CRLF da el mismo veredicto que ante LF', () => {
  const lf = "const s = 'a\\\nfunction evil() {\n';\n";
  const crlf = CRLF(lf);
  assert.ok(crlf.includes('\\\r\n'), 'el texto de prueba lleva de verdad una barra invertida seguida de CR LF');
  const a = resolveSymbol(lf, 'evil');
  const b = resolveSymbol(crlf, 'evil');
  assert.equal(a.ok, false, 'con LF, la línea que sigue a la continuación sigue siendo cadena: no declara `evil`');
  assert.equal(b.ok, false, 'con CRLF también: barra + CR + LF es UNA continuación, no una barra y un fin de cadena');
  assert.deepEqual(b, a, 'la identidad es el punto: un mismo documento no puede dar veredictos distintos en Windows y en Linux');
});

test('resolvedor: la continuación con comilla doble ante CRLF tampoco deja ver la línea siguiente', () => {
  const crlf = CRLF('const s = "a\\\nfunction evil() {\n";\nfunction real() {}\n');
  assert.equal(resolveSymbol(crlf, 'evil').ok, false, 'la cadena de comilla doble se continúa igual que la de comilla simple');
  assert.deepEqual(resolveSymbol(crlf, 'real'), { ok: true, line: 4 }, 'y el código posterior se lee normal, en su línea real');
});

test('resolvedor: una plantilla con barra invertida ante CRLF sigue enmascarada y el código posterior cuenta', () => {
  const lf = 'const s = `a\\\nfunction fake() {\n`;\nfunction real() {}\n';
  for (const [nombre, t] of [['LF', lf], ['CRLF', CRLF(lf)]]) {
    assert.equal(resolveSymbol(t, 'fake').ok, false, `(${nombre}) el texto de una plantilla no declara`);
    assert.deepEqual(resolveSymbol(t, 'real'), { ok: true, line: 4 }, `(${nombre}) tras cerrar la plantilla el código vuelve, en su línea`);
  }
});

test('resolvedor: comentario de línea, cadena sin cerrar, comentario de bloque y `#!` con CRLF conservan las líneas', () => {
  const casos = [
    ['un comentario de línea', '// function fake() {}\nfunction real() {}\n', 2],
    ['una cadena sin cerrar', "const s = 'abc\nfunction real() {}\n", 2],
    ['un comentario de bloque', '/* a\nfunction fake() {}\n*/\nfunction real() {}\n', 4],
    ['una línea `#!`', '#!/usr/bin/env node\nfunction real() {}\n', 2],
  ];
  for (const [nombre, lf, linea] of casos) {
    assert.deepEqual(resolveSymbol(CRLF(lf), 'real'), { ok: true, line: linea }, `${nombre}: con CRLF el código siguiente se lee y con su línea real`);
    assert.equal(resolveSymbol(CRLF(lf), 'fake').ok, false, `${nombre}: con CRLF lo enmascarado sigue sin declarar`);
  }
});

test('enmascarado: con CRLF el texto conserva longitud y cada CR y LF en su posición', () => {
  const t = CRLF("// c\nconst s = 'a\\\nb';\nconst t = `x\ny`;\n/* z\n*/\nconst r = x => /`/;\n");
  const { masked } = maskNonCode(t);
  assert.equal(masked.length, t.length, 'enmascarar sustituye caracteres, no los quita: la longitud es la misma');
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '\r' || t[i] === '\n') assert.equal(masked[i], t[i], `el salto de línea del desplazamiento ${i} queda donde estaba`);
  }
});

test('resolvedor: una regex tras `=>` con acento grave no abre una plantilla y no deja resolver lo de dentro de otra', () => {
  const t = 'const a = x => /`/;\nconst t = `\nfunction ghost() {}\n`;\nconst b = y => /`/;\nfunction real() {}\n';
  const r = resolveSymbol(t, 'ghost');
  assert.equal(r.ok, false, 'tras `=>` la `/` abre una regex: su acento grave no es de una plantilla, y `ghost` es texto de la plantilla real');
  assert.equal(r.reason, 'mencionado', 'sigue apareciendo en el archivo: el motivo es «mencionado»');
  assert.deepEqual(resolveSymbol(t, 'real'), { ok: true, line: 6 }, 'y el código posterior conserva su línea');
  assert.equal(maskNonCode(t).clean, true, 'el escáner llega al final del archivo sin quedar dentro de nada');
});

test('resolvedor: un `>` de cierre de etiqueta JSX no convierte la `/` siguiente en regex', () => {
  const t = 'const a = <p><b>/</b> ok</p>;\n';
  assert.equal(maskNonCode(t).masked, t, 'solo `=>` precede a una regex: tras el `>` de una etiqueta la `/` es texto JSX y no se enmascara nada');
});
