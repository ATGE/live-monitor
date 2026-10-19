// The grace cap must END the session, not only close its stdin. A CLI that keeps
// a never-ending background command alive does not exit when its input closes,
// so the `for await` over the query used to wait for ever (issue #51).
//
// The fake query here behaves like that CLI: its stream ends only when the test
// says which call ends it (`interrupt()`, `close()`, or nothing at all).
import './isolate.mjs';   // first: `claude.js` reaches the data directory
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { runClaude, claudeHooks } from '../src/claude.js';

const original = {
  query: claudeHooks.query, taskGraceMs: claudeHooks.taskGraceMs,
  graceEndMs: claudeHooks.graceEndMs, killTree: claudeHooks.killTree,
};
const restore = () => Object.assign(claudeHooks, original);
// The fake CLI streams intentionally have no OS file descriptors. Production
// always has a live CLI pipe, but under a parallel CI runner an unref() grace
// timer can otherwise be the only thing keeping the event loop alive and Node
// cancels every remaining test. This interval models that process handle.
let fakeCliKeepalive;
before(() => { fakeCliKeepalive = setInterval(() => {}, 200); });
beforeEach(() => {
  restore();
  claudeHooks.taskGraceMs = 30;
  claudeHooks.graceEndMs = 20;
});
after(() => { clearInterval(fakeCliKeepalive); restore(); });

const T = { timeout: 5000 };
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

const init = () => ({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-haiku-4-5' });
const taskStarted = (taskId) => ({ type: 'system', subtype: 'task_started', task_id: taskId, description: 'probe', is_backgrounded: true });
const result = (uuid, text) => ({
  type: 'result', subtype: 'success', result: text, num_turns: 2, total_cost_usd: 0.01,
  session_id: 'sess-1', user_message_uuid: uuid, user_message_uuids: [uuid],
});

/**
 * A query whose stream does not end when the input closes. `endsOn` says what
 * ends it: 'interrupt', 'close' or 'never'. `afterInterrupt` frames are emitted
 * by the CLI as its reaction to the interrupt, before the stream ends.
 */
function hungSdk({ endsOn, pid = null, mine = true, afterInterrupt = [] }) {
  const state = { sent: [], inputClosed: false, interrupts: 0, closes: 0, order: [] };
  claudeHooks.query = ({ prompt, options }) => {
    (async () => {
      for await (const m of prompt) state.sent.push(m);
      state.inputClosed = true;
    })();
    if (pid != null) options.onProcessSpawned?.(pid);
    const queue = [];
    let wake = null;
    let ended = false;
    const push = (f) => { queue.push(f); wake?.(); };
    const end = () => { ended = true; wake?.(); };
    const query = {
      interrupt: async () => {
        state.interrupts += 1;
        state.order.push('interrupt');
        if (endsOn === 'interrupt') { afterInterrupt.forEach(push); end(); }
        else if (afterInterrupt.length) afterInterrupt.forEach(push);
      },
      close: () => {
        state.closes += 1;
        state.order.push('close');
        if (endsOn === 'close') end();
      },
      next: async () => {
        for (;;) {
          if (queue.length) return { value: queue.shift(), done: false };
          if (ended) return { value: undefined, done: true };
          await new Promise((r) => { wake = r; });
          wake = null;
        }
      },
      return: async () => ({ value: undefined, done: true }),
      [Symbol.asyncIterator]() { return this; },
    };
    (async () => {
      await tick();
      const uuid = state.sent[0]?.uuid;
      push(init());
      push(taskStarted('task-zombi'));
      push(result(mine ? uuid : 'otro-prompt', 'respuesta'));
    })();
    return query;
  };
  return state;
}

const collect = () => { const evs = []; return { evs, onEvent: (ev) => evs.push(ev) }; };
const run = (over = {}) => runClaude({ cwd: '/wt/x', model: 'haiku', prompt: 'haz algo', trackQuota: false, ...over });
const warnsOf = (evs) => evs.filter((e) => e.kind === 'warn');

function recordKills() {
  const kills = [];
  claudeHooks.killTree = async (pid, machine) => { kills.push({ pid, machine }); };
  return kills;
}

test('sealed answer, the stream ends on interrupt(): ok, one warning, nothing killed', T, async () => {
  const kills = recordKills();
  const sdk = hungSdk({ endsOn: 'interrupt', pid: 4242 });
  const { evs, onEvent } = collect();
  const r = await run({ onEvent });

  assert.equal(r.ok, true);
  assert.equal(r.resultText, 'respuesta');
  assert.equal(sdk.interrupts, 1);
  assert.equal(sdk.inputClosed, true);
  assert.deepEqual(kills, [], 'a session that ends by itself is not killed');
  const warns = warnsOf(evs);
  assert.equal(warns.length, 1);
  assert.match(warns[0].warning, /1 background task\(s\) still have not reported/);
  assert.match(warns[0].warning, /the channel is closed/);
});

test('sealed answer, only close() ends it: the tree is killed by pid first, then closed', T, async () => {
  const kills = recordKills();
  claudeHooks.killTree = async (pid) => { kills.push(pid); sdk.order.push('kill'); };
  const sdk = hungSdk({ endsOn: 'close', pid: 4242 });
  const { evs, onEvent } = collect();
  const machine = { name: 'local' };
  const r = await run({ onEvent, machine });

  assert.equal(r.ok, true);
  assert.equal(r.resultText, 'respuesta');
  assert.deepEqual(kills, [4242]);
  assert.deepEqual(sdk.order, ['interrupt', 'kill', 'close']);
  assert.equal(warnsOf(evs).length, 1, 'no second warning for the forced end');
});

test('the machine of the session reaches the kill seam', T, async () => {
  const kills = recordKills();
  hungSdk({ endsOn: 'close', pid: 77 });
  const machine = { name: 'local' };
  await run({ onEvent: () => {}, machine });
  assert.equal(kills.length, 1);
  assert.equal(kills[0].pid, 77);
  assert.equal(kills[0].machine, machine);
});

test('unsealed answer, only close() ends it: ok false with a clear error', T, async () => {
  recordKills();
  hungSdk({ endsOn: 'close', pid: 4242, mine: false });
  const { evs, onEvent } = collect();
  const r = await run({ onEvent });

  assert.equal(r.ok, false);
  assert.equal(r.resultText, '');
  assert.match(r.error, /the session did not finish after the grace limit/);
  const warns = warnsOf(evs);
  assert.equal(warns.length, 1);
  assert.match(warns[0].warning, /no result is recognised/);
});

test('a stream that never ends: runClaude still returns, with the sealed answer', T, async () => {
  const kills = recordKills();
  const sdk = hungSdk({ endsOn: 'never', pid: 4242 });
  const r = await run({ onEvent: () => {} });

  assert.equal(r.ok, true);
  assert.equal(r.resultText, 'respuesta');
  assert.equal(sdk.closes, 1);
  assert.deepEqual(kills.map((k) => k.pid), [4242]);
});

test('a stream that never ends and nothing sealed: ok false, still returns', T, async () => {
  recordKills();
  hungSdk({ endsOn: 'never', mine: false });
  const r = await run({ onEvent: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /grace limit/);
});

test('without a captured pid nothing is killed, but the query is still closed', T, async () => {
  const kills = recordKills();
  const sdk = hungSdk({ endsOn: 'close', pid: null });
  const r = await run({ onEvent: () => {} });

  assert.equal(r.ok, true);
  assert.deepEqual(kills, []);
  assert.equal(sdk.closes, 1);
});

test('a result that arrives after the cap neither replaces the answer nor warns again', T, async () => {
  recordKills();
  const sdk = hungSdk({
    endsOn: 'interrupt',
    afterInterrupt: [{ type: 'result', subtype: 'success', result: 'tarde', num_turns: 3, session_id: 'sess-1' }],
  });
  const { evs, onEvent } = collect();
  const r = await run({ onEvent });

  assert.equal(sdk.interrupts, 1);
  assert.equal(r.resultText, 'respuesta', 'the sealed answer survives the interrupt\'s own result');
  assert.equal(r.ok, true);
  assert.equal(warnsOf(evs).length, 1);
});

test('a throwing or rejecting interrupt/close does not stop the ending', T, async () => {
  recordKills();
  const sdk = hungSdk({ endsOn: 'close' });
  const make = claudeHooks.query;
  claudeHooks.query = (args) => {
    const q = make(args);
    const close = q.close;
    q.interrupt = () => { throw new Error('no soportado'); };
    q.close = () => { close(); return Promise.reject(new Error('ya no estaba')); };
    return q;
  };
  const r = await run({ onEvent: () => {} });
  assert.equal(r.ok, true);
  assert.equal(sdk.closes, 1);
});

test('the installed SDK still calls onProcessSpawned (it is not in sdk.d.ts)', () => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
  let dir = dirname(entry);
  while (!existsSync(join(dir, 'sdk.mjs')) && dirname(dir) !== dir) dir = dirname(dir);
  const text = readFileSync(join(dir, 'sdk.mjs'), 'utf8');
  assert.ok(text.includes('onProcessSpawned'),
    'sdk.mjs lost onProcessSpawned: the grace path can no longer learn the CLI pid');
});
