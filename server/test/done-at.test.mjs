// task.doneAt: the completion date, stamped on the transition into 'done'.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as pipeline from '../src/pipeline.js';
import { store } from '../src/store.js';

const mk = (n) =>
  store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('setState to done stamps doneAt', () => {
  const t = mk(910001);
  assert.ok(!t.doneAt);
  store.setState(t, 'done');
  assert.ok(Number.isFinite(Date.parse(t.doneAt)));
});

test('done -> worktree -> done keeps the original doneAt', async () => {
  const t = mk(910002);
  store.setState(t, 'done');
  const first = t.doneAt;
  await wait(5);
  store.setState(t, 'worktree');
  assert.equal(t.doneAt, first);
  await wait(5);
  store.setState(t, 'done');
  assert.equal(t.doneAt, first);
});

test('done -> done does not re-stamp', async () => {
  const t = mk(910003);
  store.setState(t, 'done');
  const first = t.doneAt;
  await wait(5);
  store.setState(t, 'done');
  assert.equal(t.doneAt, first);
});

test('beginNewCycle clears doneAt', () => {
  assert.equal(typeof pipeline.beginNewCycle, 'function');
  const t = mk(910004);
  store.setState(t, 'done');
  assert.ok(t.doneAt);
  pipeline.beginNewCycle(t, 'test');
  assert.equal(t.doneAt, null);
  store.setState(t, 'worktree');
  store.setState(t, 'done');
  assert.ok(t.doneAt);
});
