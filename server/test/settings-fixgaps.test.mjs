import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { settings } = await import('../src/settings.js');
const { store } = await import('../src/store.js');

test('fixGaps: apagado de serie y se enciende en todo el tablero', () => {
  assert.equal(settings.fixGaps, false);
  assert.equal(settings.fixGapsFor('cualquiera'), false);
  const snap = settings.update({ fixGaps: true });
  assert.equal(snap.fixGaps, true);
  assert.equal(settings.fixGaps, true);
  assert.equal(settings.fixGapsFor('sin-overlay'), true);
  settings.update({ fixGaps: false });
});

test('fixGaps: un proyecto decide lo suyo y null vuelve al tablero', () => {
  settings.update({ fixGaps: false });
  settings.updateProject('proj-a', { fixGaps: true });
  assert.equal(settings.fixGapsFor('proj-a'), true);
  assert.equal(settings.fixGapsFor('proj-b'), false);
  assert.equal(settings.snapshot().projects['proj-a'].fixGaps, true);
  settings.updateProject('proj-a', { fixGaps: null });
  assert.equal(settings.fixGapsFor('proj-a'), false);
  assert.equal(settings.snapshot().projects['proj-a'], undefined);
});

test('fixGaps: una tarea nueva nace con el valor del proyecto', () => {
  settings.update({ fixGaps: false });
  assert.equal(store.addTask({ number: 987654, title: 't', body: '', labels: [] }, 'hfs').fixGaps, 'off');
  settings.updateProject('hfs', { fixGaps: true });
  assert.equal(store.addTask({ number: 987655, title: 't', body: '', labels: [] }, 'hfs').fixGaps, 'on');
  settings.updateProject('hfs', { fixGaps: null });
  store.flush();
});
