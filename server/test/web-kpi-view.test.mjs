import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const kpi = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../web/src/kpiView.js')).href);

test('openBucket: priority error > waiting > running > review > queued', () => {
  assert.equal(kpi.openBucket({ state: 'done' }), null);
  assert.equal(kpi.openBucket({ state: 'fixing', awaitingYou: ['pregunta'] }), 'waiting');
  assert.equal(kpi.openBucket({ state: 'error', awaitingYou: ['pregunta'] }), 'error');
  assert.equal(kpi.openBucket({ state: 'fixing' }), 'running');
  assert.equal(kpi.openBucket({ state: 'plan_ready' }), 'review');
  assert.equal(kpi.openBucket({ state: 'plan_ready', awaitingYou: ['plan'] }), 'waiting');
  assert.equal(kpi.openBucket({ state: 'pr_draft' }), 'review');
  assert.equal(kpi.openBucket({ state: 'assigned', mode: 'manual' }), 'queued');
  assert.equal(kpi.openBucket({ state: 'started' }), 'queued');
});

test('openByState: segments only for n > 0, zero lists the rest', () => {
  const r = kpi.openByState([
    { state: 'fixing' }, { state: 'testing' }, { state: 'assigned' }, { state: 'done' }, { state: 'error' },
  ]);
  assert.equal(r.total, 4);
  assert.deepEqual(r.segments.map((s) => [s.key, s.n]), [['running', 2], ['queued', 1], ['error', 1]]);
  assert.deepEqual(r.zero, ['waiting', 'review']);
  assert.equal(r.segments[0].label, 'en curso');
  assert.equal(kpi.openByState([]).total, 0);
});

test('agentsSummary sums running counters and tolerates running: null', () => {
  const r = kpi.agentsSummary([
    { running: { agents: { total: 9, done: 5, running: 2 }, commands: 2, servers: 1 } },
    { running: null },
    { running: { agents: { total: 1, done: 0, running: 0 }, commands: 0, servers: 0 } },
    {},
  ]);
  assert.deepEqual(r, { running: 2, done: 5, total: 10, pending: 3, commands: 2, servers: 1 });
  assert.equal(kpi.agentsSummary([{ running: { agents: { total: 1, done: 3, running: 1 } } }]).pending, 0);
});

test('quotaPace: session at 68 %, 2 h 14 min to reopen', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const resetsAt = now + (2 * 60 + 14) * 60e3;
  const p = kpi.quotaPace({ group: 'session', percent: 68, resetsAt }, now);
  assert.equal(p.windowMs, kpi.SESSION_MS);
  assert.equal(p.startAt, resetsAt - kpi.SESSION_MS);
  assert.ok(Math.abs(p.elapsedH - (5 - 134 / 60)) < 1e-9);
  assert.ok(Math.abs(p.leftH - 134 / 60) < 1e-9);
  assert.ok(Math.abs(p.ratePerHour - 68 / p.elapsedH) < 1e-9);
  assert.ok(Math.abs(p.budgetPerHour - 32 / p.leftH) < 1e-9);
  // 100 / 24.58 per h = 4.07 h after the start: before the reset.
  assert.ok(p.exhaustAt < resetsAt && p.exhaustAt > now);
});

test('quotaPace: weekly at 42 % never runs out before the reset; null cases', () => {
  const resetsAt = Date.UTC(2026, 9, 15, 9, 0, 0);
  const now = resetsAt - kpi.WEEK_MS / 2;
  const p = kpi.quotaPace({ group: 'weekly', percent: 42, resetsAt }, now);
  assert.equal(p.windowMs, kpi.WEEK_MS);
  assert.ok(Math.abs(p.ratePerHour - 0.5) < 1e-9);
  assert.ok(Math.abs(p.budgetPerHour - 58 / 84) < 1e-9);
  assert.equal(p.exhaustAt, null); // 200 h > 168 h
  assert.equal(kpi.quotaPace({ group: 'weekly', percent: 42, resetsAt: null }, now), null);
  assert.equal(kpi.quotaPace(null, now), null);
  // Window just opened: no rate yet.
  const fresh = kpi.quotaPace({ group: 'session', percent: 3, resetsAt: now + kpi.SESSION_MS - 60e3 }, now);
  assert.equal(fresh.ratePerHour, null);
  assert.equal(fresh.exhaustAt, null);
});

test('paceTrusted', () => {
  assert.equal(kpi.paceTrusted(null), false);
  assert.equal(kpi.paceTrusted({ stale: true, source: 'usage' }), false);
  assert.equal(kpi.paceTrusted({ stale: false, source: 'events' }), false);
  assert.equal(kpi.paceTrusted({ stale: false, source: 'usage' }), true);
});

test('percentile: nearest rank', () => {
  assert.equal(kpi.percentile([], 0.9), null);
  assert.equal(kpi.percentile([7], 0.9), 7);
  assert.equal(kpi.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9); // ceil(9) = rank 9
  assert.equal(kpi.percentile([1, 2, 3, 4], 0.9), 4); // ceil(3.6) = rank 4
  assert.equal(kpi.percentile([1, 2, 3, 4, 5], 0.5), 3);
});

test('recentDurations: skips tasks without timing, orders by completion, keeps newest n', () => {
  const mk = (issue, doneAt, wallMs, extra = {}) => ({
    issue, state: 'done', doneAt, timing: wallMs == null ? null : { wallMs }, ...extra,
  });
  const tasks = [
    mk(1, '2026-10-03T10:00:00Z', 300),
    mk(2, '2026-10-01T10:00:00Z', 100),
    mk(3, '2026-10-02T10:00:00Z', null),
    mk(4, '2026-10-04T10:00:00Z', 400),
    mk(5, '2026-10-05T10:00:00Z', 500),
    { issue: 6, state: 'fixing', timing: { wallMs: 9 } },
  ];
  const r = kpi.recentDurations(tasks, 3);
  assert.deepEqual(r.values, [300, 400, 500]);
  assert.equal(r.n, 3);
  assert.equal(r.considered, 5);
  assert.equal(r.median, 400);
  assert.equal(r.p90, 500);
  assert.deepEqual(kpi.recentDurations([]).values, []);
  assert.equal(kpi.recentDurations([]).median, null);
});

test('completedByDay: local-day buckets around midnight, endings, createdAt-only ignored', () => {
  const now = new Date(2026, 9, 10, 0, 30).getTime(); // 00:30 local
  const at = (d, h, m) => new Date(2026, 9, d, h, m).toISOString();
  const tasks = [
    { state: 'done', doneAt: at(10, 0, 5), prs: [{ state: 'MERGED', mergedAt: at(10, 0, 5) }] },
    { state: 'done', doneAt: at(9, 23, 55), closedWithoutPr: true },
    { state: 'done', doneAt: at(9, 0, 1), issueClosed: true },
    { state: 'done', doneAt: new Date(2026, 8, 28, 12, 0).toISOString(), issueClosed: true, prs: [{ state: 'CLOSED' }] }, // 28 Sep: inside 14 days
    { state: 'done', doneAt: new Date(2026, 8, 20, 12, 0).toISOString() }, // outside
    { state: 'done', createdAt: at(10, 0, 1) }, // createdAt only: ignored
    { state: 'fixing', doneAt: at(10, 0, 1) },
  ];
  const r = kpi.completedByDay(tasks, 14, now);
  assert.equal(r.days.length, 14);
  assert.equal(r.days.at(-1).day, '2026-10-10');
  assert.equal(r.days[0].day, '2026-09-27');
  assert.equal(r.days.at(-1).n, 1);
  assert.equal(r.days.at(-2).n, 2);
  assert.equal(r.total, 4);
  assert.deepEqual(r.endings, { merged: 1, noPr: 1, issueClosed: 2 });
});

test('weekdayStamp: local weekday and time', () => {
  assert.equal(kpi.weekdayStamp(new Date(2026, 9, 8, 9, 0)), 'jue 09:00'); // 8 Oct 2026 is a Thursday
  assert.equal(kpi.weekdayStamp(new Date(2026, 9, 11, 18, 5).getTime()), 'dom 18:05');
  assert.equal(kpi.weekdayStamp(null), null);
});
