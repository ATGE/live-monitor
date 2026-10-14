// The push guard reaching the chat sessions, and only them.
//
// `pushguard.test.mjs` proves the hook decides correctly. This proves the other
// half: that a chat session is handed it, and that no pipeline session is. A
// `Stop` hook in a settings file would reach both kinds, and a pipeline session
// is not meant to push on its own; so the hook travels programmatically, in the
// set the chat builds, and these tests pin that.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDir } from './teardown.mjs';

process.env.HFSMON_DATA_DIR = tempDir('hfsmon-pushguard-wiring-');
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;
let ChatSession;
let subagentGateHooks;

before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  ({ ChatSession } = await import('../src/session.js'));
  ({ subagentGateHooks } = await import('../src/subagentgate.js'));
});

let n = 9900;
const freshTask = () => {
  n += 1;
  return store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
};
const freshChat = () => ({ id: 'c1', planMode: false, pending: null, messages: [] });
const freshLive = () => ({ pending: new Map(), opencodeCalls: [] });

const STAGES = [
  'triage', 'advisor', 'plan', 'fix', 'fix:t1', 'gaps', 'qa', 'pr', 'demo', 'cr', 'close', 'draft', 'plan:t1',
];

test('mergeHooks keeps both PreToolUse sets, in order, when a Stop set joins them', () => {
  const pre = (matcher) => ({ PreToolUse: [{ matcher, hooks: [async () => ({})] }] });
  const stop = { Stop: [{ hooks: [async () => ({})] }] };
  const merged = pipeline.mergeHooks(pre(undefined), pre('Bash'), stop);
  assert.equal(merged.PreToolUse.length, 2);
  assert.equal(merged.PreToolUse[0].matcher, undefined);
  assert.equal(merged.PreToolUse[1].matcher, 'Bash');
  assert.equal(merged.Stop.length, 1);
});

test('no pipeline session carries a Stop hook', () => {
  const task = freshTask();
  for (const stage of STAGES) {
    const hooks = pipeline.ghGateHooks(task, stage);
    assert.ok(hooks.PreToolUse, `${stage} keeps its gate`);
    assert.equal('Stop' in hooks, false, `${stage} must not carry Stop`);
  }
  assert.equal('Stop' in pipeline.ghGateHooks(task, 'chat'), false, 'the gate alone never adds it either');
  assert.equal('Stop' in subagentGateHooks(), false);
  assert.equal('Stop' in pipeline.noGitHubWriteHooks(task, 'close'), false);
});

test('the chat set carries one Stop matcher next to its three PreToolUse ones', () => {
  const hooks = pipeline.chatSessionHooks(freshTask(), freshChat(), freshLive());
  assert.equal(hooks.Stop.length, 1);
  assert.equal(typeof hooks.Stop[0].hooks[0], 'function');
  assert.equal(hooks.PreToolUse.length, 3);
  assert.equal(hooks.PreToolUse[0].matcher, undefined);
  assert.equal(hooks.PreToolUse[1].matcher, 'Bash');
  assert.equal(hooks.PreToolUse[2].matcher, 'Artifact|ArtifactComments|ArtifactData');
});

test('a chat session hands its Stop set to the SDK options', async () => {
  const hooks = pipeline.chatSessionHooks(freshTask(), freshChat(), freshLive());
  const calls = [];
  const queryFn = ({ prompt, options }) => {
    calls.push(options);
    const gen = (async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'fresh-1', model: options.model };
      for await (const _ of prompt) { /* never answered: the test only reads the options */ }
    }());
    gen.close = () => { gen.return(); };
    gen.interrupt = async () => {};
    return gen;
  };
  const session = new ChatSession({ cwd: process.cwd(), hooks, queryFn });
  try {
    session.send('hi').catch(() => {});
    for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1, 'the session opened the SDK query');
    assert.equal(calls[0].hooks.Stop.length, 1);
    assert.equal(calls[0].hooks.PreToolUse.length, 3);
  } finally {
    await session.close?.();
  }
});

test('liveOf builds the chat hooks with chatSessionHooks', () => {
  const src = readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
  const start = src.indexOf('function liveOf(');
  assert.ok(start > 0, 'liveOf is there');
  const end = src.slice(start).search(/\r?\n\}\r?\n/);
  const body = src.slice(start, start + end);
  assert.match(body, /hooks:\s*chatSessionHooks\(task, chat, live\)/);
  assert.doesNotMatch(body, /hooks:\s*mergeHooks\(/, 'no hand-rolled merge left behind');
});
