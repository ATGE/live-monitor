import test from 'node:test';
import assert from 'node:assert/strict';
import { PARALLEL_SCOPE } from '../src/parallel.js';
import {
  NUDGE_DEFAULTS, nudgePolicy, shouldNudge, nudgePrompt, withNudge,
} from '../src/nudge.js';

const serial = { Read: 8, Grep: 4, Bash: 2 };
const parallel = { Read: 8, Grep: 4, Agent: 2 };

const okResult = (toolCounts, over = {}) => ({
  ok: true, quota: false, sessionId: 's-1', resultText: 'answer', toolCounts, stats: { subtype: 'success' }, ...over,
});

function rig({ first, second, name = 'triage', cfg, options = {}, before, held } = {}) {
  const task = { nudged: [] };
  const calls = [];
  const logs = [];
  let persisted = 0;
  const queue = [first, second];
  const run = async (o) => {
    calls.push(o);
    const r = queue.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  const go = () => withNudge({
    task, name, cfg, options: { prompt: 'p', maxTurns: 15, metrics: { task, role: 'triage', stage: 'triage' }, ...options },
    run, log: (m) => logs.push(m), persist: () => { persisted += 1; }, before, held,
  });
  return { task, calls, logs, go, persisted: () => persisted };
}

test('boundary: exactly minCalls pushes, one call fewer does not (M10)', async () => {
  const at = rig({ first: okResult({ Read: 12 }), second: okResult({ Agent: 2 }) });
  await at.go();
  assert.equal(at.calls.length, 2, '12 calls is the minimum: it pushes');
  const under = rig({ first: okResult({ Read: 11 }), second: okResult({ Agent: 2 }) });
  await under.go();
  assert.equal(under.calls.length, 1, '11 calls is under it');
});

test('the resumed call takes the policy cap, not the cap of the phase (M15)', async () => {
  const r = rig({ first: okResult(serial), second: okResult({ Agent: 2 }), options: { maxTurns: 40 } });
  await r.go();
  assert.equal(r.calls[0].maxTurns, 40);
  assert.equal(r.calls[1].maxTurns, NUDGE_DEFAULTS.maxTurns);
  assert.notEqual(r.calls[1].maxTurns, 40);
});

test('the resumed call is never a fork, whatever the first call asked (M16)', async () => {
  const r = rig({ first: okResult(serial), second: okResult({ Agent: 2 }), options: { forkSession: true } });
  await r.go();
  assert.equal(r.calls[0].forkSession, true);
  assert.equal(r.calls[1].forkSession, undefined);
  assert.ok('forkSession' in r.calls[1], 'the key is set to undefined, so the spread of options cannot bring it back');
});

test('policy: a cap that is not a positive integer falls to the next level (A4)', () => {
  for (const bad of [0, '15', -1, 2.5, null, NaN]) {
    const p = nudgePolicy('triage', { maxTurns: bad, minCalls: bad, minSubagents: bad }, undefined);
    assert.deepEqual(p, { minCalls: 12, minSubagents: 2, maxTurns: 15 }, String(bad));
  }
  const phase = nudgePolicy('triage', { maxTurns: 20, phases: { triage: { maxTurns: 0, minCalls: 7 } } }, undefined);
  assert.deepEqual(phase, { minCalls: 7, minSubagents: 2, maxTurns: 20 }, 'a bad phase value falls to the global one');
});

test('a quota hold stops the nudge before any paid turn and leaves the session unmarked (A5)', async () => {
  const r = rig({ first: okResult(serial), second: okResult({ Agent: 2 }), held: () => true });
  const out = await r.go();
  assert.equal(r.calls.length, 1);
  assert.equal(out.resultText, 'answer');
  assert.deepEqual(r.task.nudged, []);
  assert.equal(r.persisted(), 0);
  assert.match(r.logs.join('\n'), /quota pause/);
});

test('the adopted nudge reply carries the first answer as fallback, sealed text included', async () => {
  const r = rig({
    first: okResult(serial, { resultText: 'first answer', sealedText: 'sealed answer' }),
    second: okResult({ Agent: 2 }, { resultText: 'nothing to split' }),
  });
  const out = await r.go();
  assert.equal(out.resultText, 'nothing to split');
  assert.deepEqual(out.fallbackTexts, ['first answer', 'sealed answer']);
  const plain = rig({ first: okResult(serial), second: okResult({ Agent: 2 }, { resultText: 'x' }) });
  assert.deepEqual((await plain.go()).fallbackTexts, ['answer']);
});

test('the prompt never lets a one-line reply stand as the final answer', () => {
  const t = nudgePrompt({ calls: 14, subagents: 0 });
  assert.doesNotMatch(t, /dilo en una línea/);
  assert.match(t, /repitiendo tu respuesta final completa/);
  assert.match(t, /sin preámbulo/);
});

test('defaults: on for the read-only phases, off for the ones that write or resume the principal', () => {
  for (const n of ['triage', 'change-request', 'qa-plan', 'pr-body', 'demo']) assert.equal(NUDGE_DEFAULTS.phases[n], true, n);
  for (const n of ['fix-gaps', 'review-replies']) assert.equal(NUDGE_DEFAULTS.phases[n], false, n);
});

test('policy: exempt and edit templates are never nudged, even when the config forces them', () => {
  const forced = { phases: Object.fromEntries(Object.keys(PARALLEL_SCOPE).map((k) => [k, true])) };
  for (const [name, scope] of Object.entries(PARALLEL_SCOPE)) {
    if (scope === 'core') continue;
    assert.equal(nudgePolicy(name, forced), null, name);
  }
  assert.equal(nudgePolicy('close-issue', forced), null);
});

test('policy: global off, per-phase off and per-phase overrides', () => {
  assert.equal(nudgePolicy('triage', false), null);
  assert.equal(nudgePolicy('triage', { phases: { triage: false } }), null);
  assert.equal(nudgePolicy('fix-gaps', undefined), null);
  assert.deepEqual(nudgePolicy('fix-gaps', { phases: { 'fix-gaps': true } }), {
    minCalls: NUDGE_DEFAULTS.minCalls, minSubagents: NUDGE_DEFAULTS.minSubagents, maxTurns: NUDGE_DEFAULTS.maxTurns,
  });
  assert.equal(nudgePolicy('triage', { minCalls: 3, phases: { triage: { minCalls: 5 } } }).minCalls, 5);
  assert.equal(nudgePolicy('triage', { minCalls: 3 }).minCalls, 3);
  assert.equal(nudgePolicy('nope', undefined), null);
});

test('policy: a call whose tools lack Agent/Task is never nudged', () => {
  assert.equal(nudgePolicy('triage', undefined, ['Read', 'Grep']), null);
  assert.ok(nudgePolicy('triage', undefined, ['Read', 'Agent']));
  assert.ok(nudgePolicy('triage', undefined, undefined));
});

test('shouldNudge: serial and plenty of calls', () => {
  const policy = nudgePolicy('triage');
  assert.equal(shouldNudge(okResult(serial), policy, []), true);
  assert.equal(shouldNudge(okResult(parallel), policy, []), false);
  assert.equal(shouldNudge(okResult({ Read: 3 }), policy, []), false, 'too few calls');
  assert.equal(shouldNudge(okResult(serial), null, []), false);
});

test('shouldNudge: never after quota, error, max_turns, missing session or a repeat', () => {
  const policy = nudgePolicy('triage');
  assert.equal(shouldNudge(okResult(serial, { quota: true }), policy, []), false);
  assert.equal(shouldNudge(okResult(serial, { ok: false }), policy, []), false);
  assert.equal(shouldNudge(okResult(serial, { stats: { subtype: 'error_max_turns' } }), policy, []), false);
  assert.equal(shouldNudge(okResult(serial, { sessionId: null }), policy, []), false);
  assert.equal(shouldNudge(okResult(serial), policy, ['s-1']), false);
});

test('nudgePrompt: Spanish, asks for subagents in one message and the full answer again', () => {
  const t = nudgePrompt({ calls: 14, subagents: 0 });
  assert.match(t, /14/);
  assert.match(t, /subagente/);
  assert.match(t, /mismo mensaje/);
});

test('a serial session triggers exactly one nudge, resuming the same session', async () => {
  const r = rig({ first: okResult(serial), second: okResult({ Agent: 3, Read: 2 }, { resultText: 'better' }) });
  const out = await r.go();
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].resume, 's-1');
  assert.equal(r.calls[1].maxTurns, NUDGE_DEFAULTS.maxTurns);
  assert.equal(r.calls[1].metrics.nudge, true);
  assert.equal(r.calls[1].prompt, nudgePrompt({ calls: 14, subagents: 0 }));
  assert.equal(out.nudged, true);
  assert.equal(out.resultText, 'better');
  assert.equal(out.sessionId, 's-1');
  assert.deepEqual(out.toolCounts, { Read: 10, Grep: 4, Bash: 2, Agent: 3 });
  assert.equal(r.logs.length, 2, 'one line when it is asked, one with the outcome');
  assert.match(r.logs[0], /triage/);
});

test('after a useful nudge the stats cover both calls: ms, turns and cost summed, subtype of the last', async () => {
  const r = rig({
    first: okResult(serial, { stats: { subtype: 'success', ms: 1000, turns: 5, costUsd: 0.5 } }),
    second: okResult({ Agent: 2 }, { stats: { subtype: 'success', ms: 400, turns: 3, costUsd: 0.25, answerFrom: 'post' } }),
  });
  const out = await r.go();
  assert.equal(out.stats.ms, 1400);
  assert.equal(out.stats.turns, 8);
  assert.equal(out.stats.costUsd, 0.75);
  assert.equal(out.stats.subtype, 'success');
  assert.equal(out.stats.answerFrom, 'post');
  const nulls = rig({ first: okResult(serial, { stats: { subtype: 'success' } }), second: okResult({ Agent: 2 }, { stats: { subtype: 'success' } }) });
  const o2 = await nulls.go();
  assert.equal(o2.stats.turns ?? null, null, 'unknown stays unknown');
});

test('a parallel session triggers none', async () => {
  const r = rig({ first: okResult(parallel) });
  const out = await r.go();
  assert.equal(r.calls.length, 1);
  assert.equal(out.nudged, undefined);
});

test('a nudge never repeats for the same session, even across calls', async () => {
  const r = rig({ first: okResult(serial), second: okResult(parallel) });
  await r.go();
  assert.deepEqual(r.task.nudged, ['s-1']);
  const again = await withNudge({
    task: r.task, name: 'triage', options: { prompt: 'p' }, run: async (o) => { r.calls.push(o); return okResult(serial); },
    log() {}, persist() {},
  });
  assert.equal(r.calls.length, 3, 'only the one plain call of the second pass');
  assert.equal(again.nudged, undefined);
});

test('a refused before() leaves the session unmarked and unpersisted, and says so in the log', async () => {
  const r = rig({
    first: okResult(serial), second: okResult({ Agent: 2 }),
    before: () => { throw new Error('el chat principal tiene un turno en curso'); },
  });
  const out = await r.go();
  assert.equal(r.calls.length, 1, 'no resume ran');
  assert.deepEqual(r.task.nudged, []);
  assert.equal(r.persisted(), 0);
  assert.equal(out.nudged, 'kept');
  assert.equal(out.nudgeReason, 'refused');
  assert.equal(out.resultText, 'answer');
  assert.match(r.logs.join('\n'), /nudge refused \(el chat principal tiene un turno en curso\)/);
  // The same session can be nudged on a later pass, once the owner is free.
  const later = rig({ first: okResult(serial), second: okResult({ Agent: 2 }) });
  later.task.nudged = r.task.nudged;
  assert.equal((await later.go()).nudged, true);
});

test('refused, held, thrown, error, quota and empty nudges leave distinct log lines and reasons', async () => {
  const seen = new Map();
  const refused = rig({ first: okResult(serial), before: () => { throw new Error('busy'); } });
  const held = rig({ first: okResult(serial), held: () => true });
  const cases = [
    ['refused', refused, /nudge refused/],
    ['held', held, /quota pause/],
    ['threw', rig({ first: okResult(serial), second: new Error('boom') }), /nudge resume threw \(boom\)/],
    ['error', rig({ first: okResult(serial), second: okResult({}, { ok: false }) }), /ended with an error/],
    ['quota', rig({ first: okResult(serial), second: okResult({}, { quota: true }) }), /hit the quota/],
    ['empty', rig({ first: okResult(serial), second: okResult({}, { resultText: ' ' }) }), /returned an empty answer/],
  ];
  for (const [reason, r, line] of cases) {
    const out = await r.go();
    const last = r.logs.at(-1);
    assert.match(last, line, reason);
    assert.equal(out.nudgeReason, reason === 'held' ? undefined : reason, reason);
    assert.ok(!seen.has(last), `${reason} shares its log line with ${seen.get(last)}`);
    seen.set(last, reason);
  }
});

test('the session id is persisted after before() and before the resume runs', async () => {
  const order = [];
  const task = { nudged: [] };
  let n = 0;
  await withNudge({
    task, name: 'triage', options: { prompt: 'p' },
    run: async () => { n += 1; if (n === 2) order.push(`run2:${task.nudged.join()}`); return okResult(serial); },
    log() {}, persist: () => order.push('persist'), before: () => order.push('before'),
  });
  assert.deepEqual(order, ['before', 'persist', 'run2:s-1']);
});

test('close-issue is never nudged, nor a call with tools lacking Agent', async () => {
  const a = rig({ first: okResult(serial), name: 'close-issue', cfg: { phases: { 'close-issue': true } } });
  await a.go();
  assert.equal(a.calls.length, 1);
  const b = rig({ first: okResult(serial), options: { tools: ['Read', 'Grep'] } });
  await b.go();
  assert.equal(b.calls.length, 1);
});

test('nudge: false and a phase switched off', async () => {
  const a = rig({ first: okResult(serial), cfg: false });
  await a.go();
  assert.equal(a.calls.length, 1);
  const b = rig({ first: okResult(serial), cfg: { phases: { triage: false } } });
  await b.go();
  assert.equal(b.calls.length, 1);
});

test('no nudge after quota, error or max_turns', async () => {
  for (const over of [{ quota: true }, { ok: false }, { stats: { subtype: 'error_max_turns' } }]) {
    const r = rig({ first: okResult(serial, over) });
    await r.go();
    assert.equal(r.calls.length, 1, JSON.stringify(over));
  }
});

test('a failed, throwing, quota-hit or empty nudge keeps the original result', async () => {
  const original = okResult(serial);
  for (const second of [okResult({}, { ok: false }), new Error('boom'), okResult({}, { quota: true }), okResult({}, { resultText: '  ' })]) {
    const r = rig({ first: original, second });
    const out = await r.go();
    assert.equal(r.calls.length, 2);
    assert.equal(out.resultText, 'answer');
    assert.equal(out.nudged, 'kept');
    assert.deepEqual(out.toolCounts, serial);
  }
});

test('replaced texts of the first session travel as fallbacks, between the adopted and the sealed one', async () => {
  const r = rig({
    first: okResult(serial, { resultText: 'ack', replacedTexts: ['good'], sealedText: 'sealed' }),
    second: okResult({ Agent: 2 }, { resultText: 'nothing to split' }),
  });
  assert.deepEqual((await r.go()).fallbackTexts, ['ack', 'good', 'sealed']);
});
