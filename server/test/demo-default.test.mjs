// The demo phase's project-wide default: the per-project switch, the card's
// `auto`/`on`/`off`, how `demoWanted` resolves them, and the one-time move of
// every stored task to `auto`.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

const { settings } = await import('../src/settings.js');
const { store } = await import('../src/store.js');
const { keyOf } = await import('../src/keys.js');
const { migrateTask } = await import('../src/mode.js');
const { demoWanted, setDemo } = await import('../src/pipeline.js');

let n = 9600;
const born = (project = 'hfs') => {
  n += 1;
  return store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, project);
};

test('demo setting: on by default, a project decides its own and null goes back to the board', () => {
  assert.equal(settings.demo, true);
  assert.equal(settings.demoFor('cualquiera'), true);
  settings.updateProject('demo-a', { demo: false });
  assert.equal(settings.demoFor('demo-a'), false);
  assert.equal(settings.demoFor('demo-b'), true);
  assert.equal(settings.snapshot().projects['demo-a'].demo, false);
  settings.updateProject('demo-a', { demo: null });
  assert.equal(settings.demoFor('demo-a'), true);
  assert.equal(settings.snapshot().projects['demo-a'], undefined);
  assert.equal(settings.update({ demo: false }).demo, false);
  assert.equal(settings.demoFor('demo-b'), false);
  settings.update({ demo: true });
});

test('demoWanted: auto follows the project, on and off decide', () => {
  const task = born();
  assert.equal(task.demo, 'auto', 'a new task is born following the project');
  assert.equal(task.demoMigrated, true);
  settings.updateProject(task.project, { demo: false });
  assert.equal(demoWanted(task), false);
  settings.updateProject(task.project, { demo: true });
  assert.equal(demoWanted(task), true);
  task.demo = 'on';
  settings.updateProject(task.project, { demo: false });
  assert.equal(demoWanted(task), true, 'on ignores the project');
  task.demo = 'off';
  settings.updateProject(task.project, { demo: true });
  assert.equal(demoWanted(task), false, 'off ignores the project');
  settings.updateProject(task.project, { demo: null });
  delete task.demo;
  assert.equal(demoWanted(task), true, 'a task without the field follows the project');
});

test('setDemo takes auto, on and off, and refuses anything else', () => {
  const task = born();
  assert.equal(setDemo(keyOf(task), 'off'), 'off');
  assert.equal(task.demo, 'off');
  assert.equal(setDemo(keyOf(task), 'auto'), 'auto');
  assert.equal(task.demo, 'auto');
  assert.throws(() => setDemo(keyOf(task), 'maybe'), /auto, on or off/);
});

test('migration: every stored demo becomes auto once, and a choice made afterwards survives', () => {
  const once = migrateTask({ state: 'done', demo: 'on' });
  assert.equal(once.demo, 'auto');
  assert.equal(once.demoMigrated, true);
  assert.equal(migrateTask({ state: 'done', demo: 'off' }).demo, 'auto');
  assert.equal(migrateTask({ state: 'done' }).demo, 'auto', 'no field at all');
  once.demo = 'off';
  assert.equal(migrateTask({ ...once }).demo, 'off', 'the second boot keeps the card choice');
  assert.equal(migrateTask({ state: 'done', demo: 'x', demoMigrated: true }).demo, 'auto', 'garbage reads as auto');
});
