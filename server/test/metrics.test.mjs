import { DATA_DIR } from './isolate.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  MAX_SPANS, metricsHooks, begin, end, span, record, closeOrphans, summarize, aggregate, percentile, median, migrateCycles, openPhaseOf,
} from '../src/metrics.js';
import { beginBoardSpan, endBoardSpan, closeOpenBoardSpans, boardSpans, MAX_BOARD_SPANS } from '../src/boardtimings.js';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
let clock;
let persisted;
const tick = (ms) => { clock += ms; };

beforeEach(() => {
  clock = T0;
  persisted = 0;
  metricsHooks.now = () => clock;
  metricsHooks.persist = () => { persisted += 1; };
});
afterEach(() => {
  metricsHooks.now = () => Date.now();
  metricsHooks.persist = () => {};
});

test('begin stores an open span at once and end closes it with its length', () => {
  const task = {};
  const s = begin(task, { kind: 'phase', name: 'triage' });
  assert.equal(task.timings.length, 1);
  assert.equal(s.endedAt, null);
  assert.equal(s.outcome, null);
  assert.deepEqual(s.meta, { cycle: 1 });
  assert.equal(s.attempt, 1);
  assert.ok(persisted >= 1);
  tick(1500);
  end(task, s, { outcome: 'ok', extra: 1 });
  assert.equal(s.ms, 1500);
  assert.equal(s.endedAt, new Date(T0 + 1500).toISOString());
  assert.equal(s.outcome, 'ok');
  assert.deepEqual(s.meta, { cycle: 1, extra: 1 });
});

test('span records ok, and rethrows the very same error after recording it', async () => {
  const task = {};
  const v = await span(task, { kind: 'step', name: 'a' }, async () => { tick(10); return 42; });
  assert.equal(v, 42);
  assert.equal(task.timings[0].outcome, 'ok');
  assert.equal(task.timings[0].ms, 10);
  const boom = new Error('boom');
  await assert.rejects(span(task, { kind: 'step', name: 'b' }, () => { tick(5); throw boom; }), (e) => e === boom);
  assert.equal(task.timings[1].outcome, 'error');
  assert.equal(task.timings[1].meta.error, 'boom');
  assert.equal(task.timings[1].ms, 5);
});

test('the recorder never throws, even with a broken persist hook or bad input', async () => {
  metricsHooks.persist = () => { throw new Error('disk'); };
  const task = {};
  assert.doesNotThrow(() => begin(task, { kind: 'phase', name: 'x' }));
  assert.equal(begin(null, { kind: 'phase', name: 'x' }), null);
  assert.equal(begin(task, { kind: 'nope', name: 'x' }), null);
  assert.equal(begin(task, { kind: 'phase' }), null);
  assert.doesNotThrow(() => end(task, null));
  assert.equal(record(task, { kind: 'wait', name: 'w', startedAt: 'x', endedAt: 'y' }), null);
  assert.equal(await span(task, { kind: 'step', name: 'ok' }, () => 7), 7);
});

test('record stores a complete span', () => {
  const task = {};
  const s = record(task, { kind: 'wait', name: 'quota_park', startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 9000).toISOString(), meta: { within: null } });
  assert.equal(s.ms, 9000);
  assert.equal(s.outcome, 'ok');
  assert.equal(task.timings.length, 1);
});

test('closeOrphans closes open spans as interrupted at the given time, once', () => {
  const task = {};
  begin(task, { kind: 'phase', name: 'fixing' });
  const done = begin(task, { kind: 'step', name: 'x' });
  tick(100);
  end(task, done);
  const at = new Date(T0 + 4000).toISOString();
  assert.equal(closeOrphans(task, at), 1);
  assert.equal(task.timings[0].outcome, 'interrupted');
  assert.equal(task.timings[0].ms, 4000);
  assert.equal(task.timings[1].outcome, 'ok');
  assert.equal(closeOrphans(task, at), 0);
  assert.equal(closeOrphans({}, at), 0);
});

test('the cap evicts closed sessions and steps first, never phases, and counts what it dropped', () => {
  const task = {};
  const phases = ['worktree', 'triage', 'fixing', 'testing'];
  for (const name of phases) {
    const p = begin(task, { kind: 'phase', name });
    tick(10);
    end(task, p);
  }
  for (let i = 0; i < MAX_SPANS + 50; i += 1) {
    const s = begin(task, { kind: i % 2 ? 'session' : 'step', name: `s${i}` });
    tick(2);
    end(task, s);
  }
  assert.equal(task.timings.length, MAX_SPANS);
  assert.deepEqual(task.timings.filter((s) => s.kind === 'phase').map((s) => s.name), phases);
  assert.equal(task.timingsDropped.n, 54);
  assert.equal(task.timingsDropped.ms, 54 * 2);
  assert.equal(task.timings.at(-1).name, `s${MAX_SPANS + 49}`);
});

test('an open span is never evicted', () => {
  const task = {};
  const open = begin(task, { kind: 'session', name: 'live' });
  for (let i = 0; i < MAX_SPANS + 5; i += 1) end(task, begin(task, { kind: 'step', name: `s${i}` }));
  assert.ok(task.timings.includes(open));
  assert.equal(task.timings.length, MAX_SPANS);
});

function finishedTask() {
  const task = { createdAt: new Date(T0).toISOString(), doneAt: new Date(T0 + 100_000).toISOString() };
  const run = (kind, name, startMs, lenMs, meta) => record(task, {
    kind, name, startedAt: new Date(T0 + startMs).toISOString(), endedAt: new Date(T0 + startMs + lenMs).toISOString(), meta,
  });
  run('phase', 'triage', 0, 10_000);
  run('phase', 'testing', 10_000, 40_000);
  run('wait', 'e2e_gate', 12_000, 15_000, { within: 'testing' });
  run('session', 'triage', 1_000, 8_000, {});
  run('wait', 'quota_park', 50_000, 30_000, { within: null });
  run('phase', 'pr', 80_000, 10_000);
  return task;
}

test('summarize: wall, run, wait and active time, with sessions left out of the sums', () => {
  const s = summarize(finishedTask());
  assert.equal(s.wallMs, 100_000);
  assert.equal(s.runMs, 60_000);
  assert.equal(s.waitMs, 45_000);
  assert.equal(s.activeMs, 45_000);
  assert.deepEqual(s.byPhase.testing, { n: 1, ms: 40_000 });
  assert.deepEqual(s.byWait.quota_park, { n: 1, ms: 30_000 });
  assert.equal(s.dropped, null);
});

test('summarize: a task without timings, or still running, answers without error', () => {
  const none = summarize({ createdAt: new Date(T0).toISOString() });
  assert.equal(none.runMs, 0);
  assert.equal(none.activeMs, 0);
  assert.deepEqual(none.byPhase, {});
  const running = { createdAt: new Date(T0).toISOString() };
  begin(running, { kind: 'phase', name: 'fixing' });
  tick(7000);
  const s = summarize(running);
  assert.equal(s.runMs, 7000);
  assert.equal(s.wallMs, 7000);
  assert.equal(summarize(undefined).wallMs, null);
});

test('percentile (nearest rank) and median', () => {
  const v = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10];
  assert.equal(percentile(v, 0.9), 9);
  assert.equal(percentile(v, 1), 10);
  assert.equal(percentile([4], 0.9), 4);
  assert.equal(percentile([], 0.9), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test('aggregate: median and p90 per phase and per wait, and the share of wall time spent waiting', () => {
  const tasks = [];
  for (let i = 1; i <= 10; i += 1) {
    const t = { createdAt: new Date(T0).toISOString(), doneAt: new Date(T0 + 1000 * 100).toISOString() };
    record(t, { kind: 'phase', name: 'fixing', startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + i * 1000).toISOString() });
    if (i <= 2) record(t, { kind: 'wait', name: 'slot', startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 10_000).toISOString(), meta: { within: null } });
    tasks.push(t);
  }
  tasks.push({ createdAt: new Date(T0).toISOString() }, { timings: [] });
  const a = aggregate(tasks);
  assert.equal(a.tasks, 10);
  assert.deepEqual(a.phases.fixing, { n: 10, median: 5500, p90: 9000, totalMs: 55_000 });
  assert.deepEqual(a.waits.slot, { n: 2, median: 10_000, p90: 10_000, totalMs: 20_000 });
  assert.equal(a.wallMs, 1_000_000);
  assert.equal(a.waitShare, 0.02);
  const empty = aggregate([]);
  assert.equal(empty.waitShare, null);
  assert.deepEqual(empty.phases, {});
});

test('aggregate: counts the sessions sealed with subagents still out', () => {
  const task = { createdAt: new Date(T0).toISOString() };
  const at0 = new Date(T0).toISOString();
  const at1 = new Date(T0 + 1000).toISOString();
  record(task, { kind: 'session', name: 'plan', startedAt: at0, endedAt: at1, meta: { sealedOpen: 2 } });
  record(task, { kind: 'session', name: 'pr', startedAt: at0, endedAt: at1, meta: { sealedOpen: 0 } });
  record(task, { kind: 'session', name: 'fix', startedAt: at0, endedAt: at1, meta: {} });
  assert.equal(aggregate([task]).sealedOpen, 1);
  assert.equal(aggregate([]).sealedOpen, 0);
});

test('aggregate: counts sessions that took the later answer and those that kept the sealed one', () => {
  const task = { createdAt: new Date(T0).toISOString() };
  const at0 = new Date(T0).toISOString();
  const at1 = new Date(T0 + 1000).toISOString();
  const session = (name, meta) => record(task, { kind: 'session', name, startedAt: at0, endedAt: at1, meta });
  session('plan', { sealedOpen: 1, answerFrom: 'post' });
  session('fix', { sealedOpen: 0, sealedEarly: 1, answerFrom: 'post' });
  session('qa', { sealedOpen: 2, answerFrom: 'sealed' });
  session('pr', { sealedOpen: 0, sealedEarly: 1, answerFrom: 'sealed' });
  session('demo', { sealedOpen: 0, sealedEarly: 0, answerFrom: 'sealed' });
  session('old', {});
  session('pre-net', { sealedOpen: 1 });   // written before answerFrom existed: unknown, not kept
  const a = aggregate([task]);
  assert.equal(a.sealedRescued, 2);
  assert.equal(a.sealedKept, 2);
  assert.equal(aggregate([]).sealedRescued, 0);
  assert.equal(aggregate([]).sealedKept, 0);
});

test('aggregate: an unclosed session is neither rescued nor kept, and the debt count covers every owing session', () => {
  const task = { createdAt: new Date(T0).toISOString() };
  const at0 = new Date(T0).toISOString();
  const at1 = new Date(T0 + 1000).toISOString();
  const session = (name, meta) => record(task, { kind: 'session', name, startedAt: at0, endedAt: at1, meta });
  session('plan', { sealedOpen: 1, answerFrom: 'unclosed' });
  session('fix', { sealedOpen: 0, sealedEarly: 1, answerFrom: 'post' });
  session('qa', { sealedOpen: 2, answerFrom: 'sealed' });
  session('pr', { sealedOpen: 0, sealedEarly: 1, answerFrom: 'sealed' });
  session('demo', { sealedOpen: 0, sealedEarly: 0, answerFrom: 'sealed' });
  session('old', {});
  session('pre-net', { sealedOpen: 1 });
  const a = aggregate([task]);
  assert.equal(a.sealedUnclosed, 1);
  assert.equal(a.sealedRescued, 1);
  assert.equal(a.sealedKept, 2);
  assert.equal(a.sealedDebt, 5, 'plan, fix, qa, pr and pre-net owed a later answer');
  assert.equal(aggregate([]).sealedUnclosed, 0);
  assert.equal(aggregate([]).sealedDebt, 0);
});

test('aggregate: a window closed by an error result is its own count, not unclosed, rescued or kept', () => {
  const task = { createdAt: new Date(T0).toISOString() };
  const at0 = new Date(T0).toISOString();
  const at1 = new Date(T0 + 1000).toISOString();
  const session = (name, meta) => record(task, { kind: 'session', name, startedAt: at0, endedAt: at1, meta });
  session('plan', { sealedOpen: 1, answerFrom: 'error-closed' });
  session('fix', { sealedOpen: 0, sealedEarly: 1, answerFrom: 'error-closed' });
  session('qa', { sealedOpen: 1, answerFrom: 'unclosed' });
  session('pr', { sealedOpen: 1, answerFrom: 'post' });
  const a = aggregate([task]);
  assert.equal(a.sealedErrorClosed, 2);
  assert.equal(a.sealedUnclosed, 1);
  assert.equal(a.sealedRescued, 1);
  assert.equal(a.sealedKept, 0);
  assert.equal(a.sealedDebt, 4);
  assert.equal(aggregate([]).sealedErrorClosed, 0);
});

test('board spans: begin, end, close the orphans of a dead process, and cap', () => {
  const file = path.join(DATA_DIR, 'boardtimings.json');
  rmSync(file, { force: true });
  assert.deepEqual(boardSpans(), []);
  const a = beginBoardSpan({ name: 'restart', why: 'test' });
  const b = beginBoardSpan({ name: 'upgrade' });
  assert.ok(existsSync(file));
  assert.equal(endBoardSpan(b, { outcome: 'error', note: 'x' }), true);
  assert.equal(endBoardSpan(b), false);
  assert.equal(boardSpans().find((s) => s.id === b).outcome, 'error');
  assert.equal(closeOpenBoardSpans(new Date(Date.now() + 1000).toISOString(), { name: 'restart', outcome: 'ok' }), 1);
  const r = boardSpans().find((s) => s.id === a);
  assert.equal(r.outcome, 'ok');
  assert.ok(r.ms >= 0);
  assert.equal(r.meta.why, 'test');
  assert.equal(beginBoardSpan({}), null);
  for (let i = 0; i < MAX_BOARD_SPANS + 10; i += 1) beginBoardSpan({ name: `n${i}` });
  assert.equal(boardSpans().length, MAX_BOARD_SPANS);
  assert.equal(closeOpenBoardSpans(), MAX_BOARD_SPANS);
  assert.ok(boardSpans().every((s) => s.outcome != null));
  rmSync(file, { force: true });
});

// A reopened task: cycle 1 ran 60 min, cycle 2 has run 10 min (the clock is at T0 + 10 min after it).
const MIN = 60_000;
const at = (ms) => new Date(T0 + ms).toISOString();

test('summarize: a reopened task reports its current cycle; the whole life is under `life`', () => {
  const task = { createdAt: at(-120 * MIN) };
  record(task, { kind: 'phase', name: 'fixing', startedAt: at(-120 * MIN), endedAt: at(-60 * MIN) });
  Object.assign(task, { metricsCycle: 2, metricsCycleStartedAt: at(0) });   // what beginNewCycle does
  tick(10 * MIN);
  record(task, { kind: 'phase', name: 'fixing', startedAt: at(0), endedAt: at(10 * MIN) });
  const s = summarize(task);
  assert.equal(s.cycle, 2);
  assert.equal(s.wallMs, 10 * MIN);
  assert.equal(s.runMs, 10 * MIN);
  assert.equal(s.activeMs, 10 * MIN);
  assert.deepEqual(s.byPhase.fixing, { n: 1, ms: 10 * MIN });
  assert.equal(s.life.runMs, 70 * MIN);
  assert.ok(s.life.wallMs >= s.life.runMs);
  assert.ok(s.wallMs >= s.runMs && s.runMs >= s.activeMs);
});

test('summarize: 2 h of wait in cycle 1 does not pass the 10 min wall of cycle 2', () => {
  const task = { createdAt: at(-180 * MIN) };
  record(task, { kind: 'wait', name: 'quota_park', startedAt: at(-170 * MIN), endedAt: at(-50 * MIN), meta: { within: null } });
  Object.assign(task, { metricsCycle: 2, metricsCycleStartedAt: at(0) });
  tick(10 * MIN);
  const s = summarize(task);
  assert.equal(s.waitMs, 0);
  assert.equal(aggregate([task]).waitShare, 0);
  assert.equal(s.life.waitMs, 120 * MIN);
});

test('summarize: a grace wait outside any phase does not reduce activeMs', () => {
  const task = { createdAt: at(0) };
  record(task, { kind: 'phase', name: 'fixing', startedAt: at(0), endedAt: at(30 * MIN) });
  record(task, { kind: 'wait', name: 'subagent_grace', startedAt: at(40 * MIN), endedAt: at(50 * MIN), meta: { within: null } });
  tick(60 * MIN);
  const s = summarize(task);
  assert.equal(s.runMs, 30 * MIN);
  assert.equal(s.activeMs, 30 * MIN);
});

test('summarize: waits that overlap count once, so the wait share cannot pass 100 %', () => {
  const task = { createdAt: at(0), doneAt: at(10 * MIN) };
  record(task, { kind: 'wait', name: 'subagent_grace', startedAt: at(0), endedAt: at(8 * MIN), meta: { within: null } });
  record(task, { kind: 'wait', name: 'subagent_grace', startedAt: at(2 * MIN), endedAt: at(10 * MIN), meta: { within: null } });
  const s = summarize(task);
  assert.equal(s.waitMs, 10 * MIN);
  assert.equal(aggregate([task]).waitShare, 1);
});

test('span stamps the durable cycle itself, whatever the caller passes', () => {
  const task = { metricsCycle: 3 };
  const a = begin(task, { kind: 'step', name: 'x', cycle: '2026-01-01T00:00:00.000Z' });
  const b = record(task, { kind: 'wait', name: 'slot', startedAt: at(0), endedAt: at(1), meta: { cycle: null } });
  assert.equal(a.meta.cycle, 3);
  assert.equal(b.meta.cycle, 3);
  assert.equal(begin({}, { kind: 'step', name: 'y' }).meta.cycle, 1);
});

test('migrateCycles numbers old spans by their ISO boundaries; a null after the PR is not cycle 1', () => {
  const sp = (kind, name, start, cycle, extra = {}) => ({ kind, name, startedAt: start, endedAt: start, ms: 0, attempt: 1, outcome: 'ok', meta: { cycle, ...extra } });
  const c2 = '2026-01-02T00:00:00.000Z';
  const task = {
    cycleStartedAt: null,
    timings: [
      sp('phase', 'fixing', '2026-01-01T01:00:00.000Z', null),
      sp('phase', 'fixing', '2026-01-02T01:00:00.000Z', c2),
      sp('phase', 'demo', '2026-01-02T05:00:00.000Z', null),
    ],
  };
  assert.equal(migrateCycles(task), true);
  assert.deepEqual(task.timings.map((s) => s.meta.cycle), [1, 2, 2]);
  assert.equal(task.metricsCycle, 2);
  assert.equal(task.metricsCycleStartedAt, c2);
  assert.equal(migrateCycles(task), false, 'idempotent');
  const none = { timings: [sp('phase', 'triage', '2026-01-01T00:00:00.000Z', null)] };
  migrateCycles(none);
  assert.equal(none.metricsCycle, 1);
  assert.equal(none.metricsCycleStartedAt, null);
});

test('migrateCycles gives an old grace wait the phase that held it, or null', () => {
  const ph = { kind: 'phase', name: 'fixing', startedAt: at(0), endedAt: at(30 * MIN), ms: 30 * MIN, attempt: 1, outcome: 'ok', meta: {} };
  const g = (start) => ({ kind: 'wait', name: 'subagent_grace', startedAt: start, endedAt: start, ms: 0, attempt: 1, outcome: 'ok', meta: { within: 'cr', cycle: null } });
  const task = { timings: [ph, g(at(10 * MIN)), g(at(40 * MIN))] };
  migrateCycles(task);
  assert.equal(task.timings[1].meta.within, 'fixing');
  assert.equal(task.timings[2].meta.within, null);
});

test('span closes a throwing step with the outcome the hook names', async () => {
  const task = {};
  metricsHooks.outcomeOfError = (e) => (e.quota ? 'parked' : 'error');
  try {
    await assert.rejects(span(task, { kind: 'step', name: 'a' }, async () => { throw Object.assign(new Error('q'), { quota: true }); }));
    await assert.rejects(span(task, { kind: 'step', name: 'b' }, async () => { throw new Error('x'); }));
  } finally {
    metricsHooks.outcomeOfError = () => 'error';
  }
  assert.deepEqual(task.timings.map((s) => s.outcome), ['parked', 'error']);
});

test('openPhaseOf names the open phase, or null', () => {
  const task = {};
  assert.equal(openPhaseOf(task), null);
  const p = begin(task, { kind: 'phase', name: 'testing' });
  assert.equal(openPhaseOf(task), 'testing');
  end(task, p);
  assert.equal(openPhaseOf(task), null);
});
