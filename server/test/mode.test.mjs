import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAutoStart, findManualKeyword, shouldAskAboutMode, resumeStateFor, migrateTask, keepsForced,
} from '../src/mode.js';

const task = (over = {}) => ({ issue: 1, state: 'assigned', branch: null, prNumber: null, ...over });

test('sólo arranca sola una tarea automática', () => {
  assert.equal(canAutoStart(task()), true, 'sin campo = automática');
  assert.equal(canAutoStart(task({ mode: 'auto' })), true);
  assert.equal(canAutoStart(task({ mode: 'manual' })), false);
  assert.equal(canAutoStart(task({ mode: 'unconfirmed' })), false);
});

test('la palabra se busca en título, etiqueta y cuerpo, y devuelve la frase', () => {
  const t = findManualKeyword({ title: 'Manual test pass: SQLite', body: '', labels: [] });
  assert.equal(t.where, 'título');
  assert.match(t.quote, /Manual test pass/);

  const l = findManualKeyword({ title: 'algo', body: '', labels: ['bug', 'manual'] });
  assert.deepEqual(l, { where: 'etiqueta', quote: 'manual' });

  // El falso positivo real que motivó todo esto: el board debe seguir viéndolo,
  // porque ahora sólo pregunta — pero la cita tiene que dejar claro qué es.
  const b = findManualKeyword({
    title: 'ui: Bulk Import Submission Log never refreshes',
    body: 'The log should update as the server records them, without a manual page reload.',
    labels: [],
  });
  assert.equal(b.where, 'cuerpo');
  assert.match(b.quote, /without a manual page reload/);
});

test('"manualmente" cuenta; "semimanual" no', () => {
  assert.ok(findManualKeyword({ title: 'Probar manualmente el flujo' }));
  assert.equal(findManualKeyword({ title: 'proceso semimanual de carga' }), null);
});

test('la detección no habla de tareas ya empezadas', () => {
  const issue = { title: 'Manual test pass', labels: [] };
  assert.equal(shouldAskAboutMode(task(), issue), true, 'en cola y sin trabajo previo: pregunta');

  assert.equal(shouldAskAboutMode(task({ state: 'fixing' }), issue), false, 'en vuelo: no');
  assert.equal(shouldAskAboutMode(task({ state: 'waiting_approval', prNumber: 946 }), issue), false, 'con PR: no');
  assert.equal(shouldAskAboutMode(task({ branch: 'feat/1-x' }), issue), false, 'con rama: no');
  assert.equal(shouldAskAboutMode(task(), issue, { running: true }), false, 'con pipeline vivo: no');
  assert.equal(shouldAskAboutMode(task(), { ...issue, closed: true }), false, 'issue cerrada: no');
});

test('la detección no pregunta en un segundo ciclo: reabierta o con PRs de antes', () => {
  const issue = { title: 'Manual test pass', labels: [] };
  assert.equal(shouldAskAboutMode(task({ reopenedAt: '2026-09-21T10:00:00.000Z' }), issue), false, 'reabierta: no');
  assert.equal(shouldAskAboutMode(task({ prs: [{ number: 826, state: 'MERGED' }] }), issue), false, 'con PRs del ciclo anterior: no');
  assert.equal(shouldAskAboutMode(task({ prs: [] }), issue), true, 'una lista vacía no cuenta');
});

test('la detección no vuelve a discutir una decisión tuya', () => {
  const issue = { title: 'Manual test pass', labels: [] };
  assert.equal(shouldAskAboutMode(task({ modeDecidedByUser: true }), issue), false);
  assert.equal(shouldAskAboutMode(task({ mode: 'manual' }), issue), false);
  assert.equal(shouldAskAboutMode(task({ mode: 'unconfirmed' }), issue), false, 'ya está preguntando');
});

test('volver a automática reanuda desde la cola, pero no pisa un PR abierto', () => {
  assert.equal(resumeStateFor(task({ state: 'started' })), 'assigned');
  assert.equal(resumeStateFor(task({ state: 'assigned' })), 'assigned');
  assert.equal(resumeStateFor(task({ state: 'waiting_approval' })), null);
  assert.equal(resumeStateFor(task({ state: 'pr_draft' })), null);
  assert.equal(resumeStateFor(task({ state: 'done' })), null);
});

test('migración: las tareas viejas sin ningún campo quedan automáticas', () => {
  const t = migrateTask({ issue: 900, state: 'done' });
  assert.equal(t.mode, 'auto');
  assert.equal(t.modeDecidedByUser, false);
  assert.equal(t.bodyCheckedForMode, false);
  assert.equal(t.fixedAt, null);
});

test('migración: la #937 conserva su trabajo y sale del estado sin salida', () => {
  const t = migrateTask({
    issue: 937, state: 'manual', manual: true, branch: 'feat/937-manual-test-pass-sqlite',
    worktreePath: 'C:/wt/937', complexity: 'complex',
  });
  assert.equal(t.mode, 'manual');
  assert.equal(t.state, 'started', 'con rama, su sitio es «Ya iniciada»');
  assert.equal(t.worktreePath, 'C:/wt/937', 'no pierde el worktree');
  assert.equal(t.complexity, 'complex', 'ni el triage ya pagado');
  assert.equal(t.manual, undefined, 'el flag viejo desaparece');
});

test('migración: una manual sin rama vuelve a la cola', () => {
  assert.equal(migrateTask({ state: 'manual', manual: true }).state, 'assigned');
});

test('migración: la #955 recuerda que ya decidiste', () => {
  const t = migrateTask({ issue: 955, state: 'done', manual: false, manualOverride: true });
  assert.equal(t.mode, 'auto');
  assert.equal(t.modeDecidedByUser, true);
});

test('migración: fixedAt hereda del e2e que ya pasó', () => {
  assert.equal(migrateTask({ state: 'ready', e2ePassedAt: 'abc1234' }).fixedAt, 'abc1234');
});

test('migración: la fase donde quedó la ejecución, con «pr_draft» traducido', () => {
  assert.equal(migrateTask({ state: 'error', phase: 'pr_draft' }).phase, 'pr', 'el estado viejo nombra la fase de abrir el PR');
  assert.equal(migrateTask({ state: 'error', phase: 'browser_qa' }).phase, 'browser_qa');
  assert.equal(migrateTask({ state: 'done' }).phase, null, 'una tarea de antes no tiene fase');
  assert.equal(migrateTask({ state: 'error', phase: 'cualquier cosa' }).phase, null, 'lo que no nombra nada se borra');
});

test('migración: el aparcadero del PR y su título tienen sitio desde el principio', () => {
  const t = migrateTask({ state: 'done' });
  assert.equal(t.prPark, null);
  assert.equal(t.prTitle, null);
  const parked = migrateTask({ state: 'error', prPark: { proposal: 'fix: x', problems: ['supera 256 caracteres (265)'], at: 'ayer' }, prTitle: 'fix: y' });
  assert.equal(parked.prPark.proposal, 'fix: x', 'una propuesta guardada no se toca');
  assert.equal(parked.prTitle, 'fix: y');
});

test('migración: idempotente, se ejecuta en cada arranque', () => {
  const once = migrateTask({ state: 'manual', manual: true, branch: 'x' });
  const twice = migrateTask({ ...once });
  assert.deepEqual(twice, once);
});

test('migración: el modo de demo pasa a auto una sola vez, con marcador', () => {
  const once = migrateTask({ state: 'done', demo: 'on' });
  assert.equal(once.demo, 'auto');
  assert.equal(once.demoMigrated, true);
  once.demo = 'off';
  assert.equal(migrateTask({ ...once }).demo, 'off', 'una elección posterior sobrevive al siguiente arranque');
});

test('migración: la lista de PRs sale de lo último clasificado, sin estados inventados', () => {
  const t = migrateTask({
    state: 'done', prNumber: 826,
    existingWork: {
      branches: [],
      prs: [
        { number: 826, url: 'u826', title: 'fix: a', state: 'MERGED' },
        { number: 1263, url: 'u1263', title: 'fix: b', state: 'MERGED' },
        { number: 900, url: 'u900', title: 'fix: c', state: '' },
      ],
    },
  });
  assert.deepEqual(t.prs.map((p) => p.number), [1263, 826], 'la más reciente primero; la de estado desconocido la rellena el próximo poll');
  assert.equal(t.prs[0].mergedAt, null, 'con la forma completa');
  assert.equal(t.reopenedAt, null);
  assert.deepEqual(migrateTask({ state: 'assigned' }).prs, []);
  const kept = [{ number: 5, state: 'OPEN' }];
  assert.equal(migrateTask({ state: 'waiting_approval', prs: kept }).prs, kept, 'una lista que ya existe no se toca');
});

test('migración: `forced` solo sobrevive donde aún habla de una ejecución pendiente (#787)', () => {
  assert.equal(migrateTask({ state: 'pr_draft', forced: true }).forced, false, 'la #787: congelaba la clasificación');
  assert.equal(migrateTask({ state: 'done', forced: true }).forced, false);
  assert.equal(migrateTask({ state: 'assigned', forced: true }).forced, true, 'en cola: es el permiso de su ejecución');
  assert.equal(migrateTask({ state: 'error', forced: true }).forced, true, 'Reintentar reanuda esa misma ejecución');
  assert.equal(migrateTask({ state: 'started', forced: true, quotaPark: { resumeFrom: 'assigned' } }).forced, true, 'un clic aparcado por la cuota');
  assert.equal(keepsForced({ state: 'ready' }), false);
  assert.equal(keepsForced({ state: 'assigned', reopenedAt: '2026-09-21T10:00:00Z', issueClosed: true }), false,
    'una reapertura cuyo issue se volvió a cerrar ya no autoriza nada');
  assert.equal(keepsForced({ state: 'assigned', reopenedAt: '2026-09-21T10:00:00Z', issueClosed: false }), true);
  // Se decide con el estado ya migrado: un plan_ready sin plan vuelve a la cola, y ahí `forced` vale.
  assert.equal(migrateTask({ state: 'plan_ready', workPlan: null, forced: true }).forced, true);
});

test('migración: `cycleStartedAt` existe desde el principio', () => {
  assert.equal(migrateTask({ state: 'done' }).cycleStartedAt, null);
  assert.equal(migrateTask({ state: 'started', cycleStartedAt: 'x' }).cycleStartedAt, 'x');
});

test('migración: fixGaps se normaliza a auto/on/off', () => {
  assert.equal(migrateTask({ issue: 901, state: 'done' }).fixGaps, 'auto');
  assert.equal(migrateTask({ issue: 902, state: 'done', fixGaps: 'basura' }).fixGaps, 'auto');
  assert.equal(migrateTask({ issue: 903, state: 'done', fixGaps: true }).fixGaps, 'auto');
  for (const v of ['auto', 'on', 'off']) {
    assert.equal(migrateTask({ issue: 904, state: 'done', fixGaps: v }).fixGaps, v);
  }
});

test('migración: design es una marca booleana, apagada salvo que sea exactamente true', () => {
  assert.equal(migrateTask({ issue: 911, state: 'done' }).design, false);
  assert.equal(migrateTask({ issue: 912, state: 'done', design: 'true' }).design, false);
  assert.equal(migrateTask({ issue: 913, state: 'done', design: 1 }).design, false);
  assert.equal(migrateTask({ issue: 914, state: 'done', design: true }).design, true);
  const once = migrateTask({ issue: 915, state: 'done', design: true });
  assert.deepEqual(migrateTask({ ...once }), once, 'idempotent');
});
