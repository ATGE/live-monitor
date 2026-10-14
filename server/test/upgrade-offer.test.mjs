// The «Buscar actualizaciones» decision and the automatic offer's gates, as pure
// functions (the web has no test runner; see restart-outcome.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoOfferBlocked, manualCheckOutcome } from '../../web/src/upgradeOffer.js';

const T0 = '2026-10-08T10:00:00.000Z';
const T1 = '2026-10-08T10:05:00.000Z';
const NOW = Date.parse('2026-10-08T12:00:00.000Z');

const sdkBehind = { current: '0.3.294', latest: '0.3.300', behind: true, installable: true, manual: false, cli: '2.1.300' };
const state = (over = {}) => ({
  checkedAt: T1, sdk: sdkBehind, machines: {}, job: null, settings: {}, ...over,
});

test('the automatic offer shows for a newer, installable SDK', () => {
  assert.equal(autoOfferBlocked(state(), NOW), false);
});

test('the automatic offer is blocked by nothing newer, skipped, seen, a live snooze or a job', () => {
  assert.equal(autoOfferBlocked(null, NOW), true);
  assert.equal(autoOfferBlocked(state({ checkedAt: null }), NOW), true);
  assert.equal(autoOfferBlocked(state({ sdk: { ...sdkBehind, behind: false } }), NOW), true);
  assert.equal(autoOfferBlocked(state({ sdk: { ...sdkBehind, manual: true } }), NOW), true);
  assert.equal(autoOfferBlocked(state({ settings: { skipped: '0.3.300' } }), NOW), true);
  assert.equal(autoOfferBlocked(state({ settings: { seen: '0.3.300' } }), NOW), true);
  assert.equal(autoOfferBlocked(state({ settings: { snoozedUntil: '2026-10-09T10:00:00.000Z' } }), NOW), true);
  assert.equal(autoOfferBlocked(state({ job: { state: 'running' } }), NOW), true);
  assert.equal(autoOfferBlocked(state({ job: { state: 'failed', acknowledged: false, target: { sdk: '0.3.300' } } }), NOW), true);
});

test('an expired snooze no longer blocks the automatic offer', () => {
  assert.equal(autoOfferBlocked(state({ settings: { snoozedUntil: '2026-10-08T09:00:00.000Z' } }), NOW), false);
});

test('a manual check offers a newer SDK even right after «Más tarde», a skip or a seen mark', () => {
  const snoozed = state({ settings: { snoozedUntil: '2026-10-09T10:00:00.000Z', skipped: '0.3.300', seen: '0.3.300' } });
  assert.equal(autoOfferBlocked(snoozed, NOW), true, 'the automatic path stays blocked');
  const out = manualCheckOutcome({ checkedAt: T0 }, snoozed);
  assert.equal(out.kind, 'offer');
  assert.equal(out.sdk.latest, '0.3.300');
});

test('a manual check with nothing newer reports the versions it found', () => {
  const next = state({
    sdk: { current: '0.3.300', latest: '0.3.300', behind: false, installable: true, manual: false, cli: '2.1.300' },
    machines: { 'runner-1': { claude: '2.1.300', ok: true }, laptop: { claude: '2.1.294', ok: false } },
  });
  const out = manualCheckOutcome({ checkedAt: T0 }, next);
  assert.equal(out.kind, 'uptodate');
  assert.deepEqual(out.versions, {
    sdk: '0.3.300', latest: '0.3.300', cli: '2.1.300',
    machines: [{ name: 'runner-1', claude: '2.1.300', ok: true }, { name: 'laptop', claude: '2.1.294', ok: false }],
  });
});

test('a newer SDK the board cannot install is reported, not offered', () => {
  const out = manualCheckOutcome(null, state({ sdk: { ...sdkBehind, manual: true } }));
  assert.deepEqual(out, { kind: 'manual', current: '0.3.294', latest: '0.3.300' });
});

test('an upgrade already running opens its detail instead of a new offer', () => {
  assert.deepEqual(manualCheckOutcome({ checkedAt: T0 }, state({ job: { state: 'running' } })), { kind: 'job' });
});

test('a check that did not advance checkedAt is an error (the server swallowed the failure)', () => {
  const out = manualCheckOutcome({ checkedAt: T1 }, state({ checkedAt: T1 }));
  assert.equal(out.kind, 'error');
});

test('an unreachable registry (no latest) and an empty answer are errors', () => {
  assert.equal(manualCheckOutcome({ checkedAt: T0 }, state({ sdk: { ...sdkBehind, latest: null, behind: false } })).kind, 'error');
  assert.equal(manualCheckOutcome({ checkedAt: T0 }, null).kind, 'error');
  assert.equal(manualCheckOutcome({ checkedAt: T0 }, state({ checkedAt: null })).kind, 'error');
});

test('the first check ever (no previous state) is judged on its own', () => {
  assert.equal(manualCheckOutcome(null, state()).kind, 'offer');
});
