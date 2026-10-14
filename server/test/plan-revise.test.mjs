// Asking for changes on a fix plan, against the real pipeline module with an
// isolated data directory. Every Claude call of the fix phase goes through
// `fixHooks.runClaude` and the pipeline body through `pipelineHooks.run`, which
// here drives `fixPhaseOf` directly: nothing reaches gh, git or a session.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tempDir } from './teardown.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = tempDir('hfsmon-plan-revise-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;
let planexec;
let chats;
let config;

/** What the fake Claude does with each call; set by every test. */
let handler = null;
const calls = [];
/** The pipeline body; null means the fix phase, entered as `runPipeline` would. */
let runBody = null;

before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  ({ config } = await import('../src/config.js'));
  planexec = await import('../src/planexec.js');
  chats = await import('../src/chats.js');
  const { settings } = await import('../src/settings.js');
  settings.update({ autoStart: false, maxActiveTasks: settings.ceiling });

  pipeline.fixHooks.runClaude = async (options) => {
    // Told apart by what they are: a plan-task session carries its own prompt,
    // the planning calls are the only ones limited to 30 turns, a complaint to 3.
    const kind = /El tablero está ejecutando el plan aprobado/.test(options.prompt) ? 'task'
      : options.maxTurns === 30 ? (options.resume ? 'revise' : 'plan')
        : options.maxTurns === 3 ? 'complaint' : 'fix';
    const call = { kind, prompt: options.prompt, resume: options.resume ?? null, options };
    calls.push(call);
    return handler(call);
  };
  pipeline.pipelineHooks.run = async (task) => {
    if (runBody) return runBody(task);
    store.setState(task, 'fixing');
    return pipeline.fixPhaseOf(task, issueOf(task));
  };
});

let n = 11000;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.machine = 'local';
  task.worktreePath = tempDir(`hfsmon-wt-${n}-`);
  task.branch = `feat/${n}-x`;
  task.approvePlan = 'on';
  return Object.assign(task, fields);
}

const issueOf = (task) => ({ number: task.issue, title: task.title, body: 'cuerpo del issue' });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function waitFor(what, predicate, ms = 5000) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`no llegó: ${what}`);
    await sleep(5);
  }
}

// Every plan turn opens with the «De un vistazo» brief, because the phase now
// asks for it in the same retry as the tagged line: a turn without one gets
// complained at instead of becoming a plan.
const BRIEF = `## De un vistazo

Hoy el servidor devuelve la lista entera cuando le piden una página, así que el
cliente descarga miles de recursos para enseñar veinte. Después del cambio la
consulta pide solo la página que le toca y la respuesta baja a lo que se ve en
pantalla. Se toca la capa REST, en la parte que traduce los parámetros de
búsqueda a la consulta del almacén.`;
const planText = (tasks) => `${BRIEF}\n\nWORK_PLAN: ${JSON.stringify({ tasks })}`;
const PLAN_V1 = planText([{ id: 't1', what: 'tocar lib', files: ['src/lib.rs'], dependsOn: [] }]);
const PLAN_V2 = planText([
  { id: 't1', what: 'tocar lib', files: ['src/lib.rs'], dependsOn: [] },
  { id: 't2', what: 'tocar api', files: ['src/api.rs'], dependsOn: [] },
  { id: 't3', what: 'test', files: ['tests/it.rs'], dependsOn: ['t1', 't2'] },
]);
// Two waves of two, then one: the ties both carry ⚡.
const PLAN_TIES = planText([
  { id: 'a', what: 'a', files: ['a.rs'], dependsOn: [] },
  { id: 'b', what: 'b', files: ['b.rs'], dependsOn: [] },
  { id: 'c', what: 'c', files: ['c.rs'], dependsOn: ['a'] },
  { id: 'd', what: 'd', files: ['d.rs'], dependsOn: ['b'] },
  { id: 'e', what: 'e', files: ['e.rs'], dependsOn: ['c', 'd'] },
]);
const PLAN_SINGLES = planText([
  { id: 'a', what: 'a', files: ['a.rs'], dependsOn: [] },
  { id: 'b', what: 'b', files: ['b.rs'], dependsOn: ['a'] },
]);
const ok = (sessionId, resultText) => ({ ok: true, sessionId, resultText, toolCounts: {} });

const principal = (task) => chats.principalChat(task);
const bubble = (task, id) => principal(task).messages.find((m) => m.id === id) ?? null;
const planBubbles = (task) => principal(task).messages.filter((m) => m.scope === 'task' || m.boardOnly);

/** A plan waiting for approval with no pipeline parked on it, as after a restart. */
function parkedByRestart(task, { text = 'PLAN RECHAZADO: t1 toca src/lib.rs', sessionId = null } = {}) {
  const record = planexec.newPlanRecord({ id: `fix-${task.issue}`, text, tasks: [{ id: 't1', what: 'tocar lib', files: ['src/lib.rs'], dependsOn: [] }], waves: [['t1']] });
  record.version = 1;
  task.workPlan = record;
  task.planVersion = 1;
  task.planSessionId = sessionId;
  task.state = 'plan_ready';
  return record;
}

test('«pedir cambios» pasa a fixing con planning en el mismo tick, el replaneo reanuda la sesión del plan, v1 → v2 y las burbujas cuentan la historia', async () => {
  calls.length = 0;
  const task = freshTask({ state: 'error', prevState: 'fixing' });
  const seen = {};
  handler = async (call) => {
    if (call.kind === 'plan') {
      seen.first = { planning: { ...task.planning }, status: bubble(task, task.planning.messageId)?.status };
      call.options.onEvent({ kind: 'text', text: '\nleyendo el código del handler\nmás texto' });
      seen.progress = bubble(task, task.planning.messageId)?.progress;
      call.options.onEvent({ kind: 'tool', name: 'Grep', input: 'fn handler' });
      seen.throttled = bubble(task, task.planning.messageId)?.progress;
      return ok('plan-s1', PLAN_V1);
    }
    if (call.kind === 'revise') {
      seen.revise = { planning: { ...task.planning }, state: task.state };
      return ok('plan-s1', PLAN_V2);
    }
    if (call.kind === 'task') return ok(`task-${calls.length}`, 'hecho');
    return ok('fix-s', 'cerrado');
  };

  assert.equal(pipeline.retry(task.issue), true);
  await waitFor('plan v1 listo', () => task.state === 'plan_ready');

  assert.equal(seen.first.planning.version, 1);
  assert.equal(seen.first.planning.kind, 'initial');
  assert.equal(seen.first.planning.feedback, null);
  assert.equal(seen.first.status, 'planning', 'la burbuja se abre antes de la llamada de plan');
  assert.equal(seen.progress, 'leyendo el código del handler', 'la primera línea útil llega enseguida');
  assert.equal(seen.throttled, 'leyendo el código del handler', 'la siguiente espera a los 2 s');

  const v1 = task.workPlan;
  assert.equal(v1.version, 1);
  assert.equal(v1.feedback, null, 'el primer plan no nace de cambios pedidos');
  assert.equal(task.planVersion, 1);
  assert.equal(task.planning, null);
  assert.equal(task.pending?.kind, 'plan');
  const b1 = bubble(task, v1.messageId);
  assert.deepEqual(
    { role: b1.role, source: b1.source, scope: b1.scope, version: b1.version, status: b1.status, progress: b1.progress },
    { role: 'plan', source: 'board', scope: 'task', version: 1, status: 'pending', progress: null },
  );
  assert.equal(b1.tasks.length, 1);
  assert.deepEqual(b1.waves, [['t1']]);
  assert.equal(b1.plan, v1.text);
  assert.equal(principal(task).pending, null, 'la burbuja del tablero no aparca nada en el chat');

  // Asking for changes: everything below happens before the pipeline wakes up.
  pipeline.decideTaskPlan(task.issue, { decision: 'revise', feedback: 'parte t1 en dos\ny añade un test' });
  assert.equal(task.state, 'fixing');
  assert.equal(task.workPlan, null);
  assert.equal(task.planFeedback, 'parte t1 en dos\ny añade un test');
  assert.deepEqual(
    { version: task.planning.version, kind: task.planning.kind, feedback: task.planning.feedback },
    { version: 2, kind: 'revise', feedback: 'parte t1 en dos\ny añade un test' },
  );
  assert.equal(b1.status, 'revise');
  assert.equal(b1.feedback, 'parte t1 en dos\ny añade un test');
  const after = principal(task).messages.slice(principal(task).messages.indexOf(b1) + 1);
  assert.equal(after[0].role, 'user');
  assert.equal(after[0].boardOnly, true);
  assert.equal(after[0].text, '✏️ Cambios al plan v1:\nparte t1 en dos\ny añade un test');
  assert.equal(after[1].id, task.planning.messageId);
  assert.deepEqual({ role: after[1].role, scope: after[1].scope, version: after[1].version, status: after[1].status }, { role: 'plan', scope: 'task', version: 2, status: 'planning' });

  await waitFor('plan v2 listo', () => task.state === 'plan_ready');
  assert.deepEqual(calls.map((c) => c.kind), ['plan', 'revise']);
  const revise = calls[1];
  assert.equal(revise.resume, 'plan-s1', 'reanuda la sesión que escribió el v1');
  assert.match(revise.prompt, /parte t1 en dos\ny añade un test/);
  assert.match(revise.prompt, /WORK_PLAN/);
  assert.doesNotMatch(revise.prompt, /PLANIFICA/, 'no es el prompt de empezar de cero');
  assert.equal(seen.revise.state, 'fixing');

  const v2 = task.workPlan;
  assert.equal(v2.version, 2);
  assert.equal(v2.feedback, 'parte t1 en dos\ny añade un test', 'el v2 recuerda qué se pidió para llegar a él');
  assert.equal(task.planVersion, 2);
  assert.equal(task.planFeedback, null);
  assert.equal(task.planRejectedText, null);
  const b2 = bubble(task, v2.messageId);
  assert.equal(b2.status, 'pending');
  assert.equal(b2.tasks.length, 3);
  assert.equal(b2.summary, '3 tareas · 2 ⚡ → 1');

  pipeline.decideTaskPlan(task.issue, { decision: 'approve', selected: ['t1', 't2', 't3'] });
  assert.equal(b2.status, 'approved');
  assert.deepEqual(b2.selected, ['t1', 't2', 't3']);
  await waitFor('el fix termina', () => task.state === 'error');
  assert.equal(calls.filter((c) => c.kind === 'task').length, 3);
  assert.equal(calls.at(-1).kind, 'fix');
  assert.equal(b2.progress, planexec.planSummaryLine(task.workPlan), 'la burbuja sigue la ejecución');
  assert.match(b2.progress, /t1 ✓ t2 ✓ t3 ✓/);

  assert.deepEqual(planBubbles(task).map((m) => m.boardOnly ? 'cambios' : `v${m.version}:${m.status}`), ['v1:revise', 'cambios', 'v2:approved']);
  assert.ok(calls.every((c) => !c.prompt.includes('✏️ Cambios al plan')), 'ninguna burbuja llega a Claude');
});

test('si la sesión del plan ya no existe, replanifica en una sesión nueva con el plan rechazado y los cambios', async () => {
  calls.length = 0;
  const task = freshTask();
  parkedByRestart(task, { sessionId: 'perdida' });
  handler = async (call) => {
    if (call.kind === 'revise') return { ok: false, sessionId: null, resultText: '', toolCounts: {}, error: 'No conversation found' };
    if (call.kind === 'plan') return ok('nueva', PLAN_V2);
    throw new Error(`llamada inesperada: ${call.kind}`);
  };

  pipeline.decideTaskPlan(task.issue, { decision: 'revise', feedback: 'sepáralo por crate' });
  assert.equal(task.state, 'fixing');
  assert.equal(task.planning.version, 2);
  assert.equal(task.planning.rejectedText, undefined, 'el texto rechazado vive en la tarea, no en planning');
  const gone = (e) => e.code === 'PENDING_GONE';
  assert.throws(() => pipeline.decideTaskPlan(task.issue, { decision: 'revise', feedback: 'otra vez' }), gone, 'un segundo «pedir cambios» no tiene plan que devolver');
  assert.throws(() => pipeline.decideTaskPlan(task.issue, { decision: 'approve' }), gone, 'mientras replanifica no hay nada que aprobar');
  await waitFor('plan v2 listo', () => task.state === 'plan_ready');

  assert.deepEqual(calls.map((c) => c.kind), ['revise', 'plan']);
  assert.equal(calls[0].resume, 'perdida');
  assert.equal(calls[1].resume, null);
  assert.match(calls[1].prompt, /This is the plan proposed earlier, which the person turned down:\nPLAN RECHAZADO: t1 toca src\/lib\.rs/);
  assert.match(calls[1].prompt, /The person reviewed the previous plan and asks for changes:\nsepáralo por crate/);
  assert.equal(task.planSessionId, 'nueva');
  assert.equal(task.workPlan.version, 2);
  assert.equal(task.workPlan.feedback, 'sepáralo por crate');
  assert.equal(task.workPlan.forkFrom, 'nueva');
  assert.ok(task.log.some((l) => /could not resume the plan session/.test(l.line)));
  assert.equal(bubble(task, task.workPlan.messageId).status, 'pending');
});

test('un fallo de la reanudación que no es «sesión inexistente» reintenta la misma sesión una vez antes de ir a una nueva', async () => {
  calls.length = 0;
  const task = freshTask();
  parkedByRestart(task, { sessionId: 's-hipo' });
  let resumes = 0;
  handler = async (call) => {
    if (call.kind === 'revise') {
      resumes += 1;
      return resumes === 1 ? { ok: false, sessionId: null, resultText: '', toolCounts: {}, error: 'socket hang up' } : ok('s-hipo', PLAN_V2);
    }
    throw new Error(`llamada inesperada: ${call.kind}`);
  };
  pipeline.decideTaskPlan(task.issue, { decision: 'revise', feedback: 'uno' });
  await waitFor('plan v2 listo', () => task.state === 'plan_ready');
  assert.deepEqual(calls.map((c) => [c.kind, c.resume]), [['revise', 's-hipo'], ['revise', 's-hipo']]);
  assert.equal(task.planSessionId, 's-hipo');

  // Two hiccups in a row: then a fresh session, with the rejected plan.
  calls.length = 0;
  const other = freshTask();
  parkedByRestart(other, { sessionId: 's-caida' });
  handler = async (call) => {
    if (call.kind === 'revise') return { ok: false, sessionId: null, resultText: '', toolCounts: {}, error: 'socket hang up' };
    if (call.kind === 'plan') return ok('s-nueva', PLAN_V2);
    throw new Error(`llamada inesperada: ${call.kind}`);
  };
  pipeline.decideTaskPlan(other.issue, { decision: 'revise', feedback: 'dos' });
  await waitFor('plan v2 listo', () => other.state === 'plan_ready');
  assert.deepEqual(calls.map((c) => c.kind), ['revise', 'revise', 'plan']);
  assert.match(calls[2].prompt, /PLAN RECHAZADO/);
});

test('el bloque que falla deja la burbuja fallida: si el cuerpo del pipeline revienta antes del fix, y si revienta la llamada de plan', async () => {
  calls.length = 0;
  const task = freshTask();
  parkedByRestart(task);
  runBody = async () => { throw new Error('git caído'); };
  try {
    pipeline.decideTaskPlan(task.issue, { decision: 'revise', feedback: 'cambia algo' });
    const messageId = task.planning.messageId;
    await waitFor('la tarea para en error', () => task.state === 'error' && !pipeline.isRunning(task.issue));
    assert.equal(task.error, 'git caído');
    assert.equal(task.prevState, 'fixing');
    assert.equal(task.planning, null);
    assert.equal(task.planFeedback, 'cambia algo', 'se conserva para Reintentar');
    assert.deepEqual({ status: bubble(task, messageId).status, error: bubble(task, messageId).error }, { status: 'failed', error: 'git caído' });
  } finally {
    runBody = null;
  }

  calls.length = 0;
  const other = freshTask();
  parkedByRestart(other, { sessionId: 's-x' });
  handler = async () => { throw new Error('boom'); };
  pipeline.decideTaskPlan(other.issue, { decision: 'revise', feedback: 'cambia algo' });
  const messageId = other.planning.messageId;
  await waitFor('la tarea para en error', () => other.state === 'error' && !pipeline.isRunning(other.issue));
  assert.equal(other.error, 'could not replan: boom');
  assert.equal(other.planning, null);
  assert.deepEqual({ status: bubble(other, messageId).status, error: bubble(other, messageId).error }, { status: 'failed', error: 'could not replan: boom' });
});

test('una tarea manual tras un reinicio: pedir cambios y aprobar le dan una pasada única, que termina con la ejecución', async () => {
  for (const decision of [{ decision: 'revise', feedback: 'más pequeño' }, { decision: 'approve' }]) {
    const task = freshTask({ mode: 'manual', modeDecidedByUser: true });
    parkedByRestart(task);
    const seen = {};
    let release;
    runBody = (t) => {
      seen.userRun = pipeline.isUserRun(t.issue);
      seen.paused = pipeline.pausedForModeOf(t, 'el fix');
      return new Promise((r) => { release = r; });
    };
    try {
      pipeline.decideTaskPlan(task.issue, decision);
      await waitFor('el cuerpo arranca', () => release);
      assert.equal(seen.userRun, true, `${decision.decision}: la ejecución es la que pediste`);
      assert.equal(seen.paused, false, `${decision.decision}: no se para en el límite de fase`);
      release();
      await waitFor('la ejecución termina', () => !pipeline.isRunning(task.issue));
      assert.equal(pipeline.isUserRun(task.issue), false);
      assert.equal(task.mode, 'manual');
    } finally {
      runBody = null;
    }
  }
});

test('los cambios pedidos se recortan a 4000 caracteres con «…»', async () => {
  const task = freshTask();
  parkedByRestart(task);
  let release;
  runBody = () => new Promise((r) => { release = r; });
  try {
    pipeline.decideTaskPlan(task.issue, { decision: 'revise', feedback: 'x'.repeat(5000) });
    assert.equal(pipeline.MAX_PLAN_FEEDBACK, 4000);
    assert.equal(task.planFeedback.length, 4000);
    assert.ok(task.planFeedback.endsWith('x…'));
    assert.equal(task.planning.feedback, task.planFeedback);
    await waitFor('el cuerpo arranca', () => release);
    release();
    await waitFor('la ejecución termina', () => !pipeline.isRunning(task.issue));
  } finally {
    runBody = null;
  }
});

test('dar el fix por hecho olvida los cambios pedidos: una ronda posterior no replanifica con ellos', async () => {
  const git = (args, cwd) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
  const root = tempDir('hfsmon-accept-');
  const origin = path.join(root, 'origin.git');
  git(['init', '--bare', '-b', 'main', origin], root);
  const repo = path.join(root, 'repo');
  git(['clone', origin, repo], root);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# seed\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'seed'], repo);
  git(['push', '-u', 'origin', 'HEAD:main'], repo);
  writeFileSync(path.join(repo, 'lib.rs'), 'pub fn a() {}\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'el fix'], repo);

  const saved = config.machines;
  config.machines = { local: { kind: 'local', repoPath: repo, worktreeRoot: path.join(root, 'wt') } };
  let release;
  runBody = () => new Promise((r) => { release = r; });
  try {
    const task = freshTask({ state: 'error', prevState: 'fixing', planFeedback: 'viejo', planRejectedText: 'PLAN VIEJO' });
    task.worktreePath = repo;
    const head = await pipeline.acceptFix(task.issue);
    assert.equal(task.fixedAt, head);
    assert.equal(task.planFeedback, null);
    assert.equal(task.planRejectedText, null);
    await waitFor('el cuerpo arranca', () => release);
    release();
    await waitFor('la ejecución termina', () => !pipeline.isRunning(task.issue));
  } finally {
    runBody = null;
    if (saved === undefined) delete config.machines; else config.machines = saved;
  }
});

test('un replaneo sin plan válido acaba en error con planFeedback conservado, nunca en el fix sin plan, y «Reintentar» replanifica', async () => {
  calls.length = 0;
  const task = freshTask();
  parkedByRestart(task, { sessionId: 's-a' });
  handler = async (call) => {
    if (call.kind === 'revise') return ok('s-a', 'no sé cómo partirlo');
    if (call.kind === 'complaint') return ok('s-a', 'sigo sin plan');
    throw new Error(`llamada inesperada: ${call.kind}`);
  };

  pipeline.decideTaskPlan(task.issue, { decision: 'revise', feedback: 'hazlo en paralelo' });
  const messageId = task.planning.messageId;
  await waitFor('la tarea para en error', () => task.state === 'error');

  assert.match(task.error, /^could not replan: /);
  assert.equal(task.prevState, 'fixing');
  assert.equal(task.planFeedback, 'hazlo en paralelo');
  assert.equal(task.planning, null);
  assert.equal(task.workPlan, null);
  assert.equal(task.planVersion, 1, 'una versión fallida no gasta número');
  assert.ok(calls.every((c) => ['revise', 'complaint'].includes(c.kind)), 'ni sesiones del plan ni fix sin plan');
  assert.ok(calls.some((c) => c.kind === 'complaint'), 'pide el plan otra vez antes de rendirse');
  const failed = bubble(task, messageId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, task.error);

  calls.length = 0;
  handler = async (call) => {
    if (call.kind === 'revise') return ok('s-a', PLAN_V2);
    throw new Error(`llamada inesperada: ${call.kind}`);
  };
  assert.equal(pipeline.retry(task.issue), true);
  await waitFor('plan v2 listo tras reintentar', () => task.state === 'plan_ready');
  assert.deepEqual(calls.map((c) => c.kind), ['revise']);
  assert.equal(calls[0].resume, 's-a');
  assert.match(calls[0].prompt, /hazlo en paralelo/);
  assert.equal(task.workPlan.version, 2);
  assert.equal(task.planFeedback, null);
  const retried = bubble(task, task.workPlan.messageId);
  assert.notEqual(retried.id, messageId);
  assert.deepEqual({ status: retried.status, kind: retried.kind, version: retried.version }, { status: 'pending', kind: 'revise', version: 2 });
  assert.equal(failed.status, 'failed', 'la versión fallida se queda como estaba');
  assert.deepEqual(planBubbles(task).map((m) => m.boardOnly ? 'cambios' : `v${m.version}:${m.status}`), ['cambios', 'v2:failed', 'v2:pending']);
});

test('con commits en la rama, el camino de reinicio lee el feedback y replanifica antes de la sesión única', async () => {
  calls.length = 0;
  const task = freshTask({
    state: 'fixing', approvePlan: 'off', planVersion: 1,
    planFeedback: 'usa otro enfoque', planRejectedText: 'PLAN VIEJO X', planSessionId: null,
  });
  handler = async (call) => {
    if (call.kind === 'plan') return ok('p4', PLAN_V1);
    if (call.kind === 'task') return ok('t', 'hecho');
    return ok('fix-s', 'revisado');
  };

  await assert.rejects(pipeline.fixPhaseOf(task, issueOf(task), 'CONTEXTO DE LA RAMA', { continuing: true }), /without committing/);
  assert.deepEqual(calls.map((c) => c.kind), ['plan', 'task', 'fix']);
  assert.match(calls[0].prompt, /usa otro enfoque/);
  assert.match(calls[0].prompt, /PLAN VIEJO X/);
  assert.match(calls[0].prompt, /CONTEXTO DE LA RAMA/);
  assert.equal(task.planFeedback, null);
  assert.equal(task.workPlan.version, 2);
  const b = bubble(task, task.workPlan.messageId);
  assert.deepEqual({ status: b.status, kind: b.kind, version: b.version }, { status: 'approved', kind: 'revise', version: 2 });
  assert.deepEqual(b.selected, ['t1']);
});

test('el primer plan sin revisión conserva su comportamiento: sin plan, el fix sigue en una sesión y la burbuja dice por qué', async () => {
  calls.length = 0;
  const task = freshTask({ state: 'fixing', approvePlan: 'off' });
  handler = async (call) => (call.kind === 'plan'
    ? { ok: false, sessionId: null, resultText: '', toolCounts: {}, error: 'caída' }
    : ok('fix-s', 'hecho'));

  await assert.rejects(pipeline.fixPhaseOf(task, issueOf(task)), /without committing/);
  assert.deepEqual(calls.map((c) => c.kind), ['plan', 'fix']);
  assert.equal(task.planning, null);
  const [b] = planBubbles(task);
  assert.equal(b.status, 'failed');
  assert.equal(b.version, 1);
  assert.match(b.error, /no usable plan.*caída.*the fix goes on without a plan/);
});

test('un plan sin el resumen se pide otra vez en la misma sesión, y el texto que se aprueba abre con la prosa', async () => {
  calls.length = 0;
  const task = freshTask({ state: 'fixing', approvePlan: 'off' });
  const TASKS = [{ id: 't1', what: 'tocar lib', files: ['src/lib.rs'], dependsOn: [] }];
  const SIN_RESUMEN = `Aquí va el reparto.\nWORK_PLAN: ${JSON.stringify({ tasks: TASKS })}`;
  handler = async (call) => {
    if (call.kind === 'plan') return ok('p-brief', SIN_RESUMEN);
    // La queja llega con `maxTurns: 3` sobre la MISMA sesión: no se paga otra
    // sesión de plan por un párrafo.
    if (call.kind === 'complaint') return ok('p-brief', planText(TASKS));
    return ok('fix-s', 'hecho');
  };

  await assert.rejects(pipeline.fixPhaseOf(task, issueOf(task)), /without committing/);
  assert.deepEqual(calls.map((c) => c.kind), ['plan', 'complaint', 'task', 'fix']);
  assert.equal(calls[1].resume, 'p-brief', 'la queja reanuda, no replanifica');
  assert.match(calls[1].prompt, /De un vistazo/);
  assert.doesNotMatch(calls[1].prompt, /no terminó con una línea/, 'el WORK_PLAN estaba bien: no se queja de él');
  assert.ok(task.workPlan.text.startsWith('## De un vistazo'), 'lo que se aprueba empieza por la prosa');
  assert.match(task.workPlan.text, /t1/, 'y sigue llevando la tabla');
});

test('si el resumen no llega nunca, el plan no se pierde: se aprueba la tabla a secas', async () => {
  calls.length = 0;
  const task = freshTask({ state: 'fixing', approvePlan: 'off' });
  const TASKS = [{ id: 't1', what: 'tocar lib', files: ['src/lib.rs'], dependsOn: [] }];
  const SIN_RESUMEN = `Aquí va el reparto.\nWORK_PLAN: ${JSON.stringify({ tasks: TASKS })}`;
  handler = async (call) => {
    if (call.kind === 'plan' || call.kind === 'complaint') return ok('p-terco', SIN_RESUMEN);
    return ok('fix-s', 'hecho');
  };

  await assert.rejects(pipeline.fixPhaseOf(task, issueOf(task)), /without committing/);
  assert.equal(calls.filter((c) => c.kind === 'complaint').length, config.retry?.max ?? 3);
  assert.ok(task.workPlan?.tasks?.length, 'el plan sobrevive a la prosa que falta');
  assert.doesNotMatch(task.workPlan.text, /De un vistazo/);
  assert.ok(task.log.some((l) => /with the bare table/.test(l.line)), 'y el log dice por qué');
});

test('el resumen marca con ⚡ solo las oleadas más anchas, empatadas incluidas, y ninguna si todas son de una', async () => {
  for (const [text, expected] of [
    [PLAN_TIES, '5 tareas · 2 ⚡ → 2 ⚡ → 1'],
    [PLAN_SINGLES, '2 tareas · 1 → 1'],
  ]) {
    calls.length = 0;
    const task = freshTask({ state: 'fixing' });
    handler = async (call) => {
      if (call.kind === 'plan') return ok('p', text);
      throw new Error(`llamada inesperada: ${call.kind}`);
    };
    pipeline.fixPhaseOf(task, issueOf(task)).catch(() => {});
    await waitFor('plan listo', () => task.state === 'plan_ready');
    assert.equal(bubble(task, task.workPlan.messageId).summary, expected);
  }
});

test('el arranque con un planeo a medias lo limpia, conserva el feedback y marca la burbuja fallida sin caducar el plan esperando', () => {
  const t = chats.migrateChats({ state: 'error', prevState: 'fixing', planFeedback: 'más tests' });
  const chat = chats.principalChat(t);
  chat.messages.push(
    { id: 'm1', role: 'plan', source: 'board', scope: 'task', version: 1, status: 'revise', feedback: 'más tests' },
    { id: 'm2', role: 'user', boardOnly: true, text: '✏️ Cambios al plan v1:\nmás tests' },
    { id: 'm3', role: 'plan', source: 'board', scope: 'task', version: 2, kind: 'revise', status: 'planning', progress: '🔧 Grep: x' },
    { id: 'm4', role: 'plan', source: 'board', scope: 'task', version: 1, status: 'pending' },
    { id: 'm5', role: 'plan', status: 'pending', plan: '' },
  );
  t.planning = { version: 2, kind: 'revise', startedAt: 'x', feedback: 'más tests', messageId: 'm3' };

  chats.resetChatsOnBoot(t);

  assert.equal(t.planning, null);
  assert.equal(t.planFeedback, 'más tests');
  const m = (id) => chat.messages.find((x) => x.id === id);
  assert.deepEqual({ status: m('m3').status, error: m('m3').error, progress: m('m3').progress }, { status: 'failed', error: 'the board restarted while replanning', progress: null });
  assert.equal(m('m1').status, 'revise');
  assert.equal(m('m4').status, 'pending', 'un plan de la tarea esperando aprobación sobrevive al reinicio');
  assert.equal(m('m5').status, 'expired', 'el de un turno de chat caduca como siempre');
});
