// The web's «did the restart happen?» decision, as a pure function (the web has
// no test runner of its own; see board-filter.test.mjs for the same pattern).
import test from 'node:test';
import assert from 'node:assert/strict';
import { restartOutcome, failureMessage } from '../../web/src/restartOutcome.js';

const A = '2026-10-05T10:00:00.000Z';
const B = '2026-10-05T10:05:00.000Z';
const FALLBACK = 20_000;
const decide = (o) => restartOutcome({ fallbackMs: FALLBACK, elapsedMs: 0, sawDown: false, ...o });

test('a changed startedAt means the board came back as a new process', () => {
  assert.equal(decide({ before: { startedAt: A }, now: { startedAt: B, lastFailure: null } }), 'restarted');
  // even if the poll never saw it down and the fallback has not elapsed
  assert.equal(decide({ before: { startedAt: A }, now: { startedAt: B }, sawDown: false, elapsedMs: 1 }), 'restarted');
});

test('the same startedAt is the same process: still pending, however long it answers', () => {
  const same = { startedAt: A, state: 'restarting', lastFailure: null };
  assert.equal(decide({ before: { startedAt: A }, now: same, elapsedMs: 5_000 }), 'pending');
  assert.equal(decide({ before: { startedAt: A }, now: same, elapsedMs: 120_000, sawDown: true }), 'pending');
});

test('the same process answering waiting or idle after the gate was never restarting', () => {
  const at = (state, elapsedMs) => decide({ before: { startedAt: A }, now: { startedAt: A, state, lastFailure: null }, elapsedMs });
  assert.equal(at('waiting', FALLBACK), 'not-restarting');
  assert.equal(at('idle', FALLBACK), 'not-restarting');
  assert.equal(at('idle', FALLBACK - 1), 'pending', 'idle shows briefly while sessions close');
  assert.equal(at('restarting', 120_000), 'pending');
  // a failure still wins over the gate
  const lastFailure = { at: B, reason: 'still-alive', afterMs: 60_000 };
  assert.equal(decide({ before: { startedAt: A }, now: { startedAt: A, state: 'idle', lastFailure }, elapsedMs: FALLBACK }), 'failed');
});

test('a lastFailure from the same process is a failed restart', () => {
  const lastFailure = { at: B, reason: 'still-alive', afterMs: 60_000 };
  assert.equal(decide({ before: { startedAt: A }, now: { startedAt: A, lastFailure }, elapsedMs: 61_000 }), 'failed');
  // also when the page never learned the old startedAt
  assert.equal(decide({ before: {}, now: { lastFailure } }), 'failed');
});

test('without startedAt on either side the old rule stays: down seen, or the fallback elapsed', () => {
  assert.equal(decide({ before: {}, now: {}, sawDown: true }), 'restarted');
  assert.equal(decide({ before: {}, now: {}, elapsedMs: FALLBACK }), 'restarted');
  assert.equal(decide({ before: {}, now: {}, elapsedMs: FALLBACK - 1 }), 'pending');
  assert.equal(decide({ before: { startedAt: A }, now: {}, elapsedMs: FALLBACK }), 'restarted');
  assert.equal(decide({ before: null, now: { startedAt: B }, sawDown: true }), 'restarted');
});

test('failureMessage names the log for a still-alive board and the error for a launch failure', () => {
  assert.match(failureMessage({ reason: 'still-alive' }), /no se reinició: sigue el mismo proceso/);
  assert.match(failureMessage({ reason: 'still-alive' }), /hfs-monitor\.restart\.log/);
  assert.match(failureMessage({ reason: 'error', message: 'no powershell' }), /no powershell/);
  assert.match(failureMessage({ reason: 'error', message: 'x' }), /hfs-monitor\.err\.log/);
  assert.doesNotMatch(failureMessage({ reason: 'error', message: 'x' }), /restart\.log/);
  assert.match(failureMessage(null), /no se reinició/);
});
