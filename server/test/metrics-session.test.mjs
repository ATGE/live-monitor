// Session stats and spans: what `runClaude` and `ChatSession` report about the
// time, turns, tokens and cost of a session, and the spans `runClaude` writes
// when it is given `metrics`. No real session: `claudeHooks.query` is the seam.
import './isolate.mjs';   // first: `claude.js` reaches the data directory
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { runClaude, claudeHooks, statsOf } from '../src/claude.js';
import { begin, end } from '../src/metrics.js';

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

function fakeSdk(script) {
  const state = { sent: [], inputClosed: false };
  claudeHooks.query = ({ prompt }) => {
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

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const untilClosed = async (s) => {
  for (let i = 0; i < 500 && !s.inputClosed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
  return null;
};
const uuidOf = (s) => s.sent[0]?.uuid;
const init = (id = 'sess-s1') => ({ type: 'system', subtype: 'init', session_id: id, model: 'claude-haiku-4-5' });
const toolUse = (id, name) => ({
  type: 'assistant', session_id: 'sess-s1',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
});
const result = (uuid, over = {}) => ({
  type: 'result', subtype: 'success', result: 'HECHO', num_turns: 3, total_cost_usd: 0.5,
  session_id: 'sess-s1', user_message_uuid: uuid, user_message_uuids: [uuid],
  modelUsage: { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 7 } },
  ...over,
});
const run = (over = {}) => runClaude({ cwd: '/wt/x', model: 'haiku', prompt: 'haz algo', trackQuota: false, ...over });

test('runClaude returns stats: turns, subtype, cost, tokens and time', async () => {
  fakeSdk([tick, init, () => toolUse('t1', 'Bash'), (s) => result(uuidOf(s)), untilClosed]);
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.stats.turns, 3);
  assert.equal(r.stats.subtype, 'success');
  assert.equal(r.stats.costUsdTotal, 0.5);
  assert.equal(r.stats.costUsd, 0.5, 'a fresh session costs its whole total');
  assert.deepEqual(r.stats.tokens, { input: 10, output: 5, cacheRead: 100, cacheCreation: 7 });
  assert.equal(r.stats.resumed, false);
  assert.equal(r.stats.graceMs, 0);
  assert.ok(r.stats.ms >= 0);
});

test('stats come from the sealed result; cost from the latest, never summed', async () => {
  fakeSdk([
    tick, init,
    (s) => result(uuidOf(s), { total_cost_usd: 0.1, num_turns: 2 }),
    () => ({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9, total_cost_usd: 0.4, session_id: 'sess-s1', queued_turn_count: 0, errors: [] }),
    untilClosed,
  ]);
  claudeHooks.taskGraceMs = 50;
  const r = await run({ onEvent: () => {} });
  assert.equal(r.stats.subtype, 'success', 'a post-turn error_max_turns does not rewrite the phase turn');
  assert.equal(r.stats.turns, 2);
  assert.equal(r.stats.costUsdTotal, 0.4, 'the running total of the latest result');
});

test('a resumed session costs the delta against where it stopped; no baseline gives null', async () => {
  fakeSdk([tick, init('sess-delta'), (s) => result(uuidOf(s), { session_id: 'sess-delta', total_cost_usd: 1 }), untilClosed]);
  const first = await run();
  assert.equal(first.stats.costUsd, 1);

  fakeSdk([tick, init('sess-delta'), (s) => result(uuidOf(s), { session_id: 'sess-delta', total_cost_usd: 1.75 }), untilClosed]);
  const second = await run({ resume: 'sess-delta' });
  assert.equal(second.stats.resumed, true);
  assert.equal(second.stats.costUsdTotal, 1.75);
  assert.equal(second.stats.costUsd, 0.75);

  fakeSdk([tick, init('sess-unseen'), (s) => result(uuidOf(s), { session_id: 'sess-unseen', total_cost_usd: 9 }), untilClosed]);
  const unseen = await run({ resume: 'sess-unseen' });
  assert.equal(unseen.stats.costUsd, null);
  assert.equal(unseen.stats.costUsdTotal, 9);
});

test('a result with no cost or usage gives null, not NaN', async () => {
  fakeSdk([tick, init, (s) => ({ type: 'result', subtype: 'success', result: 'x', session_id: 'sess-s1', user_message_uuid: uuidOf(s), user_message_uuids: [uuidOf(s)] }), untilClosed]);
  const r = await run();
  assert.equal(r.stats.costUsd, null);
  assert.equal(r.stats.costUsdTotal, null);
  assert.equal(r.stats.tokens, null);
  assert.equal(r.stats.turns, null);
});

test('a session that died keeps its stats and flags it', async () => {
  fakeSdk([tick, init, () => { throw new Error('boom'); }]);
  const r = await run();
  assert.equal(r.ok, false);
  assert.equal(r.stats.subtype, null);
  assert.ok(r.stats.ms >= 0);
});

test('with `metrics`, runClaude writes a session span with role, model, counts and cost', async () => {
  fakeSdk([
    tick, init,
    () => toolUse('t1', 'Bash'), () => toolUse('t2', 'Agent'), () => toolUse('t3', 'Task'),
    (s) => result(uuidOf(s)), untilClosed,
  ]);
  const task = { timings: [], phase: 'fixing' };
  const r = await run({ effort: 'high', metrics: { task, role: 'fix', stage: 'fix:a' } });
  assert.equal(r.ok, true);
  assert.equal(task.timings.length, 1);
  const s = task.timings[0];
  assert.equal(s.kind, 'session');
  assert.equal(s.name, 'fix:a');
  assert.equal(s.outcome, 'ok');
  assert.equal(s.meta.role, 'fix');
  assert.equal(s.meta.model, 'haiku');
  assert.equal(s.meta.effort, 'high');
  assert.equal(s.meta.turns, 3);
  assert.equal(s.meta.subagents, 2);
  assert.deepEqual(s.meta.toolCounts, { Bash: 1, Agent: 1, Task: 1 });
  assert.equal(s.meta.costUsd, 0.5);
  assert.equal(s.meta.resumed, false);
});

test('a seal with subagents still out is flagged on the session span and said in the log', async () => {
  const events = [];
  fakeSdk([
    tick, init,
    () => ({ type: 'system', subtype: 'task_started', task_id: 'ag1', description: 'probe', task_type: 'local_agent', subagent_type: 'Explore' }),
    (s) => result(uuidOf(s), { result: 'the subagents are still working' }),
    () => ({ type: 'system', subtype: 'task_notification', task_id: 'ag1', status: 'completed', summary: 'listo' }),
    init,
    () => ({ type: 'result', subtype: 'success', result: 'THE PLAN', num_turns: 4, total_cost_usd: 0.6, session_id: 'sess-s1' }),
    untilClosed,
  ]);
  const task = { timings: [], phase: 'planning' };
  const r = await run({ onEvent: (e) => events.push(e), metrics: { task, role: 'plan', stage: 'plan' } });
  assert.equal(r.resultText, 'THE PLAN');
  const warns = events.filter((e) => e.kind === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0].warning, /plan/);
  assert.match(warns[0].warning, /1 subagent/);
  const meta = task.timings.find((t) => t.kind === 'session').meta;
  assert.equal(meta.sealedOpen, 1);
  assert.equal(meta.answerFrom, 'post', 'the view can tell a rescued session from one that kept the sealed sentence');
  assert.equal(meta.turns, 4, 'turns follow the adopted result');
});

test('a later turn adopted while the report was still to come is `unclosed` on the span, not rescued', async () => {
  claudeHooks.reportSettleMs = 30;   // no turn follows: do not wait the production 15 s
  fakeSdk([
    tick, init,
    () => ({ type: 'system', subtype: 'task_started', task_id: 'ag1', description: 'probe', task_type: 'local_agent', subagent_type: 'Explore' }),
    (s) => result(uuidOf(s), { result: 'the subagents are still working' }),
    init,
    () => ({ type: 'system', subtype: 'task_notification', task_id: 'ag1', status: 'completed', summary: 'listo' }),
    () => ({ type: 'result', subtype: 'success', result: 'maybe a waiting sentence', num_turns: 4, total_cost_usd: 0.6, session_id: 'sess-s1' }),
    untilClosed,
  ]);
  const task = { timings: [], phase: 'planning' };
  const r = await run({ metrics: { task, role: 'plan', stage: 'plan' } });
  assert.equal(r.resultText, 'maybe a waiting sentence');
  assert.equal(task.timings.find((t) => t.kind === 'session').meta.answerFrom, 'unclosed');
});

test('#36 C: an error result that closes the window after an unclosed turn is `error-closed` on the span', async () => {
  claudeHooks.reportSettleMs = 30;
  fakeSdk([
    tick, init,
    () => ({ type: 'system', subtype: 'task_started', task_id: 'ag1', description: 'probe', task_type: 'local_agent', subagent_type: 'Explore' }),
    (s) => result(uuidOf(s), { result: 'the subagents are still working' }),
    init,
    () => ({ type: 'system', subtype: 'task_notification', task_id: 'ag1', status: 'completed', summary: 'listo' }),
    () => ({ type: 'result', subtype: 'success', result: 'maybe a waiting sentence', num_turns: 4, total_cost_usd: 0.6, session_id: 'sess-s1' }),
    init,
    () => ({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 5, total_cost_usd: 0.7, session_id: 'sess-s1', queued_turn_count: 0, errors: [] }),
    untilClosed,
  ]);
  const task = { timings: [], phase: 'planning' };
  const r = await run({ metrics: { task, role: 'plan', stage: 'plan' } });
  assert.equal(r.resultText, 'maybe a waiting sentence');
  assert.equal(task.timings.find((t) => t.kind === 'session').meta.answerFrom, 'error-closed');
});

test('a normal session carries sealedOpen 0 on its span', async () => {
  fakeSdk([tick, init, (s) => result(uuidOf(s)), untilClosed]);
  const task = { timings: [], phase: 'fixing' };
  await run({ metrics: { task, role: 'fix', stage: 'fix' } });
  assert.equal(task.timings[0].meta.sealedOpen, 0);
  assert.equal(task.timings[0].meta.sealedEarly, 0);
  assert.equal(task.timings[0].meta.answerFrom, 'sealed');
});

test('without `metrics` no span is written and nothing breaks', async () => {
  fakeSdk([tick, init, (s) => result(uuidOf(s)), untilClosed]);
  const r = await run();
  assert.equal(r.ok, true);
});

test('hitting the turn cap is outcome max_turns on the span', async () => {
  fakeSdk([tick, init, (s) => result(uuidOf(s), { subtype: 'error_max_turns', is_error: true, result: undefined }), untilClosed]);
  const task = { timings: [] };
  const r = await run({ metrics: { task, role: 'fix', stage: 'fix' } });
  assert.equal(r.ok, false);
  assert.equal(r.stats.subtype, 'error_max_turns');
  assert.equal(task.timings[0].outcome, 'max_turns');
});

test('time held past the result for background work is a subagent_grace wait span', async () => {
  claudeHooks.taskGraceMs = 60;
  fakeSdk([
    tick, init,
    () => ({ type: 'system', subtype: 'task_started', task_id: 'bg1', description: 'probe', is_backgrounded: true }),
    (s) => result(uuidOf(s)),
    untilClosed,
  ]);
  const task = { timings: [], phase: 'fixing' };
  begin(task, { kind: 'phase', name: 'fixing' });
  const r = await run({ onEvent: () => {}, metrics: { task, role: 'fix', stage: 'fix' } });
  assert.ok(r.stats.graceMs >= 40, `graceMs ${r.stats.graceMs}`);
  const wait = task.timings.find((s) => s.kind === 'wait');
  assert.ok(wait, 'a wait span');
  assert.equal(wait.name, 'subagent_grace');
  assert.equal(wait.meta.within, 'fixing');
  assert.ok(wait.ms >= 40);
});

test('a grace wait with no phase span open is not inside any phase, even if task.phase is set', async () => {
  claudeHooks.taskGraceMs = 60;
  fakeSdk([
    tick, init,
    () => ({ type: 'system', subtype: 'task_started', task_id: 'bg2', description: 'probe', is_backgrounded: true }),
    (s) => result(uuidOf(s)),
    untilClosed,
  ]);
  const task = { timings: [], phase: 'fixing' };
  await run({ onEvent: () => {}, metrics: { task, role: 'reply', stage: 'cr' } });
  const wait = task.timings.find((s) => s.kind === 'wait');
  assert.equal(wait.meta.within, null);
  assert.equal(wait.meta.cycle, 1);
});

test('tokens are a delta on resume, like the cost; tokensTotal keeps the running total', async () => {
  const usage = (n) => ({ 'claude-haiku-4-5': { inputTokens: n, outputTokens: n * 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
  fakeSdk([tick, init('sess-tok'), (s) => result(uuidOf(s), { session_id: 'sess-tok', modelUsage: usage(10) }), untilClosed]);
  const first = await run();
  assert.deepEqual(first.stats.tokens, { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 });
  fakeSdk([tick, init('sess-tok'), (s) => result(uuidOf(s), { session_id: 'sess-tok', modelUsage: usage(25) }), untilClosed]);
  const second = await run({ resume: 'sess-tok' });
  assert.deepEqual(second.stats.tokens, { input: 15, output: 30, cacheRead: 0, cacheCreation: 0 });
  assert.deepEqual(second.stats.tokensTotal, { input: 25, output: 50, cacheRead: 0, cacheCreation: 0 });
  fakeSdk([tick, init('sess-tok-unseen'), (s) => result(uuidOf(s), { session_id: 'sess-tok-unseen', modelUsage: usage(5) }), untilClosed]);
  assert.equal((await run({ resume: 'sess-tok-unseen' })).stats.tokens, null);
});

test('a later turn of a live process is not reported as resumed but still costs the delta', () => {
  const a = statsOf({ sessionId: 'sess-live', costUsdTotal: 1, modelUsage: { m: { inputTokens: 4 } } }, { ms: 1 });
  assert.equal(a.costUsd, 1);
  const b = statsOf({ sessionId: 'sess-live', costUsdTotal: 1.5, modelUsage: { m: { inputTokens: 9 } } }, { ms: 1, resumed: false, resumedFrom: 'sess-live' });
  assert.equal(b.resumed, false);
  assert.equal(b.costUsd, 0.5);
  assert.equal(b.tokens.input, 5);
});

test('statsOf alone: tokens add up over models, and a missing session id writes no baseline', () => {
  const ctx = {
    costUsdTotal: 2, turns: 4, subtype: 'success',
    modelUsage: { a: { inputTokens: 1, outputTokens: 2 }, b: { inputTokens: 3, cacheReadInputTokens: 4 } },
  };
  const st = statsOf(ctx, { ms: 10 });
  assert.deepEqual(st.tokens, { input: 4, output: 2, cacheRead: 4, cacheCreation: 0 });
  assert.equal(st.costUsd, 2);
});

test('the session span records the phase open at its start, the uncapped call total and the nudge mark', async () => {
  fakeSdk([
    tick, init,
    () => toolUse('t1', 'Read'), () => toolUse('t2', 'Grep'), () => toolUse('t3', 'Agent'),
    (s) => result(uuidOf(s)), untilClosed,
  ]);
  const task = { timings: [] };
  const phase = begin(task, { kind: 'phase', name: 'triage' });
  await run({ metrics: { task, role: 'triage', stage: 'triage', nudge: true } });
  const s = task.timings.find((x) => x.kind === 'session');
  assert.equal(s.meta.within, 'triage');
  assert.equal(s.meta.toolCalls, 3);
  assert.equal(s.meta.nudge, true);
  assert.ok(phase);
});

test('meta.within is taken when the session starts, not when it ends', async () => {
  fakeSdk([
    tick, init,
    () => {
      // The phase closes while the session is still running.
      const open = task.timings.find((x) => x.kind === 'phase');
      end(task, open);
      return null;
    },
    (s) => result(uuidOf(s)), untilClosed,
  ]);
  const task = { timings: [] };
  begin(task, { kind: 'phase', name: 'fixing' });
  await run({ metrics: { task, role: 'fix', stage: 'fix' } });
  const s = task.timings.find((x) => x.kind === 'session');
  assert.equal(s.meta.within, 'fixing');
  assert.equal(s.meta.nudge, false);
});

test('a session outside any phase has within null, and toolCalls counts past the 30-kind cap', async () => {
  fakeSdk([
    tick, init,
    ...Array.from({ length: 35 }, (_, i) => () => toolUse(`k${i}`, `Tool${i}`)),
    (s) => result(uuidOf(s)), untilClosed,
  ]);
  const task = { timings: [], phase: 'fixing' };
  await run({ metrics: { task, role: 'reply', stage: 'cr' } });
  const s = task.timings[0];
  assert.equal(s.meta.within, null);
  assert.equal(Object.keys(s.meta.toolCounts).length, 30);
  assert.equal(s.meta.toolCalls, 35);
});
