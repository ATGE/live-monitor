// The repair turn and the plan-change proposal, wired into both plan hosts of
// pipeline.js. `fixHooks.runClaude` is replaced by a fake session that calls the
// real `mcp__plan__propose_change` handler, so what runs is the host's own
// onPropose, parking, decode and apply — everything but the model.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './teardown.mjs';

const dataDir = tempDir('hfsmon-repair-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;
let newPlanRecord;
before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  ({ newPlanRecord } = await import('../src/planexec.js'));
});

let n = 9500;
function freshTask() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = tempDir(`hfsmon-wt-${n}-`);
  task.branch = `feat/${n}-x`;
  return task;
}

function freshRecord() {
  const record = newPlanRecord({
    id: `p${n}`,
    tasks: [{ id: 't1', what: 'haz algo', files: ['a.txt'], dependsOn: [], check: 'false' }],
    waves: [['t1']],
  });
  record.status = 'running';
  const t = record.tasks[0];
  t.sessionId = 'SESSION-1';
  t.attempts = 2;
  t.lastFailure = { kind: 'check', output: 'boom', signature: 'boom', fingerprint: 'f' };
  return { record, t };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i += 1) await tick(); assert.ok(fn(), 'timeout waiting'); };

/** The handler of the tool the host handed to the session, as the SDK would call it. */
const toolOf = (mcpServers) => mcpServers.plan.instance._registeredTools.propose_change.handler;

const PROPOSAL = { reason: 'la comprobación está mal escrita', check: 'true' };

/** Installs a fake session that proposes once, then lets `decide` answer. Returns the calls seen. */
function fakeSession(fn) {
  const calls = [];
  pipeline.fixHooks.runClaude = async (options) => {
    calls.push(options);
    return fn(options, calls.length);
  };
  return calls;
}

test('repair: la propuesta aprobada se aplica, el turno devuelve changed y resume sin bifurcar', async () => {
  const task = freshTask();
  const { record, t } = freshRecord();
  const host = pipeline.planHostsForTest.fixPlanHost(task, record);
  let toolResult;
  const calls = fakeSession(async (options) => {
    const proposing = toolOf(options.mcpServers)(PROPOSAL, {});
    await until(() => task.pending?.id?.startsWith(`planchange:${record.id}:t1:`));
    assert.equal(task.pending.source, 'board');
    assert.match(task.pending.preview, /true/);
    const q = task.pending.questions[0].question;
    pipeline.answerTaskPending(task.issue, { id: task.pending.id, answers: { [q]: 'Aplicar el cambio' } });
    toolResult = await proposing;
    return { ok: true, sessionId: 'SESSION-2', resultText: 'listo' };
  });

  const r = await host.repair(t);
  assert.deepEqual(r, { changed: true, quota: false });
  assert.equal(calls[0].resume, 'SESSION-1');
  assert.ok(!calls[0].forkSession, 'la reparación nunca bifurca');
  assert.match(calls[0].prompt, /^false$/m);
  assert.match(calls[0].prompt, /mcp__plan__propose_change/);
  assert.ok(!toolResult.isError);
  assert.match(toolResult.content[0].text, /^Aplicado/);
  assert.equal(t.check, 'true');
  assert.equal(record.changes.length, 1);
  assert.equal(task.pending, null);
  assert.equal(t.sessionId, 'SESSION-2');
  // The flag is consumed: the next repair starts clean.
  fakeSession(async () => ({ ok: true, sessionId: 'SESSION-3' }));
  assert.deepEqual(await host.repair(t), { changed: false, quota: false });
});

test('repair: si la persona no aplica, nada cambia y la sesión lo lee con su motivo', async () => {
  const task = freshTask();
  const { record, t } = freshRecord();
  const host = pipeline.planHostsForTest.fixPlanHost(task, record);
  let toolResult;
  fakeSession(async (options) => {
    const proposing = toolOf(options.mcpServers)(PROPOSAL, {});
    await until(() => task.pending);
    const q = task.pending.questions[0].question;
    pipeline.answerTaskPending(task.issue, { id: task.pending.id, answers: { [q]: 'mejor no, el check es correcto' } });
    toolResult = await proposing;
    return { ok: true, sessionId: 'S' };
  });
  assert.deepEqual(await host.repair(t), { changed: false, quota: false });
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /La persona no aplicó el cambio: mejor no, el check es correcto/);
  assert.equal(t.check, 'false');
});

test('repair: «que decida Claude» y la caducidad resuelven «nadie respondió», sin detener la tarea', async () => {
  const task = freshTask();
  const { record, t } = freshRecord();
  const host = pipeline.planHostsForTest.fixPlanHost(task, record);
  const seen = [];
  fakeSession(async (options) => {
    const first = toolOf(options.mcpServers)(PROPOSAL, {});
    await until(() => task.pending);
    pipeline.answerTaskPending(task.issue, { id: task.pending.id, decision: 'skip' });
    seen.push(await first);
    // A session that ends with its proposal still parked: the host expires it.
    toolOf(options.mcpServers)(PROPOSAL, {}).catch(() => {});
    await until(() => task.pending);
    return { ok: true, sessionId: 'S' };
  });
  assert.deepEqual(await host.repair(t), { changed: false, quota: false });
  assert.match(seen[0].content[0].text, /Nadie respondió/);
  assert.equal(task.pending, null, 'la propuesta de una sesión cortada no queda aparcada');
  assert.equal(t.check, 'false');
});

test('una propuesta inválida se devuelve con el problema y no pregunta a nadie', async () => {
  const task = freshTask();
  const { record, t } = freshRecord();
  const host = pipeline.planHostsForTest.fixPlanHost(task, record);
  let toolResult;
  fakeSession(async (options) => {
    toolResult = await toolOf(options.mcpServers)({ reason: 'x', check: 'false' }, {});   // same check: no change
    return { ok: true, sessionId: 'S' };
  });
  await host.repair(t);
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /Corrígelo y vuelve a proponerlo/);
  assert.ok(!task.pending);
});

test('una propuesta no pisa la pregunta que ya está aparcada', async () => {
  const task = freshTask();
  const { record, t } = freshRecord();
  const host = pipeline.planHostsForTest.fixPlanHost(task, record);
  task.pending = { id: 'otra', kind: 'question', source: 'claude', phase: 'fix:t2', questions: [], askedAt: new Date().toISOString() };
  let toolResult;
  fakeSession(async (options) => {
    toolResult = await toolOf(options.mcpServers)(PROPOSAL, {});
    return { ok: true, sessionId: 'S' };
  });
  await host.repair(t);
  assert.match(toolResult.content[0].text, /Hay otra pregunta pendiente/);
  assert.equal(task.pending.id, 'otra');
  task.pending = null;
});

test('el ask del tablero espera un hueco libre y su id no se repite', async () => {
  const task = freshTask();
  const { record, t } = freshRecord();
  const host = pipeline.planHostsForTest.fixPlanHost(task, record);
  task.pending = { id: 'otra', kind: 'question', source: 'claude', phase: 'fix:t2', questions: [], askedAt: new Date().toISOString() };
  const asking = host.ask(t);
  await tick(50);
  assert.equal(task.pending.id, 'otra', 'no se sobrescribió');
  task.pending = null;
  await until(() => task.pending?.id?.startsWith(`board:${record.id}:t1:2:`));
  const first = task.pending.id;
  assert.match(first, /^board:.*:2:[0-9a-z]+$/);
  const q = task.pending.questions[0].question;
  pipeline.answerTaskPending(task.issue, { id: first, answers: { [q]: task.pending.questions[0].options[0].label } });
  const decision = await asking;
  assert.ok(decision.action);
});

test('un plan detenido no deja al ask esperando el hueco', async () => {
  const task = freshTask();
  const { record, t } = freshRecord();
  const host = pipeline.planHostsForTest.fixPlanHost(task, record);
  task.pending = { id: 'otra', kind: 'question', source: 'claude', phase: 'fix:t2', questions: [], askedAt: new Date().toISOString() };
  record.status = 'stopped';
  assert.deepEqual(await host.ask(t), { action: 'stop' });
  task.pending = null;
});

test('repair: la cuota se avisa y no se cuenta como cambio', async () => {
  const task = freshTask();
  const { record, t } = freshRecord();
  const host = pipeline.planHostsForTest.fixPlanHost(task, record);
  fakeSession(async () => ({ ok: false, quota: true, sessionId: 'S' }));
  assert.deepEqual(await host.repair(t), { changed: false, quota: true });
});

test('interrupt alcanza la sesión de reparación', async () => {
  const task = freshTask();
  const { record, t } = freshRecord();
  const host = pipeline.planHostsForTest.fixPlanHost(task, record);
  let interrupted = false;
  let release;
  fakeSession(async (options) => {
    options.onQuery({ interrupt: async () => { interrupted = true; release(); } });
    await new Promise((r) => { release = r; });
    return { ok: false, sessionId: 'S' };
  });
  const repairing = host.repair(t);
  await tick();
  host.interrupt(t);
  await repairing;
  assert.equal(interrupted, true);
});

test('chat: la propuesta se aparca como pregunta del tablero y se aplica al aceptarla', async () => {
  const task = freshTask();
  const chat = task.chats[0];
  const live = pipeline.liveEntryOf(task, chat);
  const { record, t } = freshRecord();
  chat.plan = record;
  const host = pipeline.planHostsForTest.chatPlanHost(task, chat, live);
  let toolResult;
  const calls = fakeSession(async (options) => {
    const proposing = toolOf(options.mcpServers)(PROPOSAL, {});
    await until(() => chat.pending?.id?.startsWith(`planchange:${record.id}:t1:`));
    const message = chat.messages.find((m) => m.id === chat.pending.messageId);
    assert.equal(message.source, 'board');
    await pipeline.answerChatPending(task.issue, chat.id, {
      id: chat.pending.id, answers: { [message.questions[0].question]: 'Aplicar el cambio' },
    });
    toolResult = await proposing;
    return { ok: true, sessionId: 'SESSION-2' };
  });
  assert.deepEqual(await host.repair(t), { changed: true, quota: false });
  assert.equal(calls[0].resume, 'SESSION-1');
  assert.match(toolResult.content[0].text, /^Aplicado/);
  assert.equal(t.check, 'true');
  assert.equal(chat.pending, null);
});

test('chat: una propuesta cortada por la sesión no deja su pregunta aparcada', async () => {
  const task = freshTask();
  const chat = task.chats[0];
  const live = pipeline.liveEntryOf(task, chat);
  const { record, t } = freshRecord();
  chat.plan = record;
  const host = pipeline.planHostsForTest.chatPlanHost(task, chat, live);
  fakeSession(async (options) => {
    toolOf(options.mcpServers)(PROPOSAL, {}).catch(() => {});
    await until(() => chat.pending);
    return { ok: true, sessionId: 'S' };
  });
  await host.repair(t);
  assert.equal(chat.pending, null);
  assert.equal(chat.messages.find((m) => m.role === 'question')?.status, 'expired');
});

test('chat: «que decida Claude» sobre la propuesta llega a la sesión como «Nadie respondió», no como un no', async () => {
  const task = freshTask();
  const chat = task.chats[0];
  const live = pipeline.liveEntryOf(task, chat);
  const { record, t } = freshRecord();
  chat.plan = record;
  const host = pipeline.planHostsForTest.chatPlanHost(task, chat, live);
  let toolResult;
  fakeSession(async (options) => {
    const proposing = toolOf(options.mcpServers)(PROPOSAL, {});
    await until(() => chat.pending);
    const message = chat.messages.find((m) => m.id === chat.pending.messageId);
    assert.ok(message.questions[0].header.length <= 12, 'la cabecera pasó por normalizeQuestions');
    assert.ok(!('preview' in message.questions[0]) && message.preview, 'la vista previa va aparte');
    await pipeline.answerChatPending(task.issue, chat.id, { id: chat.pending.id, decision: 'skip' });
    toolResult = await proposing;
    return { ok: true, sessionId: 'S' };
  });
  assert.deepEqual(await host.repair(t), { changed: false, quota: false });
  assert.match(toolResult.content[0].text, /Nadie respondió/);
  assert.equal(t.check, 'false');
});
