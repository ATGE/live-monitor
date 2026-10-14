import './isolate.mjs';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { settings, DEFAULT_REQUIRED_PLUGINS, REQUIRED_PLUGIN_RE, MAX_REQUIRED_PLUGINS } from '../src/settings.js';

beforeEach(() => {
  settings.update({ requiredPlugins: [...DEFAULT_REQUIRED_PLUGINS] });
});

test('a fresh board requires frontend-design from the official marketplace', () => {
  assert.deepEqual(DEFAULT_REQUIRED_PLUGINS, ['frontend-design@claude-plugins-official']);
  assert.deepEqual(settings.snapshot().requiredPlugins, ['frontend-design@claude-plugins-official']);
  assert.deepEqual(settings.requiredPlugins, ['frontend-design@claude-plugins-official']);
});

test('update trims, drops repeats, persists, and the list is board-wide (not per project)', () => {
  settings.update({ requiredPlugins: ['  a-b@market ', 'a-b@market', 'c.d@m_2'.replace('_', '-')] });
  assert.deepEqual(settings.requiredPlugins, ['a-b@market', 'c.d@m-2']);
  const onDisk = JSON.parse(readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
  assert.deepEqual(onDisk.requiredPlugins, ['a-b@market', 'c.d@m-2']);
  assert.throws(() => settings.updateProject('p1', { requiredPlugins: ['x@y'] }));
});

test('an empty list is allowed: nothing is required', () => {
  settings.update({ requiredPlugins: [] });
  assert.deepEqual(settings.requiredPlugins, []);
});

test('invalid lists throw and keep the previous value', () => {
  const before = settings.requiredPlugins;
  for (const bad of ['frontend-design@x', null, {}, [1], ['no-marketplace'], ['a@b@c'], ['bad id@m'], ['@m'], ['a@'], ['a/b@m'], ['--flag@m']]) {
    assert.throws(() => settings.update({ requiredPlugins: bad }), /requiredPlugins/, JSON.stringify(bad));
  }
  assert.throws(() => settings.update({ requiredPlugins: Array.from({ length: MAX_REQUIRED_PLUGINS + 1 }, (_, i) => `p${i}@m`) }), /requiredPlugins/);
  assert.deepEqual(settings.requiredPlugins, before);
});

test('the id regex accepts name@marketplace and nothing that could be a flag or a shell word', () => {
  assert.ok(REQUIRED_PLUGIN_RE.test('frontend-design@claude-plugins-official'));
  for (const bad of ['-x@m', 'a b@m', 'a;rm@m', 'a@m;x', 'a@m\n', '']) assert.equal(REQUIRED_PLUGIN_RE.test(bad), false, JSON.stringify(bad));
});

test('requiredPlugins is not an OVERRIDABLE per-project key', () => {
  assert.throws(() => settings.updateProject('p1', { requiredPlugins: [] }), /requiredPlugins/);
});
