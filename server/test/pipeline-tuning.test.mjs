// Model and effort reaching the sessions the pipeline opens.
//
// Two levels. `tunedSession` is the one place that turns `tuningFor` into
// options, so its contract is tested directly: «auto» is a key that is ABSENT
// (not `undefined`), the card's `phaseModels` moves the latest session to the
// end, and the fallbacks the pipeline always had still hold. Then real call
// sites are driven against the SDK seam (`claudeHooks.query`), which sees the
// options after `sessionOptions` has built them — the ones the CLI would get.
import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tempDir, removeTreeReported } from './teardown.mjs';
import path from 'node:path';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { saveProjects } = await import('../src/projects.js');
const { claudeHooks } = await import('../src/claude.js');
const { keyOf } = await import('../src/keys.js');
const { setTuning } = await import('../src/tuning.js');
const { effortOptionsFor } = await import('../src/effort.js');
const { migrateChat, makeChat } = await import('../src/chats.js');
const { migrateChatModels } = await import('../src/store.js');
const pipeline = await import('../src/pipeline.js');
const { tunedSession, composePrBody, triageVerdictFor, setChatModel, createChat } = pipeline;

const base = (id, extra = {}) => ({
  id, name: id, repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot,
  repo: `eterceros/${id}`, assignee: config.github.assignee, reviewer: null, overrides: { e2e: null, stack: null }, ...extra,
});
const entries = () => [
  { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
  base('plain'),
  base('sourced', { settingSources: ['user'] }),
  base('nodesign', { design: false }),
  base('ownmodels', { overrides: { e2e: null, stack: null, claude: { available: [{ id: 'zeta', label: 'Zeta' }, { id: 'opus', label: 'Opus' }] } } }),
];
before(() => saveProjects(entries()));
// Repositories a test made for itself. A live session may still hold one as its
// cwd (Windows then refuses the delete), so removal is best effort, at the end.
const tempRepos = [];
after(async () => {
  for (const dir of tempRepos) {
    await removeTreeReported('pipeline-tuning', dir, { tolerate: true, timeoutMs: 3000 });
  }
});
after(() => {
  saveProjects(entries());
  setTuning({ roles: Object.fromEntries(['triage', 'advisor', 'plan', 'fix', 'pr', 'demo', 'reply', 'chat', 'qa', 'qaPlan'].map((r) => [r, null])) });
});

let n = 8800;
function taskOf(project = 'plain', fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, project);
  task.worktreePath = `/wt/${n}`;
  task.branch = `fix/${n}-thing`;
  return Object.assign(task, fields);
}
const issueOf = (task) => ({ number: task.issue, title: `Issue ${task.issue}`, body: 'Something is broken.' });

const clearAll = () => setTuning({ fastMode: null, roles: Object.fromEntries(['triage', 'advisor', 'plan', 'fix', 'pr', 'demo', 'reply', 'chat', 'qa', 'qaPlan'].map((r) => [r, null])) });

// ---------------------------------------------------------------------------
// tunedSession

test('auto leaves the options untouched: no effort, thinking, fastMode or contextWindow KEY at all', () => {
  clearAll();
  const out = tunedSession(taskOf(), 'fix');
  // `metrics` says who is asking, so `runClaude` can record the session span.
  assert.deepEqual(Object.keys(out).sort(), ['available', 'metrics', 'model', 'onWarning']);
  assert.deepEqual(Object.keys(out.metrics).sort(), ['role', 'stage', 'task']);
  assert.equal(out.model, config.claude.fixModel);
  assert.equal('effort' in out, false);
  assert.equal('thinking' in out, false);
  assert.equal('fastMode' in out, false);
  assert.equal('contextWindow' in out, false);
  assert.equal('settingSources' in out, false);
  assert.deepEqual(out.available, config.claude.available);
});

test('a board override reaches the options, and records the card chip', () => {
  clearAll();
  setTuning({ roles: { fix: { model: 'sonnet', effort: 'high' } } });
  const task = taskOf();
  const out = tunedSession(task, 'fix');
  assert.equal(out.model, 'sonnet');
  assert.equal(out.effort, 'high');
  assert.deepEqual(task.phaseModels.fix, { model: 'sonnet', effort: 'high' });
  clearAll();
});

test('phaseModels keeps the latest session last, and records «auto» as null', () => {
  clearAll();
  const task = taskOf();
  tunedSession(task, 'triage');
  tunedSession(task, 'fix');
  tunedSession(task, 'triage');
  assert.deepEqual(Object.keys(task.phaseModels), ['fix', 'triage']);
  assert.equal(task.phaseModels.triage.effort, null);
});

test('record: false leaves phaseModels alone (re-asks in the same session)', () => {
  clearAll();
  const task = taskOf();
  tunedSession(task, 'triage', { record: false });
  assert.equal(task.phaseModels, undefined);
});

test('the fallbacks of old hold: plan -> advisor, reply -> demo, qa -> fix, qaPlan -> advisor', () => {
  clearAll();
  const task = taskOf();
  const cfg = structuredClone(config);
  delete cfg.claude.planModel;
  delete cfg.claude.replyModel;
  cfg.claude.advisorModel = 'opus';
  cfg.claude.demoModel = 'haiku';
  cfg.claude.fixModel = 'sonnet';
  cfg.qa = { ...(cfg.qa ?? {}) };
  delete cfg.qa.model;
  delete cfg.qa.planModel;
  assert.equal(tunedSession(task, 'plan', { cfg, record: false }).model, 'opus');
  assert.equal(tunedSession(task, 'reply', { cfg, record: false }).model, 'haiku');
  assert.equal(tunedSession(task, 'qa', { cfg, record: false }).model, 'sonnet');
  assert.equal(tunedSession(task, 'qaPlan', { cfg, record: false }).model, 'opus');
});

test('the project settingSources ride along, and only when declared', () => {
  clearAll();
  assert.deepEqual(tunedSession(taskOf('sourced'), 'fix', { record: false }).settingSources, ['user']);
  assert.equal('settingSources' in tunedSession(taskOf('plain'), 'fix', { record: false }), false);
});

test('boardPlugins rides along only for an attended stage of a project with design on', () => {
  clearAll();
  const on = taskOf('plain');
  assert.deepEqual(tunedSession(on, 'chat', { record: false }).boardPlugins, ['hfs-ux']);
  assert.deepEqual(tunedSession(on, 'fix', { stage: 'plan:t1', record: false }).boardPlugins, ['hfs-ux']);
  assert.deepEqual(pipeline.chatSessionTuning(on, null, 'chat').boardPlugins, ['hfs-ux']);
  for (const [role, stage] of [['fix', 'fix'], ['fix', 'fix:t1'], ['qa', 'qa'], ['triage', 'triage'], ['plan', 'plan'], ['pr', 'pr']]) {
    assert.equal('boardPlugins' in tunedSession(on, role, { stage, record: false }), false, `${role}/${stage}`);
  }
  const off = taskOf('nodesign');
  assert.equal('boardPlugins' in tunedSession(off, 'chat', { record: false }), false);
  assert.equal('boardPlugins' in tunedSession(off, 'fix', { stage: 'plan:t1', record: false }), false);
  assert.equal('boardPlugins' in pipeline.chatSessionTuning(off, null, 'chat'), false);
});

test('onWarning writes to the task log under the stage', () => {
  const task = taskOf();
  tunedSession(task, 'fix', { stage: 'gaps', record: false }).onWarning('algo se descartó');
  assert.ok(task.log.some((l) => l.phase === 'gaps' && /algo se descartó/.test(l.line)));
});

// ---------------------------------------------------------------------------
// Real call sites, seen from the SDK seam

const uuidOf = (s) => s.sent[0]?.uuid;
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

/** A `query` that records the options of every session and answers from a queue. */
function fakeSdk(answers) {
  const seen = [];
  const queue = [...answers];
  const original = claudeHooks.query;
  claudeHooks.query = ({ prompt, options }) => {
    seen.push(options);
    const sent = [];
    let closed = false;
    (async () => { for await (const m of prompt) sent.push(m); closed = true; })();
    return (async function* stream() {
      await tick();
      const text = queue.shift() ?? '';
      yield { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5' };
      yield { type: 'assistant', user_message_uuid: uuidOf({ sent }), session_id: 's1', message: { role: 'assistant', content: [{ type: 'text', text }] } };
      yield { type: 'result', subtype: 'success', result: text, num_turns: 1, total_cost_usd: 0, session_id: 's1', user_message_uuid: uuidOf({ sent }), user_message_uuids: [uuidOf({ sent })] };
      for (let i = 0; i < 500 && !closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  return { seen, restore: () => { claudeHooks.query = original; } };
}

const GOOD_BODY = '## At a glance: before vs. after\n\nBefore: it crashed. After: it works.\n';

test('the PR body session: nothing chosen passes no effort; a choice reaches the CLI options and the log', async () => {
  clearAll();
  const quiet = fakeSdk([GOOD_BODY]);
  try {
    const task = taskOf();
    await composePrBody(task, issueOf(task));
    const [options] = quiet.seen;
    assert.equal(options.model, config.claude.prModel ?? config.claude.chatModel);
    assert.equal('effort' in options, false, 'auto = the key is absent');
    assert.ok(options.hooks?.PreToolUse, 'the gh gate is still on every session');
    assert.deepEqual(task.phaseModels.pr, { model: options.model, effort: null });
  } finally { quiet.restore(); }

  setTuning({ roles: { pr: { effort: 'high' } } });
  const loud = fakeSdk([GOOD_BODY]);
  try {
    const task = taskOf();
    await composePrBody(task, issueOf(task));
    assert.equal(loud.seen[0].effort, 'high');
    assert.equal(task.phaseModels.pr.effort, 'high');
    assert.ok(task.log.some((l) => /Claude session started \(.*effort high\)/.test(l.line)), 'the start line says the effort');
  } finally { loud.restore(); clearAll(); }
});

test('the triage re-ask carries the same tuning as the first triage session', async () => {
  clearAll();
  setTuning({ roles: { triage: { effort: 'low' } } });
  const task = taskOf();
  const calls = [];
  const run = async (options) => { calls.push(options); return { ok: true, resultText: 'TRIAGE_RESULT: {"complexity":"simple","reason":"r","summary":"s"}', sessionId: 's2' }; };
  const out = await triageVerdictFor(task, { resultText: 'sin línea', sessionId: 's1' }, { run });
  assert.equal(out.path, 'reasked');
  assert.equal(calls[0].effort, 'low');
  assert.equal(calls[0].resume, 's1');
  assert.equal(task.phaseModels, undefined, 'a re-ask is the same session: it does not rewrite the chip');
  clearAll();
});

// ---------------------------------------------------------------------------
// Per-chat effort (C7)

test('a chat stores its effort next to its model; null by birth, forks inherit it', () => {
  assert.equal(makeChat().effort, null);
  assert.equal(migrateChat({ planMode: false, pending: null, plan: null, handoff: null }).effort, null);
  assert.equal(migrateChat({ effort: 'high' }).effort, 'high');
  assert.equal(makeChat({ effort: 'low' }).effort, 'low');
});

test('setChatModel takes an effort, validates it against the chat\'s model, and keeps its positional args', () => {
  const task = taskOf();
  const key = keyOf(task);
  // Positional behaviour of old: model only, effort untouched.
  assert.equal(setChatModel(key, null, 'opus'), 'opus');
  const chat = task.chats[0];
  assert.ok(chat, 'the task has a principal chat');
  assert.equal(chat.effort ?? null, null);

  assert.equal(setChatModel(key, null, 'opus', 'high'), 'opus');
  assert.equal(chat.effort, 'high');
  // `undefined` leaves it; `null` and `auto` clear it.
  setChatModel(key, null, 'opus');
  assert.equal(chat.effort, 'high');
  setChatModel(key, null, 'opus', 'auto');
  assert.equal(chat.effort, 'auto');
  setChatModel(key, null, 'opus', 'xhigh');
  setChatModel(key, null, 'opus', null);
  assert.equal(chat.effort, null);

  // A value that is not a level is refused, nothing stored. A level the model
  // lacks is NOT: it is kept as chosen and clamped when the session opens.
  setChatModel(key, null, 'opus', 'high');
  assert.throws(() => setChatModel(key, null, 'opus', 'enormous'), /effort/);
  assert.equal(chat.effort, 'high');
  assert.equal(chat.model, 'opus');
  assert.equal(setChatModel(key, null, 'haiku', 'low'), 'haiku');
  assert.equal(chat.effort, 'low');
  assert.equal(chat.model, 'haiku');
});

test('setChatModel: an ABSENT model keeps the chat model, null clears it', () => {
  const task = taskOf();
  const key = keyOf(task);
  setChatModel(key, null, 'opus');
  const chat = task.chats[0];
  setChatModel(key, null, undefined, 'high');
  assert.equal(chat.model, 'opus', 'a patch with only an effort leaves the model');
  assert.equal(chat.effort, 'high');
  setChatModel(key, null, undefined, undefined, 'auto');
  assert.equal(chat.model, 'opus');
  setChatModel(key, null, null);
  assert.equal(chat.model, null, 'an explicit null is the config default again');
});

test('a chat stores its thinking: null by birth, validated against the resulting model, forks inherit it', () => {
  assert.equal(makeChat().thinking, null);
  assert.equal(makeChat({ thinking: 'auto' }).thinking, 'auto');
  assert.equal(migrateChat({}).thinking, null);
  assert.equal(migrateChat({ thinking: 'auto' }).thinking, 'auto');
  assert.equal(migrateChat({}).lastTurnAt, null);

  const task = taskOf();
  const key = keyOf(task);
  const chat = task.chats[0];
  setChatModel(key, null, 'opus');
  assert.throws(() => setChatModel(key, null, 'opus', undefined, { type: 'enabled', budgetTokens: 2000 }), /does not support enabled thinking/);
  assert.throws(() => setChatModel(key, null, 'opus', undefined, { type: 'bogus' }), /Thinking must be/);
  assert.throws(() => setChatModel(key, null, 'opus', undefined, 'sideways'), /Thinking must be/);
  assert.equal(chat.thinking, null, 'nothing stored by a refused patch');
  setChatModel(key, null, 'opus', undefined, { type: 'adaptive' });
  assert.deepEqual(chat.thinking, { type: 'adaptive' });
  // A patch with only the model, whose stored thinking stops fitting: refused, nothing changed.
  assert.throws(() => setChatModel(key, null, 'haiku'), /does not support adaptive thinking/);
  assert.equal(chat.model, 'opus');
  assert.deepEqual(chat.thinking, { type: 'adaptive' });
  // An absent thinking keeps it; null clears it (inherits the role «chat»); auto passes nothing.
  setChatModel(key, null, 'sonnet');
  assert.deepEqual(chat.thinking, { type: 'adaptive' });
  setChatModel(key, null, 'haiku', undefined, null);
  assert.equal(chat.thinking, null);
  setChatModel(key, null, 'haiku', undefined, { type: 'enabled' });
  assert.deepEqual(chat.thinking, { type: 'enabled' }, 'the budget is the role\'s, resolved when the session opens');
  // A budget sent for a chat is ignored, not validated: only the type is stored.
  setChatModel(key, null, 'haiku', undefined, { type: 'enabled', budgetTokens: 10 });
  assert.deepEqual(chat.thinking, { type: 'enabled' });
  setChatModel(key, null, 'haiku', undefined, 'auto');
  assert.equal(chat.thinking, 'auto');

  setChatModel(key, null, 'opus', undefined, { type: 'adaptive' });
  chat.sessionId = 'parent-thinking';
  const child = createChat(key, { forkFrom: chat.id });
  assert.deepEqual(child.thinking, { type: 'adaptive' });
  assert.notEqual(child.thinking, chat.thinking, 'a copy, not the same object');
});

test('a chat session thinking: empty inherits the role chat, auto sends nothing, an enabled budget comes from the role', () => {
  clearAll();
  const task = taskOf();
  const chat = task.chats[0];
  setTuning({ roles: { chat: { thinking: { type: 'adaptive' } } } });
  chat.model = null;                                    // the config chat model (sonnet)
  chat.thinking = null;
  assert.deepEqual(pipeline.chatSessionTuning(task, chat, 'chat').thinking, { type: 'adaptive' });
  chat.thinking = 'auto';
  assert.equal('thinking' in pipeline.chatSessionTuning(task, chat, 'chat'), false);
  chat.thinking = { type: 'adaptive' };
  assert.deepEqual(pipeline.chatSessionTuning(task, chat, 'chat').thinking, { type: 'adaptive' });

  // Haiku with a budget: the chat picks the mode, the number is the role's.
  setTuning({ roles: { chat: { model: 'haiku', thinking: { type: 'enabled', budgetTokens: 4096 } } } });
  chat.model = 'haiku';
  chat.thinking = { type: 'enabled' };
  assert.deepEqual(pipeline.chatSessionTuning(task, chat, 'chat').thinking, { type: 'enabled', budgetTokens: 4096 });
  // A budget left on the chat by an older file is not read: the number is always the role's.
  chat.thinking = { type: 'enabled', budgetTokens: 2048 };
  assert.deepEqual(pipeline.chatSessionTuning(task, chat, 'chat').thinking, { type: 'enabled', budgetTokens: 4096 });
  // The role has no budget: the minimum.
  setTuning({ roles: { chat: { thinking: 'auto' } } });
  chat.thinking = { type: 'enabled' };
  assert.deepEqual(pipeline.chatSessionTuning(task, chat, 'chat').thinking, { type: 'enabled', budgetTokens: 1024 });
  clearAll();
});

test('the chat public effort is clamped to its model; auto and Haiku give null', () => {
  clearAll();
  const task = taskOf();
  const chat = task.chats[0];
  chat.model = 'opus';
  chat.effort = 'xhigh';
  assert.equal(pipeline.chatEffectiveEffort(task, chat), 'xhigh');
  chat.model = 'haiku';
  assert.equal(pipeline.chatEffectiveEffort(task, chat), null);
  chat.model = 'sonnet';
  chat.effort = 'auto';
  assert.equal(pipeline.chatEffectiveEffort(task, chat), null);
  chat.effort = null;                                    // inherits the role «chat» (auto here)
  assert.equal(pipeline.chatEffectiveEffort(task, chat), null);
  setTuning({ roles: { chat: { effort: 'max' } } });
  assert.equal(pipeline.chatEffectiveEffort(task, chat), 'max');
  clearAll();
});

test('/model in the chat: same flow as the picker; a thinking that does not fit is cleared and said so', () => {
  clearAll();
  const task = taskOf();
  const chat = task.chats[0];
  const key = keyOf(task);
  setChatModel(key, null, 'opus', 'high', { type: 'adaptive' });
  pipeline.sendChat(key, chat.id, '/model haiku');
  assert.equal(chat.model, 'haiku');
  assert.equal(chat.thinking, null, 'cleared');
  assert.equal(chat.effort, 'high', 'the effort is kept, clamped at session open');
  const reply = chat.messages.at(-1);
  assert.equal(reply.role, 'assistant');
  assert.match(reply.text, /haiku/i);
  assert.match(reply.text, /«adaptive» thinking.*I removed it/);
  // A thinking that fits is left alone and nothing is said about it.
  setChatModel(key, null, 'opus', undefined, { type: 'adaptive' });
  pipeline.sendChat(key, chat.id, '/model sonnet');
  assert.equal(chat.model, 'sonnet');
  assert.deepEqual(chat.thinking, { type: 'adaptive' });
  assert.doesNotMatch(chat.messages.at(-1).text, /thinking/i);
});

test('a live session is retuned with the chat full state; a reopen is told in the chat', async () => {
  clearAll();
  const task = taskOf();
  const chat = task.chats[0];
  const key = keyOf(task);
  const live = pipeline.liveEntryOf(task, chat);
  const calls = [];
  let reopened = false;
  let reason = 'model';
  live.session.retune = async (o) => { calls.push(o); return { reopened, effort: o.effort, reason }; };
  const noticed = chat.messages.length;
  setChatModel(key, null, 'opus', 'high', { type: 'adaptive' });
  await tick();
  assert.deepEqual(calls.at(-1), { model: 'opus', effort: 'high', thinking: { type: 'adaptive' } });
  assert.equal(chat.messages.length, noticed, 'no notice when nothing is reopened');
  // auto clears what the process runs with: null, never undefined (undefined would keep it)
  setChatModel(key, null, undefined, 'auto', 'auto');
  await tick();
  assert.deepEqual(calls.at(-1), { model: 'opus', effort: null, thinking: null });
  reopened = true;
  setChatModel(key, null, 'haiku', undefined, null);
  await tick();
  assert.equal(calls.at(-1).model, 'haiku');
  assert.match(chat.messages.at(-1).text, /^I switched to Haiku; I will reopen the session because its thinking is not compatible$/);
  reason = 'thinking';
  setChatModel(key, null, undefined, undefined, { type: 'enabled', budgetTokens: 9999 });
  await tick();
  assert.equal(chat.messages.at(-1).text, 'I changed the thinking; I will reopen the session to apply it.');
  assert.deepEqual(calls.at(-1).thinking, { type: 'enabled', budgetTokens: 1024 }, 'the number sent by the caller is ignored');
});

test('a thinking inherited from the role that the chat model does not support is left out, silently', () => {
  clearAll();
  const task = taskOf();
  const chat = task.chats[0];
  setTuning({ roles: { chat: { thinking: { type: 'adaptive' } } } });
  chat.model = 'haiku';
  chat.thinking = null;
  const t = pipeline.chatSessionTuning(task, chat, 'chat');
  assert.equal('thinking' in t, false);
  const before = task.log.length;
  t.onWarning?.('x');                                   // the only path a warning could take
  const opts = effortOptionsFor({ model: t.model, thinking: t.thinking, available: t.available });
  assert.deepEqual(opts.warnings, [], 'nothing to warn about: it was never sent');
  assert.ok(task.log.length >= before);
  // The chat's OWN thinking keeps today's behaviour: kept in the tuning, and warned about by the session.
  chat.thinking = { type: 'adaptive' };
  assert.deepEqual(pipeline.chatSessionTuning(task, chat, 'chat').thinking, { type: 'adaptive' });
  // Inherited and supported: sent.
  chat.model = 'opus';
  chat.thinking = null;
  assert.deepEqual(pipeline.chatSessionTuning(task, chat, 'chat').thinking, { type: 'adaptive' });
  clearAll();
});

test('a session closed while idle takes the tuning the chat resolves to now before it reopens', async () => {
  clearAll();
  // The turn path insists on a real worktree OF THE TASK'S PROJECT: a project whose
  // checkout is a repository of this file's own, with the task standing in it (the
  // main checkout is a worktree of itself). Never the configured checkout, which
  // the fixture does not provide.
  const repo = tempDir('tuning-wt-');
  tempRepos.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'c'], { cwd: repo });
  try {
    saveProjects([...entries(), base('ownrepo', { repoPath: repo, worktreeRoot: `${repo}-wt` })]);
    const task = taskOf('ownrepo', { worktreePath: repo });
    const chat = task.chats[0];
    chat.model = null; chat.thinking = null; chat.effort = null;
    const live = pipeline.liveEntryOf(task, chat);
    const order = [];
    let alive = false;
    Object.defineProperty(live.session, 'alive', { get: () => alive });
    live.session.retune = async (o) => { order.push(['retune', o]); };
    live.session.send = async () => { order.push(['send']); return { ok: true, sessionId: 's-r', resultText: 'vale', toolCounts: {} }; };
    const run = async (text) => {
      pipeline.sendChat(keyOf(task), chat.id, text);
      for (let i = 0; i < 200 && (chat.busy || !order.some((o) => o[0] === 'send')); i += 1) await new Promise((r) => { setTimeout(r, 5); });
      for (let i = 0; i < 200 && chat.busy; i += 1) await new Promise((r) => { setTimeout(r, 5); });
    };
    setTuning({ roles: { chat: { effort: 'high', thinking: { type: 'adaptive' } } } });
    await run('uno');
    assert.deepEqual(order.map((o) => o[0]), ['retune', 'send'], 'retune first, then the send that reopens');
    assert.equal(order[0][1].effort, 'high');
    assert.deepEqual(order[0][1].thinking, { type: 'adaptive' });
    // A live process is not touched on a send.
    order.length = 0;
    alive = true;
    await run('dos');
    assert.deepEqual(order.map((o) => o[0]), ['send']);
  } finally {
    clearAll();
    saveProjects(entries());
  }
});

test('lastTurnAt is written when the chat own turn ends', async () => {
  clearAll();
  const task = taskOf();
  const chat = task.chats[0];
  const live = pipeline.liveEntryOf(task, chat);
  live.session.send = async () => ({ ok: true, sessionId: 's-last', resultText: 'vale', toolCounts: {} });
  assert.equal(chat.lastTurnAt ?? null, null);
  const before = Date.now();
  pipeline.sendChat(keyOf(task), chat.id, 'hola');
  for (let i = 0; i < 200 && (chat.busy || !chat.lastTurnAt); i += 1) await new Promise((r) => { setTimeout(r, 5); });
  assert.ok(chat.lastTurnAt, 'set at the end of the turn');
  assert.ok(Date.parse(chat.lastTurnAt) >= before);
  assert.ok(!chat.busy);
});

test('a tuned thinking reaches the session options only when chosen', () => {
  clearAll();
  const task = taskOf();
  assert.equal('thinking' in tunedSession(task, 'fix', { record: false }), false);
  setTuning({ roles: { fix: { thinking: { type: 'adaptive' } } } });
  assert.deepEqual(tunedSession(task, 'fix', { record: false }).thinking, { type: 'adaptive' });
  setTuning({ roles: { fix: { thinking: 'auto' } } });
  assert.equal('thinking' in tunedSession(task, 'fix', { record: false }), false);
  clearAll();
});

test('a forked chat inherits the parent\'s model and effort', () => {
  const task = taskOf();
  const key = keyOf(task);
  setChatModel(key, null, 'opus', 'max');
  const parent = (task.chats ?? [])[0];
  parent.sessionId = 'parent-session';
  const child = createChat(key, { forkFrom: parent.id });
  assert.equal(child.model, 'opus');
  assert.equal(child.effort, 'max');
});

test('boot: an effort this board does not know goes back to auto, a good one stays', () => {
  const task = { chats: [{ id: 'a', model: 'opus', effort: 'turbo' }, { id: 'b', model: 'opus', effort: 'high' }, { id: 'c', model: null, effort: 'auto' }] };
  migrateChatModels(task, config.claude.available);
  assert.deepEqual(task.chats.map((c) => c.effort), [null, 'high', 'auto']);
});

test('setChatModel validates against the task models, not the board-wide list', () => {
  const task = taskOf('ownmodels');
  assert.equal(setChatModel(keyOf(task), null, 'zeta'), 'zeta');
  assert.throws(() => setChatModel(keyOf(task), null, 'sonnet'), /Modelo desconocido: sonnet/);
  const plain = taskOf('plain');
  assert.throws(() => setChatModel(keyOf(plain), null, 'zeta'), /Modelo desconocido: zeta/);
});

test('setChatModel switches a live session to the tuned chat model, and to the chat own model once set', async () => {
  clearAll();
  const task = taskOf('plain');
  const chat = task.chats[0];
  const live = pipeline.liveEntryOf(task, chat);
  const seen = [];
  live.session.retune = async ({ model }) => { seen.push(model); return { reopened: false }; };
  const key = keyOf(task);
  setChatModel(key, null, null);
  await tick();
  const tuned = pipeline.tunedSession(task, 'chat', { record: false }).model;
  assert.equal(seen.at(-1), tuned, 'no chat model: the tuned model of the chat role');
  setChatModel(key, null, 'opus');
  await tick();
  assert.equal(seen.at(-1), 'opus');
});

test('design: a work phase gets the key only with a person\'s mark; a chat always; triage never', () => {
  clearAll();
  const plain = taskOf();
  for (const stage of ['fix', 'plan', 'gaps', 'fix:t1', 'triage']) {
    assert.equal('design' in tunedSession(plain, 'fix', { stage, record: false }), false, `${stage} unmarked`);
  }
  assert.equal(tunedSession(plain, 'chat', { stage: 'chat', record: false }).design, true, 'a chat has a person in front');
  assert.equal(tunedSession(plain, 'fix', { stage: 'plan:t1', record: false }).design, true, 'so does a plan:<id> session');
  const marked = taskOf('plain', { design: true });
  for (const stage of ['fix', 'plan', 'gaps', 'fix:t1']) {
    assert.equal(tunedSession(marked, 'fix', { stage, record: false }).design, true, `${stage} marked`);
  }
  for (const stage of ['triage', 'advisor', 'qa', 'pr', 'demo', 'cr', 'close']) {
    assert.equal('design' in tunedSession(marked, 'fix', { stage, record: false }), false, `${stage} never`);
  }
  assert.equal('design' in tunedSession(plain, 'fix'), false);
});
