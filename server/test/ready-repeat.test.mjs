// A repeated «Listo para revisión» is an answered request, not a failure (#17).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './teardown.mjs';
// Pure and with no server imports of its own, so it is safe before HFSMON_DATA_DIR.
import { DEFAULT_PROJECT_ID } from '../src/keys.js';

const dataDir = tempDir('hfsmon-ready-repeat-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline; let store;
before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
});

let n = 9500;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, DEFAULT_PROJECT_ID);
  task.issueClosed = false;
  return Object.assign(task, fields);
}
const drafted = (over = {}) => freshTask({
  state: 'pr_draft', branch: 'fix/x', prNumber: 77, prUrl: 'https://x/pull/77',
  prs: [{ number: 77, url: 'https://x/pull/77', title: 't', state: 'DRAFT' }], ...over,
});

/** The outside calls of `markReady`, counted; `gate` holds `mergeBeforeReview` until released. */
function steps(gate = null) {
  const calls = [];
  return {
    calls,
    prView: async (number) => { calls.push('prView'); return { number, state: 'OPEN', isDraft: true }; },
    mergeBeforeReview: async () => { calls.push('mergeBeforeReview'); if (gate) await gate; },
    pushBeforeReview: async () => { calls.push('pushBeforeReview'); },
    readyPr: async () => { calls.push('readyPr'); },
    reclassify: async () => { calls.push('reclassify'); },
    addReviewer: async () => { calls.push('addReviewer'); },
  };
}
const readyLines = (task) => task.log.filter((l) => /^PR #\d+ ready for review;/.test(l.line));
const failLines = (task) => task.log.filter((l) => /failed/.test(l.line));

test('a repeat on a task that is already ready answers success and does nothing', async () => {
  const task = drafted();
  const s = steps();
  await pipeline.markReady(task.issue, { reviewer: 'alice' }, s);
  const before = [...s.calls];
  assert.equal(await pipeline.markReady(task.issue, { reviewer: 'alice' }, s), undefined);
  assert.deepEqual(s.calls, before, 'no prView, push, readyPr or addReviewer the second time');
  assert.equal(readyLines(task).length, 1);
  assert.equal(failLines(task).length, 0);
  assert.ok(task.log.some((l) => l.phase === 'pr' && /already ready for review/.test(l.line)));
});

test('two concurrent requests do the work once', async () => {
  const task = drafted();
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = steps(gate);
  const first = pipeline.markReady(task.issue, { reviewer: 'alice' }, s);
  const second = pipeline.markReady(task.issue, { reviewer: 'alice' }, s);
  await new Promise((r) => { setTimeout(r, 20); });
  release();
  await Promise.all([first, second]);
  assert.equal(s.calls.filter((c) => c === 'readyPr').length, 1);
  assert.equal(s.calls.filter((c) => c === 'addReviewer').length, 1);
  assert.equal(readyLines(task).length, 1);
  assert.equal(failLines(task).length, 0);
});

test('the three refusals say which case it is', async () => {
  const noPr = freshTask({ state: 'pr_draft' });
  await assert.rejects(() => pipeline.markReady(noPr.issue, {}, steps()), (e) => /has no PR/.test(e.message) && !/draft/i.test(e.message));

  const other = drafted({ state: 'done' });
  await assert.rejects(() => pipeline.markReady(other.issue, {}, steps()), (e) => /state «done»/.test(e.message));

  const ready = drafted({ state: 'ready' });
  const s = steps();
  await pipeline.markReady(ready.issue, {}, s);
  assert.deepEqual(s.calls, []);
});

test('a repeated publish of a resolved change request answers success without republishing', async () => {
  const cr = { reviewId: 5, status: 'resolved', draftReplies: [{ threadId: 't', body: 'b', path: 'p' }] };
  const task = drafted({ changeRequests: [cr] });
  assert.equal(await pipeline.resolveChangeRequest(task.issue, 5), cr);
  assert.ok(task.log.some((l) => l.phase === 'cr' && /already published/.test(l.line)));
  assert.equal(task.log.filter((l) => /⚠️/.test(l.line)).length, 0);
});
