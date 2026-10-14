// Reassigned issues: the poller marks the task, restores it, and never touches
// its state. GitHub and the pipeline's cleanup come in as injected steps.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { DEFAULT_PROJECT_ID } from '../src/keys.js';

let poller;
let store;
let owner;

before(async () => {
  poller = await import('../src/poller.js');
  ({ store } = await import('../src/store.js'));
  ({ assigneeOf: owner } = await import('../src/github.js'));
});

let n = 31000;
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, DEFAULT_PROJECT_ID);
  task.issueClosed = false;
  return Object.assign(task, fields);
}
const settler = (result = 'settled') => {
  const calls = [];
  const fn = async (t) => { calls.push(t); if (result === 'settled') t.unassigned.settled = true; return result; };
  fn.calls = calls;
  return fn;
};
const logs = (t, needle) => t.log.filter((l) => String(l.line).includes(needle)).length;

test('reassigned to someone else: marked and settled', async () => {
  const t = freshTask();
  const settle = settler();
  assert.equal(await poller.noteAssignees(t, { assignees: ['otra'] }, { settle }), 'marked');
  assert.deepEqual(t.unassigned.to, ['otra']);
  assert.equal(t.unassigned.settled, true);
  assert.equal(settle.calls.length, 1);
  assert.equal(logs(t, 'reassigned on GitHub to otra'), 1);
});

test('empty assignee list: marked as unassigned', async () => {
  const t = freshTask();
  assert.equal(await poller.noteAssignees(t, { assignees: [] }, { settle: settler() }), 'marked');
  assert.deepEqual(t.unassigned.to, []);
  assert.equal(logs(t, 'left unassigned'), 1);
});

test('assigned back: mark cleared', async () => {
  const t = freshTask();
  await poller.noteAssignees(t, { assignees: ['otra'] }, { settle: settler() });
  assert.equal(await poller.noteAssignees(t, { assignees: [owner(t.project)] }, { settle: settler() }), 'restored');
  assert.equal(t.unassigned, null);
  assert.equal(logs(t, 'assigned to you again'), 1);
});

test('owner comparison ignores case, and owner present with no mark is none', async () => {
  const t = freshTask();
  const settle = settler();
  assert.equal(await poller.noteAssignees(t, { assignees: [owner(t.project).toUpperCase(), 'otra'] }, { settle }), 'none');
  assert.equal(t.unassigned ?? null, null);
  assert.equal(settle.calls.length, 0);
});

test('done or closed tasks and rows without the field are left alone', async () => {
  const settle = settler();
  const done = freshTask({ state: 'done' });
  const closed = freshTask({ issueClosed: true });
  const plain = freshTask();
  assert.equal(await poller.noteAssignees(done, { assignees: [] }, { settle }), 'none');
  assert.equal(await poller.noteAssignees(closed, { assignees: [] }, { settle }), 'none');
  assert.equal(await poller.noteAssignees(plain, { closed: false }, { settle }), 'none');
  assert.equal(await poller.noteAssignees(null, { assignees: [] }, { settle }), 'none');
  assert.equal(settle.calls.length, 0);
  assert.ok(!done.unassigned && !closed.unassigned && !plain.unassigned);
});

test('running: warns once, retries settle later without repeating the warning', async () => {
  const t = freshTask();
  const settle = settler('running');
  await poller.noteAssignees(t, { assignees: ['otra'] }, { settle });
  await poller.noteAssignees(t, { assignees: ['otra'] }, { settle });
  assert.equal(settle.calls.length, 2);
  assert.equal(t.unassigned.settled, false);
  assert.equal(logs(t, 'with a run in progress'), 1);
});

test('a settle that throws never escapes', async () => {
  const t = freshTask();
  const settle = async () => { throw new Error('boom'); };
  assert.equal(await poller.noteAssignees(t, { assignees: ['otra'] }, { settle }), 'none');
});

test('sweep: reassigned task is noted before the closed check, and unsettled marks are retried', async () => {
  const project = { id: DEFAULT_PROJECT_ID };
  const t = freshTask();
  const stuck = freshTask({ unassigned: { at: 'x', to: ['otra'], settled: false } });
  const rows = new Map([[t.issue, { number: t.issue, closed: false, assignees: ['otra'] }]]);
  const settle = settler();
  const seenNotes = [];
  const counts = await poller.sweepClosedIssues(project, new Set(), {
    steps: { issueStates: async () => rows },
    note: async (task) => { seenNotes.push(task); },
    complete: () => 'skip',
    assignees: (task, row) => poller.noteAssignees(task, row, { settle }),
    settle,
  });
  assert.equal(t.unassigned.settled, true);
  assert.equal(seenNotes.length, 0);
  assert.equal(counts.flipped, 0);
  assert.ok(settle.calls.includes(stuck));
  assert.equal(stuck.unassigned.settled, true);
});

test('a done or closed task with a settled mark is restored when assigned back', async () => {
  const done = freshTask({ state: 'done', unassigned: { at: 'x', to: ['otra'], settled: true } });
  const closed = freshTask({ issueClosed: true, unassigned: { at: 'x', to: [], settled: true } });
  const settle = settler();
  assert.equal(await poller.noteAssignees(done, { assignees: [owner(done.project)] }, { settle }), 'restored');
  assert.equal(await poller.noteAssignees(closed, { assignees: [owner(closed.project)] }, { settle }), 'restored');
  assert.equal(done.unassigned, null);
  assert.equal(closed.unassigned, null);
  assert.equal(done.state, 'done');
  assert.equal(settle.calls.length, 0);
});

test('a row that says closed never creates a mark', async () => {
  const t = freshTask();
  const settle = settler();
  assert.equal(await poller.noteAssignees(t, { assignees: ['otra'], closed: true }, { settle }), 'none');
  assert.ok(!t.unassigned);
  assert.equal(settle.calls.length, 0);
});
