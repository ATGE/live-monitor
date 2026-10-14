// Which machines get a «login about to expire» chip, as pure functions (the web
// has no test runner of its own; see restart-outcome.test.mjs for the pattern).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  LOGIN_WARN_MS, loginWarning, loginChips, readLogin, jobFinished, safeLoginUrl,
} from '../../web/src/loginChip.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const at = (ms) => NOW + ms;

test('the threshold is five days', () => {
  assert.equal(LOGIN_WARN_MS, 5 * D);
});

test('4 d 23 h left shows a chip, 5 d 1 h does not', () => {
  const near = loginWarning({ state: 'ok', expiresAt: at(4 * D + 23 * H) }, NOW);
  assert.equal(near?.tone, 'expiring');
  assert.equal(loginWarning({ state: 'ok', expiresAt: at(5 * D + H) }, NOW), null);
  assert.equal(loginWarning({ state: 'expiring', expiresAt: at(5 * D + H) }, NOW), null,
    'the client trusts the timestamp over a stale label');
});

test('exactly five days is still shown', () => {
  assert.equal(loginWarning({ state: 'ok', expiresAt: at(5 * D) }, NOW)?.tone, 'expiring');
});

test('an expired login (state or timestamp) is shown as expired', () => {
  assert.equal(loginWarning({ state: 'expired', expiresAt: 0 }, NOW)?.tone, 'expired');
  assert.equal(loginWarning({ state: 'expired', expiresAt: at(30 * D) }, NOW)?.tone, 'expired');
  assert.equal(loginWarning({ state: 'ok', expiresAt: at(-1) }, NOW)?.tone, 'expired');
});

test('unknown and ok-without-a-date show nothing', () => {
  assert.equal(loginWarning({ state: 'unknown', expiresAt: at(D) }, NOW), null);
  assert.equal(loginWarning({ state: 'unknown' }, NOW), null);
  assert.equal(loginWarning({ state: 'ok' }, NOW), null);
  assert.equal(loginWarning(null, NOW), null);
  assert.equal(loginWarning(undefined, NOW), null);
});

test('without a timestamp the server label decides', () => {
  assert.equal(loginWarning({ state: 'expiring' }, NOW)?.tone, 'expiring');
});

test('labels say days, then hours, then expired', () => {
  assert.match(loginWarning({ state: 'ok', expiresAt: at(4 * D + 23 * H) }, NOW).label, /4 d/);
  assert.match(loginWarning({ state: 'ok', expiresAt: at(5 * H) }, NOW).label, /5 h/);
  assert.match(loginWarning({ state: 'ok', expiresAt: at(10 * 60_000) }, NOW).label, /1 h/);
  assert.match(loginWarning({ state: 'expired' }, NOW).label, /caducado/i);
});

test('every machine with a warning gets a chip, the laptop included, sorted by name', () => {
  const chips = loginChips({
    runner: { state: 'expired', expiresAt: 0 },
    local: { state: 'expiring', expiresAt: at(2 * D) },
    far: { state: 'ok', expiresAt: at(20 * D) },
    ghost: { state: 'unknown' },
  }, NOW);
  assert.deepEqual(chips.map((c) => c.machine), ['local', 'runner']);
  assert.equal(chips[0].tone, 'expiring');
  assert.equal(chips[1].tone, 'expired');
});

test('no state, no chips', () => {
  assert.deepEqual(loginChips(null, NOW), []);
  assert.deepEqual(loginChips({}, NOW), []);
});

test('readLogin accepts the bare map, the wrapped broadcast and the wrapped GET', () => {
  const map = { local: { state: 'ok', expiresAt: 1 } };
  assert.deepEqual(readLogin(map), map);
  assert.deepEqual(readLogin({ type: 'login', state: map }), map);
  assert.deepEqual(readLogin({ login: map }), map);
  assert.deepEqual(readLogin(null), {});
  assert.deepEqual(readLogin({ type: 'login' }), {});
});

test('a job is finished only in a terminal state', () => {
  for (const s of ['done', 'failed', 'cancelled']) assert.equal(jobFinished({ state: s }), true, s);
  for (const s of ['waiting', 'starting', 'url', 'code', 'verifying']) assert.equal(jobFinished({ state: s }), false, s);
  assert.equal(jobFinished(null), false);
});

test('only https links are offered as the login URL', () => {
  assert.equal(safeLoginUrl('https://claude.ai/oauth/authorize?x=1'), 'https://claude.ai/oauth/authorize?x=1');
  assert.equal(safeLoginUrl('javascript:alert(1)'), null);
  assert.equal(safeLoginUrl('http://example.com'), null);
  assert.equal(safeLoginUrl(''), null);
  assert.equal(safeLoginUrl(null), null);
});

test('the login UI never logs, stores or prints the URL, the code or the ticket', () => {
  const WEB = path.resolve(import.meta.dirname, '..', '..', 'web', 'src');
  for (const f of ['components/LoginDialog.jsx', 'components/LoginChips.jsx', 'components/LoginCard.jsx', 'loginChip.js']) {
    const src = readFileSync(path.join(WEB, f), 'utf8');
    assert.doesNotMatch(src, /console\./, `${f} must not log`);
    assert.doesNotMatch(src, /localStorage|sessionStorage/, `${f} must not persist anything`);
  }
  const dialog = readFileSync(path.join(WEB, 'components/LoginDialog.jsx'), 'utf8');
  assert.doesNotMatch(dialog, /[?&]ticket=/, 'the ticket travels in a header, never in a query');
});
