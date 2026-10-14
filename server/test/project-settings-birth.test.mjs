import './isolate.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// A task is born with its project's effective values (the project's own
// override, else the board's), copied once: moving a switch later only affects
// tasks created afterwards.

const { settings } = await import('../src/settings.js');
const { store } = await import('../src/store.js');
const { config } = await import('../src/config.js');

const savedMachines = config.machines;
const savedFlat = {
  browserQa: settings.browserQa,
  approvePlan: settings.approvePlan,
  fixGaps: settings.fixGaps,
  defaultMachine: settings.defaultMachine,
};
const PROJECTS = ['birth-a', 'birth-b', 'birth-c'];

let n = 770000;
const born = (project) => {
  n += 1;
  return store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, project);
};

before(() => {
  config.machines = {
    local: { kind: 'local', repoPath: process.cwd(), worktreeRoot: process.cwd() },
    box: { kind: 'runner', url: 'http://127.0.0.1:1', token: 't', repoPath: process.cwd(), worktreeRoot: process.cwd() },
  };
});

after(() => {
  for (const p of PROJECTS) settings.updateProject(p, { browserQa: null, approvePlan: null, fixGaps: null, demo: null, defaultMachine: null });
  if (savedMachines === undefined) delete config.machines;
  else config.machines = savedMachines;
  settings.update(savedFlat);
  store.flush();
});

test('birth: a project with overrides gets them, a project without gets the board values', () => {
  settings.update({ browserQa: true, approvePlan: false, fixGaps: false, defaultMachine: 'local' });
  settings.updateProject('birth-a', { browserQa: false, approvePlan: true, fixGaps: true, defaultMachine: 'box' });

  const own = born('birth-a');
  assert.equal(own.browserQa, 'off');
  assert.equal(own.approvePlan, 'on');
  assert.equal(own.fixGaps, 'on');
  assert.equal(own.machine, 'box');

  const inherited = born('birth-c');
  assert.equal(inherited.browserQa, 'auto', 'board Browser QA on: the triage decides');
  assert.equal(inherited.approvePlan, 'off');
  assert.equal(inherited.fixGaps, 'off');
  assert.equal(inherited.machine, 'local');
});

test('birth: demo is born auto whatever the project says, and follows it live', () => {
  settings.updateProject('birth-a', { demo: false });
  assert.equal(born('birth-a').demo, 'auto');
  assert.equal(born('birth-c').demo, 'auto');
  settings.updateProject('birth-a', { demo: null });
});

test('birth: a project without overrides follows the board when the board is flipped', () => {
  settings.update({ browserQa: false, approvePlan: true, fixGaps: true, defaultMachine: 'box' });
  const t = born('birth-c');
  assert.equal(t.browserQa, 'off');
  assert.equal(t.approvePlan, 'on');
  assert.equal(t.fixGaps, 'on');
  assert.equal(t.machine, 'box');
});

test('birth: two projects with opposite values never leak into each other', () => {
  settings.update({ browserQa: true, approvePlan: false, fixGaps: false, defaultMachine: 'local' });
  settings.updateProject('birth-a', { browserQa: false, approvePlan: true, fixGaps: true, defaultMachine: 'box' });
  settings.updateProject('birth-b', { browserQa: true, approvePlan: false, fixGaps: false, defaultMachine: 'local' });

  const a = born('birth-a');
  const b = born('birth-b');
  assert.deepEqual([a.browserQa, a.approvePlan, a.fixGaps, a.machine], ['off', 'on', 'on', 'box']);
  assert.deepEqual([b.browserQa, b.approvePlan, b.fixGaps, b.machine], ['auto', 'off', 'off', 'local']);
});

test('birth: the values are copied, so changing the project afterwards leaves the task alone', () => {
  settings.update({ browserQa: true, approvePlan: false, fixGaps: false, defaultMachine: 'local' });
  settings.updateProject('birth-a', { browserQa: true, approvePlan: false, fixGaps: false, defaultMachine: 'local' });
  const t = born('birth-a');
  assert.deepEqual([t.browserQa, t.approvePlan, t.fixGaps, t.machine], ['auto', 'off', 'off', 'local']);

  settings.updateProject('birth-a', { browserQa: false, approvePlan: true, fixGaps: true, defaultMachine: 'box' });
  settings.update({ browserQa: false, approvePlan: true, fixGaps: true });
  assert.deepEqual([t.browserQa, t.approvePlan, t.fixGaps, t.machine], ['auto', 'off', 'off', 'local'], 'a stored on/off/machine does not follow the setting');

  const later = born('birth-a');
  assert.deepEqual([later.browserQa, later.approvePlan, later.fixGaps, later.machine], ['off', 'on', 'on', 'box']);
});

test('birth: the design mark is off, whatever the project says', () => {
  assert.equal(born('birth-a').design, false);
  assert.equal(born('birth-c').design, false);
});
