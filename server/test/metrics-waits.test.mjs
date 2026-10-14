import './isolate.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parkForQuota, clearQuotaPark } from '../src/quota.js';
import { metricsHooks } from '../src/metrics.js';

const task = () => ({ project: 'hfs', issue: 41, timings: [] });

afterEach(() => {
  metricsHooks.now = () => Date.now();
  metricsHooks.persist = () => {};
});

test('clearing a quota park records a wait span from `since` to now', () => {
  const t = task();
  parkForQuota(t, { resumeFrom: 'fixing', wasUserRun: true });
  // A park that began 90 s ago, e.g. before a board restart: `since` is persisted.
  t.quotaPark.since = '2026-10-05T10:00:00.000Z';
  metricsHooks.now = () => Date.parse('2026-10-05T10:01:30.000Z');
  let persisted = 0;
  metricsHooks.persist = () => { persisted += 1; };

  assert.equal(clearQuotaPark(t), true);

  assert.equal(t.quotaPark, null);
  assert.equal(t.timings.length, 1);
  const [s] = t.timings;
  assert.equal(s.kind, 'wait');
  assert.equal(s.name, 'quota_park');
  assert.equal(s.ms, 90_000);
  assert.equal(s.startedAt, '2026-10-05T10:00:00.000Z');
  assert.equal(s.endedAt, '2026-10-05T10:01:30.000Z');
  assert.equal(s.meta.within, null);
  assert.equal(s.meta.cycle, 1, 'stamped by the recorder');
  assert.equal(s.meta.resumeFrom, 'fixing');
  assert.equal(s.meta.wasUserRun, true);
  assert.ok(persisted >= 1);
});

test('clearing a task that is not parked records nothing', () => {
  const t = task();
  assert.equal(clearQuotaPark(t), false);
  assert.equal(t.timings.length, 0);
});

test('a second clear does not record a second span', () => {
  const t = task();
  parkForQuota(t);
  clearQuotaPark(t);
  clearQuotaPark(t);
  assert.equal(t.timings.filter((s) => s.name === 'quota_park').length, 1);
});

test('a task without a timings array still clears and gets the span', () => {
  const t = { project: 'hfs', issue: 42 };
  parkForQuota(t);
  clearQuotaPark(t);
  assert.equal(t.timings.length, 1);
});
