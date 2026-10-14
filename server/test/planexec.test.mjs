import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newPlanRecord, selectWithDeps, deselectWithDependents, applySelection, readyTasks, blockedTasks,
  exhausted, planProgress, planSummaryLine, parallelismReport, runPlan, stopPlan, continuePlan,
} from '../src/planexec.js';
import { validateWorkPlan } from '../src/workplan.js';

const graph = () => {
  const r = validateWorkPlan({ tasks: [
    { id: 't1', what: 'uno', files: ['a.rs'], dependsOn: [], check: 'cargo check' },
    { id: 't2', what: 'dos', files: ['b.rs'], dependsOn: [] },
    { id: 't3', what: 'tres', files: ['c.rs'], dependsOn: ['t1'] },
    { id: 't4', what: 'cuatro', files: ['d.rs'], dependsOn: ['t1', 't2'] },
  ] });
  assert.ok(r.ok, r.problem);
  return newPlanRecord({ id: 'p1', text: '# plan', ...r.plan });
};

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A host whose sessions are scripted per task and attempt, recording concurrency. */
function fakeHost({ outcomes = {}, checks = {}, decisions = [], forkFrom = 'chat-session', fingerprints = null } = {}) {
  const log = [];
  const started = [];
  const sessions = [];
  let open = 0;
  let peak = 0;
  const host = {
    forkFrom,
    maxRetries: 3,
    log: (l) => log.push(l),
    onChange: () => {},
    close: async (plan) => { host.closed = plan.status; },
    runSession: async ({ task, attempt, resume, fork }) => {
      sessions.push({ id: task.id, attempt, resume, fork });
      open += 1; peak = Math.max(peak, open);
      started.push(task.id);
      await tick(); await tick();
      open -= 1;
      const o = outcomes[task.id]?.[attempt - 1] ?? outcomes[task.id]?.at(-1) ?? { ok: true };
      return { sessionId: `s-${task.id}`, resultText: `hecho ${task.id}`, ...o };
    },
    check: async (task) => {
      const c = checks[task.id];
      if (!c) return { ok: true };
      const r = c.shift();
      return r ?? { ok: true };
    },
    filesChanged: async (task) => task.files.map((path) => ({ path, added: 1, removed: 0 })),
    ask: async () => decisions.shift() ?? { action: 'stop' },
    interrupt: () => {},
    log_: log, started, sessions, peak: () => peak,
  };
  // Optional, like on the real hosts: one scripted worktree fingerprint per
  // failed check of the task, the last one repeating.
  if (fingerprints) {
    const seen = {};
    host.fingerprint = async (task) => {
      const list = fingerprints[task.id] ?? [];
      const i = seen[task.id] = (seen[task.id] ?? -1) + 1;
      return list[Math.min(i, list.length - 1)] ?? null;
    };
  }
  return host;
}

test('selección: marcar una tarea arrastra sus dependencias pendientes; desmarcar arrastra a sus dependientes', () => {
  const plan = graph();
  assert.deepEqual(selectWithDeps(plan, ['t4']), { selected: ['t1', 't2', 't4'], added: ['t1', 't2'] });
  assert.deepEqual(deselectWithDependents(plan, ['t1', 't2', 't3', 't4'], 't1'), { selected: ['t2'], removed: ['t1', 't3', 't4'] });
  plan.tasks[0].status = 'done';
  assert.deepEqual(selectWithDeps(plan, ['t3']).added, [], 'una dependencia ya hecha no se vuelve a marcar');
});

test('applySelection deja saltado lo no elegido, y readyTasks solo lo que tiene sus dependencias hechas', () => {
  const plan = applySelection(graph(), ['t3']);
  assert.deepEqual(plan.tasks.map((t) => t.status), ['pending', 'skipped', 'pending', 'skipped']);
  assert.deepEqual(readyTasks(plan).map((t) => t.id), ['t1']);
  plan.tasks[0].status = 'done';
  assert.deepEqual(readyTasks(plan).map((t) => t.id), ['t3']);
});

test('una oleada entera arranca a la vez: las dos listas están abiertas antes de que termine ninguna', async () => {
  const plan = graph();
  const host = fakeHost();
  await runPlan(plan, host);
  assert.equal(host.peak(), 2, 't1 y t2 corrieron a la vez');
  assert.deepEqual(host.started.slice(0, 2).sort(), ['t1', 't2']);
  assert.deepEqual(plan.tasks.map((t) => t.status), ['done', 'done', 'done', 'done']);
  assert.equal(plan.status, 'done');
  assert.equal(host.closed, 'done', 'al terminar todo, el host cierra');
  assert.equal(parallelismReport(plan).peak, 2);
});

test('tres listas arrancan las tres: no hay tope', async () => {
  const r = validateWorkPlan({ tasks: ['a', 'b', 'c'].map((id) => ({ id, what: id, files: [`${id}.rs`], dependsOn: [] })) });
  const plan = newPlanRecord({ id: 'p', ...r.plan });
  const host = fakeHost();
  await runPlan(plan, host);
  assert.equal(host.peak(), 3);
});

test('la primera sesión de cada tarea es rama de la del host, y los reintentos reanudan la suya', async () => {
  const plan = graph();
  const host = fakeHost({ outcomes: { t2: [{ ok: false, error: 'boom' }, { ok: true }] } });
  await runPlan(plan, host);
  const first = host.sessions.find((s) => s.id === 't2' && s.attempt === 1);
  const retry = host.sessions.find((s) => s.id === 't2' && s.attempt === 2);
  assert.deepEqual({ resume: first.resume, fork: first.fork }, { resume: 'chat-session', fork: true });
  assert.deepEqual({ resume: retry.resume, fork: retry.fork }, { resume: 's-t2', fork: false });
  assert.equal(plan.tasks[1].attempts, 2);
  assert.equal(plan.tasks[1].status, 'done');
});

test('un check que falla dos veces y pasa a la tercera: done con tres intentos', async () => {
  const plan = graph();
  const host = fakeHost({ checks: { t1: [{ ok: false, output: 'error[E0308]' }, { ok: false, output: 'error[E0308]' }, { ok: true }] } });
  await runPlan(plan, host);
  assert.equal(plan.tasks[0].status, 'done');
  assert.equal(plan.tasks[0].attempts, 3);
  assert.equal(plan.tasks[0].lastFailure, null);
  assert.ok(host.log_.some((l) => /t1: the check failed \(attempt 1\)/.test(l)));
});

test('agotados los reintentos se pregunta; las hermanas siguen; «Saltar» salta a ella y a sus dependientes', async () => {
  const plan = graph();
  const host = fakeHost({
    checks: { t1: [{ ok: false, output: 'x' }, { ok: false, output: 'x' }, { ok: false, output: 'x' }, { ok: false, output: 'x' }] },
    decisions: [{ action: 'skip' }],
  });
  await runPlan(plan, host);
  assert.equal(plan.tasks[0].status, 'skipped');
  assert.equal(plan.tasks[0].attempts, 4, 'un intento y tres reintentos');
  assert.equal(plan.tasks[1].status, 'done', 't2 no dependía de t1 y terminó');
  assert.equal(plan.tasks[2].status, 'skipped', 't3 dependía de t1');
  assert.equal(plan.tasks[3].status, 'skipped', 't4 también');
  assert.equal(plan.status, 'done', 'lo que quedaba por hacer se hizo o se saltó');
});

test('«Otro» llega como pista y da otra ronda; «Detener» para el plan', async () => {
  const plan = graph();
  const host = fakeHost({
    checks: { t1: Array(6).fill({ ok: false, output: 'x' }) },
    decisions: [{ action: 'retry', hint: 'prueba con --features R4' }, { action: 'stop' }],
  });
  await runPlan(plan, host);
  assert.equal(plan.tasks[0].hint, 'prueba con --features R4');
  assert.equal(plan.tasks[0].attempts, 5, 'una ronda más tras la pista');
  assert.equal(plan.status, 'stopped');
  assert.equal(plan.tasks[0].status, 'failed');
  assert.ok(['stopped', 'pending', 'done'].includes(plan.tasks[2].status));
});

test('Detener marca detenidas las que corrían; Continuar relanza solo lo que falta', async () => {
  const plan = graph();
  let stopOnce = true;
  const host = fakeHost();
  const slow = host.runSession;
  host.runSession = async (args) => {
    if (args.task.id === 't2' && stopOnce) { stopOnce = false; stopPlan(plan, host); }
    return slow(args);
  };
  await runPlan(plan, host);
  assert.equal(plan.status, 'stopped');
  const stopped = plan.tasks.filter((t) => t.status === 'stopped').map((t) => t.id);
  assert.ok(stopped.length >= 1, `algo quedó detenido: ${planSummaryLine(plan)}`);
  const before = host.sessions.length;
  await continuePlan(plan, host);
  assert.equal(plan.status, 'done');
  assert.deepEqual(plan.tasks.map((t) => t.status), ['done', 'done', 'done', 'done']);
  const relaunched = host.sessions.slice(before).map((s) => s.id);
  assert.ok(!relaunched.includes('t1') || stopped.includes('t1'), 'lo hecho no se repite');
});

test('una fallida bloquea a sus dependientes, nunca a sus hermanas; el plan acaba failed', async () => {
  const plan = graph();
  const host = fakeHost({ outcomes: { t1: [{ ok: false, error: 'boom' }] }, decisions: [{ action: 'stop' }] });
  await runPlan(plan, host);
  assert.equal(plan.tasks[1].status, 'done', 't2 terminó aunque t1 fallara');
  assert.deepEqual(blockedTasks(plan).map((t) => t.id).sort(), ['t3', 't4']);
  assert.notEqual(host.closed, 'done');
});

test('progreso, resumen y reporte de paralelismo', () => {
  const plan = graph();
  plan.tasks[0].status = 'done'; plan.tasks[0].attempts = 2;
  plan.tasks[1].status = 'running';
  assert.deepEqual(planProgress(plan), { total: 4, done: 1, counts: { done: 1, running: 1, pending: 2 }, estimateMs: null });
  assert.equal(planSummaryLine(plan), 't1 ✓² t2 ⟳ t3 · t4 ·');
  assert.equal(exhausted({ attempts: 4 }, 3), true);
  assert.equal(exhausted({ attempts: 3 }, 3), false);
});

test('planProgress estima por la media de lo ya hecho, y espera al más rezagado', () => {
  const ahora = Date.parse('2026-09-14T12:00:00.000Z');
  const cuando = (ms) => new Date(ahora + ms).toISOString();
  const plan = graph();

  assert.equal(planProgress(plan, ahora).estimateMs, null, 'sin nada terminado no hay nada que prometer');

  plan.tasks[0].status = 'running';
  plan.tasks[0].startedAt = cuando(-60000);
  assert.equal(planProgress(plan, ahora).estimateMs, null, 'corriendo pero sin una sola medida tampoco');

  plan.tasks[0].status = 'done';
  plan.tasks[0].startedAt = cuando(-600000);
  plan.tasks[0].endedAt = cuando(-300000);        // 5 min
  assert.equal(planProgress(plan, ahora).estimateMs, null, 'hecha la medida, pero ya no corre nadie');

  plan.tasks[1].status = 'running';
  plan.tasks[1].startedAt = cuando(-60000);       // lleva 1, le quedan 4
  plan.tasks[2].status = 'checking';
  plan.tasks[2].startedAt = cuando(-120000);      // lleva 2, le quedan 3
  const p = planProgress(plan, ahora);
  assert.equal(p.estimateMs, 240000, 'las tareas corren a la vez: la espera es la de la más rezagada');
  assert.deepEqual({ total: p.total, done: p.done }, { total: 4, done: 1 }, 'lo de siempre sigue ahí');

  plan.tasks[1].startedAt = cuando(-3600000);
  plan.tasks[2].startedAt = cuando(-3600000);
  assert.equal(planProgress(plan, ahora).estimateMs, 60000, 'pasada la media, nunca se promete menos de un minuto');
});

// ---------------------------------------------------------------------------
// Cuota agotada a mitad del plan

/**
 * Un host cuya sesión de `quotaOn` muere por cuota enseguida, mientras un
 * hermano sigue trabajando: así se ve que al hermano lo cortan de verdad.
 */
function quotaHost({ quotaOn = 't1' } = {}) {
  const asked = [];
  const interrupted = [];
  const log = [];
  return {
    forkFrom: null,
    maxRetries: 3,
    asked,
    interrupted,
    log_: log,
    log: (l) => log.push(l),
    onChange: () => {},
    close: async () => {},
    runSession: async ({ task }) => {
      if (task.id === quotaOn) {
        await tick();
        return { ok: false, quota: true, error: "You've hit your usage limit · resets 4:30pm (UTC)" };
      }
      for (let i = 0; i < 10; i += 1) await tick();
      return { ok: true, sessionId: `s-${task.id}`, resultText: `hecho ${task.id}` };
    },
    check: async () => ({ ok: true }),
    filesChanged: async () => [],
    ask: async (task) => { asked.push(task.id); return { action: 'stop' }; },
    interrupt: (task) => interrupted.push(task.id),
  };
}

test('cuota agotada: no cuenta como intento, corta a los hermanos y NUNCA pregunta', async () => {
  const plan = graph();
  const host = quotaHost();
  await runPlan(plan, host);

  const t1 = plan.tasks.find((t) => t.id === 't1');
  // La regresión directa de la pregunta de 20 minutos que nadie podía contestar.
  assert.deepEqual(host.asked, [], 'no se pregunta a nadie por un muro de la cuenta');
  assert.equal(t1.attempts, 0, 'el intento se devuelve: no dice nada de la tarea');
  assert.equal(t1.status, 'stopped');
  assert.equal(plan.status, 'stopped');
  assert.equal(plan.quotaStopped, true, 'el pipeline lo lee para no dejar la tarea en error');
  assert.ok(host.interrupted.includes('t2'), 'al hermano se le corta la sesión: iba al mismo muro');
  assert.ok(host.log_.some((l) => /quota exhausted/.test(l)));
});

test('al continuar, el plan olvida que lo paró la cuota y los hechos siguen hechos', async () => {
  const plan = graph();
  await runPlan(plan, quotaHost());
  assert.equal(plan.quotaStopped, true);

  const host = fakeHost();
  await continuePlan(plan, host);
  assert.equal(plan.quotaStopped, false);
  assert.equal(plan.status, 'done');
  assert.equal(plan.tasks.find((t) => t.id === 't1').attempts, 1, 'arranca de cero, no desde un intento gastado');
});

// ---------------------------------------------------------------------------
// Fallo irrecuperable: la misma comprobación falla igual sobre el mismo worktree

const failing = (output, n = 8) => Array.from({ length: n }, () => ({ ok: false, output }));
const askedOf = (host) => {
  const asked = [];
  const ask = host.ask;
  host.ask = async (task) => { asked.push({ id: task.id, attempts: task.attempts, unrecoverable: Boolean(task.lastFailure?.unrecoverable) }); return ask(task); };
  return asked;
};

test('mismo fallo y mismo worktree: se pregunta al segundo intento, no al cuarto', async () => {
  const plan = graph();
  const host = fakeHost({ checks: { t1: failing('error[E0308]') }, fingerprints: { t1: ['tree-a'] }, decisions: [{ action: 'skip' }] });
  const asked = askedOf(host);
  await runPlan(plan, host);
  const t1 = plan.tasks[0];
  assert.equal(t1.attempts, 2, 'un intento y un reintento, no tres');
  assert.deepEqual(asked, [{ id: 't1', attempts: 2, unrecoverable: true }]);
  assert.equal(t1.lastFailure.unrecoverable, true, 'queda en el registro persistido');
  assert.equal(t1.lastFailure.fingerprint, 'tree-a');
  assert.equal(t1.status, 'skipped');
  assert.ok(host.log_.some((l) => /^t1: unrecoverable failure — the check failed the same way and the worktree did not change; not retrying$/.test(l)));
});

test('mismo fallo pero la sesión cambió archivos: se sigue reintentando como siempre', async () => {
  const plan = graph();
  const host = fakeHost({ checks: { t1: failing('error[E0308]') }, fingerprints: { t1: ['a', 'b', 'c', 'd'] }, decisions: [{ action: 'skip' }] });
  const asked = askedOf(host);
  await runPlan(plan, host);
  assert.equal(plan.tasks[0].attempts, 4);
  assert.deepEqual(asked, [{ id: 't1', attempts: 4, unrecoverable: false }]);
  assert.ok(!host.log_.some((l) => /unrecoverable/.test(l)));
});

test('lo que solo difiere en números (tiempos, puertos) cuenta como el mismo fallo', async () => {
  const plan = graph();
  const host = fakeHost({
    checks: { t1: [{ ok: false, output: 'test e2e took 1.2s on port 40123\nFAILED' }, { ok: false, output: '  test e2e took 13.47s on port 40999\nFAILED\n' }] },
    fingerprints: { t1: ['tree-a'] },
    decisions: [{ action: 'skip' }],
  });
  await runPlan(plan, host);
  assert.equal(plan.tasks[0].attempts, 2);
  assert.equal(plan.tasks[0].lastFailure.unrecoverable, true);
  assert.equal(plan.tasks[0].lastFailure.signature, 'test e#e took #.#s on port #\nFAILED', 'toda tira de dígitos, sin excepción');
});

test('sin huella del worktree (host sin fingerprint, o git que falla) nada es irrecuperable', async () => {
  for (const fingerprints of [null, { t1: [null] }]) {
    const plan = graph();
    const host = fakeHost({ checks: { t1: failing('x') }, fingerprints, decisions: [{ action: 'skip' }] });
    await runPlan(plan, host);
    assert.equal(plan.tasks[0].attempts, 4, 'los tres reintentos de siempre');
    assert.ok(!plan.tasks[0].lastFailure.unrecoverable);
    assert.ok(!host.log_.some((l) => /unrecoverable/.test(l)));
  }
});

test('el contador no pasa del máximo: la ronda que pide la persona se llama extra', async () => {
  const plan = graph();
  const host = fakeHost({ checks: { t1: failing('x') }, decisions: [{ action: 'retry', hint: 'prueba otra cosa' }, { action: 'stop' }] });
  await runPlan(plan, host);
  assert.equal(plan.tasks[0].attempts, 5);
  const counted = host.log_.map((l) => /retry (\d+) of 3/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  assert.deepEqual(counted, [1, 2, 3]);
  assert.ok(host.log_.some((l) => /^t1: extra retry \(requested by you\)/.test(l)));
});

test('tras un irrecuperable, «Reintentar» da una ronda; si falla igual, se vuelve a preguntar', async () => {
  const plan = graph();
  const host = fakeHost({ checks: { t1: failing('x') }, fingerprints: { t1: ['tree-a'] }, decisions: [{ action: 'retry', hint: null }, { action: 'stop' }] });
  const asked = askedOf(host);
  await runPlan(plan, host);
  assert.deepEqual(asked, [
    { id: 't1', attempts: 2, unrecoverable: true },
    { id: 't1', attempts: 3, unrecoverable: true },
  ], 'comparado contra el intento de justo antes, sin vuelta silenciosa');
  assert.equal(plan.status, 'stopped');
});

test('tras «Continuar», el primer intento no se compara con el fallo de la vez anterior', async () => {
  const plan = graph();
  const first = fakeHost({ checks: { t1: failing('x') }, fingerprints: { t1: ['tree-a'] }, decisions: [{ action: 'stop' }] });
  await runPlan(plan, first);
  assert.equal(plan.status, 'stopped');
  assert.equal(plan.tasks[0].lastFailure.fingerprint, 'tree-a', 'el fallo sobrevive al reinicio');

  const second = fakeHost({ checks: { t1: [{ ok: false, output: 'x' }, { ok: true }] }, fingerprints: { t1: ['tree-a'] } });
  const asked = askedOf(second);
  await continuePlan(plan, second);
  assert.deepEqual(asked, [], 'el primer intento de la nueva ronda tiene su oportunidad');
  assert.equal(plan.tasks[0].status, 'done');
  assert.equal(plan.tasks[0].attempts, 2);
  assert.ok(!second.log_.some((l) => /unrecoverable/.test(l)));
});

test('detenida a mitad de reintentos: tras «Continuar» un fallo idéntico no se declara irrecuperable', async () => {
  const plan = graph();
  const first = fakeHost({ checks: { t1: failing('x') }, fingerprints: { t1: ['tree-a'] } });
  const run = first.runSession;
  first.runSession = async (args) => {
    if (args.task.id === 't1' && args.attempt === 2) stopPlan(plan, first);
    return run(args);
  };
  await runPlan(plan, first);
  const t1 = plan.tasks[0];
  assert.equal(t1.status, 'stopped');
  assert.equal(t1.attempts, 2, 'una detenida conserva su cuenta');
  assert.equal(t1.lastFailure.fingerprint, 'tree-a');

  const second = fakeHost({ checks: { t1: [{ ok: false, output: 'x' }, { ok: true }] }, fingerprints: { t1: ['tree-a'] } });
  const asked = askedOf(second);
  await continuePlan(plan, second);
  assert.deepEqual(asked, [], 'el fallo de la ronda anterior no sirve de comparación');
  assert.ok(!second.log_.some((l) => /unrecoverable/.test(l)));
  assert.equal(t1.status, 'done');
  assert.equal(t1.attempts, 4, 'el presupuesto de la detenida no se toca');
});

// ---------------------------------------------------------------------------
// Reparación, «Dar por hecha» y `check: <comando>`

/** t1 fails the same way twice over the same tree, so it is unrecoverable at attempt 2. */
const unrecov = (over = {}) => fakeHost({ checks: { t1: failing('boom') }, fingerprints: { t1: ['tree-a'] }, ...over });
const withRepair = (host, fn) => { host.repairCalls = 0; host.repair = async (task) => { host.repairCalls += 1; return fn(task, host); }; return host; };
/** Scripts t1's checks: whatever is left after the list passes. */
const scriptChecks = (host, list) => { host.check = async (t) => (t.id === 't1' ? (list.shift() ?? { ok: true }) : { ok: true }); };
const boom = { ok: false, output: 'boom' };

test('reparación con cambio aprobado y el check pasa: hecha sin sesión nueva ni intento nuevo', async () => {
  const plan = graph();
  const host = withRepair(unrecov({ decisions: [{ action: 'stop' }] }), (task) => {
    assert.equal(task.status, 'running');
    assert.equal(task.repairing, true);
    return { changed: true };
  });
  scriptChecks(host, [boom, boom, { ok: true }]);
  await runPlan(plan, host);
  const t1 = plan.tasks[0];
  assert.equal(t1.status, 'done');
  assert.equal(t1.attempts, 2);
  assert.equal(host.sessions.filter((s) => s.id === 't1').length, 2, 'ninguna sesión nueva');
  assert.equal(host.repairCalls, 1);
  assert.equal(t1.repairing, false);
  assert.equal(t1.summary, 'hecho t1');
  assert.ok(host.log_.some((l) => l === 't1: unrecoverable failure — the session analyzes whether the failure is in the plan'));
  assert.ok(host.log_.some((l) => l === 't1: check after the plan change ✓'));
});

test('reparación con cambio y el mismo fallo: se pregunta, sin segunda reparación', async () => {
  const plan = graph();
  const host = withRepair(unrecov({ decisions: [{ action: 'skip' }] }), () => ({ changed: true }));
  const asked = askedOf(host);
  await runPlan(plan, host);
  assert.equal(host.repairCalls, 1);
  assert.deepEqual(asked, [{ id: 't1', attempts: 2, unrecoverable: true }]);
  assert.equal(plan.tasks[0].lastFailure.repairTried, true);
  assert.ok(host.log_.some((l) => l === 't1: check after the plan change ✗'));
});

test('reparación y el check falla distinto: flujo normal, se sigue reintentando', async () => {
  const plan = graph();
  const host = withRepair(unrecov({ decisions: [{ action: 'skip' }] }), () => ({ changed: true }));
  scriptChecks(host, [boom, boom, { ok: false, output: 'otro error' }]);
  await runPlan(plan, host);
  const t1 = plan.tasks[0];
  assert.equal(t1.status, 'done', 'el intento 3 pasa');
  assert.equal(t1.attempts, 3);
});

test('{changed:false}: se pregunta, y un Reintentar que vuelve a fallar igual no gasta otra reparación', async () => {
  const plan = graph();
  const host = withRepair(unrecov({ decisions: [{ action: 'retry', hint: null }, { action: 'stop' }] }), () => ({ changed: false }));
  const asked = askedOf(host);
  await runPlan(plan, host);
  assert.equal(host.repairCalls, 1, 'una reparación por el mismo fallo');
  assert.equal(asked.length, 2);
  assert.equal(plan.tasks[0].attempts, 3);
});

test('reparación que lanza: se pregunta sin volver a comprobar', async () => {
  const plan = graph();
  const host = withRepair(unrecov({ decisions: [{ action: 'skip' }] }), () => { throw new Error('kaput'); });
  let checks = 0;
  const check = host.check;
  host.check = async (t) => { checks += 1; return check(t); };
  await runPlan(plan, host);
  assert.equal(checks, 2, 'solo los dos checks de los intentos');
  assert.equal(plan.tasks[0].status, 'skipped');
  assert.ok(host.log_.some((l) => /repair failed \(kaput\)/.test(l)));
});

test('reparación con cuota: el plan se detiene y no cuenta intento', async () => {
  const plan = graph();
  const host = withRepair(unrecov(), () => ({ changed: false, quota: true }));
  const asked = askedOf(host);
  await runPlan(plan, host);
  assert.equal(plan.status, 'stopped');
  assert.equal(plan.quotaStopped, true);
  assert.equal(plan.tasks[0].status, 'stopped');
  assert.equal(plan.tasks[0].attempts, 2);
  assert.deepEqual(asked, []);
});

test('sin host.repair: el comportamiento de siempre (se pregunta)', async () => {
  const plan = graph();
  const host = unrecov({ decisions: [{ action: 'skip' }] });
  const asked = askedOf(host);
  await runPlan(plan, host);
  assert.equal(asked.length, 1);
  assert.ok(!host.log_.some((l) => /analyzes/.test(l)));
});

test('Detener durante la reparación: la tarea queda detenida y sin «repairing»', async () => {
  const plan = graph();
  const host = withRepair(unrecov(), async (task) => {
    assert.equal(task.repairing, true);
    stopPlan(plan, host);
    assert.equal(task.repairing, false);
    return { changed: true };
  });
  await runPlan(plan, host);
  assert.equal(plan.status, 'stopped');
  assert.equal(plan.tasks[0].status, 'stopped');
  assert.equal(plan.tasks[0].repairing, false);
});

test('ask → «Dar por hecha»: hecha sin pasar el check, con el resumen de la última sesión', async () => {
  const plan = graph();
  const host = unrecov({ decisions: [{ action: 'done' }] });
  await runPlan(plan, host);
  const t1 = plan.tasks[0];
  assert.equal(t1.status, 'done');
  assert.equal(t1.lastFailure, null);
  assert.equal(t1.summary, 'hecho t1');
  assert.ok(t1.endedAt);
  assert.ok(host.log_.includes('t1: marked done by the person (check not run)'));
  assert.equal(plan.tasks[2].status, 'done', 'su dependiente corre');
});

test('ask → set-check que pasa: check cambiado, registrado, hecha sin sesión nueva', async () => {
  const plan = graph();
  const host = unrecov({ decisions: [{ action: 'set-check', check: 'true' }] });
  scriptChecks(host, [boom, boom, { ok: true }]);
  await runPlan(plan, host);
  const t1 = plan.tasks[0];
  assert.equal(t1.check, 'true');
  assert.equal(t1.status, 'done');
  assert.equal(host.sessions.filter((s) => s.id === 't1').length, 2);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].taskId, 't1');
  assert.equal(plan.changes[0].reason, 'changed by the person');
  assert.deepEqual(plan.changes[0].before, { check: 'cargo check' });
  assert.deepEqual(plan.changes[0].after, { check: 'true' });
  assert.deepEqual(plan.changes[0].added, []);
  assert.ok(host.log_.some((l) => l === 't1: check changed by the person: `cargo check` → `true`'));
});

test('ask → set-check que falla: se pregunta de nuevo al instante, con el fallo nuevo y sin sesiones extra', async () => {
  const plan = graph();
  const host = unrecov({ decisions: [{ action: 'set-check', check: 'nope' }, { action: 'skip' }] });
  const seen = [];
  const ask = host.ask;
  host.ask = async (task) => { seen.push(task.lastFailure.output); return ask(task); };
  scriptChecks(host, [boom, boom, { ok: false, output: 'nope: not found' }]);
  await runPlan(plan, host);
  assert.deepEqual(seen, ['boom', 'nope: not found']);
  assert.equal(host.sessions.filter((s) => s.id === 't1').length, 2);
  assert.equal(plan.tasks[0].status, 'skipped');
  assert.equal(plan.tasks[0].check, 'nope');
});

test('el resumen de una tarea es la respuesta sellada cuando el turno adoptado es un acuse', async () => {
  const GOOD = 'Cambié a.rs y añadí el test.\n' + 'detalle '.repeat(40);
  const plan = graph();
  const host = fakeHost({ outcomes: { t1: [{ ok: true, resultText: 'Background agent completed: PONG received.', sealedText: GOOD }] } });
  await runPlan(plan, host);
  assert.equal(plan.tasks[0].summary, GOOD);
  assert.equal(plan.tasks[1].summary, 'hecho t2', 'a plain short summary with nothing sealed stays');
  assert.ok(host.log_.some((l) => /t1: the adopted answer looked like an acknowledgement/.test(l)));
});
