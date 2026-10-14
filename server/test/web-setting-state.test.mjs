import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** settingState.js is pure ESM so node can import it; the cards and the menu share it. */
const WEB = path.resolve(import.meta.dirname, '..', '..', 'web', 'src');
const S = await import(pathToFileURL(path.join(WEB, 'settingState.js')).href);

test('option lists: three values, and the two-valued subset', () => {
  assert.deepEqual(S.TRI_OPTIONS.map((o) => o.value), ['on', 'off', 'auto']);
  assert.deepEqual(S.TRI_OPTIONS.map((o) => o.label), ['Activar', 'Desactivar', 'Automático']);
  assert.deepEqual(S.DUO_OPTIONS.map((o) => o.value), ['on', 'off']);
});

test('statusText', () => {
  assert.equal(S.statusText(true), 'sí');
  assert.equal(S.statusText(false), 'no');
});

test('demo: auto follows the server (demoWanted) and says "según el proyecto"', () => {
  let r = S.taskTriState({}, 'demo');
  assert.equal(r.value, 'auto');
  assert.equal(r.effective, true);
  assert.equal(r.source, 'según el proyecto');
  assert.equal(r.locked, false);
  assert.equal(S.taskTriState({ demoWanted: false }, 'demo').effective, false);
  // The server's answer wins over the task's own value.
  assert.equal(S.taskTriState({ demo: 'on', demoWanted: false }, 'demo').effective, false);
  r = S.taskTriState({ demo: 'off' }, 'demo');
  assert.equal(r.value, 'off');
  assert.equal(r.effective, false);
  assert.equal(r.source, 'elegido en esta tarea');
  r = S.taskTriState({ demo: 'on' }, 'demo');
  assert.equal(r.value, 'on');
  assert.equal(r.effective, true);
  assert.ok(r.detail.length > 0);
});

test('browserQa: auto/on/off, qaUi === false, and locked by the project', () => {
  let r = S.taskTriState({ qaUi: true }, 'browserQa');
  assert.deepEqual([r.value, r.effective, r.locked, r.source], ['auto', true, false, 'según el triage']);
  assert.equal(S.taskTriState({}, 'browserQa').effective, true);
  r = S.taskTriState({ qaUi: false }, 'browserQa');
  assert.equal(r.effective, false);
  assert.equal(r.value, 'auto');
  r = S.taskTriState({ qaUi: false, browserQa: 'on' }, 'browserQa');
  assert.deepEqual([r.value, r.effective, r.source], ['on', true, 'elegido en esta tarea']);
  r = S.taskTriState({ qaUi: true, browserQa: 'off' }, 'browserQa');
  assert.deepEqual([r.value, r.effective], ['off', false]);
  r = S.taskTriState({ browserQaProjectOn: false, browserQa: 'on', qaUi: true }, 'browserQa');
  assert.deepEqual([r.locked, r.effective, r.source], [true, false, 'apagado en el proyecto']);
  assert.equal(S.taskTriState({ browserQaProjectOn: true }, 'browserQa').locked, false);
});

for (const [key, wanted] of [['approvePlan', 'approvePlanWanted'], ['fixGaps', 'fixGapsWanted']]) {
  test(`${key}: own choice, else the board's (${wanted})`, () => {
    let r = S.taskTriState({}, key);
    assert.deepEqual([r.value, r.effective, r.source, r.locked], ['auto', false, 'según el tablero', false]);
    assert.equal(S.taskTriState({ [wanted]: true }, key).effective, true);
    assert.equal(S.taskTriState({ [wanted]: 'yes' }, key).effective, false); // strictly === true
    r = S.taskTriState({ [key]: 'on' }, key);
    assert.deepEqual([r.value, r.effective, r.source], ['on', true, 'elegido en esta tarea']);
    r = S.taskTriState({ [key]: 'off', [wanted]: true }, key);
    assert.deepEqual([r.value, r.effective], ['off', false]);
  });
}

test('taskTriState rejects an unknown key', () => {
  assert.throws(() => S.taskTriState({}, 'nope'));
});

test('projectTriState: own override vs "según el tablero", defaults per key', () => {
  // Default-on keys: effective unless the value is explicitly false.
  for (const key of ['autoStart', 'browserQa', 'demo']) {
    let r = S.projectTriState({}, {}, key, true);
    assert.deepEqual([r.value, r.effective, r.source], ['auto', true, 'según el tablero'], key);
    r = S.projectTriState({}, { [key]: false }, key, true);
    assert.deepEqual([r.value, r.effective, r.source], ['auto', false, 'según el tablero'], key);
    r = S.projectTriState({ [key]: false }, { [key]: true }, key, true);
    assert.deepEqual([r.value, r.effective, r.source], ['off', false, 'propio de este proyecto'], key);
    r = S.projectTriState({ [key]: true }, {}, key, true);
    assert.deepEqual([r.value, r.effective, r.source], ['on', true, 'propio de este proyecto'], key);
  }
  // Default-off keys: effective only when the value is exactly true.
  for (const key of ['approvePlan', 'fixGaps']) {
    let r = S.projectTriState({}, {}, key, true);
    assert.deepEqual([r.value, r.effective, r.source], ['auto', false, 'según el tablero'], key);
    r = S.projectTriState({}, { [key]: true }, key, true);
    assert.deepEqual([r.value, r.effective], ['auto', true], key);
    r = S.projectTriState({ [key]: true }, { [key]: false }, key, true);
    assert.deepEqual([r.value, r.effective, r.source], ['on', true, 'propio de este proyecto'], key);
  }
});

test('projectTriState with no active project is the flat board setting, never "auto"', () => {
  let r = S.projectTriState({}, { demo: false }, 'demo', false);
  assert.deepEqual([r.value, r.effective, r.source], ['off', false, 'según el tablero']);
  r = S.projectTriState({}, {}, 'approvePlan', false);
  assert.deepEqual([r.value, r.effective], ['off', false]);
  r = S.projectTriState(undefined, undefined, 'autoStart', false);
  assert.deepEqual([r.value, r.effective], ['on', true]);
});

test('triToProject', () => {
  assert.equal(S.triToProject('on'), true);
  assert.equal(S.triToProject('off'), false);
  assert.equal(S.triToProject('auto'), null);
});
