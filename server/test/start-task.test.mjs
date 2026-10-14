// Starting one task by hand, against the real pipeline module with an isolated
// data directory and auto-start off. The pipeline body goes through
// `pipelineHooks.run`, so nothing here reaches gh, git or a Claude session:
// each test holds the run open with a promise it settles itself.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './teardown.mjs';
import { planOfRun } from '../src/phases.js';

const dataDir = tempDir('hfsmon-start-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;
let settings;
let upgrade;
const runs = [];   // { task, resumeFrom, stateAtStart, resolve, reject }

before(async () => {
  // A waiting upgrade on disk before anything reads it: the job is loaded
  // once and cached, so this is the one moment it can be planted without
  // `resumeOnBoot`, which would arm the timers that start an upgrade. The
  // first test clears it with «Cancelar».
  writeFileSync(path.join(dataDir, 'upgrade.json'), JSON.stringify({
    id: 'u-start-waiting', state: 'waiting', target: {}, previous: {}, steps: [], runners: {},
    laptop: {}, logTail: [], requestedAt: new Date().toISOString(),
  }));
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  ({ settings } = await import('../src/settings.js'));
  upgrade = await import('../src/upgrade.js');
  settings.update({ autoStart: false, maxActiveTasks: settings.ceiling });
  pipeline.pipelineHooks.run = (task, resumeFrom) => new Promise((resolve, reject) => {
    runs.push({ task, resumeFrom, stateAtStart: task.state, resolve, reject });
  });
});

let n = 7000;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  return Object.assign(task, fields);
}

const lastRunOf = (task) => runs.filter((r) => r.task === task).at(-1);
const settled = () => new Promise((r) => { setImmediate(r); });

/** Starts it and waits for the body to be entered: the hook runs a tick later. */
async function start(task, fn = pipeline.startTask) {
  const result = fn(task.issue);
  await settled();
  return result;
}

async function finish(task, error = null) {
  const run = lastRunOf(task);
  if (error) run.reject(error);
  else run.resolve();
  await settled();
  await settled();
}

test('con una actualización esperando se rechaza con 409 y un mensaje claro', async () => {
  const task = freshTask();
  assert.equal(upgrade.upgradeHoldsNewWork(), true);
  assert.throws(() => pipeline.startTask(task.issue), (e) => e.status === 409 && /board update is waiting/.test(e.message));
  await settled();
  assert.equal(lastRunOf(task), undefined);
  assert.equal(task.state, 'assigned');
  upgrade.cancelUpgrade();
  assert.equal(upgrade.upgradeHoldsNewWork(), false);
});

test('con auto-start apagado, iniciar una tarea asignada y automática arranca el pipeline', async () => {
  assert.equal(settings.autoStart, false);
  const task = freshTask();
  const result = await start(task);
  assert.equal(result.started, true);
  assert.equal(result.mode, 'auto');
  assert.equal(result.oneShot, false);
  assert.equal(typeof result.active, 'number');
  assert.equal(typeof result.limit, 'number');
  assert.equal(result.overLimit, result.active >= result.limit);
  assert.ok(lastRunOf(task), 'el pipeline se lanzó sin pasar por tick()');
  assert.equal(pipeline.isRunning(task.issue), true);
  assert.equal(pipeline.isUserRun(task.issue), false, 'una tarea automática no es una ejecución única');
  await finish(task);
  assert.equal(pipeline.isRunning(task.issue), false);
});

test('en «started» marca forced, pasa por «assigned» y no cambia el modo', async () => {
  const task = freshTask({ state: 'started', branch: 'feat/x' });
  const result = await start(task);
  assert.equal(task.forced, true);
  assert.equal(lastRunOf(task).stateAtStart, 'assigned');
  assert.equal(task.mode, 'auto');
  assert.equal(result.mode, 'auto');
  assert.ok(task.log.some((l) => /start forced by the user/.test(l.line)));
  await finish(task);
});

test('una tarea manual corre una vez: oneShot, sigue manual, no se para en el triage y sale del set al terminar', async () => {
  const task = freshTask({ mode: 'manual', modeDecidedByUser: true });
  const result = await start(task);
  assert.equal(result.oneShot, true);
  assert.equal(result.mode, 'manual');
  assert.equal(task.mode, 'manual');
  assert.equal(pipeline.isUserRun(task.issue), true);
  task.state = 'worktree';   // where the body would be when it reaches the boundary
  assert.equal(pipeline.pausedForModeOf(task, 'el triage'), false, 'la ejecución pedida no se aparca');
  assert.equal(task.state, 'worktree');
  await finish(task);
  assert.equal(pipeline.isUserRun(task.issue), false);
  assert.equal(task.mode, 'manual');
  // With the run over, the board is back to not carrying a manual task on.
  assert.equal(pipeline.pausedForModeOf(task, 'el triage'), true);
});

test('las rondas de reparación respetan la ejecución única: mayCarryOn es true dentro y false fuera', async () => {
  const task = freshTask({ mode: 'manual', modeDecidedByUser: true });
  assert.equal(pipeline.mayCarryOn(task), false, 'manual y sin ejecución pedida: no se lanza otra ronda');
  await start(task);
  assert.equal(pipeline.mayCarryOn(task), true, 'dentro de la ejecución única sí');
  await finish(task);
  assert.equal(pipeline.mayCarryOn(task), false);
  assert.equal(pipeline.mayCarryOn(freshTask()), true, 'una automática siempre sigue');
});

test('la card se entera: el primer broadcast ya dice userRun y uno al terminar dice que no', async () => {
  const task = freshTask({ state: 'started', branch: 'feat/y', mode: 'manual', modeDecidedByUser: true });
  const seen = [];
  const listener = (t) => { if (t === task) seen.push(pipeline.isUserRun(t.issue)); };
  store.on('task', listener);
  try {
    await start(task);
    assert.ok(seen.length > 0);
    assert.equal(seen[0], true, 'antes del cambio de estado y de la primera línea de log');
    seen.length = 0;
    await finish(task);
    assert.ok(seen.length > 0, 'terminar la ejecución emite la tarea');
    assert.equal(seen.at(-1), false);
  } finally {
    store.off('task', listener);
  }
});

test('una ejecución única que falla también sale del set', async () => {
  const task = freshTask({ mode: 'manual', modeDecidedByUser: true });
  await start(task);
  assert.equal(pipeline.isUserRun(task.issue), true);
  await finish(task, new Error('se cayó'));
  assert.equal(pipeline.isUserRun(task.issue), false);
  assert.equal(pipeline.isRunning(task.issue), false);
  assert.equal(task.state, 'error');
  assert.equal(task.mode, 'manual');
});

test('un cuerpo que lanza de forma síncrona llega igualmente al finally', async () => {
  const task = freshTask({ mode: 'manual', modeDecidedByUser: true });
  const hook = pipeline.pipelineHooks.run;
  pipeline.pipelineHooks.run = () => { throw new Error('síncrono'); };
  try {
    pipeline.startTask(task.issue);
    await settled();
    await settled();
    assert.equal(pipeline.isRunning(task.issue), false);
    assert.equal(pipeline.isUserRun(task.issue), false);
    assert.equal(task.state, 'error');
  } finally {
    pipeline.pipelineHooks.run = hook;
  }
});

test('setMode durante una ejecución única la saca del set y la manual se para en la siguiente frontera', async () => {
  const task = freshTask({ mode: 'manual', modeDecidedByUser: true });
  await start(task);
  assert.equal(pipeline.isUserRun(task.issue), true);
  pipeline.setMode(task.issue, 'manual');
  assert.equal(pipeline.isUserRun(task.issue), false);
  assert.equal(pipeline.pausedForModeOf(task, 'el fix'), true);
  await finish(task);
});

test('se rechaza con 409: sin modo confirmado, ya corriendo, en estado activo o mudándose; 404 si no existe', async () => {
  const is409 = (pattern) => (e) => e.status === 409 && pattern.test(e.message);

  const unconfirmed = freshTask({ mode: 'unconfirmed' });
  assert.throws(() => pipeline.startTask(unconfirmed.issue), is409(/automatic or manual/));
  await settled();
  assert.equal(lastRunOf(unconfirmed), undefined);

  const busy = freshTask();
  await start(busy);
  assert.throws(() => pipeline.startTask(busy.issue), is409(/working/));
  await finish(busy);

  const active = freshTask({ state: 'triage' });
  assert.throws(() => pipeline.startTask(active.issue), is409(/working/));
  active.state = 'assigned';

  const moving = freshTask({ moving: { from: 'local', to: 'box', step: 'push' } });
  assert.throws(() => pipeline.startTask(moving.issue), is409(/moving/));
  assert.equal(moving.state, 'assigned', 'nada cambia antes de rechazar');

  const parked = freshTask({ state: 'pr_draft' });
  assert.throws(() => pipeline.startTask(parked.issue), (e) => e.status === 409);

  assert.throws(() => pipeline.startTask(999999), (e) => e.status === 404);
});

test('overLimit es true cuando activas ≥ límite, y aun así arranca', async () => {
  const saved = settings.maxActiveTasks;
  const holder = freshTask();
  pipeline.markRunning(holder.issue, true);
  settings.update({ maxActiveTasks: 1 });
  try {
    const task = freshTask();
    const result = await start(task);
    assert.equal(result.limit, 1);
    assert.ok(result.active >= 1);
    assert.equal(result.overLimit, true);
    assert.equal(result.started, true);
    assert.ok(lastRunOf(task));
    assert.ok(task.log.some((l) => /over the limit/.test(l.line)));
    assert.ok(task.log.some((l) => /e2e test queue/.test(l.line)), 'avisa de que los tests pueden esperar turno');
    await finish(task);
  } finally {
    pipeline.markRunning(holder.issue, false);
    settings.update({ maxActiveTasks: saved });
  }
});

// ---------------------------------------------------------------------------
// Reanudar donde falló: la #1125

const HEAD = '5835cde9aa11bb22cc33';

/** La tarea de la #1125 tal cual quedó: QA a medias, PR sin abrir. */
const parkedAtPr = (over = {}) => freshTask({
  state: 'error',
  prevState: 'browser_qa',
  phase: 'pr',
  error: 'No se publica el título del PR: el texto supera 256 caracteres (265)',
  branch: 'fix/1125-bulk-import-log',
  worktreePath: 'C:/src/hfs-wt/fix-1125-bulk-import-log',
  fixedAt: HEAD,
  e2ePassedAt: HEAD,
  qa: {
    ui: true,
    passedAt: null,          // se paró sola con 5 de 12 pasos: veredicto unverified
    ranAtHead: HEAD,         // …pero corrió 25 minutos en este mismo commit
    results: { verdict: 'unverified', counts: { passed: 5, failed: 0, unverified: 7 } },
  },
  prPark: { proposal: 'fix: el título de 265 caracteres', problems: ['el texto supera 256 caracteres (265)'], at: new Date().toISOString() },
  ...over,
});

test('#1125: un fallo al abrir el PR se reintenta en el PR, sin main, sin tests y sin QA', async () => {
  const task = parkedAtPr();
  assert.equal(pipeline.retry(task.issue), true);
  await settled();
  const run = lastRunOf(task);
  assert.equal(run.resumeFrom, 'pr', 'antes reanudaba en «browser_qa» y repetía 25 minutos de QA');
  const todo = planOfRun(run.resumeFrom);
  assert.equal(todo.mergeMain, false, 'traer main invalidaría los tests y el QA de este commit');
  assert.equal(todo.qa, false);
  assert.equal(todo.e2e, false);
  assert.equal(todo.fix, false);
  assert.ok(task.log.some((l) => /opening the PR/.test(l.line)), 'el log nombra la fase');
  await finish(task);
});

test('sin campo «phase», un «pr_draft» guardado como estado anterior también reanuda en el PR', async () => {
  const task = parkedAtPr({ phase: null, prevState: 'pr_draft' });
  assert.equal(pipeline.retry(task.issue), true);
  await settled();
  assert.equal(lastRunOf(task).resumeFrom, 'pr');
  await finish(task);
});

test('una tarea sin fase ni estado anterior sigue reanudando desde el arranque', async () => {
  const task = freshTask({ state: 'error', phase: null, prevState: null, error: 'algo' });
  assert.equal(pipeline.retry(task.issue), true);
  await settled();
  assert.equal(lastRunOf(task).resumeFrom, 'assigned');
  await finish(task);
});

test('startPipeline deja escrita la fase desde el primer instante', async () => {
  const task = parkedAtPr();
  pipeline.retry(task.issue);
  await settled();
  assert.equal(task.phase, 'pr', 'un fallo temprano se recuerda en su fase, no en la anterior');
  await finish(task);
});

// ---------------------------------------------------------------------------
// «Publicar PR»

test('publishPr: un título largo o en español devuelve 400 con sus motivos y no lanza nada', async () => {
  const task = parkedAtPr();
  const is400 = (e) => e.status === 400 && Array.isArray(e.problems) && e.problems.length > 0;

  await assert.rejects(() => pipeline.publishPr(task.issue, `fix: ${'x'.repeat(252)}`), is400);
  await assert.rejects(() => pipeline.publishPr(task.issue, 'arregla el refresco del log de importación'), is400);
  await assert.rejects(() => pipeline.publishPr(task.issue, '   '), is400);
  await settled();

  assert.equal(lastRunOf(task), undefined, 'ninguna ejecución se lanzó');
  assert.equal(task.prTitle, null, 'ni se guardó el título rechazado');
  assert.equal(task.state, 'error');
});

test('publishPr: con un título bueno guarda el texto, limpia el error y arranca en «pr»', async () => {
  const task = parkedAtPr();
  const title = 'fix(ui): refresh the bulk import submission log while the server records entries';
  assert.equal(pipeline.isRunning(task.issue), false);
  const result = await pipeline.publishPr(task.issue, `  ${title}  `);
  await settled();
  assert.deepEqual(result, { title });
  assert.equal(task.prTitle, title, 'recortado de espacios');
  assert.equal(task.error, null);
  assert.equal(lastRunOf(task).resumeFrom, 'pr');
  assert.ok(task.log.some((l) => l.line.includes(title)));
  assert.equal(task.prPark.problems.length, 1, 'el aparcadero lo limpia la fase al empezar, no la petición');
  // Lo que `publicTask` proyecta como `pipelineRunning`. El estado no sirve
  // para esto: reanudada en el PR, la tarea sigue en «error» hasta que el PR
  // existe, y la tarjeta ofrecería «Publicar PR» y «Reintentar» mientras se
  // está abriendo.
  assert.equal(pipeline.isRunning(task.issue), true, 'mientras se abre el PR la tarjeta debe verlo trabajando');
  assert.equal(task.state, 'error', 'y no se inventa un estado: «pr_draft» significa que el PR existe');
  await finish(task);
  assert.equal(pipeline.isRunning(task.issue), false);
});

test('publishPr: sin nada aparcado no se publica nada', async () => {
  // Reanudar en «pr» da por hechos el worktree, el triage, el fix y los tests.
  // Sobre una tarea recién asignada eso creaba un worktree, lanzaba el triage y
  // escribía en el log que un fix que nadie hizo ya estaba hecho.
  const is409 = (e) => e.status === 409 && /parked PR/.test(e.message);
  const fresh = freshTask();
  await assert.rejects(() => pipeline.publishPr(fresh.issue, 'fix: something perfectly publishable'), is409);
  const noBranch = parkedAtPr({ branch: null });
  await assert.rejects(() => pipeline.publishPr(noBranch.issue, 'fix: something perfectly publishable'), is409);
  await settled();

  assert.equal(lastRunOf(fresh), undefined);
  assert.equal(lastRunOf(noBranch), undefined);
  assert.equal(fresh.prTitle, null, 'ni se guarda el título');
  assert.equal(fresh.state, 'assigned');
});

test('publishPr: con PR abierto, mudándose o trabajando, se niega', async () => {
  const withPr = parkedAtPr({ prNumber: 1126 });
  await assert.rejects(() => pipeline.publishPr(withPr.issue, 'fix: something short'), /already has PR #1126/);

  const moving = parkedAtPr({ moving: { from: 'local', to: 'box', step: 'push' } });
  await assert.rejects(() => pipeline.publishPr(moving.issue, 'fix: something short'), /moving/);

  const active = parkedAtPr({ state: 'browser_qa' });
  await assert.rejects(() => pipeline.publishPr(active.issue, 'fix: something short'), /working/);
  active.state = 'error';

  await assert.rejects(() => pipeline.publishPr(999999, 'fix: something short'), /Unknown task/);
  await settled();
  for (const t of [withPr, moving, active]) assert.equal(lastRunOf(t), undefined);
});

test('publishPr: una tarea manual publica una vez y sigue manual', async () => {
  const task = parkedAtPr({ mode: 'manual', modeDecidedByUser: true });
  await pipeline.publishPr(task.issue, 'fix: publish the pull request title from the card');
  await settled();
  assert.equal(pipeline.isUserRun(task.issue), true, 'la ejecución pedida no se aparca en la frontera de fase');
  assert.equal(task.mode, 'manual');
  await finish(task);
  assert.equal(pipeline.isUserRun(task.issue), false);
});

test('forceStart funciona con auto-start apagado y no toca el modo', async () => {
  const task = freshTask({ state: 'waiting_approval', mode: 'manual', modeDecidedByUser: true });
  assert.equal(await start(task, pipeline.forceStart), true);
  assert.equal(lastRunOf(task).stateAtStart, 'assigned');
  assert.equal(task.forced, true);
  assert.equal(task.mode, 'manual');
  assert.equal(pipeline.isUserRun(task.issue), true, 'lo que publicTask expone como userRun');
  await finish(task);
  assert.equal(pipeline.isUserRun(task.issue), false);
});

// ---------------------------------------------------------------------------
// 🚀 sobre trabajo ya mergeado: un ciclo nuevo, no una adopción (#787)

const MERGED_826 = {
  number: 826, url: 'https://github.com/x/pull/826', title: 'fix: nightly', state: 'MERGED',
  createdAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-02T00:00:00Z', closedAt: '2026-09-02T00:00:00Z',
};

/** La #787 tal como quedó: PR mergeado sin cerrar el issue, y evidencia del ciclo anterior. */
const mergedWork = (over = {}) => freshTask({
  state: 'done',
  branch: 'fix/787-inferno-us-core-nightly',
  prNumber: null,
  prs: [MERGED_826],
  fixedAt: HEAD,
  e2ePassedAt: HEAD,
  qa: { ui: true, passedAt: HEAD, ranAtHead: HEAD },
  workPlan: { status: 'done', tasks: [] },
  fixAttempts: [{ round: 1, tail: 'x', at: 'ayer' }],
  demoSteps: 'pasos del ciclo anterior',
  changeRequests: [{ reviewId: 'r1', status: 'fixed' }, { reviewId: 'r2', status: 'resolved' }],
  activeChangeRequest: 'r1',
  existingWork: { branches: [], prs: [MERGED_826], reasons: ['ya hay PR: #826'] },
  ...over,
});

test('🚀 en «done» con el último PR mergeado abre un ciclo nuevo: nada del anterior se da por hecho', async () => {
  const task = mergedWork();
  await start(task);
  const run = lastRunOf(task);
  assert.ok(run);
  assert.equal(run.stateAtStart, 'assigned', 'desde el arranque, para que se integre main');
  assert.equal(task.forced, true);
  assert.equal(task.prNumber, null);
  assert.equal(task.fixedAt, null, 'el fix no se salta');
  assert.equal(task.e2ePassedAt, null);
  assert.equal(task.qa, null);
  assert.equal(task.workPlan, null, 'un plan viejo no se vuelve a ejecutar');
  assert.deepEqual(task.fixAttempts, []);
  assert.equal(task.demoSteps, null);
  assert.equal(task.existingWork, null);
  assert.equal(task.changeRequests[0].status, 'superseded');
  assert.equal(task.changeRequests[1].status, 'resolved', 'lo resuelto sigue resuelto');
  assert.equal(task.activeChangeRequest, null);
  assert.deepEqual(task.prs.map((p) => p.number), [826], 'el historial se conserva');
  assert.equal(task.reopenedAt, null, 'un 🚀 no es una reapertura');
  assert.ok(task.log.some((l) => /new cycle/.test(l.line) && /#826/.test(l.line)));
  await finish(task);
});

test('🚀 en «waiting_approval» con un PR abierto no abre ciclo: sigue siendo ese PR', async () => {
  const open = { ...MERGED_826, number: 1263, state: 'OPEN', mergedAt: null, closedAt: null };
  const task = mergedWork({ state: 'waiting_approval', prNumber: 1263, prs: [open, MERGED_826] });
  await start(task);
  assert.equal(task.prNumber, 1263);
  assert.equal(task.fixedAt, HEAD);
  assert.ok(!task.log.some((l) => /new cycle/.test(l.line)));
  await finish(task);
});

test('🚀 sin cuota: el ciclo nuevo se abre antes de aparcar, y `forced` sobrevive a la espera', async () => {
  const quota = await import('../src/quota.js');
  quota.resetQuotaForTests();
  quota.noteQuotaHit({ status: 'rejected', via: 'sdk', resetsAt: Date.now() + 60 * 60_000 });
  try {
    const task = mergedWork();
    const result = pipeline.startTask(task.issue);
    await settled();
    assert.equal(result.parked, true);
    assert.equal(lastRunOf(task), undefined);
    assert.equal(task.fixedAt, null, 'lo que arranque al volver la cuota ya es el ciclo nuevo');
    assert.equal(task.forced, true);
    assert.equal(task.state, 'started', 'aparcada donde se puede reanudar');
    // El poll de mientras no la devuelve a «done» por el PR mergeado.
    let asked = 0;
    await pipeline.refreshClassification(task, {
      findBranchesForIssue: async () => { asked += 1; return []; },
      linkedPullRequests: async () => [],
      prsForBranch: async () => [MERGED_826],
      issueReopenInfo: async () => null,
    });
    assert.equal(asked, 0, 'ni se pregunta a GitHub');
    assert.equal(task.state, 'started');
  } finally {
    quota.resetQuotaForTests();
  }
});

test('🚀 sin cuota sobre un PR esperando aprobación: aparca en «waiting_approval», sin forzar nada', async () => {
  const quota = await import('../src/quota.js');
  quota.resetQuotaForTests();
  quota.noteQuotaHit({ status: 'rejected', via: 'sdk', resetsAt: Date.now() + 60 * 60_000 });
  try {
    const open = { ...MERGED_826, number: 1263, state: 'OPEN', mergedAt: null, closedAt: null };
    const task = mergedWork({ state: 'waiting_approval', prNumber: 1263, prs: [open, MERGED_826] });
    const result = pipeline.startTask(task.issue);
    await settled();
    assert.equal(result.parked, true);
    assert.equal(task.state, 'waiting_approval', 'el PR sigue esperando revisión mientras vuelve la cuota');
    assert.notEqual(task.forced, true);
    assert.equal(task.prNumber, 1263);
  } finally {
    quota.resetQuotaForTests();
  }
});
