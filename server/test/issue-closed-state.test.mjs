// Un issue cerrado en GitHub termina la tarea, donde sea que esté parada.
//
// La decisión vive en una sola función exportada, `completeOnIssueClosed`, que
// comparten la reclasificación y el poller. Aquí se prueba por sus dos puertas:
// llamándola directamente (los estados que la clasificación no mira siquiera) y
// a través de `refreshClassification`, con GitHub entrando solo por los pasos
// inyectables — ninguna prueba de este archivo llama a `gh` ni a `git`.
//
// El caso que lo motivó: la #1126, cerrada por un compañero mientras la tarjeta
// seguía en «PR en borrador», donde se quedó para siempre.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as pipeline from '../src/pipeline.js';
import { store } from '../src/store.js';
import { keyOf } from '../src/keys.js';

const BRANCH = 'fix/1126-closed-by-a-teammate';

const pr = (number, state, { created, merged = null, closed = null } = {}) => ({
  number,
  url: `https://github.com/x/pull/${number}`,
  title: `fix: pr ${number}`,
  state,
  createdAt: created ?? '2026-09-20T00:00:00Z',
  mergedAt: merged,
  closedAt: closed ?? merged,
});
const PR_1126_DRAFT = pr(1126, 'DRAFT');

let n = 11000;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.issueClosed = false;
  return Object.assign(task, fields);
}

/** Lo que GitHub y git dirían, contado (la misma forma que `reopen.test.mjs`). */
function github({ branches = [], linked = [], byBranch = {}, reopenedAt = null, live = {} } = {}) {
  const calls = [];
  return {
    calls,
    findBranchesForIssue: async (issue) => { calls.push(['findBranchesForIssue', issue]); return branches; },
    linkedPullRequests: async (issue) => { calls.push(['linkedPullRequests', issue]); return linked; },
    prsForBranch: async (branch, options) => { calls.push(['prsForBranch', branch, options]); return byBranch[branch] ?? []; },
    issueReopenInfo: async (issue) => { calls.push(['issueReopenInfo', issue]); return reopenedAt; },
    prView: async (number) => {
      calls.push(['prView', number]);
      const state = live[number] ?? 'OPEN';
      return { number, state, isDraft: state === 'DRAFT' };
    },
  };
}

/** La última línea que escribió el guardián. */
const guardLine = (task) => [...task.log].reverse().find((l) => l.phase === 'guard')?.line ?? '';

// ---------------------------------------------------------------------------
// Lo que un issue cerrado termina

test('#1126: un issue cerrado con un PR en borrador abierto llega a «Completada» y el registro nombra el PR', async () => {
  const task = freshTask({
    state: 'pr_draft', classified: true, branch: BRANCH, issueClosed: true,
    prNumber: 1126, prUrl: PR_1126_DRAFT.url, prs: [PR_1126_DRAFT],
  });
  const gh = github({ branches: [BRANCH], byBranch: { [BRANCH]: [PR_1126_DRAFT] } });
  await pipeline.refreshClassification(task, gh);

  assert.equal(task.state, 'done',
    'un issue cerrado es la palabra de GitHub sobre el trabajo: la tarea termina aunque su PR siga abierto');
  assert.equal(task.prNumber, 1126,
    'el PR abierto sigue en la tarjeta: es de donde sale la pista, no de un campo nuevo');
  assert.match(guardLine(task), /issue was closed on GitHub/,
    'el registro dice por qué se movió la tarjeta, no solo que se movió');
  assert.match(guardLine(task), /#1126/,
    'nombra el PR que queda abierto, con su número, para que nadie lo pierda de vista');
  assert.match(guardLine(task), /draft/,
    'y dice que es un borrador: cerrar el issue no lo publica');
});

test('un «error» cuyo issue se cerró termina completado, sin `error` vivo, sin `phase`, y con el mensaje en el registro', () => {
  const task = freshTask({
    state: 'error', issueClosed: true, phase: 'testing', error: 'los tests fallaron', branch: BRANCH,
  });
  assert.equal(pipeline.completeOnIssueClosed(task), 'done',
    '«error» está en CLOSED_OUT_STATES precisamente porque nada más lo asienta');
  assert.equal(task.state, 'done');
  assert.equal(task.error, null,
    '`setState` limpia el error: por eso el mensaje se lee antes de moverla');
  assert.equal(task.phase, null,
    'sin esto `reopenBlocker` contesta «la tarea tiene un ciclo en curso» para siempre y el issue no se puede volver a tomar');
  assert.match(guardLine(task), /los tests fallaron/,
    'el error no se pierde al limpiarlo: queda contado en el registro');
});

test('un plan esperando aprobación cuyo issue se cerró termina completado y sin pregunta parada', () => {
  const task = freshTask({
    state: 'plan_ready', issueClosed: true, phase: 'plan',
    pending: { kind: 'plan', phase: 'plan', question: '¿apruebas el plan?' },
    workPlan: { status: 'proposed', tasks: [] },
  });
  assert.equal(pipeline.completeOnIssueClosed(task), 'done',
    'un plan que nadie va a aprobar ya no es un ciclo en curso: el issue está cerrado');
  assert.equal(task.state, 'done');
  assert.equal(task.pending, null,
    'tras un reinicio no hay espera viva que responder, y el `pending` persistido dejaría un ❓ en una tarjeta «Completada» que nadie puede quitar');
  assert.equal(task.phase, null,
    '`plan_ready` también carga una `phase`: la versión que solo la limpiaba en «error» dejaba la tarea bloqueada para una reapertura');
  assert.match(guardLine(task), /will not run/,
    'el registro avisa de que ese plan no va a correr');
});

// ---------------------------------------------------------------------------
// Lo que NO se toca

test('`forced` en «assigned» manda: la orden aún no ha corrido; con la reapertura retirada sí se completa', () => {
  const ordered = freshTask({ state: 'assigned', issueClosed: true, forced: true });
  const snapshot = JSON.stringify(ordered);
  assert.equal(pipeline.completeOnIssueClosed(ordered), 'skip',
    'un 🚀 en cola (o una parada por cuota) es una orden pendiente, no un estado que el cierre asiente');
  assert.equal(JSON.stringify(ordered), snapshot,
    'y no se escribe nada: ni estado, ni registro, ni `phase`');

  const withdrawn = freshTask({ state: 'assigned', issueClosed: true, forced: true, reopenedAt: '2026-09-20T09:00:00Z' });
  assert.equal(pipeline.completeOnIssueClosed(withdrawn), 'done',
    'la excepción de `keepsForced`: una reapertura anulada por un cierre posterior ya no habla por esa orden');
  assert.equal(withdrawn.state, 'done');
});

test('`forced` en «error» no manda: esa orden ya corrió y falló, y el cierre la zanja', () => {
  // `keepsForced` también retiene `error`, para que Reintentar continúe la
  // misma vuelta. Pero ahí la orden ya se ejecutó: sin este caso, una tarea
  // que arrancaste a mano sobre trabajo previo, que falló, y a la que luego le
  // cerraron el issue en GitHub se quedaba en rojo para siempre.
  const task = freshTask({
    state: 'error', issueClosed: true, forced: true, phase: 'fixing', error: 'los tests fallaron',
  });
  assert.equal(pipeline.completeOnIssueClosed(task), 'done',
    'un 🚀 que ya corrió y falló no protege a la tarea de un issue cerrado');
  assert.equal(task.state, 'done', 'la tarjeta baja a «Completada»');
  assert.equal(task.phase, null, 'y sin `phase`, o ninguna reapertura futura podría tomarse');
  assert.match(guardLine(task), /los tests fallaron/,
    'el mensaje de error se guarda en el registro antes de que `setState` lo borre');

  const queued = freshTask({ state: 'error', issueClosed: true, forced: true, quotaPark: { at: '2026-09-20T09:00:00Z' } });
  assert.equal(pipeline.completeOnIssueClosed(queued), 'skip',
    'pero una espera de cuota sí es una orden pendiente: esa no se toca');
});

test('una ejecución en marcha nunca se interrumpe: contesta «running» y no escribe nada', () => {
  const task = freshTask({ state: 'plan_ready', issueClosed: true, phase: 'plan' });
  pipeline.markRunning(keyOf(task), true);
  try {
    const snapshot = JSON.stringify(task);
    assert.equal(pipeline.completeOnIssueClosed(task), 'running',
      'un pipeline parado en «plan_ready» guarda su clave en `running` aunque su estado no sea activo: es lo que impide arrancarle la aprobación de debajo');
    assert.equal(JSON.stringify(task), snapshot,
      'quien llama escribe una línea y decide la persona; la función no toca la tarea');
  } finally {
    pipeline.markRunning(keyOf(task), false);
  }
});

test('una mudanza o un chat ocupado aplazan el cierre: nada se escribe', () => {
  const moving = freshTask({
    state: 'error', issueClosed: true, error: 'los tests fallaron', prevState: 'testing',
    moving: { from: 'laptop', to: 'runner-1', step: 'blockers', saved: { state: 'error', prevState: 'testing', error: 'los tests fallaron' } },
  });
  const movingSnapshot = JSON.stringify(moving);
  assert.equal(pipeline.completeOnIssueClosed(moving), 'skip',
    'la mudanza guarda `{state, prevState, error}` para devolverlos: `setState` los machacaría y una tarea en error perdería su Reintentar');
  assert.equal(JSON.stringify(moving), movingSnapshot, 'la instantánea de la mudanza sigue siendo la verdad');

  const chatting = freshTask({ state: 'waiting_approval', issueClosed: true, chats: [{ id: 'c1', busy: true, messages: [] }] });
  const chatSnapshot = JSON.stringify(chatting);
  assert.equal(pipeline.completeOnIssueClosed(chatting), 'skip',
    'hay una persona en un turno de chat sobre esta tarea: el cierre espera al siguiente ciclo');
  assert.equal(JSON.stringify(chatting), chatSnapshot, 'y no se escribe nada mientras ese turno corre');

  const done = freshTask({ state: 'done', issueClosed: true, classified: true });
  assert.equal(pipeline.completeOnIssueClosed(done), 'skip', 'una tarea ya terminada no se vuelve a terminar');
  assert.equal(pipeline.completeOnIssueClosed(freshTask({ state: 'assigned' })), 'skip',
    'con el issue abierto esta regla no es asunto suyo');
});

// ---------------------------------------------------------------------------
// La tentación: meter «error» y «plan_ready» en CLASSIFIABLE

test('«error» y «plan_ready» siguen fuera de `CLASSIFIABLE`: la reclasificación no le pregunta nada a GitHub', async () => {
  const gh = github({ branches: [BRANCH], byBranch: { [BRANCH]: [PR_1126_DRAFT] } });
  for (const state of ['error', 'plan_ready']) {
    const task = freshTask({ state, issueClosed: false, branch: BRANCH, phase: 'testing', error: 'los tests fallaron' });
    const snapshot = JSON.stringify(task);
    await pipeline.refreshClassification(task, gh);
    assert.equal(JSON.stringify(task), snapshot,
      `${state}: clasificar aquí pondría \`verdict.state\` en cada poll de un issue ABIERTO y se llevaría el 🔁 Reintentar y su mensaje`);
  }
  assert.deepEqual(gh.calls, [],
    'ni una llamada a `gh`: la regla del cierre se decide en `completeOnIssueClosed`, no ampliando `CLASSIFIABLE`');
});

// ---------------------------------------------------------------------------
// La regla del silencio

test('una tarjeta completada sobre un issue cerrado calla, aunque conserve un PR abierto', async () => {
  const task = freshTask({
    state: 'done', classified: true, issueClosed: true, branch: BRANCH,
    prNumber: 1126, prUrl: PR_1126_DRAFT.url, prs: [PR_1126_DRAFT],
  });
  const gh = github({ branches: [BRANCH], byBranch: { [BRANCH]: [PR_1126_DRAFT] } });
  await pipeline.refreshClassification(task, gh);
  assert.ok(gh.calls.length > 0, 'la primera vuelta sí clasifica: es la que deja la marca de la hora');
  const after = gh.calls.length;
  await pipeline.refreshClassification(task, gh);
  assert.equal(gh.calls.length, after,
    'y la siguiente calla: con el PR abierto en la lista, la regla vieja pagaba un `detectExistingWork` entero en cada ciclo, para siempre');
  assert.equal(task.state, 'done', 'callar no la mueve de sitio');
});

test('y una completada sin ningún PR también calla', async () => {
  const task = freshTask({ state: 'done', classified: true, issueClosed: true, closedWithoutPr: true, prs: [] });
  const gh = github();
  await pipeline.refreshClassification(task, gh);
  assert.ok(gh.calls.length > 0, 'la primera vuelta clasifica');
  const after = gh.calls.length;
  await pipeline.refreshClassification(task, gh);
  assert.equal(gh.calls.length, after,
    'el término `length > 0` que había antes contestaba false para siempre en un cierre sin PR: esa tarjeta nunca callaba');
});

// ---------------------------------------------------------------------------
// El stack no sobrevive a la tarea que lo abrió.

/** Deja el microtask del `.catch` que `completeOnIssueClosed` no espera. */
const settled = () => new Promise((r) => { setImmediate(r); });

/** La última línea que escribió el canal `stack`. */
const stackLine = (task) => [...task.log].reverse().find((l) => l.phase === 'stack')?.line ?? '';

test('una tarea con stack que se completa pide que se pare, por su clave', async () => {
  const calls = [];
  const original = pipeline.issueClosedHooks.stopStack;
  pipeline.issueClosedHooks.stopStack = async (key) => { calls.push(key); };
  try {
    const task = freshTask({
      state: 'error', issueClosed: true, error: 'los tests fallaron', stack: { status: 'running' },
    });
    assert.equal(pipeline.completeOnIssueClosed(task), 'done',
      'el mismo cierre de siempre: un stack no cambia adónde va la tarjeta');
    await settled();
    assert.deepEqual(calls, [keyOf(task)],
      'el stack de la tarea que termina se manda parar exactamente una vez, por la clave de esa tarea');
  } finally {
    pipeline.issueClosedHooks.stopStack = original;
  }
});

test('una tarea sin stack no pide nada: `stopStack` lanza cuando la tarea no tiene uno', async () => {
  const calls = [];
  const original = pipeline.issueClosedHooks.stopStack;
  pipeline.issueClosedHooks.stopStack = async (key) => { calls.push(key); };
  try {
    const task = freshTask({ state: 'error', issueClosed: true, error: 'los tests fallaron' });
    assert.ok(!task.stack, 'de partida esta tarea no tiene stack');
    assert.equal(pipeline.completeOnIssueClosed(task), 'done');
    await settled();
    assert.deepEqual(calls, [], 'la guarda es la misma que en `closeIssueWithoutPr`: sin `task.stack`, no se llama a `stopStack`');
  } finally {
    pipeline.issueClosedHooks.stopStack = original;
  }
});

test('«running» o «skip» no piden nada, aunque la tarea tenga stack: ninguno escribe, por contrato', async () => {
  const calls = [];
  const original = pipeline.issueClosedHooks.stopStack;
  pipeline.issueClosedHooks.stopStack = async (key) => { calls.push(key); };
  try {
    const running = freshTask({ state: 'plan_ready', issueClosed: true, phase: 'plan', stack: { status: 'running' } });
    pipeline.markRunning(keyOf(running), true);
    try {
      assert.equal(pipeline.completeOnIssueClosed(running), 'running');
    } finally {
      pipeline.markRunning(keyOf(running), false);
    }

    const skipped = freshTask({ state: 'assigned', issueClosed: true, forced: true, stack: { status: 'running' } });
    assert.equal(pipeline.completeOnIssueClosed(skipped), 'skip');

    await settled();
    assert.deepEqual(calls, [],
      'solo la rama que de verdad completa la tarea pide el stack; «running» y «skip» no escriben nada más tampoco');
  } finally {
    pipeline.issueClosedHooks.stopStack = original;
  }
});

test('un `stopStack` que rechaza no sale de `completeOnIssueClosed` ni le quita a la tarea llegar a «done»', async () => {
  const original = pipeline.issueClosedHooks.stopStack;
  pipeline.issueClosedHooks.stopStack = async () => { throw new Error('el contenedor no respondió'); };
  try {
    const task = freshTask({
      state: 'error', issueClosed: true, error: 'los tests fallaron', stack: { status: 'running' },
    });
    let result;
    assert.doesNotThrow(() => { result = pipeline.completeOnIssueClosed(task); },
      'el rechazo llega después, en el `.catch` que no se espera: la llamada síncrona no debe verlo');
    assert.equal(result, 'done',
      'el punto del `.catch`: un stack que no se puede parar no debe impedir que la tarea complete');
    await settled();
    assert.match(stackLine(task), /could not stop the stack/,
      'el `.catch` escribe la advertencia en el canal `stack`, sin tumbar la promesa (ni el proceso)');
    assert.match(stackLine(task), /el contenedor no respondió/,
      'y nombra el motivo del rechazo, no solo que algo falló');
  } finally {
    pipeline.issueClosedHooks.stopStack = original;
  }
});
