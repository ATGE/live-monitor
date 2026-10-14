// Cerrar un issue sin PR, por la mitad que no toca la red.
//
// Las tres piezas que deciden algo aquí son puras a propósito —
// `validateClosingDraft` (qué se le puede enseñar a una persona),
// `cleanupVerdict` (qué se puede borrar) y `noteClosableOf` (qué se aparca) —
// y este archivo las prueba sin `gh`, sin `git` y sin reloj. Lo que sí toca la
// red (publicar, etiquetar, cerrar) vive en `issue-close-github.test.mjs` y en
// la ventana de confirmación: nadie cierra nada sin que una persona lo lea.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateClosingDraft, cleanupVerdict, noteClosableOf } from '../src/pipeline.js';
import { stripTaggedLine } from '../src/tagged.js';
import { store } from '../src/store.js';
import { CLOSE_COMMENT_MAX } from '../src/github.js';

const LABELS = [
  { name: 'bug', color: 'd73a4a', description: '' },
  { name: 'Documentation', color: '0075ca', description: '' },
];

/** Una propuesta válida, para cambiarle un campo cada vez. */
const draft = (fields = {}) => ({
  verdict: 'closable',
  comment: 'Already covered: the handler at `crates/ui/src/x.rs:120` does this, and `ui_smoke` proves it.',
  reason: 'completed',
  why: 'The requested behavior already exists and is tested.',
  duplicateOf: null,
  labels: [],
  missing: null,
  ...fields,
});

// ---------------------------------------------------------------------------
// validateClosingDraft

test('una propuesta limpia pasa y conserva lo que escribió el agente', () => {
  const r = validateClosingDraft(draft(), { labels: LABELS });
  assert.equal(r.ok, true);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.draft.verdict, 'closable');
  assert.equal(r.draft.reason, 'completed');
  assert.match(r.draft.comment, /crates\/ui\/src\/x\.rs:120/);
});

test('un comentario en español se rechaza, y el rechazo dice por qué', () => {
  const r = validateClosingDraft(
    draft({ comment: 'Esto ya está cubierto por el handler que hay en la interfaz, así que no hace falta ningún cambio.' }),
    { labels: LABELS },
  );
  assert.equal(r.ok, false);
  assert.equal(r.draft, null);
  // El motivo tiene que ser accionable: es lo que se le pega al prompt del
  // segundo intento, y «rechazado» a secas no le dice qué reescribir.
  const dicho = r.rejected.join(' | ');
  assert.match(dicho, /comentario/);
  assert.match(dicho, /acentuadas|español/);
});

test('un comentario más largo que el tope de GitHub se rechaza con la cifra', () => {
  const r = validateClosingDraft(draft({ comment: 'a'.repeat(CLOSE_COMMENT_MAX + 1) }), { labels: LABELS });
  assert.equal(r.ok, false);
  assert.match(r.rejected.join(' | '), new RegExp(String(CLOSE_COMMENT_MAX)));
});

test('un motivo que no es uno de los tres se rechaza', () => {
  const r = validateClosingDraft(draft({ reason: 'wontfix' }), { labels: LABELS });
  assert.equal(r.ok, false);
  const dicho = r.rejected.join(' | ');
  assert.match(dicho, /wontfix/);
  assert.match(dicho, /completed, not_planned, duplicate/);
});

test('«duplicate» sin número no pasa: un duplicado a ojo cierra el issue de otro', () => {
  for (const malo of [null, undefined, 0, -3, 1.5, 'unos cuantos']) {
    const r = validateClosingDraft(draft({ reason: 'duplicate', duplicateOf: malo }), { labels: LABELS });
    assert.equal(r.ok, false, `duplicateOf=${JSON.stringify(malo)} no debería pasar`);
    assert.match(r.rejected.join(' | '), /duplicate/);
  }
  const bueno = validateClosingDraft(draft({ reason: 'duplicate', duplicateOf: '1274' }), { labels: LABELS });
  assert.equal(bueno.ok, true);
  assert.equal(bueno.draft.duplicateOf, 1274, 'el número llega como número, no como cadena');
});

test('las etiquetas desconocidas se descartan; las conocidas se quedan con la grafía del repositorio', () => {
  const r = validateClosingDraft(
    draft({ labels: ['BUG', 'inventada', 'documentation', 'bug'] }),
    { labels: LABELS },
  );
  // Descartar y no fallar: una etiqueta mala no puede tirar todo el análisis.
  assert.equal(r.ok, true);
  assert.deepEqual(r.draft.labels, ['bug', 'Documentation']);
  assert.deepEqual(r.dropped, ['inventada']);
});

test('«unclear» no es un error: se aparca con lo que le falta', () => {
  const r = validateClosingDraft(
    { verdict: 'unclear', comment: '', reason: null, why: '', duplicateOf: null, labels: [], missing: 'whether the R6 path is covered' },
    { labels: LABELS },
  );
  assert.equal(r.ok, true);
  assert.equal(r.draft.verdict, 'unclear');
  assert.equal(r.draft.comment, '', 'sin comentario inventado');
  assert.equal(r.draft.reason, null);
  assert.match(r.draft.missing, /R6/);
});

test('«unclear» sin `missing` sí es un error: no dice nada que la ventana pueda enseñar', () => {
  const r = validateClosingDraft({ verdict: 'unclear', missing: '  ' }, { labels: LABELS });
  assert.equal(r.ok, false);
  assert.match(r.rejected.join(' | '), /missing/);
});

test('un veredicto que no es ninguno de los dos se rechaza', () => {
  const r = validateClosingDraft({ verdict: 'maybe' }, { labels: LABELS });
  assert.equal(r.ok, false);
  assert.match(r.rejected.join(' | '), /veredicto/);
});

// ---------------------------------------------------------------------------
// cleanupVerdict

test('sin nada que perder, se borra el worktree y la rama local', () => {
  const v = cleanupVerdict({ dirty: false, unpushed: 0, commits: false });
  assert.equal(v.worktree, 'removed');
  assert.equal(v.branch, 'deleted');
});

test('sin rama en origin y con commits: se conserva («unpushed === null» no es cero)', () => {
  const v = cleanupVerdict({ dirty: false, unpushed: null, commits: true });
  assert.equal(v.worktree, 'kept');
  assert.equal(v.branch, 'kept');
  assert.match(v.why, /its own commits/);
});

/**
 * El caso sutil, y el que más fácil se escribe mal: la rama está subida del
 * todo (`unpushed === 0`) pero tiene commits. «Todo está en origin, bórralo»
 * suena razonable y es falso: el issue se cerró SIN PR, así que nada mergeó ese
 * trabajo, y el worktree es el único sitio donde está en disco.
 */
test('rama subida del todo pero con commits: se conserva igual', () => {
  const v = cleanupVerdict({ dirty: false, unpushed: 0, commits: true });
  assert.equal(v.worktree, 'kept');
  assert.equal(v.branch, 'kept');
});

test('cambios sin commitear: se conserva, y el motivo los nombra', () => {
  const v = cleanupVerdict({ dirty: true, unpushed: 0, commits: false });
  assert.equal(v.worktree, 'kept');
  assert.equal(v.branch, 'kept');
  assert.match(v.why, /uncommitted/);
});

test('commits sin subir: se conserva', () => {
  const v = cleanupVerdict({ dirty: false, unpushed: 2, commits: true });
  assert.equal(v.worktree, 'kept');
  assert.match(v.why, /2 commit/);
});

test('sin argumentos no borra nada por accidente… salvo que de verdad no haya nada', () => {
  // El valor por defecto describe «worktree limpio, sin commits»: es el único
  // estado en el que borrar no pierde trabajo.
  assert.equal(cleanupVerdict().worktree, 'removed');
  assert.equal(cleanupVerdict({}).branch, 'deleted');
});

// ---------------------------------------------------------------------------
// noteClosableOf

let n = 7000;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.issueClosed = false;
  return Object.assign(task, fields);
}
const CHAT = { id: 'c1', title: 'Principal' };

const CLOSABLE = (json) => `He mirado los tres crates y no hace falta tocar nada.\nCLOSABLE: ${JSON.stringify(json)}`;

test('una línea CLOSABLE válida aparca la sugerencia', () => {
  const task = freshTask();
  const r = noteClosableOf(task, CHAT, CLOSABLE({ reason: 'completed', why: 'Already implemented.', duplicateOf: null }));
  assert.ok(r);
  assert.equal(task.closable.reason, 'completed');
  assert.equal(task.closable.why, 'Already implemented.');
  assert.equal(task.closable.chatId, 'c1');
  assert.equal(task.closable.duplicateOf, null);
  assert.ok(task.closable.at, 'lleva cuándo se dijo');
});

test('un duplicado con número lo conserva como número', () => {
  const task = freshTask();
  noteClosableOf(task, CHAT, CLOSABLE({ reason: 'duplicate', why: 'Same as the other one.', duplicateOf: '1274' }));
  assert.equal(task.closable.duplicateOf, 1274);
});

test('una línea inválida ni aparca ni lanza', () => {
  const malas = [
    CLOSABLE({ reason: 'wontfix', why: 'x', duplicateOf: null }),           // motivo fuera de los tres
    CLOSABLE({ reason: 'completed', why: '   ', duplicateOf: null }),       // sin frase
    CLOSABLE({ reason: 'duplicate', why: 'x', duplicateOf: null }),         // duplicado sin número
    CLOSABLE({ reason: 'completed', why: 'x', duplicateOf: -1 }),           // número imposible
    'CLOSABLE: esto no es JSON',
    'CLOSABLE: {"reason":"completed",',                                      // JSON roto
  ];
  for (const texto of malas) {
    const task = freshTask();
    let r;
    assert.doesNotThrow(() => { r = noteClosableOf(task, CHAT, texto); }, `no debe lanzar con: ${texto.slice(0, 40)}`);
    assert.equal(r, null);
    assert.equal(task.closable ?? null, null, `no debe aparcar nada con: ${texto.slice(0, 40)}`);
  }
});

test('un turno sin la línea deja en paz una sugerencia previa', () => {
  const task = freshTask();
  noteClosableOf(task, CHAT, CLOSABLE({ reason: 'not_planned', why: 'Out of scope.', duplicateOf: null }));
  const antes = { ...task.closable };
  noteClosableOf(task, CHAT, 'He mirado otra cosa y no digo nada del cierre.');
  assert.deepEqual(task.closable, antes, 'un turno callado no borra lo que dijo el anterior');
  // Y una línea rota tampoco.
  noteClosableOf(task, CHAT, 'CLOSABLE: {"reason":"inventado"}');
  assert.deepEqual(task.closable, antes);
});

/**
 * El test que demuestra que DETECTAR no es CERRAR. La línea es una señal para
 * la persona: el día que se publicó sin lector, lo que costó fue una burbuja
 * con JSON crudo y un botón inexistente — no un issue cerrado. Que siga así.
 */
test('detectar no cierra nada: ni `issueClosed` ni `state` se mueven', () => {
  const casos = [
    CLOSABLE({ reason: 'completed', why: 'Already implemented.', duplicateOf: null }),
    CLOSABLE({ reason: 'duplicate', why: 'Same as the other.', duplicateOf: 900 }),
    CLOSABLE({ reason: 'wontfix', why: 'x', duplicateOf: null }),
    'CLOSABLE: no parseable',
    'un turno normal sin línea ninguna',
  ];
  for (const texto of casos) {
    const task = freshTask({ state: 'started' });
    const estadoAntes = task.state;
    noteClosableOf(task, CHAT, texto);
    assert.equal(task.issueClosed, false, `issueClosed se movió con: ${texto.slice(0, 40)}`);
    assert.equal(task.state, estadoAntes, `state se movió con: ${texto.slice(0, 40)}`);
    assert.equal(task.closedWithoutPr ?? false, false);
  }
});

// ---------------------------------------------------------------------------
// El recorte de la burbuja

test('la línea CLOSABLE no llega a la burbuja del chat', () => {
  const texto = 'No hace falta ningún cambio.\nCLOSABLE: {"reason":"completed","why":"Done.","duplicateOf":null}';
  const visto = stripTaggedLine(texto, 'CLOSABLE');
  assert.equal(visto, 'No hace falta ningún cambio.');
  assert.ok(!visto.includes('CLOSABLE'));
});

test('un turno que es SOLO la línea deja el texto vacío, y por eso no se añade mensaje', () => {
  assert.equal(stripTaggedLine('CLOSABLE: {"reason":"completed","why":"Done.","duplicateOf":null}', 'CLOSABLE').trim(), '');
  // Con sangría delante también: el recorte usa el mismo regex que el parser.
  assert.equal(stripTaggedLine('   CLOSABLE: {"reason":"completed"}', 'CLOSABLE').trim(), '');
});

test('un texto que menciona la palabra sin ser la línea se queda entero', () => {
  const texto = 'El bloque CLOSABLE del prompt pide una sola línea al final.';
  assert.equal(stripTaggedLine(texto, 'CLOSABLE'), texto);
});
