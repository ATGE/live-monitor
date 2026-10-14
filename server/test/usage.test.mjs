// The quota meter's numbers: the /usage probe, its two response shapes, and
// the rate_limit_event fallback.
//
// No test opens a real session: `usageHooks.query` is swapped for a fake that
// returns a stub query object, and `usageHooks.now`/`timeoutMs` keep the clock
// and the timeout under the test's control.
import './isolate.mjs';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  usageHooks, usageEvents, usageState, refreshUsage, normalizeUsage, noteUsageEvent,
  nextProbeDelay, resetUsageForTests, usageRouter,
  PROBE_INTERVAL_MS, PROBE_MAX_INTERVAL_MS, REFRESH_THROTTLE_MS, STALE_AFTER_MS,
} from '../src/usage.js';

// The answer the CLI gave on 2026-09-21: both shapes at once.
const FIXTURE = {
  session: { total_cost_usd: 0, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 2, resets_at: '2026-09-21T09:00:00.953529+00:00' },
    seven_day: { utilization: 93, resets_at: '2026-09-21T23:00:00.953550+00:00' },
    model_scoped: [{ display_name: 'Fable', utilization: 32, resets_at: '2026-09-21T22:59:58.953721+00:00' }],
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
    limits: [
      { kind: 'session', group: 'session', percent: 2, severity: 'normal', resets_at: '2026-09-21T09:00:00.953529+00:00', scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 93, severity: 'critical', resets_at: '2026-09-21T23:00:00.953550+00:00', scope: null, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 32, severity: 'normal', resets_at: '2026-09-21T22:59:58.953721+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
    ],
  },
};

const T0 = Date.UTC(2026, 8, 21, 8, 0);
let clock = T0;
const original = { ...usageHooks };

/** A fake `query()` that records how it was used. */
function fakeQuery({ answer = FIXTURE, missing = false, hang = false, fail = null } = {}) {
  const calls = { opened: 0, closed: 0, options: null, asked: null };
  usageHooks.query = ({ prompt, options }) => {
    calls.opened += 1;
    calls.options = options;
    calls.prompt = prompt;
    const q = { close: () => { calls.closed += 1; } };
    if (!missing) {
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = (opts) => {
        calls.asked = opts;
        if (hang) return new Promise(() => {});
        if (fail) return Promise.reject(new Error(fail));
        return Promise.resolve(structuredClone(answer));
      };
    }
    return q;
  };
  return calls;
}

beforeEach(() => {
  resetUsageForTests();
  Object.assign(usageHooks, original);
  clock = T0;
  usageHooks.now = () => clock;
  usageEvents.removeAllListeners();
});

after(() => {
  resetUsageForTests();
  Object.assign(usageHooks, original);
});

test('the real response: limits[] wins, with severity, labels and the active row', () => {
  const n = normalizeUsage(FIXTURE);
  assert.equal(n.subscription, 'max');
  assert.deepEqual(n.rows.map((r) => [r.kind, r.group, r.label, r.percent, r.severity, r.active]), [
    ['session', 'session', 'Sesión (5 h)', 2, 'normal', false],
    ['weekly_all', 'weekly', 'Semanal', 93, 'critical', true],
    ['weekly_scoped', 'weekly', 'Semanal · Fable', 32, 'normal', false],
  ]);
  assert.equal(n.rows[1].resetsAt, Date.parse('2026-09-21T23:00:00.953Z'));
  assert.deepEqual(n.extra, { enabled: false, usedCredits: null, monthlyLimit: null, utilization: null, currency: null });
});

test('keyed windows only: no severity, and the fullest row becomes active', () => {
  const { limits, ...keyed } = FIXTURE.rate_limits;
  keyed.seven_day_opus = { utilization: 40, resets_at: '2026-09-22T00:00:00Z' };
  keyed.seven_day_oauth_apps = { utilization: 99, resets_at: null };
  keyed.seven_day_sonnet = null;
  const n = normalizeUsage({ ...FIXTURE, rate_limits: keyed });
  assert.deepEqual(n.rows.map((r) => [r.kind, r.label, r.percent, r.severity, r.active]), [
    ['session', 'Sesión (5 h)', 2, null, false],
    ['weekly_all', 'Semanal', 93, null, true],
    ['weekly_scoped', 'Semanal · Fable', 32, null, false],
    ['weekly_scoped', 'Semanal · Opus', 40, null, false],
  ]);
  assert.equal(n.rows[0].resetsAt, Date.parse('2026-09-21T09:00:00.953Z'));
});

test('no plan limits (API key): no rows, available false', () => {
  const n = normalizeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null });
  assert.deepEqual(n.rows, []);
  assert.equal(n.available, false);
});

test('a probe opens an idle, settings-free session and closes it', async () => {
  const calls = fakeQuery();
  const seen = [];
  usageEvents.on('state', (u) => seen.push(u));
  const u = await refreshUsage();
  assert.equal(calls.opened, 1);
  assert.equal(calls.closed, 1);
  assert.deepEqual(calls.asked, { skipBehaviors: true });
  assert.deepEqual(calls.options.settingSources, []);
  assert.equal(calls.options.persistSession, false);
  assert.equal('ANTHROPIC_API_KEY' in calls.options.env, false);
  // The prompt was released: the generator finishes instead of hanging.
  assert.deepEqual(await calls.prompt.next(), { value: undefined, done: true });
  assert.equal(u.source, 'usage');
  assert.equal(u.stale, false);
  assert.equal(u.error, null);
  assert.equal(u.subscription, 'max');
  assert.equal(u.rows.length, 3);
  assert.equal(seen.length, 1);
  assert.deepEqual(usageState(), u);
});

test('method missing → the rate_limit_event rows, source events', async () => {
  fakeQuery({ missing: true });
  noteUsageEvent({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.91, resetsAt: T0 + 3_600_000, via: 'sdk' });
  noteUsageEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 12, resetsAt: T0 + 60_000, via: 'sdk' });
  const u = await refreshUsage();
  assert.equal(u.source, 'events');
  assert.equal(u.stale, true);
  assert.match(u.error, /método/);
  const weekly = u.rows.find((r) => r.kind === 'weekly_all');
  assert.equal(Math.round(weekly.percent), 91);
  assert.equal(weekly.active, true);
  assert.equal(u.rows.find((r) => r.kind === 'session').percent, 12);
});

test('events never overwrite a fresh probe', async () => {
  fakeQuery();
  await refreshUsage();
  noteUsageEvent({ status: 'allowed', rateLimitType: 'seven_day', utilization: 10, resetsAt: null, via: 'sdk' });
  const u = usageState();
  assert.equal(u.source, 'usage');
  assert.equal(u.rows.find((r) => r.kind === 'weekly_all').percent, 93);
  // …but once the probe goes stale, the newer event shows.
  clock += STALE_AFTER_MS + 1;
  noteUsageEvent({ status: 'allowed', rateLimitType: 'seven_day', utilization: 95, resetsAt: null, via: 'sdk' });
  const later = usageState();
  assert.equal(later.source, 'events');
  assert.equal(later.rows.find((r) => r.kind === 'weekly_all').percent, 95);
  assert.equal(later.rows.length, 3);
});

test('timeout → stale with an error, close() still called, the old rows kept', async () => {
  fakeQuery();
  await refreshUsage();
  const calls = fakeQuery({ hang: true });
  usageHooks.timeoutMs = 20;
  clock += REFRESH_THROTTLE_MS;
  const u = await refreshUsage();
  assert.equal(calls.closed, 1);
  assert.equal(u.stale, true);
  assert.match(u.error, /No response/);
  assert.equal(u.source, 'usage');
  assert.equal(u.rows.length, 3);
});

test('a failure with nothing known yet still reports the error', async () => {
  fakeQuery({ fail: 'boom' });
  const u = await refreshUsage();
  assert.equal(u.stale, true);
  assert.equal(u.error, 'boom');
  assert.deepEqual(u.rows, []);
});

test('backoff: failures double the interval up to 30 min, success resets it', async () => {
  assert.equal(nextProbeDelay(0), PROBE_INTERVAL_MS);
  assert.equal(nextProbeDelay(1), 2 * PROBE_INTERVAL_MS);
  assert.equal(nextProbeDelay(2), 4 * PROBE_INTERVAL_MS);
  assert.equal(nextProbeDelay(3), PROBE_MAX_INTERVAL_MS);
  assert.equal(nextProbeDelay(10), PROBE_MAX_INTERVAL_MS);

  fakeQuery({ fail: 'down' });
  await refreshUsage({ force: true });
  await refreshUsage({ force: true });
  assert.equal(nextProbeDelay(), 4 * PROBE_INTERVAL_MS);
  fakeQuery();
  await refreshUsage({ force: true });
  assert.equal(nextProbeDelay(), PROBE_INTERVAL_MS);
});

test('throttle: within 60 s a refresh returns the current state without probing', async () => {
  const calls = fakeQuery();
  await refreshUsage();
  clock += REFRESH_THROTTLE_MS - 1;
  await refreshUsage();
  assert.equal(calls.opened, 1);
  clock += 1;
  await refreshUsage();
  assert.equal(calls.opened, 2);
});

test('one probe at a time: a concurrent refresh joins the running one', async () => {
  const calls = fakeQuery();
  const [a, b] = await Promise.all([refreshUsage({ force: true }), refreshUsage({ force: true })]);
  assert.equal(calls.opened, 1);
  assert.deepEqual(a, b);
});

test('paused (upgrade holding new work): nothing runs', async () => {
  const calls = fakeQuery();
  usageHooks.paused = () => true;
  assert.equal(await refreshUsage({ force: true }), null);
  assert.equal(calls.opened, 0);
});

test('noteUsageEvent: a fractional utilization rounds cleanly (0.57 → 57, not 56.99999999999999)', () => {
  noteUsageEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.57, resetsAt: null, via: 'sdk' });
  const row = usageState().rows[0];
  assert.equal(row.percent, 57);
});

test('noteUsageEvent ignores events without a window or a number, and never throws', () => {
  noteUsageEvent(null);
  noteUsageEvent({ status: 'allowed', rateLimitType: 'overage', utilization: 50 });
  noteUsageEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: null });
  assert.equal(usageState(), null);
  // A rejection without a number is a full window.
  noteUsageEvent({ status: 'rejected', rateLimitType: 'seven_day_opus', utilization: null, resetsAt: null });
  const row = usageState().rows[0];
  assert.deepEqual([row.label, row.percent, row.severity], ['Semanal · Opus', 100, 'critical']);
});

test('usageRouter mounts POST /api/usage/refresh', () => {
  const router = usageRouter();
  const layer = router.stack.find((l) => l.route?.path === '/api/usage/refresh');
  assert.ok(layer);
  assert.equal(layer.route.methods.post, true);
});
