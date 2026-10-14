import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';
const pipeline = await import('../src/pipeline.js');
const { store } = await import('../src/store.js');

const fakeTask = () => ({ project: 'hfs', issue: 9001, machine: 'box', state: 'running', chats: [], log: [] });

test('onChatEvent: un evento auth deja una tarjeta con solo la máquina, una por turno', () => {
  const pushed = [];
  const original = store.pushChat;
  store.pushChat = (task, chat, message) => { pushed.push(message); return message; };
  try {
    const task = fakeTask();
    const chat = { id: 'c1', messages: [] };
    const live = { activity: {}, session: { busy: false } };
    pipeline.onChatEventOf(task, chat, live, { kind: 'turn_start' });
    pipeline.onChatEventOf(task, chat, live, { kind: 'auth', machine: 'box' });
    pipeline.onChatEventOf(task, chat, live, { kind: 'auth', machine: 'box' });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].role, 'auth');
    assert.equal(pushed[0].machine, 'box');
    assert.deepEqual(Object.keys(pushed[0]).sort(), ['machine', 'role', 'ts']);
    pipeline.onChatEventOf(task, chat, live, { kind: 'turn_start' });
    pipeline.onChatEventOf(task, chat, live, { kind: 'auth', machine: 'box' });
    assert.equal(pushed.length, 2, 'un turno nuevo vuelve a mostrar la tarjeta');
  } finally {
    store.pushChat = original;
  }
});

test('claudeLogger + catch: una fase que muere por auth deja errorCode auth_failed con la máquina', () => {
  const task = fakeTask();
  pipeline.claudeLoggerOf(task, 'fix')({ kind: 'auth', machine: 'box' });
  pipeline.markAuthFailureOf(task);
  assert.equal(task.errorCode, 'auth_failed');
  assert.deepEqual(task.errorInfo, { machine: 'box' });
});

test('sin evento auth, un fallo corriente no recibe errorCode', () => {
  const task = fakeTask();
  pipeline.claudeLoggerOf(task, 'fix')({ kind: 'error', error: 'OAuth session expired' });
  pipeline.markAuthFailureOf(task);
  assert.equal(task.errorCode, undefined);
  assert.equal(task.errorInfo, undefined);
});

test('el catch real de startPipeline: una fase que muere por auth deja errorCode y la máquina', async () => {
  const task = store.addTask({ number: 9101, title: 't', labels: [], url: 'https://x/9101', closed: false }, 'hfs');
  task.machine = 'box';
  const previous = pipeline.pipelineHooks.run;
  pipeline.pipelineHooks.run = async (t) => {
    pipeline.claudeLoggerOf(t, 'fix')({ kind: 'auth', machine: 'box' });
    throw new Error('Failed to authenticate');
  };
  try {
    pipeline.startPipelineOf(task, 'assigned');
    for (let i = 0; i < 6; i += 1) await new Promise((r) => { setImmediate(r); });
  } finally {
    pipeline.pipelineHooks.run = previous;
  }
  assert.equal(task.state, 'error');
  assert.equal(task.errorCode, 'auth_failed');
  assert.deepEqual(task.errorInfo, { machine: 'box' });
});

test('el mismo catch sin evento auth no pone errorCode', async () => {
  const task = store.addTask({ number: 9102, title: 't', labels: [], url: 'https://x/9102', closed: false }, 'hfs');
  const previous = pipeline.pipelineHooks.run;
  pipeline.pipelineHooks.run = async () => { throw new Error('boom'); };
  try {
    pipeline.startPipelineOf(task, 'assigned');
    for (let i = 0; i < 6; i += 1) await new Promise((r) => { setImmediate(r); });
  } finally {
    pipeline.pipelineHooks.run = previous;
  }
  assert.equal(task.state, 'error');
  assert.ok(!task.errorCode);
});

test('el catch real de startChangeRequest: un change request que muere por auth deja errorCode y la máquina', async () => {
  const task = store.addTask({ number: 9103, title: 't', labels: [], url: 'https://x/9103', closed: false }, 'hfs');
  task.machine = 'box';
  pipeline.registerChangeRequest(task, { reviewId: 'r9103', author: 'rev', comments: [] }, 'abc123');
  const previous = pipeline.pipelineHooks.runChangeRequest;
  pipeline.pipelineHooks.runChangeRequest = async (t) => {
    pipeline.claudeLoggerOf(t, 'cr')({ kind: 'auth', machine: 'box' });
    throw new Error('Failed to authenticate');
  };
  try {
    assert.equal(pipeline.startChangeRequest(task.issue, { force: true }), true);
    for (let i = 0; i < 6; i += 1) await new Promise((r) => { setImmediate(r); });
  } finally {
    pipeline.pipelineHooks.runChangeRequest = previous;
  }
  assert.equal(task.state, 'error');
  assert.equal(task.errorCode, 'auth_failed');
  assert.deepEqual(task.errorInfo, { machine: 'box' });
});
