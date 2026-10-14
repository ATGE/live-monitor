import './isolate.mjs';   // primero: aisla el directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishProblems, isPublishable } from '../src/language.js';

/**
 * The gate is only worth having if it holds in both directions: it must let
 * real review replies through — they are full of paths, code and identifiers —
 * and it must stop Spanish before it reaches a public PR.
 */

const ok = (text, why) => assert.ok(isPublishable(text), `${why}\n  problemas: ${publishProblems(text).join(' | ')}`);
const blocked = (text, why) => assert.ok(!isPublishable(text), why);

test('deja pasar una respuesta de review real, con rutas y código', () => {
  ok(
    'Done — the cap is now `1` and `SQLITE_MAX_FILE_CONCURRENCY` is gone. '
    + 'See `crates/rest/src/config.rs:602`, where the match arm reads:\n\n'
    + '```rust\nBackendKind::Sqlite => 1,\n```\n\n'
    + 'The three tests below simplify accordingly.',
    'una respuesta normal debe publicarse',
  );
});

test('no confunde rutas ni identificadores con español', () => {
  // "del" lives inside this path, "las" inside this identifier.
  ok('Moved to `crates/model/del/las_rules.rs` and renamed `del_entry`.', 'rutas e identificadores no son prosa');
  ok('Fixed in a/b/del/una.rs and c/las/por.rs — see the diff.', 'dos rutas no hacen un texto en español');
});

test('deja pasar inglés que reusa palabras que también son españolas', () => {
  ok('Left a todo for the follow-up; all todos are tracked in #950.', '"todo/todos" es inglés corriente');
  ok('The sin and cos helpers are unchanged, no era of rewrites here.', '"sin", "cos", "era" son inglés');
  ok('This is a pro/con list: con is that it costs a round-trip.', '"con" es inglés');
  ok('Order the hay before the son of the previous run.', '"hay" y "son" son inglés');
});

test('bloquea una respuesta en español', () => {
  blocked(
    'Listo, ya cambié el valor del clamp a 1 y eliminé la constante, '
    + 'porque como bien dices no aporta nada.',
    'una respuesta en español no puede publicarse',
  );
});

test('bloquea el inglés que se le escapa una frase en español', () => {
  blocked(
    'Done, the cap is now 1 and the constant is gone. '
    + 'Nota: los tests de abajo también se simplificaron.',
    'una sola frase en español ya lo invalida',
  );
});

test('bloquea por acentos y por signos que solo existen en español', () => {
  blocked('Fixed the revisión as requested.', 'un acento basta');
  blocked('¿Done? The clamp is 1 now.', 'los signos de apertura bastan');
  blocked('Renamed the año field.', 'la eñe basta');
});

test('deja pasar préstamos ingleses con acento', () => {
  ok('The naïve approach was a cliché; the café example in the docs still builds.', 'préstamos aceptados');
});

test('permite citar código en español dentro de un bloque', () => {
  // Quoting a Spanish comment that already lives in the repo is not the board
  // writing Spanish — the fence is code, not prose.
  ok(
    'The existing comment there explains it:\n\n```rust\n// el lock exclusivo se mantiene durante la extracción\n```\n\nLeft as is.',
    'el código citado no cuenta como prosa',
  );
});

test('deja pasar el nombre del board', () => {
  ok('Pushed by hfs-monitor after the fix.', 'el board puede nombrarse hacia fuera');
  ok('Generated with HFS Monitor.', 'tampoco con otra grafía');
  ok('Run by hfs_monitor on the runner.', 'ni con guion bajo');
  ok('The board is now called Live Monitor.', 'ni con el nombre nuevo');
});

test('bloquea texto vacío o desmedido', () => {
  blocked('', 'vacío');
  blocked('   \n  ', 'solo espacios');
  blocked('x'.repeat(4001), 'demasiado largo para un comentario de review');
});

test('el tope del título de un PR: 256 pasa, 257 no', async () => {
  // El tope de GitHub, el que la #1125 pasó por cinco caracteres y nueve.
  const { PR_TITLE_MAX } = await import('../src/prtitle.js');
  assert.equal(PR_TITLE_MAX, 256);
  assert.deepEqual(publishProblems(`fix: ${'x'.repeat(251)}`, { maxChars: PR_TITLE_MAX }), [], '256 caracteres se publican');
  const problems = publishProblems(`fix: ${'x'.repeat(252)}`, { maxChars: PR_TITLE_MAX });
  assert.ok(problems.some((p) => /supera 256 caracteres \(257\)/.test(p)), problems.join(' | '));
});

test('el mensaje de error dice qué encontró', () => {
  const problems = publishProblems('Ya está listo, los cambios están en el archivo.');
  assert.ok(problems.some((p) => p.includes('parece español') || p.includes('acentuadas')), problems.join(' | '));
});

test('parseTaggedJson lee la línea REVIEW_REPLIES con saltos escapados', async () => {
  const { parseTaggedJson } = await import('../src/claude.js');
  // Built with JSON.stringify so the escaping under test is the one the agent
  // really emits: a body with newlines, backticks and quotes, all on one line.
  const payload = JSON.stringify({
    replies: [{ threadId: 'PRRT_kwDO1', body: 'Done in `config.rs:602`.\n\nThe "constant" is gone.' }],
    summary: 'Capped at 1.',
  });
  const line = `Ahí van:\nREVIEW_REPLIES: ${payload}\n`;
  const parsed = parseTaggedJson(line, 'REVIEW_REPLIES');
  assert.equal(parsed.replies.length, 1);
  assert.equal(parsed.replies[0].threadId, 'PRRT_kwDO1');
  assert.match(parsed.replies[0].body, /The "constant" is gone/);
  assert.equal(parsed.summary, 'Capped at 1.');
});

test('parseTaggedJson se queda con la última línea válida', async () => {
  const { parseTaggedJson } = await import('../src/claude.js');
  const text = 'REVIEW_REPLIES: {"replies":[],"summary":"first"}\nREVIEW_REPLIES: {"replies":[],"summary":"second"}';
  assert.equal(parseTaggedJson(text, 'REVIEW_REPLIES').summary, 'second');
});

// ---------------------------------------------------------------------------
// Project language and quoted strings

test('a project whose language is not English skips the accent and stopword checks', () => {
  const es = 'Listo, ya cambié el clamp a 1, porque no aporta nada.';
  blocked(es, 'the default stays English');
  assert.deepEqual(publishProblems(es, { language: 'es' }), []);
  assert.deepEqual(publishProblems(es, { language: 'pt-BR' }), []);
  assert.ok(publishProblems(es, { language: 'en-US' }).length > 0, 'en-US is still English');
  assert.ok(publishProblems(es, { language: 'EN' }).length > 0, 'the code is case-insensitive');
});

test('a non-English project still gets the structural checks', () => {
  assert.ok(publishProblems('', { language: 'es' }).length > 0);
  assert.ok(publishProblems('x'.repeat(50), { language: 'es', maxChars: 10 }).length > 0);
  assert.deepEqual(publishProblems('Se arregló hfs-monitor', { language: 'es' }), []);
});

test('quoted Spanish UI strings do not count in English prose', () => {
  ok('The button now reads "Iniciar aplicación" instead of "Levantar la app de este proyecto".', 'double quotes');
  ok('The label changed to “Cerrar huecos: está listo” on the card.', 'curly double quotes');
  ok("The tooltip says 'Levantar la app según su stack' now.", 'single quotes');
  ok('The tooltip says ‘Levantar la app según su stack’ now.', 'curly single quotes');
  ok('The heading is «Cerrar huecos: está listo».', 'guillemets');
  ok('Changed the label to `Iniciar app` (before: `Iniciar HFS`).', 'inline code');
  ok('Before:\n\n```text\nIniciar aplicación está listo porque sí\n```\n\nAfter it is gone.', 'fenced code');
});

test('Spanish outside the quotes is still blocked, and apostrophes do not open a quote', () => {
  blocked('The button says "Iniciar app" pero ahora está roto porque no hace nada.', 'prose beside a quote');
  blocked("It doesn't work porque el archivo está vacío, y that's the cause — también el cambio.", 'an apostrophe must not hide the rest');
  blocked('Listo, ya cambié el clamp, porque no aporta nada.', 'plain Spanish');
});

test('a long quoted Spanish sentence (over 80 chars) is still blocked', () => {
  const long = 'Listo, ya cambié el archivo porque el comportamiento anterior no aportaba nada y además era confuso para todos';
  assert.ok(long.length > 80);
  blocked(`The description now says "${long}" in the card.`, 'long double-quoted span');
  blocked(`The heading is «${long}».`, 'long guillemets');
});

test('keepQuotes makes quoted text count again (raw GraphQL source)', () => {
  const mutation = 'mutation { addComment(input: {body: "Listo, ya está cambiado porque sí."}) { id } }';
  assert.deepEqual(publishProblems(mutation), []);
  assert.ok(publishProblems(mutation, { keepQuotes: true }).length > 0);
});
