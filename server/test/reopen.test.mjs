// Un PR por ciclo: la reclasificación, la reapertura de un issue y
// «Listo para revisión», contra el pipeline de verdad.
//
// GitHub entra solo por los pasos inyectables (`CLASSIFY_STEPS`, `PR_STEPS`,
// `READY_STEPS`): ninguna prueba de aquí llama a `gh` ni a `git`. El caso que
// lo motivó es la #787 — dos PRs mergeados en la misma rama, la tarea en
// «pr_draft» sobre el primero y `forced` congelando la clasificación.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './teardown.mjs';
// Pure and with no server imports of its own, so it is safe before HFSMON_DATA_DIR.
import { DEFAULT_PROJECT_ID } from '../src/keys.js';

const dataDir = tempDir('hfsmon-reopen-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;
let settings;

before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  ({ settings } = await import('../src/settings.js'));
  settings.update({ autoStart: false, browserQa: true });
});

const HEAD = '5835cde9aa11bb22cc33';
const BRANCH = 'fix/787-inferno-us-core-nightly';

const pr = (number, state, { created, merged = null, closed = null } = {}) => ({
  number,
  url: `https://github.com/x/pull/${number}`,
  title: `fix: pr ${number}`,
  state,
  createdAt: created ?? `2026-09-${String(number % 28 + 1).padStart(2, '0')}T00:00:00Z`,
  mergedAt: merged,
  closedAt: closed ?? merged,
});
const PR_826 = pr(826, 'MERGED', { created: '2026-09-01T00:00:00Z', merged: '2026-09-02T12:00:00Z' });
const PR_1263 = pr(1263, 'MERGED', { created: '2026-09-18T00:00:00Z', merged: '2026-09-19T12:00:00Z' });

let n = 9000;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, DEFAULT_PROJECT_ID);
  task.issueClosed = false;
  return Object.assign(task, fields);
}

/** Lo que GitHub y git dirían, contado. */
function github({ branches = [], linked = [], byBranch = {}, reopenedAt = null, live = {}, fail = null, onFetch = null } = {}) {
  const calls = [];
  const maybeFail = (name) => { if (fail === name) throw new Error(`gh ${name} failed: HTTP 502`); };
  return {
    calls,
    findBranchesForIssue: async (issue) => { calls.push(['findBranchesForIssue', issue]); maybeFail('findBranchesForIssue'); onFetch?.(); return branches; },
    linkedPullRequests: async (issue) => { calls.push(['linkedPullRequests', issue]); maybeFail('linkedPullRequests'); return linked; },
    prsForBranch: async (branch, options) => { calls.push(['prsForBranch', branch, options]); maybeFail('prsForBranch'); return byBranch[branch] ?? []; },
    issueReopenInfo: async (issue) => { calls.push(['issueReopenInfo', issue]); maybeFail('issueReopenInfo'); return reopenedAt; },
    prView: async (number) => {
      calls.push(['prView', number]);
      maybeFail('prView');
      const state = live[number] ?? 'OPEN';
      return { number, state, isDraft: state === 'DRAFT' };
    },
  };
}

/** Una tarea terminada con su PR mergeado y la evidencia de ese ciclo. */
const finished = (over = {}) => freshTask({
  state: 'done',
  classified: true,
  branch: BRANCH,
  worktreePath: 'C:/src/hfs-wt/fix-787',
  prs: [PR_826],
  fixedAt: HEAD,
  e2ePassedAt: HEAD,
  qa: { ui: false, passedAt: HEAD, ranAtHead: HEAD },
  ...over,
});

// ---------------------------------------------------------------------------
// La reclasificación

test('#787: «pr_draft» forzada sobre un PR mergeado se repara sola en el siguiente poll', async () => {
  const task = freshTask({
    state: 'pr_draft', forced: true, classified: true, branch: BRANCH,
    prNumber: 826, prUrl: PR_826.url, prs: [],
  });
  const gh = github({ byBranch: { [BRANCH]: [PR_1263, PR_826] } });
  await pipeline.refreshClassification(task, gh);

  assert.equal(task.forced, false, '`forced` no congela la clasificación fuera de «assigned»');
  assert.equal(task.state, 'done');
  assert.equal(task.prNumber, null, 'un PR mergeado no es el PR del ciclo');
  assert.equal(task.prUrl, null);
  assert.deepEqual(task.prs.map((p) => p.number), [1263, 826], 'todos, el más reciente primero');
  assert.deepEqual(gh.calls.find((c) => c[0] === 'prsForBranch'), ['prsForBranch', BRANCH, { cache: false, project: DEFAULT_PROJECT_ID }],
    'en «pr_draft» se pregunta en vivo, por la rama de la tarea aunque git ya no la liste, y en el repositorio de su proyecto');
});

test('`forced` se respeta en «assigned»: esa ejecución aún no ha corrido', async () => {
  const task = freshTask({ state: 'assigned', forced: true, branch: BRANCH });
  const gh = github({ byBranch: { [BRANCH]: [PR_826] } });
  await pipeline.refreshClassification(task, gh);
  assert.equal(task.forced, true);
  assert.equal(task.state, 'assigned');
  assert.equal(gh.calls.length, 0);
});

test('la regla: un PR abierto manda; si no, el más reciente decide', async () => {
  const withOpen = freshTask({ state: 'done', branch: BRANCH });
  await pipeline.refreshClassification(withOpen, github({ byBranch: { [BRANCH]: [pr(1300, 'DRAFT'), PR_1263] } }));
  assert.equal(withOpen.state, 'waiting_approval');
  assert.equal(withOpen.prNumber, 1300);
  assert.equal(withOpen.prUrl, 'https://github.com/x/pull/1300');

  const closedLast = freshTask({ state: 'done', branch: BRANCH });
  await pipeline.refreshClassification(closedLast, github({
    branches: [`origin/${BRANCH}`],
    byBranch: { [BRANCH]: [pr(1300, 'CLOSED', { closed: '2026-09-20T00:00:00Z' }), PR_1263] },
  }));
  assert.equal(closedLast.state, 'started', 'el último se cerró sin mergear: la rama está empezada');
  assert.equal(closedLast.prNumber, null);

  const closedNoBranch = freshTask({ state: 'started' });
  await pipeline.refreshClassification(closedNoBranch, github({
    linked: [pr(1300, 'CLOSED', { closed: '2026-09-20T00:00:00Z' })],
  }));
  assert.equal(closedNoBranch.state, 'assigned', 'sin rama, a la cola');
});

test('los PRs se piden por rama, también los viejos: nada depende de los 200 más recientes', async () => {
  const task = freshTask({ state: 'started', branch: BRANCH });
  const gh = github({
    branches: [`origin/${BRANCH}`, 'fix/787-otro-intento'],
    linked: [{ number: 826, url: PR_826.url, title: '', state: 'MERGED' }],
    byBranch: { [BRANCH]: [PR_826], 'fix/787-otro-intento': [pr(12, 'CLOSED', { closed: '2025-01-01T00:00:00Z' })] },
  });
  await pipeline.refreshClassification(task, gh);
  const asked = gh.calls.filter((c) => c[0] === 'prsForBranch').map((c) => c[1]).sort();
  assert.deepEqual(asked, [BRANCH, 'fix/787-otro-intento'], 'sin «origin/» y sin repetir la rama de la tarea');
  assert.ok(gh.calls.filter((c) => c[0] === 'prsForBranch').every((c) => c[2].cache === true), 'fuera de pr_draft/ready, con caché');
  assert.deepEqual(task.prs.map((p) => p.number), [826, 12]);
  assert.equal(task.prs[0].title, 'fix: pr 826', 'el registro rico gana al del enlace');
  assert.equal(task.state, 'done');
});

test('recién creado el PR, la lista de GitHub puede no traerlo: la tarea no lo pierde', async () => {
  const task = freshTask({
    state: 'pr_draft', branch: BRANCH, prNumber: 1300, prUrl: 'https://github.com/x/pull/1300',
    prs: [{ ...pr(1300, 'DRAFT'), title: 'fix: new cycle' }, PR_826],
  });
  const gh = github({ byBranch: { [BRANCH]: [PR_826] }, live: { 1300: 'DRAFT' } });
  await pipeline.refreshClassification(task, gh);
  assert.deepEqual(gh.calls.filter((c) => c[0] === 'prView'), [['prView', 1300]], 'su estado se pregunta, una vez, en vez de suponerlo');
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.prNumber, 1300);
  assert.deepEqual(task.prs.map((p) => p.number), [1300, 826]);
  assert.equal(task.prs[0].title, 'fix: new cycle');
  assert.equal(task.prs[0].state, 'DRAFT');

  // Y si lo que falta de la lista es que se mergeó entretanto, eso manda.
  const gone = freshTask({ state: 'ready', branch: BRANCH, prNumber: 1300, prs: [pr(1300, 'OPEN')] });
  await pipeline.refreshClassification(gone, github({ live: { 1300: 'MERGED' } }));
  assert.equal(gone.state, 'done');
  assert.equal(gone.prNumber, null);
});

test('un PR mergeado que la tarea conoce no se olvida aunque GitHub no lo devuelva: nunca «assigned»', async () => {
  // Rama borrada al mergear, la tarea sin rama propia y el issue sin enlace:
  // GitHub contesta vacío, y vacío en un issue abierto era «nadie lo ha tocado».
  const task = freshTask({ state: 'done', branch: null, prs: [PR_826] });
  await pipeline.refreshClassification(task, github({ linked: [] }));
  assert.equal(task.state, 'done', 'no vuelve a la cola, así que el auto-arranque no la recoge');
  assert.deepEqual(task.prs.map((p) => p.number), [826]);

  // El último PR cerrado sin mergear, uno anterior mergeado, y sin rama.
  const closedAfterMerge = freshTask({ state: 'done', branch: null, prs: [PR_826] });
  await pipeline.refreshClassification(closedAfterMerge, github({
    linked: [pr(1300, 'CLOSED', { closed: '2026-09-20T00:00:00Z' })],
  }));
  assert.equal(closedAfterMerge.state, 'started', 'hay trabajo mergeado: empezada, no en cola');

  // La guarda de `runPipeline` aplica la misma regla con lo que la tarea sabe.
  const verdict = await pipeline.classifyIssue(task.issue, { task, steps: github({ linked: [] }) });
  assert.equal(verdict.state, 'done');
});

test('un ciclo nuevo sin rama encontrada y con todos los merges anteriores: «started», nunca «assigned»', async () => {
  const task = freshTask({ state: 'started', branch: null, prs: [PR_826], cycleStartedAt: '2026-09-21T08:00:00.000Z' });
  await pipeline.refreshClassification(task, github({ linked: [] }));
  assert.equal(task.state, 'started', '`since` solo elige entre done y started: la cola es del auto-arranque');
  assert.equal(pipeline.classifyPrs([PR_826], [], { since: '2026-09-21T08:00:00.000Z' }).state, 'started');
});

test('un ciclo nuevo que descansa en «started» antes de tener PR no vuelve a «done» por el merge anterior', async () => {
  const task = freshTask({ state: 'started', branch: BRANCH, prs: [PR_826], cycleStartedAt: '2026-09-21T08:00:00.000Z' });
  await pipeline.refreshClassification(task, github({ branches: [`origin/${BRANCH}`], byBranch: { [BRANCH]: [PR_826] } }));
  assert.equal(task.state, 'started');

  // Uno mergeado después de empezar el ciclo sí cuenta.
  const later = pr(1300, 'MERGED', { created: '2026-09-21T09:00:00Z', merged: '2026-09-21T10:00:00Z' });
  await pipeline.refreshClassification(task, github({ branches: [`origin/${BRANCH}`], byBranch: { [BRANCH]: [later, PR_826] } }));
  assert.equal(task.state, 'done');
});

test('lo que cambió mientras gh contestaba no se pisa', async () => {
  const task = freshTask({ state: 'started', branch: BRANCH, prs: [] });
  const gh = github({ byBranch: { [BRANCH]: [PR_826] }, onFetch: () => { task.state = 'assigned'; task.forced = true; } });
  await pipeline.refreshClassification(task, gh);
  assert.equal(task.state, 'assigned', 'un 🚀 llegó a mitad: se respeta');
  assert.equal(task.forced, true);
  assert.deepEqual(task.prs, []);

  const busy = freshTask({ state: 'done', branch: BRANCH, prs: [] });
  await pipeline.refreshClassification(busy, github({ onFetch: () => pipeline.markRunning(busy.issue, true) }));
  pipeline.markRunning(busy.issue, false);
  assert.equal(busy.state, 'done');
  assert.notEqual(busy.classified, true);
});

test('una reapertura cuyo issue se vuelve a cerrar antes de arrancar no arranca', async () => {
  const task = finished({ issueClosed: true });
  await pipeline.reopenIfNeeded(task, true, github({ byBranch: { [BRANCH]: [PR_826] }, reopenedAt: '2026-09-20T09:00:00Z' }));
  assert.equal(task.state, 'assigned');
  assert.equal(task.forced, true);

  task.issueClosed = true;   // lo que el poller anota en el ciclo siguiente
  await pipeline.refreshClassification(task, github({ byBranch: { [BRANCH]: [PR_826] } }));
  assert.equal(task.forced, false);
  assert.equal(task.reopenedAt, null);
  assert.equal(task.cycleStartedAt, null);
  assert.equal(task.state, 'done');
});

test('una tarea terminada con el issue cerrado se reclasifica como mucho una vez por hora', async () => {
  const task = finished({ issueClosed: true, prs: [PR_826] });
  const first = github({ byBranch: { [BRANCH]: [PR_826] } });
  await pipeline.refreshClassification(task, first);
  assert.ok(first.calls.length > 0);
  const second = github({ byBranch: { [BRANCH]: [PR_826] } });
  await pipeline.refreshClassification(task, second);
  assert.equal(second.calls.length, 0);
});

test('si gh falla a medias, la tarea queda exactamente como estaba', async () => {
  const task = freshTask({ state: 'pr_draft', branch: BRANCH, forced: true, prNumber: 826, prs: [PR_826] });
  const snapshot = JSON.stringify(task);
  await assert.rejects(
    () => pipeline.refreshClassification(task, github({ byBranch: { [BRANCH]: [PR_826] }, fail: 'prsForBranch' })),
    /HTTP 502/,
  );
  assert.equal(JSON.stringify(task), snapshot);
});

// ---------------------------------------------------------------------------
// La reapertura

test('detectReopen: pura, idempotente, y solo con un REOPENED posterior al último merge', () => {
  const task = { issue: 1, prs: [PR_1263, PR_826], reopenedAt: null };
  assert.equal(pipeline.detectReopen(task, true, '2026-09-20T09:00:00Z').reopen, true);
  assert.equal(pipeline.detectReopen(task, false, '2026-09-20T09:00:00Z').reopen, true, '`wasClosed` no es condición: un ciclo perdido no pierde la reapertura');
  assert.equal(pipeline.detectReopen(task, true, null).why, 'no-reopen-event');
  assert.equal(pipeline.detectReopen(task, true, '2026-09-10T00:00:00Z').why, 'reopen-before-merge', 'reabierto antes del último merge');
  assert.equal(pipeline.detectReopen({ ...task, reopenedAt: '2026-09-20T09:05:00Z' }, true, '2026-09-20T09:00:00Z').why, 'already-handled');
  assert.equal(pipeline.detectReopen({ ...task, prs: [pr(1300, 'OPEN'), PR_1263] }, true, '2026-09-20T09:00:00Z').why, 'open-pr');
  const deferred = pipeline.detectReopen(task, true, '2026-09-20T09:00:00Z', { blocker: 'hay un turno de chat en marcha' });
  assert.equal(deferred.reopen, false);
  assert.equal(deferred.defer, true);
});

test('reapertura real → ciclo nuevo en «assigned»: el fix no se salta y se abre un PR nuevo', async () => {
  const task = finished({ issueClosed: true, prs: [PR_826] });
  const gh = github({ byBranch: { [BRANCH]: [PR_826] }, reopenedAt: '2026-09-20T09:00:00Z' });
  const decision = await pipeline.reopenIfNeeded(task, true, gh);
  assert.equal(decision.reopen, true);
  assert.equal(task.state, 'assigned', 'el auto-arranque la recoge desde aquí, y así se integra main');
  assert.equal(task.forced, true, 'su propia rama y su PR mergeado no la frenan en la guarda');
  assert.ok(task.reopenedAt, 'la pill «♻️ Reabierta»');
  assert.equal(task.fixedAt, null);
  assert.equal(task.e2ePassedAt, null);
  assert.equal(task.qa, null);
  assert.ok(task.log.some((l) => /new cycle/.test(l.line) && /reopened/.test(l.line)));

  // La ejecución que sigue, con el cuerpo real de `runPipeline` y la fase del
  // PR real: todo se hace otra vez y el PR nuevo va delante del viejo.
  const calls = [];
  const step = (name, fn) => async (...args) => { calls.push(name); return fn?.(...args); };
  let created = 0;
  await pipeline.runPipeline(task, 'assigned', {
    getIssue: async () => ({ number: task.issue, title: 'Inferno US Core nightly', labels: [], body: '' }),
    classifyIssue: step('classifyIssue', async () => ({ state: 'done', pr: null, branches: [], prs: [PR_826], reasons: [] })),
    isProjectWorktree: async () => true,
    ensureWorktree: step('ensureWorktree'),
    bringMain: step('bringMain', async () => ({ merged: true, behind: 0, conflicts: [], blocked: null })),
    headCommit: async () => HEAD,
    hasCommits: async () => true,
    continuationContext: async () => '',
    triagePhase: step('triagePhase'),
    prepareDependencies: step('prepareDependencies', async () => ({ ok: true })),
    fixPhase: step('fixPhase'),
    testPhase: step('testPhase'),
    browserQaPhase: step('browserQaPhase'),
    composePrBody: step('composePrBody'),
    draftPrPhase: (t, issue) => { calls.push('draftPrPhase'); return pipeline.draftPrPhase(t, issue, {
      pushBranch: async () => {},
      findPrForBranch: async () => null,
      createDraftPr: async () => { created += 1; return { number: 1300, url: 'https://github.com/x/pull/1300' }; },
      commitSubject: async () => 'fix(ui): keep the nightly Inferno run green',
      prView: async () => { throw new Error('no hay PR que preguntar'); },
    }); },
    generateDemoSteps: step('generateDemoSteps'),
  });
  assert.ok(!calls.includes('classifyIssue'), '`forced`: la guarda no la para');
  assert.ok(calls.includes('fixPhase'), 'el fix no se salta');
  assert.ok(calls.includes('testPhase'));
  assert.equal(created, 1);
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.prNumber, 1300);
  assert.deepEqual(task.prs.map((p) => p.number), [1300, 826]);
  assert.equal(task.reopenedAt, null, 'con PR, la pill se va');

  // Terminada la ejecución, el siguiente poll ya no la ve como reabierta:
  // el REOPENED que la despertó es anterior a su propio PR.
  const again = await pipeline.reopenIfNeeded(task, false, gh);
  assert.equal(again, null);
});

test('issue abierto con PR mergeado y sin REOPENED: no se toca, y cuesta una sola llamada por poll', async () => {
  const task = finished();
  const snapshot = JSON.stringify(task);
  const gh = github({ byBranch: { [BRANCH]: [PR_826] }, reopenedAt: null });
  assert.equal(await pipeline.reopenIfNeeded(task, false, gh), null);
  assert.deepEqual(gh.calls.map((c) => c[0]), ['issueReopenInfo'], 'ni ramas ni PRs: solo la pregunta barata');
  assert.equal(JSON.stringify(task), snapshot);

  // Un REOPENED anterior al último merge registrado, o ya atendido, tampoco
  // pide más.
  const old = github({ byBranch: { [BRANCH]: [PR_826] }, reopenedAt: '2026-09-01T00:00:00Z' });
  assert.equal(await pipeline.reopenIfNeeded(task, false, old), null);
  assert.deepEqual(old.calls.map((c) => c[0]), ['issueReopenInfo']);
  const acted = github({ byBranch: { [BRANCH]: [PR_826] }, reopenedAt: '2026-09-20T09:00:00Z' });
  assert.equal(await pipeline.reopenIfNeeded({ ...task, reopenedAt: '2026-09-20T10:00:00Z' }, false, acted), null);
  assert.deepEqual(acted.calls.map((c) => c[0]), ['issueReopenInfo']);

  await pipeline.refreshClassification(task, gh);
  assert.equal(task.state, 'done', 'y la clasificación la deja en Completadas');
});

test('un REOPENED antiguo, anterior al último merge, no reabre nada', async () => {
  const task = finished({ prs: [PR_1263, PR_826] });
  const gh = github({ byBranch: { [BRANCH]: [PR_1263, PR_826] }, reopenedAt: '2026-09-10T00:00:00Z' });
  const decision = await pipeline.reopenIfNeeded(task, true, gh);
  assert.equal(decision.why, 'reopen-before-merge');
  assert.equal(task.state, 'done');
  assert.equal(task.fixedAt, HEAD);
});

// El nombre dice «reabierto»: el issue de la fixture está ABIERTO, que es lo
// que el nombre pide y lo que deja ver la regla del PR. El caso del issue
// cerrado es la prueba siguiente, y ya no acaba aquí.
test('reabierto pero con un PR abierto: «waiting_approval» con ese PR, sin ciclo nuevo', async () => {
  const task = finished({ issueClosed: false });
  const gh = github({ byBranch: { [BRANCH]: [pr(1300, 'OPEN'), PR_826] }, reopenedAt: '2026-09-20T09:00:00Z' });
  assert.equal(await pipeline.reopenIfNeeded(task, true, gh), null);
  assert.ok(!gh.calls.some((c) => c[0] === 'issueReopenInfo'), 'ni se pregunta por la reapertura');
  assert.equal(task.fixedAt, HEAD);
  await pipeline.refreshClassification(task, gh);
  assert.equal(task.state, 'waiting_approval');
  assert.equal(task.prNumber, 1300);
});

// El mismo PR abierto, pero con el issue cerrado. Antes esto era
// «waiting_approval»: la tarjeta volvía a «Esperando aprobación» porque el PR
// mandaba. Ahora manda el issue — alguien lo cerró, y eso es la palabra de
// GitHub sobre el trabajo diga lo que diga el PR (`completeOnIssueClosed`) —,
// así que la tarea se queda en «Completada» con el PR todavía nombrado en la
// tarjeta, que es lo único que hay que saber de él.
test('el issue cerrado manda sobre el PR abierto: «Completada», con el PR aún en la tarjeta', async () => {
  const task = finished({ issueClosed: true });
  const gh = github({ byBranch: { [BRANCH]: [pr(1300, 'OPEN'), PR_826] }, reopenedAt: '2026-09-20T09:00:00Z' });
  assert.equal(await pipeline.reopenIfNeeded(task, true, gh), null, 'un PR abierto tampoco abre un ciclo nuevo');
  await pipeline.refreshClassification(task, gh);
  assert.equal(task.state, 'done', 'el issue cerrado deja la tarea en «Completada», diga lo que diga el PR');
  assert.equal(task.prNumber, 1300, 'y el PR abierto sigue nombrado en la tarjeta: es lo que queda por mirar');
  assert.deepEqual(task.prs.map((p) => p.number), [1300, 826], 'el registro de PRs no se pierde al completar');
});

test('ocupada (chat en marcha, mudándose, trabajando): se aplaza al siguiente ciclo, sin perderse', async () => {
  const task = finished({ issueClosed: true, moving: { from: 'local', to: 'box', step: 'push' } });
  const gh = github({ byBranch: { [BRANCH]: [PR_826] }, reopenedAt: '2026-09-20T09:00:00Z' });
  assert.equal(await pipeline.reopenIfNeeded(task, true, gh), null);
  assert.equal(gh.calls.length, 0, 'sin preguntar a GitHub');
  assert.equal(task.state, 'done');

  task.moving = null;
  const chats = task.chats;
  task.chats = [{ id: 'c1', busy: true }];
  assert.equal(await pipeline.reopenIfNeeded(task, true, gh), null, 'un turno de chat en marcha también aplaza');
  task.chats = chats;

  pipeline.markRunning(task.issue, true);
  try {
    assert.equal(await pipeline.reopenIfNeeded(task, true, gh), null);
  } finally {
    pipeline.markRunning(task.issue, false);
  }

  // El ciclo siguiente, ya libre: el mismo evento sigue ahí.
  const decision = await pipeline.reopenIfNeeded(task, false, gh);
  assert.equal(decision.reopen, true);
  assert.equal(task.state, 'assigned');
});

test('un ciclo en curso nunca se reabre: plan esperando, error, o arranque en cola', async () => {
  const gh = github({ byBranch: { [BRANCH]: [PR_826] }, reopenedAt: '2026-09-20T09:00:00Z' });
  const cases = [
    finished({ issueClosed: true, state: 'plan_ready', workPlan: { status: 'proposed', tasks: [] } }),
    finished({ issueClosed: true, state: 'error', phase: 'testing', error: 'los tests fallaron' }),
    finished({ issueClosed: true, state: 'assigned', forced: true }),
    finished({ issueClosed: true, state: 'started', phase: 'fixing' }),
  ];
  for (const task of cases) {
    const snapshot = JSON.stringify(task);
    assert.equal(await pipeline.reopenIfNeeded(task, true, gh), null, task.state);
    assert.equal(JSON.stringify(task), snapshot, `${task.state}: nada se borra`);
  }
  assert.equal(gh.calls.length, 0, 'ni se pregunta a GitHub');
});

test('sin un PR mergeado en el registro ni un cierre visto, no se pregunta nada', async () => {
  const task = freshTask({ state: 'started', branch: BRANCH, prs: [] });
  const gh = github({ reopenedAt: '2026-09-20T09:00:00Z' });
  assert.equal(await pipeline.reopenIfNeeded(task, false, gh), null);
  assert.equal(gh.calls.length, 0);
});

test('si GitHub no responde a la reapertura, la función lanza y la tarea no cambia', async () => {
  const task = finished({ issueClosed: true });
  const snapshot = JSON.stringify(task);
  await assert.rejects(
    () => pipeline.reopenIfNeeded(task, true, github({ byBranch: { [BRANCH]: [PR_826] }, fail: 'issueReopenInfo' })),
    /HTTP 502/,
  );
  assert.equal(JSON.stringify(task), snapshot, 'el poller tampoco escribe `issueClosed`: el próximo ciclo repite');
});

test('el poller usa CLASSIFY_STEPS por defecto: se pueden sustituir sin llamar a gh', async () => {
  const task = finished({ issueClosed: true });
  const saved = { ...pipeline.CLASSIFY_STEPS };
  const { calls, ...fake } = github({ byBranch: { [BRANCH]: [PR_826] }, reopenedAt: '2026-09-20T09:00:00Z' });
  Object.assign(pipeline.CLASSIFY_STEPS, fake);
  try {
    const decision = await pipeline.reopenIfNeeded(task, true);
    assert.equal(decision.reopen, true);
    assert.ok(calls.some((c) => c[0] === 'issueReopenInfo'));
  } finally {
    Object.assign(pipeline.CLASSIFY_STEPS, saved);
  }
});

// ---------------------------------------------------------------------------
// «Listo para revisión»

/** Los pasos de `markReady`, contados. */
function ready({ state = 'DRAFT', reviewerFails = false } = {}) {
  const calls = [];
  return {
    calls,
    prView: async (number) => { calls.push('prView'); return { number, state, isDraft: state === 'DRAFT' }; },
    mergeBeforeReview: async () => { calls.push('mergeBeforeReview'); },
    pushBeforeReview: async () => { calls.push('pushBeforeReview'); },
    readyPr: async () => { calls.push('readyPr'); },
    reclassify: async () => { calls.push('reclassify'); },
    addReviewer: async () => {
      calls.push('addReviewer');
      if (reviewerFails) throw new Error('gh pr edit failed: could not request reviewer');
    },
  };
}

const drafted = (over = {}) => freshTask({
  state: 'pr_draft', branch: BRANCH, prNumber: 826, prUrl: PR_826.url, prs: [pr(826, 'DRAFT')], ...over,
});

test('markReady sobre un PR mergeado: PR_GONE, antes de integrar main o subir nada, y queda en el log', async () => {
  const task = drafted();
  const steps = ready({ state: 'MERGED' });
  await assert.rejects(
    () => pipeline.markReady(task.issue, {}, steps),
    (e) => e.code === 'PR_GONE' && /PR #826 is already merged; this cycle has no PR yet/.test(e.message),
  );
  await new Promise((r) => { setImmediate(r); });
  assert.deepEqual(steps.calls, ['prView', 'reclassify'],
    'la rama de un PR mergeado no recibe merge ni push, y la tarjeta deja de apuntar a ese PR sin esperar al poll');
  assert.equal(task.state, 'pr_draft');
  assert.ok(task.log.some((l) => l.phase === 'pr' && /already merged/.test(l.line)));

  const closed = drafted();
  await assert.rejects(() => pipeline.markReady(closed.issue, {}, ready({ state: 'CLOSED' })), (e) => e.code === 'PR_GONE' && /already closed/.test(e.message));
});

test('markReady en draft: main, push, ready y revisor, en ese orden', async () => {
  const task = drafted();
  const steps = ready();
  await pipeline.markReady(task.issue, {}, steps);
  assert.deepEqual(steps.calls, ['prView', 'mergeBeforeReview', 'pushBeforeReview', 'readyPr', 'addReviewer']);
  assert.equal(task.state, 'ready');
  assert.equal(task.prs[0].state, 'OPEN');
});

test('markReady con el PR ya fuera de draft en GitHub: main y push igual, sin «gh pr ready»', async () => {
  const task = drafted();
  const steps = ready({ state: 'OPEN' });
  await pipeline.markReady(task.issue, {}, steps);
  assert.deepEqual(steps.calls, ['prView', 'mergeBeforeReview', 'pushBeforeReview', 'addReviewer']);
  assert.equal(task.state, 'ready');
});

test('si falla el revisor, el PR ya está listo: la tarea pasa a «ready» y el log dice lo que falta', async () => {
  const task = drafted();
  await pipeline.markReady(task.issue, {}, ready({ reviewerFails: true }));
  assert.equal(task.state, 'ready');
  assert.ok(task.log.some((l) => /the review could not be requested/.test(l.line)));
});

test('cualquier fallo de markReady llega al log de la tarea, no solo al aviso', async () => {
  const task = drafted();
  const steps = ready();
  steps.readyPr = async () => { throw new Error('gh pr ready failed: HTTP 502'); };
  await assert.rejects(() => pipeline.markReady(task.issue, {}, steps), /HTTP 502/);
  assert.equal(task.state, 'pr_draft');
  assert.ok(task.log.some((l) => /«Ready for review» failed: gh pr ready failed/.test(l.line)));

  const noPr = freshTask({ state: 'done' });
  await assert.rejects(() => pipeline.markReady(noPr.issue, {}, ready()), /The task has no PR$/);
  assert.ok(noPr.log.some((l) => /failed/.test(l.line)));
});

// ---------------------------------------------------------------------------
// El cableado del poller

test('poller: lee `issueClosed` antes de sobrescribirlo, y no lo escribe si la comprobación falla', async () => {
  const { noteIssue } = await import('../src/poller.js');
  const task = finished({ issueClosed: true });
  const seen = [];
  await noteIssue(task, { number: task.issue, title: 'nuevo título', labels: ['bug'], closed: false }, {
    reopen: async (t, was) => { seen.push([was, t.issueClosed]); },
  });
  assert.deepEqual(seen, [[true, true]], 'la comprobación recibe lo que vio el ciclo anterior');
  assert.equal(task.issueClosed, false);
  assert.equal(task.title, 'nuevo título');

  const failing = finished({ issueClosed: true });
  const boom = async () => { throw new Error('gh api graphql failed: HTTP 502'); };
  const issue = { number: failing.issue, title: 't', labels: [], closed: false };
  await noteIssue(failing, issue, { reopen: boom });
  await noteIssue(failing, issue, { reopen: boom });
  assert.equal(failing.issueClosed, true, 'el ciclo siguiente vuelve a preguntar desde el mismo sitio');
  assert.equal(failing.log.filter((l) => /could not check whether the issue was reopened/.test(l.line)).length, 1, 'el mismo fallo, una línea');

  const closed = finished({ issueClosed: false });
  let asked = 0;
  await noteIssue(closed, { number: closed.issue, title: 't', labels: [], closed: true }, { reopen: async () => { asked += 1; } });
  assert.equal(closed.issueClosed, true);
  assert.equal(asked, 0, 'un issue cerrado no se comprueba');
});

// El barrido por número: lo que el listado de cerrados no puede contar.
//
// `gh issue list --state closed --limit 12` ordena por NÚMERO descendente, no
// por fecha de cierre: la #1126 está en la posición 17 y la #937 en la 30
// aunque fueron las dos últimas en cerrarse, así que `noteIssue` nunca corrió
// para ellas. `sweepClosedIssues` pregunta por número, y aquí entra solo por su
// paso inyectable: ninguna de estas pruebas llama a `gh`.

/** Un proyecto propio por prueba: el barrido recorre `store.all()`, que es el
 *  almacén entero, y las tareas de las pruebas de arriba viven todas en «hfs»;
 *  con su propio id, lo que cada prueba barre es exactamente lo que ella creó. */
let sweeps = 0;
const ownProject = () => ({ id: `sweep${++sweeps}` });

/** Una tarea de un proyecto dado, con su número si hace falta fijarlo. */
function taskIn(projectId, fields = {}, number = null) {
  n += 1;
  const issue = number ?? n;
  const task = store.addTask(
    { number: issue, title: `t${issue}`, labels: [], url: `https://x/${issue}`, closed: false },
    projectId,
  );
  task.issueClosed = false;
  return Object.assign(task, fields);
}

/** Lo que `issueStates` contestaría, contado. `rows` es `{ número: cerrado }`,
 *  y un número que no esté ahí está AUSENTE del mapa, como en github.js. */
function states(rows = {}, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    issueStates: async (numbers, projectId) => {
      calls.push([[...numbers].sort((a, b) => a - b), projectId]);
      if (fail) throw new Error('gh api graphql (estado de issues) failed: HTTP 502');
      return new Map(Object.entries(rows).map(([number, closed]) => [Number(number), {
        number: Number(number), title: `t${number}`, url: `https://x/${number}`, closed, labels: [],
      }]));
    },
  };
}

// El barrido nunca vuelve a llamar a `noteIssue` con la bandera ya puesta (la
// respuesta coincide y se salta), así que la protección del aviso hay que
// probarla por la otra puerta: el listado de cerrados SÍ trae el mismo issue en
// cada ciclo, y ahí es donde una línea por poll se acumularía en la tarjeta.
test('poller: el aviso de un cierre cuelga del cambio de bandera — una vez, y otra si se reabre y se vuelve a cerrar', async () => {
  const { noteIssue } = await import('../src/poller.js');
  const task = taskIn(ownProject().id, { state: 'fixing', phase: 'fixing' });
  const closed = { number: task.issue, title: 't', labels: [], closed: true };
  const open = { number: task.issue, title: 't', labels: [], closed: false };
  const tried = [];
  const deps = { reopen: async () => {}, complete: (t) => { tried.push(t.state); return 'running'; } };
  const warned = () => task.log.filter((l) => l.phase === 'poll' && /with a run in progress/.test(l.line)).length;

  await noteIssue(task, closed, deps);
  await noteIssue(task, closed, deps);
  await noteIssue(task, closed, deps);
  assert.equal(warned(), 1, 'sin leer `was` antes de sobrescribirlo, el listado dejaría una línea por ciclo en la misma tarjeta');
  assert.deepEqual(tried, ['fixing'], 'y la completación se intenta solo en el cambio: los ciclos siguientes no la piden');

  await noteIssue(task, open, deps);
  assert.equal(task.issueClosed, false, 'reabierto');
  await noteIssue(task, closed, deps);
  assert.equal(warned(), 2, 'reabierto y cerrado otra vez es un cambio de bandera nuevo, y eso sí es un aviso nuevo');
  assert.equal(tried.length, 2);
});

test('el barrido pregunta solo por las tareas de las que el tablero puede estar equivocado', async () => {
  const { sweepClosedIssues } = await import('../src/poller.js');
  const project = ownProject();
  taskIn(project.id, { state: 'done', issueClosed: true });
  const doubtful = taskIn(project.id, { state: 'done', issueClosed: false });
  const working = taskIn(project.id, { state: 'started' });
  const listed = taskIn(project.id, { state: 'started' });
  const steps = states();
  await sweepClosedIssues(project, new Set([listed.issue]), { steps, note: async () => {} });
  assert.deepEqual(
    steps.calls, [[[doubtful.issue, working.issue], project.id]],
    'una tarea «done» con la bandera puesta no puede estar equivocada, y la que el listado ya contestó no se vuelve a pagar',
  );

  const quiet = ownProject();
  taskIn(quiet.id, { state: 'done', issueClosed: true });
  const none = states();
  await sweepClosedIssues(quiet, new Set(), { steps: none, note: async () => {} });
  assert.equal(none.calls.length, 0, 'sin candidatos no se llama a GitHub en absoluto: el barrido no cuesta nada cuando no hay nada que preguntar');
});

test('una respuesta que coincide con lo que la tarea ya cree no escribe nada', async () => {
  const { sweepClosedIssues } = await import('../src/poller.js');
  const project = ownProject();
  const task = taskIn(project.id, { state: 'started' });
  const snapshot = JSON.stringify(task);
  let notes = 0;
  const counts = await sweepClosedIssues(project, new Set(), {
    steps: states({ [task.issue]: false }), note: async () => { notes += 1; },
  });
  assert.equal(notes, 0, 'el issue sigue abierto y la tarea ya lo creía: `noteIssue` no tiene nada que anotar');
  assert.equal(JSON.stringify(task), snapshot, 'ni `updatedAt`: una respuesta que confirma no es un cambio');
  assert.equal(counts.flipped, 0);
});

test('un número ausente de la respuesta no es una respuesta: la tarea no se toca', async () => {
  const { sweepClosedIssues } = await import('../src/poller.js');
  const project = ownProject();
  const task = taskIn(project.id, { state: 'started', issueClosed: false });
  const snapshot = JSON.stringify(task);
  let notes = 0;
  await sweepClosedIssues(project, new Set(), { steps: states({}), note: async () => { notes += 1; } });
  assert.equal(notes, 0, 'un número que es un PR, o un issue borrado o transferido, no dice nada sobre si está cerrado');
  assert.equal(JSON.stringify(task), snapshot, 'y anotarlo como abierto habría «reabierto» un issue que GitHub no conoce');

  // La dirección que de verdad importa, y la que una ausencia leída como
  // «abierto» rompería: la tarea ya cree que el issue está cerrado. Tratar la
  // fila que falta como `closed: false` la haría pasar por `noteIssue` y por la
  // comprobación de reapertura, sobre un número que GitHub no ha contestado.
  // `complete` devuelve «skip» para que el repaso final no escriba: lo que se
  // mide aquí es solo si la ausencia cambió la creencia.
  const believes = taskIn(project.id, { state: 'error', issueClosed: true });
  const before = JSON.stringify(believes);
  let reopens = 0;
  await sweepClosedIssues(project, new Set(), {
    steps: states({}), note: async () => { reopens += 1; }, complete: () => 'skip',
  });
  assert.equal(reopens, 0, 'una ausencia no reabre nada: sin respuesta no hay cambio de creencia');
  assert.equal(believes.issueClosed, true, 'la bandera se queda como estaba');
  assert.equal(JSON.stringify(believes), before, 'y la tarea sigue byte a byte igual');
});

test('un issue cerrado sobre una tarea trabajando: cambia la bandera, deja el estado, y avisa una sola vez', async () => {
  const { sweepClosedIssues } = await import('../src/poller.js');
  const project = ownProject();
  const task = taskIn(project.id, { state: 'fixing', phase: 'fixing' });
  const steps = states({ [task.issue]: true });
  const warned = () => task.log.filter((l) => /closed on GitHub with a run in progress/.test(l.line)).length;

  const counts = await sweepClosedIssues(project, new Set(), { steps });
  assert.equal(task.issueClosed, true, 'la bandera es lo único que el barrido decide');
  assert.equal(task.state, 'fixing', 'una ejecución en marcha no se interrumpe: la decisión es del mantenedor');
  assert.equal(task.phase, 'fixing', 'y la fase desde la que se reanuda sigue ahí');
  assert.equal(warned(), 1, 'una línea, en el canal del poll');
  assert.equal(counts.flipped, 1);

  await sweepClosedIssues(project, new Set(), { steps });
  await sweepClosedIssues(project, new Set(), { steps });
  assert.equal(warned(), 1, 'el aviso cuelga del cambio de bandera, así que los ciclos siguientes no repiten nada — sin ningún campo nuevo en la tarea');
});

test('si `gh` no contesta al barrido, cada candidato queda byte a byte igual y nada se escribe en él', async () => {
  const { sweepClosedIssues } = await import('../src/poller.js');
  const project = ownProject();
  const working = taskIn(project.id, { state: 'started' });
  const broken = taskIn(project.id, { state: 'error', phase: 'testing', error: 'los tests fallaron' });
  const before = [working, broken].map((t) => JSON.stringify(t));
  await assert.rejects(
    () => sweepClosedIssues(project, new Set(), { steps: states({}, { fail: true }) }),
    /HTTP 502/,
    'el fallo sube al ciclo, que lo cuenta una vez por proyecto y por mensaje',
  );
  assert.deepEqual([working, broken].map((t) => JSON.stringify(t)), before,
    'ni el error de la tarea ni su fase se pierden: el próximo ciclo pregunta desde el mismo sitio');
  assert.equal(working.log.length, 0, 'un `gh` que falló no escribe en ninguna tarea');
});

test('una respuesta que abre un issue cerrado pasa por `noteIssue`, y por tanto por la comprobación de reapertura', async () => {
  const { noteIssue, sweepClosedIssues } = await import('../src/poller.js');
  const project = ownProject();
  const task = taskIn(project.id, { state: 'started', issueClosed: true, branch: BRANCH, prs: [PR_826] });
  const asked = [];
  await sweepClosedIssues(project, new Set(), {
    steps: states({ [task.issue]: false }),
    note: (t, row) => noteIssue(t, row, { reopen: async (x, was) => { asked.push(was); } }),
  });
  assert.deepEqual(asked, [true], 'el barrido no toca la bandera por su cuenta: `noteIssue` sigue siendo el único sitio, y le pasa lo que el ciclo anterior creía');
  assert.equal(task.issueClosed, false, 'y solo entonces se anota que está abierto');
});

test('el repaso final cierra la tarea en «error» cuya bandera ya estaba puesta: el hueco que deja CLASSIFIABLE', async () => {
  const { sweepClosedIssues } = await import('../src/poller.js');
  const project = ownProject();
  const task = taskIn(project.id, {
    state: 'error', phase: 'testing', error: 'los tests fallaron', issueClosed: true, classified: true,
  });
  let notes = 0;
  // La respuesta no dice nada de ella a propósito: el repaso no depende del
  // barrido, porque el caso real es una bandera que puso el listado de cerrados.
  const counts = await sweepClosedIssues(project, new Set(), { steps: states({}), note: async () => { notes += 1; } });
  assert.equal(notes, 0, 'la bandera ya estaba puesta: no hay nada que anotar, solo algo que terminar');
  assert.equal(task.state, 'done', '`refreshClassification` vuelve en su puerta CLASSIFIABLE para «error», así que sin este repaso nadie la movería nunca');
  assert.equal(task.phase, null, 'sin fase no queda «un ciclo en curso» que bloquee una reapertura futura');
  assert.ok(task.log.some((l) => l.phase === 'guard' && /the issue was closed on GitHub/.test(l.line)),
    'la línea la escribe `completeOnIssueClosed`, una sola vez y en su propio canal');
  assert.equal(counts.settled, 1);

  const again = await sweepClosedIssues(project, new Set(), { steps: states({}), note: async () => {} });
  assert.equal(again.settled, 0, 'idempotente: ya está en «Completada», y `completeOnIssueClosed` contesta «skip»');
});

test('el barrido va por proyecto: el id viaja en la pregunta y dos proyectos con el mismo #12 no se mezclan', async () => {
  const { sweepClosedIssues } = await import('../src/poller.js');
  const mine = ownProject();
  const theirs = taskIn(DEFAULT_PROJECT_ID, { state: 'started' }, 12);
  const ours = taskIn(mine.id, { state: 'started' }, 12);
  const snapshot = JSON.stringify(theirs);
  const steps = states({ 12: true });

  await sweepClosedIssues(mine, new Set(), { steps });
  assert.deepEqual(steps.calls, [[[12], mine.id]],
    'el id del proyecto barrido viaja en la llamada: el número solo significa algo dentro de su repositorio');
  assert.equal(ours.issueClosed, true);
  assert.equal(ours.state, 'done', 'y desde «started» la tarea se completa en el mismo barrido');
  assert.equal(JSON.stringify(theirs), snapshot, `el ${DEFAULT_PROJECT_ID}#12 no es candidato de otro proyecto y no se toca`);
});

// ---------------------------------------------------------------------------
// El auto-arranque. Al final a propósito: `tick()` recorre todas las tareas
// del almacén, y aquí se enciende.

test('tick: no arranca una reapertura cuyo issue se volvió a cerrar, pero sí un 🚀 en cola sobre un issue cerrado', async () => {
  const started = [];
  const previousRun = pipeline.pipelineHooks.run;
  const previousEnv = process.env.HFSMON_NO_AUTOSTART;
  const previousSettings = { autoStart: settings.autoStart, maxActiveTasks: settings.maxActiveTasks };
  // The slots this needs are the file's own to provide: earlier tests leave tasks
  // in the store, so the ceiling must not be whatever the loaded config happens to say.
  const { config } = await import('../src/config.js');
  const previousLimits = config.limits;
  config.limits = { ...config.limits, maxActiveTasksCeiling: 1000 };
  const withdrawn = freshTask({
    state: 'assigned', forced: true, classified: true, issueClosed: true, reopenedAt: '2026-09-21T10:00:00.000Z',
  });
  const queued = freshTask({ state: 'assigned', forced: true, classified: true, issueClosed: true, reopenedAt: null });
  // A run that never ends: one that resolved would re-enter `tick()` from
  // `startPipeline`'s `finally`, find the same queued tasks and loop for ever.
  pipeline.pipelineHooks.run = (t) => { started.push(t.issue); return new Promise(() => {}); };
  process.env.HFSMON_NO_AUTOSTART = '0';
  settings.update({ autoStart: true, maxActiveTasks: settings.ceiling });
  try {
    pipeline.tick();
    await new Promise((r) => { setImmediate(r); });
    assert.ok(!started.includes(withdrawn.issue), 'la reapertura retirada espera al poll que la reclasifica');
    assert.ok(started.includes(queued.issue), 'tu 🚀 sigue siendo tu orden');
  } finally {
    process.env.HFSMON_NO_AUTOSTART = previousEnv;
    settings.update(previousSettings);
    config.limits = previousLimits;
    pipeline.pipelineHooks.run = previousRun;
    for (const issue of started) pipeline.markRunning(issue, false);
  }
});
