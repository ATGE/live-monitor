// The per-task design mark: born off, written only by `setDesign` from a strict
// boolean, and never derived from what GitHub says about the issue.
import './isolate.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.HFSMON_NO_AUTOSTART = '1';

const { store } = await import('../src/store.js');
const { migrateTask } = await import('../src/mode.js');
let pipeline;
before(async () => { pipeline = await import('../src/pipeline.js'); });

let n = 880000;
const born = (fields = {}) => {
  n += 1;
  return Object.assign(store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs'), fields);
};

test('a task is born with the mark off', () => {
  assert.equal(born().design, false);
});

test('setDesign takes a strict boolean, keyed by the task key, and refuses the rest', () => {
  const task = born();
  const key = `hfs#${task.issue}`;
  assert.equal(pipeline.setDesign(key, true), true);
  assert.equal(task.design, true);
  assert.equal(pipeline.setDesign(key, false), false);
  for (const bad of ['true', 'on', 1, 0, null, undefined, {}]) {
    assert.throws(() => pipeline.setDesign(key, bad), /must be true or false/, JSON.stringify(bad));
  }
  assert.equal(task.design, false, 'a refused value changes nothing');
  assert.throws(() => pipeline.setDesign('hfs#999999999', true), /Unknown task/);
});

test('an issue that asks for a canvas does not turn the mark on', () => {
  const task = born({ title: 'Publish a canvas', labels: ['design', 'artifact'] });
  assert.equal(migrateTask(task).design, false);
  assert.equal(pipeline.designSessionFor(task, 'fix'), false);
});

test('only setDesign, the birth default and the migration write the mark', () => {
  // The poller and the mode logic read GitHub; they must not touch `design`.
  for (const f of ['../src/poller.js', '../src/github.js']) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /\.design\b/, f);
  }
  const mode = readFileSync(new URL('../src/mode.js', import.meta.url), 'utf8');
  const writes = mode.split(/\r?\n/).filter((l) => /\.design\s*=/.test(l));
  assert.deepEqual(writes.map((l) => l.trim()), ['if (task.design !== true) task.design = false;']);
});
