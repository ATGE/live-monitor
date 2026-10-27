// The Artifact gate as the board wires it: a PreToolUse hook inside
// `ghGateHooks` (a `canUseTool` rule never runs under bypass), the
// confirmation parked on the chat or the task, and plan mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './teardown.mjs';

process.env.HFSMON_DATA_DIR = tempDir('hfsmon-artifact-');
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;
let config;
// The real tool lives inside a Claude session with an open process pipe.
// The unit-test fake has no such handle; keep the event loop alive while
// asserting that its unref() approval timeout denies a silent request.
let fakeSessionKeepalive;
before(async () => {
  fakeSessionKeepalive = setInterval(() => {}, 200);
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  ({ config } = await import('../src/config.js'));
});
after(() => clearInterval(fakeSessionKeepalive));

let n = 9500;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = tempDir(`hfsmon-art-wt-${n}-`);
  task.branch = `feat/${n}-x`;
  return Object.assign(task, fields);
}

const ENTRY = 1;   // PreToolUse[0] is Bash; the Artifact entry sits behind it.
const decisionOf = (out) => out?.hookSpecificOutput?.permissionDecision ?? 'allow';
const until = async (ok, what, ms = 3000) => {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
};
const call = (hooks, tool_input, extra = {}) => hooks.PreToolUse[ENTRY].hooks[0](
  { hook_event_name: 'PreToolUse', tool_name: 'Artifact', tool_input, tool_use_id: `u${Math.random().toString(36).slice(2)}`, ...extra },
  undefined,
  { signal: new AbortController().signal },
);

test('the hook is an entry of ghGateHooks, behind Bash, with an explicit timeout', () => {
  const hooks = pipeline.ghGateHooks(freshTask(), 'fix');
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(hooks.PreToolUse[ENTRY].matcher, 'Artifact|ArtifactComments|ArtifactData');
  assert.ok(hooks.PreToolUse[ENTRY].timeout > (config.ask?.timeoutMinutes ?? 20) * 60, 'longer than the board\'s own timer');
});

test('an unattended phase without the mark denies everything, reads included', async () => {
  const task = freshTask({ title: 'Please publish a canvas', body: 'publish a canvas with Artifact' });
  for (const phase of ['fix', 'plan', 'gaps', 'triage', 'qa']) {
    const hooks = pipeline.ghGateHooks(task, phase);
    assert.equal(decisionOf(await call(hooks, { action: 'list' })), 'deny', `${phase} list`);
    assert.equal(decisionOf(await call(hooks, { action: 'publish', file_path: 'x.html' })), 'deny', `${phase} publish`);
  }
});

test('with the mark set by a person, a work phase may read; it never reads in triage', async () => {
  const task = freshTask();
  pipeline.setDesign(`hfs#${task.issue}`, true);
  assert.equal(task.design, true);
  assert.equal(decisionOf(await call(pipeline.ghGateHooks(task, 'fix'), { action: 'list', scope: 'mine' })), 'allow');
  assert.equal(decisionOf(await call(pipeline.ghGateHooks(task, 'fix:t1'), { action: 'read' })), 'allow');
  assert.equal(decisionOf(await call(pipeline.ghGateHooks(task, 'triage'), { action: 'list' })), 'deny');
});

test('a marked phase holds a publish on the task and lets it through only on «Sí, publicar»', async () => {
  const task = freshTask({ design: true });
  const hooks = pipeline.ghGateHooks(task, 'fix');
  const held = call(hooks, { action: 'publish', file_path: 'x.html', title: 'T' });
  await until(() => task.pending?.kind === 'question', 'the pending');
  assert.equal(task.pending.source, 'board');
  const [q] = task.pending.questions;
  pipeline.answerTaskPending(`hfs#${task.issue}`, { id: task.pending.id, answers: { [q.question]: 'Sí, publicar' } });
  assert.equal(decisionOf(await held), 'allow');

  const refused = call(hooks, { action: 'delete_asset', asset_id: 'a' });
  await until(() => task.pending, 'the second pending');
  const [q2] = task.pending.questions;
  pipeline.answerTaskPending(`hfs#${task.issue}`, { id: task.pending.id, answers: { [q2.question]: 'Otro: sí, claro' } });
  assert.equal(decisionOf(await refused), 'deny', '«Otro» is a no');

  const skipped = call(hooks, { action: 'pin' });
  await until(() => task.pending, 'the third pending');
  pipeline.answerTaskPending(`hfs#${task.issue}`, { id: task.pending.id, decision: 'skip' });
  assert.equal(decisionOf(await skipped), 'deny');
});

test('a marked phase denies a held publish when nobody answers in time', async () => {
  const task = freshTask({ design: true });
  const saved = config.ask?.timeoutMinutes;
  config.ask = { ...(config.ask ?? {}), timeoutMinutes: 0.001 };
  try {
    const out = await call(pipeline.ghGateHooks(task, 'gaps'), { action: 'upload_asset', file_path: 'a.png' });
    assert.equal(decisionOf(out), 'deny');
    assert.equal(task.pending, null);
  } finally {
    config.ask = { ...config.ask, timeoutMinutes: saved };
  }
});

test('a subagent may read lienzos but never publish', async () => {
  const task = freshTask({ design: true });
  const hooks = pipeline.ghGateHooks(task, 'fix');
  assert.equal(decisionOf(await call(hooks, { action: 'list' }, { agent_id: 'sub1' })), 'allow');
  assert.equal(decisionOf(await call(hooks, { action: 'publish' }, { agent_id: 'sub1' })), 'deny');
  assert.ok(!task.pending, 'nothing was parked for a subagent');
});

test('an unknown or missing action asks, and a gate that breaks denies', async () => {
  const task = freshTask({ design: true });
  const hooks = pipeline.ghGateHooks(task, 'fix');
  const held = call(hooks, { action: 'frobnicate' });
  await until(() => task.pending, 'pending for an unknown action');
  pipeline.answerTaskPending(`hfs#${task.issue}`, { id: task.pending.id, decision: 'skip' });
  assert.equal(decisionOf(await held), 'deny');

  const broken = new Proxy({}, { get(_, key) { throw new Error(`boom: ${String(key)}`); } });
  assert.equal(decisionOf(await call(pipeline.ghGateHooks(broken, 'fix'), { action: 'list' })), 'deny', 'fails closed');
});

test('in a chat the confirmation is parked on the chat, survives nothing past the turn, and a yes is remembered', async () => {
  const task = freshTask();
  const chat = { id: 'c-art', planMode: false, pending: null, messages: [], title: 't' };
  task.chats = [chat];
  const live = { pending: new Map(), opencodeCalls: [], artifactOk: new Set() };
  const hooks = pipeline.ghGateHooks(task, 'chat', { chat, live });
  assert.equal(decisionOf(await call(hooks, { action: 'list' })), 'allow', 'a chat is a design session without the mark');

  const held = call(hooks, { action: 'publish', file_path: 'x.html' }, { tool_use_id: 'tu-1' });
  await until(() => chat.pending, 'the chat pending');
  assert.equal(chat.pending.source, 'board');
  assert.ok(chat.pending.id.startsWith('artifact:'));
  // A second call while one waits is told to wait, not stacked.
  assert.equal(decisionOf(await call(hooks, { action: 'delete_asset' })), 'deny');
  const entry = live.pending.get(chat.pending.id);
  entry.resolve({ behavior: 'allow', answers: { q: 'Sí, publicar' } });
  assert.equal(decisionOf(await held), 'allow');
  assert.ok(live.artifactOk.has('tu-1'), 'remembered for plan mode');
});

test('in a chat a «No», and the end of the turn, deny', async () => {
  const task = freshTask();
  const chat = { id: 'c-art2', planMode: false, pending: null, messages: [], title: 't' };
  task.chats = [chat];
  const live = { pending: new Map(), opencodeCalls: [], artifactOk: new Set() };
  const hooks = pipeline.ghGateHooks(task, 'chat', { chat, live });

  const no = call(hooks, { action: 'pin' }, { tool_use_id: 'tu-2' });
  await until(() => chat.pending, 'pending');
  live.pending.get(chat.pending.id).resolve({ behavior: 'allow', answers: { q: 'No' } });
  assert.equal(decisionOf(await no), 'deny');
  assert.equal(live.artifactOk.has('tu-2'), false);

  // A chat without its context cannot ask, so it denies.
  assert.equal(decisionOf(await call(pipeline.ghGateHooks(task, 'chat'), { action: 'publish' })), 'deny');
});

test('plan mode: a read passes, a publish passes only after the hook got a yes for that call', async () => {
  const task = freshTask();
  const chat = { id: 'c-plan', planMode: true, pending: null, messages: [] };
  const live = { pending: new Map(), artifactOk: new Set() };
  const ctx = (id) => ({ toolUseID: id, signal: new AbortController().signal });
  const read = await pipeline.chatCanUseTool(task, chat, live, 'Artifact', { action: 'list' }, ctx('r1'));
  assert.equal(read.behavior, 'allow');
  const blocked = await pipeline.chatCanUseTool(task, chat, live, 'Artifact', { action: 'publish' }, ctx('p1'));
  assert.equal(blocked.behavior, 'deny');
  assert.equal((await pipeline.chatCanUseTool(task, chat, live, 'ArtifactData', {}, ctx('p2'))).behavior, 'deny', 'no action = publish');
  live.artifactOk.add('p1');
  assert.equal((await pipeline.chatCanUseTool(task, chat, live, 'Artifact', { action: 'publish' }, ctx('p1'))).behavior, 'allow');
  // Anything else in plan mode is still denied as before.
  assert.equal((await pipeline.chatCanUseTool(task, chat, live, 'Write', {}, ctx('w1'))).behavior, 'deny');
});

test('delete outside plan mode is refused at once in a chat: no question is parked', async () => {
  const task = freshTask();
  const chat = { id: 'c-del', planMode: false, pending: null, messages: [], title: 't' };
  task.chats = [chat];
  const live = { pending: new Map(), opencodeCalls: [], artifactOk: new Set() };
  const hooks = pipeline.ghGateHooks(task, 'chat', { chat, live });
  const out = await call(hooks, { action: 'delete', url: 'https://claude.ai/artifact/x' }, { tool_use_id: 'tu-del' });
  assert.equal(decisionOf(out), 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /claude\.ai/);
  assert.equal(chat.pending, null);
  assert.equal(live.pending.size, 0);
  assert.equal(live.artifactOk.has('tu-del'), false);
  // Every other action still asks.
  const held = call(hooks, { action: 'pin' });
  await until(() => chat.pending, 'pin still asks');
  live.pending.get(chat.pending.id).resolve({ behavior: 'allow', answers: { q: 'No' } });
  assert.equal(decisionOf(await held), 'deny');
});

test('delete is refused at once in a marked unattended phase and in a plan:<id> run', async () => {
  const task = freshTask({ design: true });
  assert.equal(decisionOf(await call(pipeline.ghGateHooks(task, 'fix'), { action: 'delete' })), 'deny');
  assert.ok(!task.pending, 'nothing parked on the task');
  // plan:<id> runs run under bypass even though chat.planMode is true.
  const chat = { id: 'c-del-plan', planMode: true, pending: null, messages: [], title: 't' };
  task.chats = [chat];
  const live = { pending: new Map(), opencodeCalls: [], artifactOk: new Set() };
  const hooks = pipeline.ghGateHooks(task, 'plan:t1', { chat, live });
  assert.equal(decisionOf(await call(hooks, { action: 'delete' })), 'deny');
  assert.equal(chat.pending, null);
});

test('delete in a chat in plan mode still asks, a yes is memoized and chatCanUseTool lets it through', async () => {
  const task = freshTask();
  const chat = { id: 'c-del-pm', planMode: true, pending: null, messages: [], title: 't' };
  task.chats = [chat];
  const live = { pending: new Map(), opencodeCalls: [], artifactOk: new Set() };
  const hooks = pipeline.ghGateHooks(task, 'chat', { chat, live });
  const input = { action: 'delete', url: 'https://claude.ai/artifact/x' };
  const held = call(hooks, input, { tool_use_id: 'tu-pm' });
  await until(() => chat.pending, 'the plan-mode pending');
  assert.ok(chat.pending.id.startsWith('artifact:'));
  live.pending.get(chat.pending.id).resolve({ behavior: 'allow', answers: { q: 'Sí, publicar' } });
  assert.equal(decisionOf(await held), 'allow');
  assert.ok(live.artifactOk.has('tu-pm'));
  const ctx = (id) => ({ toolUseID: id, signal: new AbortController().signal });
  assert.equal((await pipeline.chatCanUseTool(task, chat, live, 'Artifact', input, ctx('tu-pm'))).behavior, 'allow');
  assert.equal((await pipeline.chatCanUseTool(task, chat, live, 'Artifact', input, ctx('other'))).behavior, 'deny');
});

test('designSessionFor: chats and plan:<id> always, work phases only with the mark, never triage', () => {
  const marked = { design: true };
  const plain = { design: false };
  for (const stage of ['chat', 'plan:t1']) assert.equal(pipeline.designSessionFor(plain, stage), true, stage);
  for (const stage of ['plan', 'fix', 'fix:t2', 'gaps']) {
    assert.equal(pipeline.designSessionFor(plain, stage), false, `${stage} plain`);
    assert.equal(pipeline.designSessionFor(marked, stage), true, `${stage} marked`);
  }
  for (const stage of ['triage', 'advisor', 'qa', 'pr', 'demo', 'cr', 'close']) {
    assert.equal(pipeline.designSessionFor(marked, stage), false, `${stage} never`);
  }
  assert.equal(pipeline.designSessionFor({ design: 'true' }, 'fix'), false, 'only the boolean true');
});
