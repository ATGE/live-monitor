// A task reassigned away from the board's user in GitHub is settled, never
// interrupted: `settleUnassigned` follows the guard order of
// `completeOnIssueClosed`, leaves `task.state` alone and marks the card for
// hiding. Nothing here calls `gh` or `git`: the tasks have no worktree and no
// branch, and the stack stop goes through the `issueClosedHooks` seam.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as pipeline from '../src/pipeline.js';
import { store } from '../src/store.js';

let n = 12000;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.issueClosed = false;
  task.unassigned = { at: '2026-10-02T00:00:00Z', to: ['someone-else'], settled: false };
  return Object.assign(task, fields);
}

function withStackSeam(fn) {
  const original = pipeline.issueClosedHooks.stopStack;
  const stopped = [];
  pipeline.issueClosedHooks.stopStack = async (key) => { stopped.push(key); };
  return Promise.resolve(fn(stopped)).finally(() => { pipeline.issueClosedHooks.stopStack = original; });
}

test('an active state is never interrupted: answers running and writes nothing', async () => {
  const task = freshTask({ state: 'fixing', forced: true });
  const snapshot = JSON.stringify(task);
  assert.equal(await pipeline.settleUnassigned(task), 'running');
  assert.equal(JSON.stringify(task), snapshot);
  assert.equal(task.unassigned.settled, false);
});

test('a task being moved is skipped', async () => {
  const task = freshTask({ state: 'assigned', moving: { step: 'chats' } });
  assert.equal(await pipeline.settleUnassigned(task), 'skip');
  assert.equal(task.unassigned.settled, false);
});

test('a busy chat is skipped', async () => {
  const task = freshTask({ state: 'assigned', chats: [{ id: 'c1', busy: true }] });
  assert.equal(await pipeline.settleUnassigned(task), 'skip');
  assert.equal(task.unassigned.settled, false);
});

test('a task without the mark is not this function\'s business', async () => {
  const task = freshTask({ state: 'assigned', unassigned: null });
  assert.equal(await pipeline.settleUnassigned(task), 'skip');
});

test('a quiet task settles: state untouched, question answered, forced dropped, stack stopped', async () => {
  await withStackSeam(async (stopped) => {
    const task = freshTask({
      state: 'waiting_approval', forced: true, stack: { ports: [1] },
      pending: { kind: 'plan', question: '?' },
      prs: [{ number: 7, state: 'OPEN' }],
    });
    assert.equal(await pipeline.settleUnassigned(task), 'settled');
    assert.equal(task.state, 'waiting_approval', 'the state is never changed: reassigning back restores the card');
    assert.equal(task.pending, null);
    assert.equal(task.forced, false);
    assert.equal(task.unassigned.settled, true);
    assert.equal(stopped.length, 1);
    const lines = task.log.map((l) => l.line).join('\n');
    assert.match(lines, /#7/, 'the open PR that stays is named');
  });
});

test('a failing stack stop is logged and does not stop the settle', async () => {
  const original = pipeline.issueClosedHooks.stopStack;
  pipeline.issueClosedHooks.stopStack = async () => { throw new Error('boom'); };
  try {
    const task = freshTask({ state: 'assigned', stack: { ports: [1] } });
    assert.equal(await pipeline.settleUnassigned(task), 'settled');
    assert.ok(task.log.some((l) => /could not stop the stack: boom/.test(l.line)));
  } finally {
    pipeline.issueClosedHooks.stopStack = original;
  }
});

test('manual start and retry refuse a reassigned task', () => {
  const task = freshTask({ state: 'assigned' });
  assert.throws(() => pipeline.startTask(task.issue), (e) => e.status === 409 && /reassigned to someone-else on GitHub/.test(e.message));
  const failed = freshTask({ state: 'error' });
  assert.equal(pipeline.retry(failed.issue), false);
  assert.equal(pipeline.startChangeRequest(task.issue), false);
});

test('tick does not start a reassigned task that is assigned and classified', () => {
  const started = [];
  const original = pipeline.pipelineHooks.run;
  pipeline.pipelineHooks.run = async (t) => { started.push(t.issue); };
  try {
    const task = freshTask({ state: 'assigned', classified: true });
    pipeline.tick();
    assert.ok(!started.includes(task.issue));
    assert.equal(pipeline.isRunning(task.issue), false);
  } finally {
    pipeline.pipelineHooks.run = original;
  }
});

test('plan revise, accept-fix and publish-PR refuse a reassigned task before touching it', async () => {
  const plan = freshTask({ state: 'plan_ready', workPlan: { status: 'proposed', tasks: [] } });
  const fix = freshTask({ state: 'error', error: 'boom' });
  const pr = freshTask({ state: 'error', error: 'boom', branch: 'b', prPark: { proposal: 'fix: x', problems: [], at: 'now' } });
  const snap = (t) => JSON.stringify({ s: t.state, e: t.error, f: t.planFeedback, w: t.workPlan, p: t.prTitle, x: t.fixedAt });
  const before = [plan, fix, pr].map(snap);
  const refused = (e) => e.status === 409 && /reassigned to someone-else on GitHub/.test(e.message);
  assert.throws(() => pipeline.decideTaskPlan(plan.issue, { decision: 'revise', feedback: 'cambia algo' }), refused);
  await assert.rejects(pipeline.acceptFix(fix.issue), refused);
  await assert.rejects(pipeline.publishPr(pr.issue, 'fix: un título válido'), refused);
  assert.deepEqual([plan, fix, pr].map(snap), before);
  for (const t of [plan, fix, pr]) assert.equal(pipeline.isRunning(t.issue), false);
});
