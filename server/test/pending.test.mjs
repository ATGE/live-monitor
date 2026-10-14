// The parking of questions and plans, driven against the real pipeline module
// with an isolated data directory: the callback the SDK would call, the
// routes' functions, and what the chat and the task look like in between.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tempDir } from './teardown.mjs';
import path from 'node:path';

const dataDir = tempDir('hfsmon-pending-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;
let config;
before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  ({ config } = await import('../src/config.js'));
  pipeline.planHooks.runChatPlan = async () => {};   // an approval must not launch sessions here
});

let n = 9000;
function freshTask() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = tempDir(`hfsmon-wt-${n}-`);
  task.branch = `feat/${n}-x`;
  return task;
}

const ctx = (id) => ({ toolUseID: id, requestId: `r-${id}`, signal: new AbortController().signal });
// Waits until a callback has parked its question. ExitPlanMode reads the plan
// file before parking, so a fixed delay is a race under load.
async function until(ok, what, ms = 3000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}
const questions = [{ question: '¿Qué enfoque?', header: 'Enfoque', multiSelect: false, options: [{ label: 'A (Recomendado)', description: 'a' }, { label: 'B', description: 'b' }] }];

test('una pregunta del modelo se aparca en el chat y la respuesta vuelve como updatedInput', async () => {
  const task = freshTask();
  const chat = task.chats[0];
  const live = pipeline.liveEntryOf(task, chat);
  const parked = pipeline.chatCanUseTool(task, chat, live, 'AskUserQuestion', { questions }, ctx('q1'));
  await until(() => chat.pending?.id === 'q1', 'q1');
  assert.equal(chat.pending?.id, 'q1');
  assert.equal(chat.pending.kind, 'question');
  const message = chat.messages.find((m) => m.id === chat.pending.messageId);
  assert.equal(message.role, 'question');
  assert.equal(message.status, 'pending');
  assert.equal(chat.activity, 'waiting for your answer…');

  // A second question while one waits is refused, and so is a subagent's.
  const second = await pipeline.chatCanUseTool(task, chat, live, 'AskUserQuestion', { questions }, ctx('q2'));
  assert.equal(second.behavior, 'deny');
  const fromAgent = await pipeline.chatCanUseTool(task, chat, live, 'AskUserQuestion', { questions }, { ...ctx('q3'), agentID: 'a1' });
  assert.match(fromAgent.message, /hilo principal/);

  // The wrong id is 409-shaped; the right one settles the callback.
  await assert.rejects(pipeline.answerChatPending(task.issue, chat.id, { id: 'nope', answers: {} }), (e) => e.code === 'PENDING_GONE');
  await assert.rejects(pipeline.answerChatPending(task.issue, chat.id, { id: 'q1', answers: { '¿Qué enfoque?': '' } }), /sin responder/);
  await pipeline.answerChatPending(task.issue, chat.id, { id: 'q1', answers: { '¿Qué enfoque?': 'mi idea' } });
  const result = await parked;
  assert.deepEqual(result, { behavior: 'allow', updatedInput: { questions, answers: { '¿Qué enfoque?': 'mi idea' } } });
  assert.equal(chat.pending, null);
  assert.equal(message.status, 'answered');
  assert.deepEqual(message.answers, { '¿Qué enfoque?': 'mi idea' });
  await assert.rejects(pipeline.answerChatPending(task.issue, chat.id, { id: 'q1', answers: {} }), (e) => e.code === 'PENDING_GONE', 'la primera respuesta gana');
});

test('«Que decida Claude» devuelve un deny con la instrucción, y el mensaje queda como saltado', async () => {
  const task = freshTask();
  const chat = task.chats[0];
  const live = pipeline.liveEntryOf(task, chat);
  const parked = pipeline.chatCanUseTool(task, chat, live, 'AskUserQuestion', { questions }, ctx('q1'));
  await until(() => chat.pending?.id === 'q1', 'q1');
  await pipeline.answerChatPending(task.issue, chat.id, { id: 'q1', decision: 'skip' });
  const result = await parked;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /mejor criterio/);
  assert.equal(chat.messages.find((m) => m.role === 'question').status, 'skipped');
});

test('ExitPlanMode lee el plan del archivo, valida el WORK_PLAN, y aprobar lo convierte en el plan del chat', async () => {
  const task = freshTask();
  const chat = task.chats[0];
  const live = pipeline.liveEntryOf(task, chat);
  // A plan without its WORK_PLAN is sent back to the model, not to the person.
  const noGraph = await pipeline.chatCanUseTool(task, chat, live, 'ExitPlanMode', { plan: '# Plan\nsolo texto' }, ctx('x0'));
  assert.equal(noGraph.behavior, 'deny');
  assert.match(noGraph.message, /WORK_PLAN/);
  assert.equal(chat.pending, null);

  const graph = 'WORK_PLAN: {"tasks":[{"id":"t1","what":"uno","files":["a.rs"],"dependsOn":[],"check":"true"},{"id":"t2","what":"dos","files":["b.rs"],"dependsOn":["t1"]}]}\n';
  // …and one whose WORK_PLAN is fine but that opens with a file list instead
  // of prose goes back to the model too: the person approving reads the top.
  const noBrief = await pipeline.chatCanUseTool(task, chat, live, 'ExitPlanMode', { plan: `# Plan\n\nDos tareas.\n\n${graph}` }, ctx('x0b'));
  assert.equal(noBrief.behavior, 'deny');
  assert.match(noBrief.message, /De un vistazo/);
  assert.equal(chat.pending, null);

  const dir = path.join(task.worktreePath, 'tmp', 'hfsmon-plans', chat.id);
  mkdirSync(dir, { recursive: true });
  const planText = `## De un vistazo

Hoy el importador se traga el fichero entero en memoria antes de escribir nada,
y con un bundle grande el servidor se queda sin RAM y muere a media importación.
Después del cambio lo lee por trozos y va escribiendo, así que la memoria deja
de crecer con el tamaño del fichero. Se toca la capa de persistencia, en el
camino de escritura por lotes.

${graph}`;
  writeFileSync(path.join(dir, 'mi-plan.md'), planText);
  live.planFile = path.join(dir, 'mi-plan.md');   // what the turn's Write named

  const parked = pipeline.chatCanUseTool(task, chat, live, 'ExitPlanMode', {}, ctx('x1'));
  await until(() => chat.pending?.id === 'x1', 'x1');
  assert.equal(chat.pending?.kind, 'plan');
  const message = chat.messages.find((m) => m.role === 'plan');
  assert.equal(message.plan, planText);
  assert.deepEqual(message.waves, [['t1'], ['t2']]);
  assert.equal(message.tasks[0].check, 'true');

  // Revise: a deny with the feedback, still in plan mode, nothing executed.
  await pipeline.answerChatPending(task.issue, chat.id, { id: 'x1', decision: 'revise', feedback: 'quita t2' });
  const revised = await parked;
  assert.equal(revised.behavior, 'deny');
  assert.match(revised.message, /quita t2[\s\S]*ExitPlanMode/);
  assert.equal(message.status, 'revise');
  assert.equal(chat.plan, null);

  // Approve two of two: the chat's turn is cut, and the record is the chat's plan.
  const again = pipeline.chatCanUseTool(task, chat, live, 'ExitPlanMode', {}, ctx('x2'));
  await until(() => chat.pending?.id === 'x2', 'x2');
  await pipeline.answerChatPending(task.issue, chat.id, { id: 'x2', decision: 'approve', selected: ['t2'] });
  const approved = await again;
  assert.equal(approved.behavior, 'deny');
  assert.equal(approved.interrupt, true);
  assert.equal(chat.plan.status, 'approved');
  assert.deepEqual(chat.plan.selected, ['t1', 't2'], 't2 arrastra a t1');
  assert.deepEqual(chat.plan.tasks.map((t) => t.status), ['pending', 'pending']);
});

test('el modo plan se guarda por chat, y /plan on|off contesta en el chat', async () => {
  const task = freshTask();
  const chat = task.chats[0];
  assert.equal(pipeline.setChatPlanMode(task.issue, chat.id, true), true);
  assert.equal(chat.planMode, true);
  pipeline.sendChat(task.issue, chat.id, '/plan off');
  assert.equal(chat.planMode, false);
  assert.match(chat.messages.at(-1).text, /Plan mode off|Modo plan desactivado/);
  pipeline.sendChat(task.issue, chat.id, '/plan');
  assert.match(chat.messages.at(-1).text, /Plan mode: off.*\/plan on/);
});

test('una pregunta de una sesión del pipeline se aparca en la tarea y vence sola: Claude decide', async () => {
  const task = freshTask();
  const previous = config.ask?.timeoutMinutes;
  config.ask = { ...(config.ask ?? {}), timeoutMinutes: 0.001 };   // 60 ms
  try {
    const cb = pipeline.taskCanUseTool(task, 'triage');
    assert.deepEqual(await cb('Bash', {}, ctx('b')), { behavior: 'allow' });
    const parked = cb('AskUserQuestion', { questions }, ctx('tq1'));
    await until(() => task.pending?.id === 'tq1', 'tq1');
    assert.equal(task.pending?.id, 'tq1');
    assert.equal(task.pending.phase, 'triage');
    assert.deepEqual(task.pending.questions[0].options.map((o) => o.label), ['A (Recomendado)', 'B']);
    const result = await parked;
    assert.equal(result.behavior, 'deny');
    assert.match(result.message, /no contestó/);
    assert.equal(task.pending, null);
    assert.ok(task.log.some((l) => /no answer/.test(l.line)));
  } finally {
    config.ask.timeoutMinutes = previous;
  }
});

test('una pregunta de la tarea respondida a tiempo vuelve a la sesión', async () => {
  const task = freshTask();
  const cb = pipeline.taskCanUseTool(task, 'fix');
  const parked = cb('AskUserQuestion', { questions }, ctx('tq2'));
  await until(() => task.pending?.id === 'tq2', 'tq2');
  assert.throws(() => pipeline.answerTaskPending(task.issue, { id: 'otra' }), (e) => e.code === 'PENDING_GONE');
  pipeline.answerTaskPending(task.issue, { id: 'tq2', answers: { '¿Qué enfoque?': 'B' } });
  const result = await parked;
  assert.deepEqual(result.updatedInput.answers, { '¿Qué enfoque?': 'B' });
  assert.equal(task.pending, null);
});

test('aprobar el plan: por tarea manda sobre el tablero, y la decisión sin pipeline aparcado se guarda', async () => {
  const task = freshTask();
  const { settings } = await import('../src/settings.js');
  // Una tarea nace con el valor copiado (on/off); `auto` es lo de las tareas anteriores.
  task.approvePlan = 'auto';
  assert.equal(pipeline.approvePlanWanted(task), settings.approvePlan, 'auto sigue al tablero');
  pipeline.setApprovePlan(task.issue, 'on');
  assert.equal(pipeline.approvePlanWanted(task), true);
  pipeline.setApprovePlan(task.issue, 'off');
  assert.equal(pipeline.approvePlanWanted(task), false);
  assert.throws(() => pipeline.setApprovePlan(task.issue, 'maybe'), /auto, on or off/);
  assert.throws(() => pipeline.decideTaskPlan(task.issue, { decision: 'approve' }), (e) => e.code === 'PENDING_GONE');
});

test('parar una tarea de fondo la marca «stopping» y le pide a la sesión un TaskStop', async () => {
  const task = freshTask();
  const chat = task.chats[0];
  // Con el plan en marcha, `sendChat` aparca el mensaje como nota en vez de
  // abrir un turno: el aviso queda en el chat sin arrancar ninguna sesión.
  chat.plan = { id: 'p1', status: 'running', selected: [], tasks: [] };
  const now = new Date().toISOString();
  const tree = store.pushChat(task, chat, {
    role: 'activity', ts: now, dropped: 0,
    items: [
      { id: 'b1', kind: 'bash', name: 'Bash', background: true, status: 'running', command: 'node serve.js dist 18003', taskId: 'bg_1', startedAt: now },
      { id: 'b2', kind: 'bash', name: 'Bash', background: true, status: 'running', command: 'cargo test -p helios-ui', startedAt: now },
    ],
  });

  assert.deepEqual(await pipeline.stopBackground(task.issue, chat.id, 'b1'), { taskId: 'bg_1', status: 'stopping' });
  assert.equal(tree.items[0].status, 'stopping');
  const asked = chat.messages.filter((m) => m.role === 'user').at(-1);
  assert.match(asked.text, /TaskStop/);
  assert.match(asked.text, /bg_1/);
  assert.match(asked.text, /node serve\.js dist 18003/, 'el comando describe qué se para');

  // Sin identificador de tarea no hay nada que la sesión pueda parar, y lo
  // que ya no está en el chat tampoco: las dos cosas son 400, no un 500.
  await assert.rejects(pipeline.stopBackground(task.issue, chat.id, 'b2'), (e) => e.status === 400);
  assert.equal(tree.items[1].status, 'running');
  await assert.rejects(pipeline.stopBackground(task.issue, chat.id, 'no-existe'), (e) => e.status === 400);
});
