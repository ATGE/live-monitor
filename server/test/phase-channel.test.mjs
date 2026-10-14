// El canal de una fase: por qué `runClaude` ya no manda el prompt como cadena.
//
// La causa está medida en `tools/permission-probe` (commit fe52807): con un
// `prompt` de tipo cadena —y con un generador que termina, que es lo mismo— el
// SDK cierra stdin al primer `result`, eso mata el canal de control, y el CLI
// aborta cualquier hook `PreToolUse` nuestro y DENIEGA toda herramienta que el
// matcher de ese hook cubra. Mismo hook con el canal abierto: cero denegaciones.
//
// Aquí no se abre ninguna sesión real: `claudeHooks.query` es la costura, al
// estilo de `usageHooks.query`. Lo que se comprueba es la forma del generador,
// el criterio de cierre (result sellado + nada vivo), que un result posterior
// no pisa el resultado de la fase, y que una denegación se ve.
import './isolate.mjs';   // primero: `claude.js` llega al directorio de datos
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  runClaude, claudeHooks, TASK_GRACE_MS, DENIED_TOOL_TEXT, isDeniedToolResult,
  resultAnswers, stamped,
} from '../src/claude.js';
import { newActivity, applyEvent } from '../src/activity.js';

const original = { query: claudeHooks.query, taskGraceMs: claudeHooks.taskGraceMs, reportSettleMs: claudeHooks.reportSettleMs };
beforeEach(() => {
  claudeHooks.query = original.query;
  claudeHooks.taskGraceMs = original.taskGraceMs;
  claudeHooks.reportSettleMs = original.reportSettleMs;
});
after(() => {
  claudeHooks.query = original.query;
  claudeHooks.taskGraceMs = original.taskGraceMs;
  claudeHooks.reportSettleMs = original.reportSettleMs;
});

/** Un turno del bucle de eventos: deja que el drenaje del prompt avance. */
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Un `query` falso que hace de CLI: drena el prompt (eso es su stdin) y emite
 * los frames del guión. Un paso del guión puede ser un objeto —el frame— o una
 * función que recibe el estado y devuelve un frame (o nada).
 */
function fakeSdk(script) {
  const state = { prompt: null, options: null, sent: [], inputClosed: false, interrupted: false };
  claudeHooks.query = ({ prompt, options }) => {
    state.prompt = prompt;
    state.options = options;
    // El stdin del CLI: se lee en paralelo, y termina solo cuando el tablero
    // suelta el generador.
    (async () => {
      for await (const m of prompt) state.sent.push(m);
      state.inputClosed = true;
    })();
    return (async function* stream() {
      for (const step of script) {
        const frame = typeof step === 'function' ? await step(state) : step;
        if (frame) yield frame;
      }
    })();
  };
  return state;
}

const uuidOf = (s) => s.sent[0]?.uuid;

const init = () => ({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-haiku-4-5' });
const text = (uuid, t) => ({
  type: 'assistant', user_message_uuid: uuid, session_id: 'sess-1',
  message: { role: 'assistant', content: [{ type: 'text', text: t }] },
});
const toolUse = (uuid, id, name, input = {}) => ({
  type: 'assistant', session_id: 'sess-1', ...(uuid ? { user_message_uuid: uuid } : {}),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, content, isError = false) => ({
  type: 'user', session_id: 'sess-1',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});
const ok = (uuid, result) => ({
  type: 'result', subtype: 'success', result, num_turns: 2, total_cost_usd: 0.01,
  session_id: 'sess-1', ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}),
});
const taskStarted = (taskId, extra = {}) => ({ type: 'system', subtype: 'task_started', task_id: taskId, description: 'probe', is_backgrounded: true, ...extra });
const taskDone = (taskId) => ({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', summary: 'listo' });
const bgTasks = (tasks) => ({ type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-1', tasks });

/**
 * Como el CLI de verdad: el flujo no termina hasta que se cierra su stdin.
 * Espera con el reloj, no con `setImmediate`: el tope de gracia es un timer y
 * una cadena de inmediatos no lo deja llegar.
 */
const untilClosed = async (s) => {
  for (let i = 0; i < 500 && !s.inputClosed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
  return null;
};

const collect = () => { const evs = []; return { evs, onEvent: (ev) => evs.push(ev) }; };
const run = (over = {}) => runClaude({ cwd: '/wt/x', model: 'haiku', prompt: 'haz algo', trackQuota: false, ...over });

// ---------------------------------------------------------------- la forma

test('el prompt llega al SDK como iterable asíncrono, con la forma que empuja session.js', async () => {
  const sdk = fakeSdk([tick, (s) => text(uuidOf(s), 'hola'), (s) => ok(uuidOf(s), 'HECHO'), untilClosed]);
  const r = await run();

  assert.equal(typeof sdk.prompt, 'object');
  assert.equal(typeof sdk.prompt[Symbol.asyncIterator], 'function', 'una cadena cerraría stdin al primer result');
  assert.equal(sdk.sent.length, 1, 'un solo mensaje: el prompt de la fase');
  const sent = sdk.sent[0];
  assert.equal(sent.type, 'user');
  assert.equal(sent.message.role, 'user');
  assert.equal(sent.message.content, 'haz algo');
  assert.equal(sent.parent_tool_use_id, null);
  assert.equal(sent.session_id, '');
  assert.match(sent.uuid, /^[0-9a-f-]{36}$/, 'el sello con el que se reconoce nuestro result');
  assert.equal(r.ok, true);
  assert.equal(r.resultText, 'HECHO');
});

test('el generador NO termina antes del result: el canal de control sigue vivo mientras corren las herramientas', async () => {
  const seen = [];
  const sdk = fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'b1', 'Bash', { command: 'cargo test' }),
    async (s) => { await tick(); seen.push(['tras el tool_use', s.inputClosed]); return toolResult('b1', 'ok'); },
    async (s) => { await tick(); seen.push(['tras el tool_result', s.inputClosed]); return null; },
    (s) => ok(uuidOf(s), 'HECHO'),
    untilClosed,
  ]);
  await run();

  assert.deepEqual(seen, [['tras el tool_use', false], ['tras el tool_result', false]]);
  assert.equal(sdk.inputClosed, true, 'y se cierra cuando el turno acabó de verdad');
});

// ------------------------------------------------------- criterio de cierre

// Records `inputClosed` at this point of the script. The assertion is made after
// `run()`: one thrown inside the generator is swallowed by `runClaude`, and the
// failure would show up as a different `resultText` instead of its own message.
const snap = (into, key) => async (s) => { await tick(); into[key] = s.inputClosed; return null; };

test('con el result sellado y ninguna tarea viva, el generador termina', async () => {
  const at = {};
  const sdk = fakeSdk([
    tick,
    init,
    (s) => ok(uuidOf(s), 'HECHO'),
    snap(at, 'afterResult'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(at.afterResult, true, 'nada vivo: se cierra en el result');
  assert.equal(r.resultText, 'HECHO');
  assert.equal(sdk.inputClosed, true);
});

test('una tarea de fondo viva mantiene el canal abierto; el nivel background_tasks_changed lo libera', async () => {
  const at = {};
  const sdk = fakeSdk([
    tick,
    init,
    taskStarted('task-1'),
    (s) => ok(uuidOf(s), 'lanzado, espero'),
    snap(at, 'working'),
    // Nivel con semántica de reemplazo: la ambiental no es actividad.
    () => bgTasks([{ task_id: 'task-1', task_type: 'agent', description: 'probe' }, { task_id: 'watch-1', task_type: 'watcher', description: 'live', ambient: true }]),
    snap(at, 'inLevel'),
    () => bgTasks([{ task_id: 'watch-1', task_type: 'watcher', description: 'live', ambient: true }]),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(at.working, false, 'el subagente sigue trabajando');
  assert.equal(at.inLevel, false, 'task-1 sigue en el nivel');
  assert.equal(r.resultText, 'lanzado, espero');
  assert.equal(sdk.inputClosed, true, 'sin tareas no ambientales, se cierra');
});

test('sin nivel, los bordes valen de respaldo: task_notification cierra el canal', async () => {
  const at = {};
  const sdk = fakeSdk([
    tick,
    init,
    taskStarted('task-1'),
    (s) => ok(uuidOf(s), 'lanzado'),
    snap(at, 'working'),
    () => taskDone('task-1'),
    untilClosed,
  ]);
  await run();
  assert.equal(at.working, false, 'la tarea sigue viva: el canal sigue abierto');
  assert.equal(sdk.inputClosed, true);
});

test('el tope de gracia libera una tarea que nunca reporta, y lo dice', async () => {
  claudeHooks.taskGraceMs = 40;
  const { evs, onEvent } = collect();
  const sdk = fakeSdk([
    tick,
    init,
    taskStarted('task-zombi'),
    (s) => ok(uuidOf(s), 'lanzado'),
    untilClosed,
  ]);
  const r = await run({ onEvent });

  assert.equal(sdk.inputClosed, true, 'al vencer el tope se cierra igual');
  const warn = evs.filter((e) => e.kind === 'warn');
  assert.equal(warn.length, 1, 'el tope tiene su línea de log');
  assert.match(warn[0].warning, /task-zombi/);
  assert.match(warn[0].warning, /the channel is closed/);
  assert.equal(r.resultText, 'lanzado', 'el resultado de la fase se conserva');
  assert.equal(TASK_GRACE_MS, 10 * 60_000, 'en producción el tope son diez minutos');
});

// --------------------------------------------- el segundo result, domado

test('un result posterior sin sello no pisa resultText, pero sí cuenta sus herramientas', async () => {
  const { evs, onEvent } = collect();
  const sdk = fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Bash', { command: 'cargo test', run_in_background: true, description: 'probe' }),
    () => toolResult('a1', 'lanzado'),
    taskStarted('task-1', { task_type: 'local_bash', tool_use_id: 'a1' }),
    // El result que contesta a NUESTRO prompt: esto es el resultado de la fase.
    (s) => ok(uuidOf(s), 'TRIAGE_RESULT: {"complexity":"simple"}'),
    // Y ahora el CLI arranca un turno propio al enterarse del comando de fondo.
    init,
    () => toolUse(null, 'b9', 'Bash', { command: 'cat report.txt' }),
    () => toolResult('b9', 'el informe'),
    () => ({ type: 'result', subtype: 'success', result: 'he leído la salida del comando', num_turns: 1, total_cost_usd: 0.02, session_id: 'sess-1' }),
    () => taskDone('task-1'),
    untilClosed,
  ]);
  const r = await run({ onEvent });

  assert.equal(r.resultText, 'TRIAGE_RESULT: {"complexity":"simple"}', 'el sellado manda: si no, la fase leería el turno posterior');
  assert.equal(r.ok, true);
  assert.equal(r.toolCounts.Bash, 2, 'lo posterior va a los contadores');
  const results = evs.filter((e) => e.kind === 'result');
  assert.deepEqual(results.map((e) => e.post), [false, true], 'el segundo result se marca como post-turno');
  assert.equal(evs.filter((e) => e.kind === 'warn').length, 0, 'un comando fuera no es el caso de la regla de subagentes');
  assert.equal(r.stats.sealedOpen, 0);
  assert.equal(sdk.inputClosed, true);
});

// Un subagente fuera al sellar: el sello es la frase de espera, y manda el result del turno que sigue al último informe.
const WAITING = 'los subagentes siguen trabajando; escribo el plan cuando lleguen';
const PLAN = 'WORK_PLAN: {"tasks":[]}';
const finalResult = (text) => () => ({ type: 'result', subtype: 'success', result: text, num_turns: 3, total_cost_usd: 0.03, session_id: 'sess-1' });
const agentStarted = (id) => taskStarted(id, { task_type: 'local_agent', subagent_type: 'Explore', tool_use_id: 'a1' });

for (const [name, order, answerFrom, warnings] of [
  ['el subagente reporta antes de que el CLI abra su turno: ese turno cierra la ventana', (id) => [() => taskDone(id), init], 'post', 1],
  ['el CLI abre su turno antes de que el subagente reporte: ese turno no cierra y queda sin cerrar', (id) => [init, () => taskDone(id)], 'unclosed', 2],
]) {
  test(`con un subagente fuera al sellar, se adopta el result del turno que sigue: ${name}`, async () => {
    const { evs, onEvent } = collect();
    claudeHooks.reportSettleMs = 30;   // no turn follows the report: do not wait 15 s
    const sdk = fakeSdk([
      tick,
      init,
      (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore', description: 'probe' }),
      agentStarted('task-1'),
      (s) => ok(uuidOf(s), WAITING),
      ...order('task-1'),
      finalResult(PLAN),
      untilClosed,
    ]);
    const r = await run({ onEvent, metrics: undefined });

    assert.equal(r.resultText, PLAN, 'la respuesta de verdad, no la frase de espera');
    assert.equal(r.ok, true);
    assert.equal(r.stats.sealedOpen, 1);
    assert.equal(r.stats.turns, 3, 'turns es el del result adoptado, no el del sellado');
    assert.equal(r.stats.subtype, 'success');
    assert.equal(r.stats.answerFrom, answerFrom);
    const warns = evs.filter((e) => e.kind === 'warn');
    assert.equal(warns.length, warnings);
    assert.match(warns[0].warning, /1 subagent\(s\)/);
    assert.match(warns[0].warning, /the turn after the last report/, 'the warning no longer says «último result con éxito»');
    if (answerFrom === 'unclosed') assert.match(warns[1].warning, /the wait for the turn .* ran out/);
    assert.equal(sdk.inputClosed, true);
  });
}

test('un subagente se reconoce por el tool_use de Agent aunque el frame no traiga tipo', async () => {
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Task', { subagent_type: 'Explore' }),
    taskStarted('task-1', { tool_use_id: 'a1' }),
    (s) => ok(uuidOf(s), WAITING),
    init,
    () => taskDone('task-1'),
    finalResult(PLAN),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, PLAN);
  assert.equal(r.stats.sealedOpen, 1);
});

test('con un subagente fuera al sellar, un error posterior no pisa la respuesta', async () => {
  claudeHooks.reportSettleMs = 30;   // el informe llega sin turno detrás: no se espera 15 s
  fakeSdk([
    tick,
    init,
    agentStarted('task-1'),
    (s) => ok(uuidOf(s), 'PLAN BUENO'),
    init,
    () => ({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9, total_cost_usd: 0.03, session_id: 'sess-1', queued_turn_count: 0, errors: [] }),
    () => taskDone('task-1'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.resultText, 'PLAN BUENO');
});

test('sin ninguna tarea fuera al sellar, un result posterior no pisa nada', async () => {
  fakeSdk([
    tick,
    init,
    (s) => ok(uuidOf(s), 'PLAN BUENO'),
    init,
    finalResult('he vuelto a pensar'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, 'PLAN BUENO');
  assert.equal(r.stats.sealedOpen, 0);
});

test('un result de error posterior tampoco pisa el resultado de la fase', async () => {
  const sdk = fakeSdk([
    tick,
    init,
    taskStarted('task-1'),
    (s) => ok(uuidOf(s), 'PLAN BUENO'),
    init,
    () => ({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9, total_cost_usd: 0.03, session_id: 'sess-1', queued_turn_count: 0, errors: [] }),
    () => taskDone('task-1'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.resultText, 'PLAN BUENO');
  assert.equal(sdk.inputClosed, true);
});

test('el sello se casa por user_message_uuids, y un error sin sello ni cola sí es nuestro', () => {
  assert.equal(stamped({ user_message_uuids: ['a', 'b'] }, 'b'), true);
  assert.equal(resultAnswers({ subtype: 'success', user_message_uuid: 'x' }, 'x'), true);
  assert.equal(resultAnswers({ subtype: 'success' }, 'x'), false, 'un éxito sin sello es un turno del CLI');
  assert.equal(resultAnswers({ subtype: 'error_during_execution', queued_turn_count: 0 }, 'x'), true);
  assert.equal(resultAnswers({ subtype: 'error_during_execution', queued_turn_count: 1 }, 'x'), false);
});

// ------------------------------------------------- la denegación, visible

test('una denegación emite warn, marca el tool_end y el árbol la cierra en error', async () => {
  const { evs, onEvent } = collect();
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'b1', 'Bash', { command: 'cargo test', run_in_background: true }),
    () => toolResult('b1', DENIED_TOOL_TEXT, true),
    (s) => ok(uuidOf(s), 'no pude'),
    untilClosed,
  ]);
  await run({ onEvent });

  const end = evs.find((e) => e.kind === 'tool_end');
  assert.equal(end.denied, true, 'activity.js lee esta marca');
  assert.equal(end.ok, false);
  const warn = evs.filter((e) => e.kind === 'warn');
  assert.equal(warn.length, 1, 'ruidoso a propósito: el texto manda al modelo esperar a un usuario que no existe');
  assert.match(warn[0].warning, /DENIED/);
  assert.match(warn[0].warning, /Bash/);

  // Y el árbol de actividad: nada queda girando.
  const a = newActivity('t');
  for (const ev of evs) if (ev.kind === 'tool' || ev.kind === 'tool_end') applyEvent(a, ev);
  assert.equal(a.items[0].status, 'error');
  assert.equal(a.items[0].denied, true);
  assert.match(a.items[0].output, /doesn't want to take this action/);
});

test('la denegación de un subagente se nombra como tal', async () => {
  const { evs, onEvent } = collect();
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore', description: 'probe' }),
    () => ({
      type: 'assistant', parent_tool_use_id: 'a1', session_id: 'sess-1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'inner1', name: 'Bash', input: { command: 'echo uno' } }] },
    }),
    () => ({
      type: 'user', parent_tool_use_id: 'a1', session_id: 'sess-1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'inner1', content: DENIED_TOOL_TEXT, is_error: true }] },
    }),
    (s) => ok(uuidOf(s), 'nada'),
    untilClosed,
  ]);
  await run({ onEvent });

  const warn = evs.find((e) => e.kind === 'warn');
  assert.match(warn.warning, /subagent/, 'es el caso que más lo sufre');
  assert.equal(isDeniedToolResult('todo bien'), false);
  assert.equal(isDeniedToolResult(DENIED_TOOL_TEXT), true);
});

// ---------------------------------------------------------------- triage: una sola re-pregunta

/**
 * Un `query` falso por turno: el n-ésimo turno contesta `replies[n]`. Guarda las
 * opciones y el prompt de cada turno, para ver que la re-pregunta REANUDA.
 */
function turnsSdk(replies) {
  const turns = [];
  claudeHooks.query = ({ prompt, options }) => {
    const turn = { options, sent: [], closed: false };
    turns.push(turn);
    const reply = replies[turns.length - 1] ?? '';
    (async () => { for await (const m of prompt) turn.sent.push(m); turn.closed = true; })();
    return (async function* stream() {
      await tick();
      const uuid = turn.sent[0]?.uuid;
      yield init();
      yield text(uuid, reply);
      yield ok(uuid, reply);
      for (let i = 0; i < 500 && !turn.closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  return turns;
}

const VERDICT = 'TRIAGE_RESULT: {"complexity":"simple","reason":"una línea","summary":"A one line fix."}';

async function triageHarness() {
  process.env.HFSMON_NO_AUTOSTART = '1';
  const { store } = await import('../src/store.js');
  const pipeline = await import('../src/pipeline.js');
  const task = store.addTask({ number: 9700 + Math.floor(Math.random() * 200), title: 't', labels: [], url: 'https://x/1', closed: false }, 'hfs');
  task.worktreePath = '/wt/triage';
  const first = { ok: true, sessionId: 'sess-1', resultText: 'Analicé el issue: es simple, tocar un archivo.' };
  return { pipeline, task, first, logs: () => task.log.filter((l) => l.phase === 'triage').map((l) => l.line) };
}

test('triage sin TRIAGE_RESULT: se pregunta UNA vez en la misma sesión y se usa esa respuesta', async () => {
  const { pipeline, task, first, logs } = await triageHarness();
  const turns = turnsSdk([VERDICT]);
  const r = await pipeline.triageVerdictFor(task, first, { run: runClaude });

  assert.equal(r.path, 'reasked');
  assert.equal(r.verdict.complexity, 'simple');
  assert.equal(turns.length, 1, 'una sola pregunta más');
  assert.equal(turns[0].options.resume, 'sess-1', 'la misma sesión, no una nueva');
  assert.equal(turns[0].sent[0].message.content, pipeline.TRIAGE_REASK);
  assert.ok(logs().some((l) => /asking once more in the same session/.test(l)), logs().join('\n'));
});

test('triage con la línea a la primera: no se pregunta nada', async () => {
  const { pipeline, task, first } = await triageHarness();
  const turns = turnsSdk([VERDICT]);
  const r = await pipeline.triageVerdictFor(task, { ...first, resultText: `${VERDICT}\nresto` }, { run: runClaude });
  assert.equal(r.path, 'first');
  assert.equal(turns.length, 0);
});

test('triage que sigue sin veredicto tras la re-pregunta: «complejo» por prudencia, y se dice por qué camino', async () => {
  const { pipeline, task, first, logs } = await triageHarness();
  const turns = turnsSdk(['sigo sin dar la línea', 'otra vez nada']);
  const r = await pipeline.triageVerdictFor(task, first, { run: runClaude });
  assert.equal(r.path, 'fallback');
  assert.equal(r.verdict.complexity, 'complex');
  assert.equal(r.verdict.summary, first.resultText.slice(0, 500));
  assert.equal(turns.length, 1, 'nunca más de una re-pregunta');
  assert.ok(logs().some((l) => /assumed complex to be safe/.test(l)), logs().join('\n'));
});

// ------------------------------------- la red del sello: ventana de adopción (#28)

const RECORDED = JSON.parse(readFileSync(new URL('../../tools/subagent-probe/result-rewrite.json', import.meta.url), 'utf8')).runs;

/**
 * The frames of a recorded probe run, rebuilt. The recording keeps no task ids,
 * no stamps and cut texts, so ids are synthesised and the first result is the
 * stamped one (the seal), the way the board saw it.
 */
function replay(run) {
  let results = 0;
  return run.events.flatMap((e) => {
    switch (e.kind) {
      case 'init': return [init];
      case 'tool_use': return [(s) => toolUse(uuidOf(s), 'a1', e.name, {})];
      case 'task_started': return [() => taskStarted('task-1', {
        task_type: e.task_type, subagent_type: e.subagent_type, tool_use_id: 'a1', is_backgrounded: e.is_backgrounded,
      })];
      case 'background_tasks_changed': return [() => bgTasks(e.tasks.map((t) => ({ ...t, task_id: 'task-1' })))];
      case 'tool_result': return [() => toolResult('a1', e.text)];
      case 'task_notification': return [() => taskDone('task-1')];
      case 'result': {
        results += 1;
        const text = e.text;
        return results === 1 ? [(s) => ok(uuidOf(s), text)] : [finalResult(text)];
      }
      default: return [];
    }
  });
}

/** Records whether the channel was already closed when this step runs, after the seal settled. */
const probeClosed = (into) => async (s) => { await tick(); await tick(); into.closed = s.inputClosed; return null; };

test('la secuencia grabada: el subagente informa antes del sello y la respuesta de verdad llega en el turno siguiente', async () => {
  const at = {};
  const control = RECORDED[0];
  assert.match(control.label, /control/);
  const frames = replay(control);
  const sealAt = frames.findIndex((f, i) => i > 0 && control.events[i]?.kind === 'result');
  const sdk = fakeSdk([tick, ...frames.slice(0, sealAt + 1), probeClosed(at), ...frames.slice(sealAt + 1), untilClosed]);
  const { evs, onEvent } = collect();
  const r = await run({ onEvent });

  assert.equal(r.resultText, 'FINAL: PONG', 'no la frase de espera que selló el turno');
  assert.equal(r.stats.answerFrom, 'post');
  assert.equal(r.stats.sealedOpen, 0, 'al sellar no quedaba nada fuera: ya había informado');
  assert.equal(r.stats.sealedEarly, 1);
  assert.equal(at.closed, false, 'el canal sigue abierto tras el sello: el turno del CLI aún tiene que abrirse');
  assert.equal(evs.filter((e) => e.kind === 'warn').length, 1);
  assert.equal(sdk.inputClosed, true);
});

// Guarda de regresión (no prueba de arreglo): este comportamiento ya era así antes de #31.
test('guarda de regresión: con el subagente en primer plano lo sellado ya es la respuesta y el canal se cierra', async () => {
  const at = {};
  const sdk = fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    () => taskStarted('task-1', { task_type: 'local_agent', subagent_type: 'Explore', tool_use_id: 'a1', is_backgrounded: false }),
    () => taskDone('task-1'),
    (s) => ok(uuidOf(s), 'FINAL: PONG'),
    probeClosed(at),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, 'FINAL: PONG');
  assert.equal(r.stats.sealedEarly, 0, 'un subagente en primer plano no debe nada');
  assert.equal(r.stats.answerFrom, 'sealed');
  assert.equal(at.closed, true, 'sin deuda no se espera ningún turno');
  assert.equal(sdk.inputClosed, true);
});

// Guarda de regresión (no prueba de arreglo): este comportamiento ya era así antes de #31.
test('guarda de regresión: un subagente ya informado y ningún turno después, vence la espera corta y queda la respuesta sellada', async () => {
  claudeHooks.reportSettleMs = 30;
  const { evs, onEvent } = collect();
  const sdk = fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    agentStarted('task-1'),
    () => taskDone('task-1'),
    (s) => ok(uuidOf(s), WAITING),
    untilClosed,
  ]);
  const r = await run({ onEvent });
  assert.equal(r.resultText, WAITING);
  assert.equal(r.stats.answerFrom, 'sealed');
  assert.equal(sdk.inputClosed, true, 'se suelta el canal');
  assert.ok(evs.some((e) => e.kind === 'warn' && /no turn/.test(e.warning)));
});

test('la ventana se cierra con el turno que sigue al último informe: el turno de un comando de fondo no pisa el plan', async () => {
  const sdk = fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore', description: 'probe' }),
    agentStarted('task-1'),
    (s) => ok(uuidOf(s), WAITING),
    () => taskDone('task-1'),
    init,
    () => toolUse(null, 'b1', 'Bash', { command: 'cargo build', run_in_background: true }),
    taskStarted('build-1', { task_type: 'local_bash', tool_use_id: 'b1' }),
    finalResult(PLAN),
    // La compilación termina y el CLI abre un turno propio para contarlo.
    () => taskDone('build-1'),
    init,
    finalResult('la compilación terminó'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, PLAN, 'el turno de la compilación no es la respuesta');
  assert.equal(r.stats.answerFrom, 'post');
  assert.equal(r.stats.sealedOpen, 1);
  assert.equal(sdk.inputClosed, true);
});

test('un sello en error seguido de un éxito: ok, subtipo y turnos son los del result adoptado', async () => {
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    agentStarted('task-1'),
    (s) => ({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9, total_cost_usd: 0.03, session_id: 'sess-1', user_message_uuid: uuidOf(s), user_message_uuids: [uuidOf(s)] }),
    () => taskDone('task-1'),
    init,
    finalResult(PLAN),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.resultText, PLAN);
  assert.equal(r.stats.subtype, 'success', 'no ok=true con el subtipo de un error');
  assert.equal(r.stats.turns, 3);
});

test('un turno que ya estaba en vuelo cuando informó el subagente no cierra la ventana', async () => {
  const at = {};
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    agentStarted('task-1'),
    (s) => ok(uuidOf(s), WAITING),
    init,
    () => taskDone('task-1'),
    finalResult('todavía no es el plan: el turno estaba en vuelo'),
    snap(at, 'waiting'),
    init,
    finalResult(PLAN),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(at.waiting, false, 'el canal espera el turno que sigue al informe');
  assert.equal(r.resultText, PLAN, 'el turno que abrió después del informe sí es el que cierra');
  assert.equal(r.stats.answerFrom, 'post');
});

// #31 §1: a subagent launched AFTER the seal is owed too. Red on e6cdf37: the turn that
// answers «waiting for B» closed the window, so the plan that followed was dropped.
const agentB = () => taskStarted('task-2', { task_type: 'local_agent', subagent_type: 'Explore', tool_use_id: 'a2' });

test('un subagente lanzado tras el sello también se debe: el turno que dice «espero a B» no cierra la ventana', async () => {
  claudeHooks.reportSettleMs = 30;
  const at = {};
  const sdk = fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    agentStarted('task-1'),
    (s) => ok(uuidOf(s), WAITING),
    () => taskDone('task-1'),
    init,
    () => toolUse(null, 'a2', 'Agent', { subagent_type: 'Explore', run_in_background: true }),
    agentB,
    finalResult('espero a B'),
    snap(at, 'afterWaitingForB'),
    () => taskDone('task-2'),
    init,
    finalResult(PLAN),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(at.afterWaitingForB, false, 'B sigue fuera: el canal no se suelta');
  assert.equal(r.resultText, PLAN, 'el turno que sigue al último informe es la respuesta');
  assert.equal(r.stats.answerFrom, 'post');
  assert.equal(r.stats.sealedOpen, 1, 'al sellar solo A estaba fuera');
  assert.equal(sdk.inputClosed, true);
});

test('un subagente lanzado tras el sello que informa dentro de su turno: ese turno no cierra, el siguiente sí', async () => {
  claudeHooks.reportSettleMs = 30;
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    agentStarted('task-1'),
    (s) => ok(uuidOf(s), WAITING),
    () => taskDone('task-1'),
    init,
    agentB,
    () => taskDone('task-2'),
    finalResult('B ya informó pero esto aún es una frase de espera'),
    init,
    finalResult(PLAN),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, PLAN);
  assert.equal(r.stats.answerFrom, 'post');
});

test('un subagente en primer plano lanzado y terminado dentro de un turno posterior no debe nada', async () => {
  claudeHooks.reportSettleMs = 30;
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    agentStarted('task-1'),
    (s) => ok(uuidOf(s), WAITING),
    () => taskDone('task-1'),
    init,
    () => taskStarted('task-2', { task_type: 'local_agent', subagent_type: 'Explore', tool_use_id: 'a2', is_backgrounded: false }),
    () => taskDone('task-2'),
    finalResult(PLAN),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, PLAN);
  assert.equal(r.stats.answerFrom, 'post', 'cierra en ese turno: no añade espera');
});

test('task_type local_agent alone marks a subagent: no subagent_type, no tool_use_id, no Agent call', async () => {
  claudeHooks.reportSettleMs = 30;
  fakeSdk([
    tick,
    init,
    taskStarted('task-1', { task_type: 'local_agent' }),
    (s) => ok(uuidOf(s), WAITING),
    () => taskDone('task-1'),
    init,
    finalResult(PLAN),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.stats.sealedOpen, 1);
  assert.equal(r.resultText, PLAN);
});

// #31 §6, measured with the real CLI (`tools/subagent-probe`, scenario `inturn`):
// a background subagent reports inside the turn that already holds the good
// answer, and the CLI opens a turn of its own whose result is an acknowledgement.
test('#31 §6: la respuesta sellada buena sobrevive como sealedText cuando el turno de reacción la pisa', async () => {
  const GOOD = 'FINAL: DONE\n## Plan de implementación\nlo bueno';
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'general-purpose', run_in_background: true }),
    agentStarted('task-1'),
    () => taskDone('task-1'),
    (s) => ok(uuidOf(s), GOOD),
    init,
    finalResult('Background agent completed: PONG received.'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, 'Background agent completed: PONG received.', 'la red adopta el turno que sigue al informe');
  assert.equal(r.stats.answerFrom, 'post');
  assert.equal(r.sealedText, GOOD, 'el texto sellado se devuelve para que el validador pueda caer a él');
});

// An assistant text frame with no stamp: a turn of a CLI that sends no `init`.
const plain = (t) => ({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

// #36 C: a turn adopted as `unclosed`, then an error result that closes the window.
// The error is never adopted, but «no turn closed the window» would be false.
test('#36 C: un result de error que cierra la ventana tras un turno sin cerrar queda como error-closed', async () => {
  claudeHooks.reportSettleMs = 30;
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    agentStarted('task-1'),
    (s) => ok(uuidOf(s), WAITING),
    init,
    () => taskDone('task-1'),
    finalResult('maybe a waiting sentence'),
    init,
    () => ({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 5, total_cost_usd: 0.04, session_id: 'sess-1', queued_turn_count: 0, errors: [] }),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, 'maybe a waiting sentence', 'the error is not adopted');
  assert.equal(r.ok, true);
  assert.equal(r.stats.answerFrom, 'error-closed');
});

test('#36 C: un error que cierra la ventana sin haber adoptado nada deja sealed', async () => {
  claudeHooks.reportSettleMs = 30;
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    agentStarted('task-1'),
    (s) => ok(uuidOf(s), WAITING),
    () => taskDone('task-1'),
    init,
    () => ({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 5, total_cost_usd: 0.04, session_id: 'sess-1', queued_turn_count: 0, errors: [] }),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, WAITING);
  assert.equal(r.stats.answerFrom, 'sealed');
});

// #36 G1: the CLI sends no `init` per turn. Turn T launches background B, B reports
// inside T, T ends with «waiting for B»: that turn must not close the window.
test('#36 G1: sin init por turno, el turno que dice «espero a B» tras informar B no cierra la ventana', async () => {
  claudeHooks.reportSettleMs = 30;
  const at = {};
  const sdk = fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore' }),
    agentStarted('task-1'),
    (s) => ok(uuidOf(s), WAITING),
    () => taskDone('task-1'),
    () => plain('miro el informe de A'),
    () => toolUse(null, 'a2', 'Agent', { subagent_type: 'Explore', run_in_background: true }),
    agentB,
    () => taskDone('task-2'),
    finalResult('espero a B'),
    snap(at, 'afterWaitingForB'),
    () => plain('ahora sí'),
    finalResult(PLAN),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(at.afterWaitingForB, false, 'the channel is held for the turn that follows B');
  assert.equal(r.resultText, PLAN);
  assert.equal(r.stats.answerFrom, 'post');
  assert.equal(sdk.inputClosed, true);
});

// #36 G2: the good answer arrives in an intermediate turn and a later reaction
// turn replaces it with an acknowledgement.
test('#36 G2: la respuesta buena de un turno intermedio sobrevive en replacedTexts cuando otro turno la pisa', async () => {
  claudeHooks.reportSettleMs = 30;
  const GOOD = 'FINAL: DONE\n## Plan de implementación\nlo bueno';
  fakeSdk([
    tick,
    init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'Explore', run_in_background: true }),
    agentStarted('task-1'),
    (s) => toolUse(uuidOf(s), 'a2', 'Agent', { subagent_type: 'Explore', run_in_background: true }),
    agentB,
    (s) => ok(uuidOf(s), WAITING),
    () => taskDone('task-1'),
    init,
    finalResult(GOOD),
    () => taskDone('task-2'),
    init,
    finalResult('Background agent completed: PONG received.'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, 'Background agent completed: PONG received.');
  assert.equal(r.sealedText, WAITING);
  assert.deepEqual(r.replacedTexts, [GOOD]);
});

test('#36 G2: sin textos reemplazados no hay replacedTexts', async () => {
  fakeSdk([
    tick, init,
    (s) => ok(uuidOf(s), 'HECHO'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal('replacedTexts' in r, false);
});

test('#36 G2: la respuesta adoptada tras el sello que nadie pisó no está en replacedTexts', async () => {
  fakeSdk([
    tick, init,
    (s) => toolUse(uuidOf(s), 'a1', 'Agent', { subagent_type: 'general-purpose', run_in_background: true }),
    agentStarted('task-1'),
    () => taskDone('task-1'),
    (s) => ok(uuidOf(s), 'sellada'),
    init,
    finalResult('ultima'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, 'ultima');
  assert.equal('replacedTexts' in r, false, 'the sealed text has its own field');
});

test('#31 §6: sin texto adoptado distinto no hay sealedText', async () => {
  fakeSdk([
    tick, init,
    (s) => ok(uuidOf(s), 'HECHO'),
    untilClosed,
  ]);
  const r = await run();
  assert.equal(r.resultText, 'HECHO');
  assert.equal('sealedText' in r, false);
});
