import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROJECT_ID,
  PROJECT_ID_RE,
  isProjectId,
  makeKey,
  keyOf,
  parseKey,
  coerceKey,
  tasksFileOf,
} from '../src/keys.js';

// keys.js is pure: no disk, no config, no other server module. These tests
// import it and nothing else on purpose — if this file ever needs a fixture
// directory, the module has grown a dependency it was not supposed to have.

// --- the constants ---------------------------------------------------------

test('DEFAULT_PROJECT_ID is the board\'s original project, and is itself a valid id', () => {
  assert.equal(DEFAULT_PROJECT_ID, 'hfs');
  assert.ok(isProjectId(DEFAULT_PROJECT_ID));
});

test('isProjectId / PROJECT_ID_RE: lowercase alphanumerics and hyphens, never leading with one', () => {
  for (const ok of ['hfs', 'app-b', 'a', '0', 'x9-y8-z7']) {
    assert.ok(isProjectId(ok), ok);
    assert.ok(PROJECT_ID_RE.test(ok), ok);
  }
  for (const bad of [
    '-leading', 'Upper', 'has space', 'dot.ted', 'under_score', 'slash/ed',
    '..', '', 'acento-ñ', null, undefined, 12, true, {},
  ]) {
    assert.equal(isProjectId(bad), false, String(bad));
  }
});

// --- makeKey ---------------------------------------------------------------

test('makeKey builds the canonical form from a number or a canonical digit string', () => {
  assert.equal(makeKey('hfs', 12), 'hfs#12');
  assert.equal(makeKey('hfs', '12'), 'hfs#12');
  assert.equal(makeKey('app-b', 1), 'app-b#1');
  assert.equal(makeKey('hfs', 969), 'hfs#969');
});

test('makeKey throws on an invalid project — it never silently defaults', () => {
  for (const bad of ['-x', 'Upper', 'two words', '', null, undefined, 3, {}]) {
    assert.throws(() => makeKey(bad, 12), TypeError, `project ${String(bad)}`);
  }
});

test('makeKey throws on anything that is not a positive integer issue', () => {
  for (const bad of [0, -3, 1.5, NaN, Infinity, '012', '0', '12abc', '', ' 12', null, undefined, true, {}, []]) {
    assert.throws(() => makeKey('hfs', bad), TypeError, `issue ${String(bad)}`);
  }
});

// --- parseKey and the round trip -------------------------------------------

test('parseKey splits a canonical key, returning the issue as a number', () => {
  assert.deepEqual(parseKey('hfs#12'), { projectId: 'hfs', issue: 12 });
  assert.deepEqual(parseKey('app-b#7'), { projectId: 'app-b', issue: 7 });
  assert.deepEqual(parseKey('a#1'), { projectId: 'a', issue: 1 });
});

test('makeKey and parseKey are inverses, both ways round', () => {
  for (const [project, issue] of [['hfs', 12], ['app-b', 1], ['x9-y8', 4242]]) {
    const key = makeKey(project, issue);
    const back = parseKey(key);
    assert.equal(back.projectId, project);
    assert.equal(back.issue, issue);
    // …and back again: re-making from the parsed halves gives the same string.
    assert.equal(makeKey(back.projectId, back.issue), key);
  }
});

test('parseKey rejects every non-canonical spelling — two spellings of one task would be two Map entries', () => {
  for (const bad of [
    'hfs#012',        // leading zero
    'hfs#0',          // not a positive issue
    ' hfs#12',        // leading space
    'hfs#12 ',        // trailing space
    'hfs #12',        // space around the separator
    'HFS#12',         // uppercase project
    'hfs#12abc',      // trailing junk
    'hfs#',           // no issue
    '#12',            // no project
    '12',             // the bare number: that is coerceKey's job, not this one
    'hfs#12#13',      // two separators
    '-hfs#12',        // invalid project
    'hfs/12',         // wrong separator
    '',
    null, undefined, 12, true, {}, ['hfs#12'],
  ]) {
    assert.throws(() => parseKey(bad), TypeError, String(bad));
  }
});

// --- coerceKey: the whole behaviour table ----------------------------------

test('coerceKey: the behaviour table, verbatim', () => {
  assert.equal(coerceKey(12, 'hfs'), 'hfs#12', 'a bare number takes the default project');
  assert.equal(coerceKey('12', 'hfs'), 'hfs#12', 'a bare numeric string likewise');
  assert.equal(coerceKey('hfs#12', 'hfs'), 'hfs#12', 'an already-canonical key passes through');
  assert.equal(coerceKey('otro#12', 'hfs'), 'otro#12', 'an explicit key beats the default');
  assert.equal(coerceKey('hfs#012', 'hfs'), null, 'a leading zero is not canonical');
  for (const bad of ['12abc', NaN, true, null, {}]) {
    assert.equal(coerceKey(bad, 'hfs'), null, String(bad));
  }
});

test('coerceKey defaults to DEFAULT_PROJECT_ID when no default is passed', () => {
  assert.equal(coerceKey(12), 'hfs#12');
  assert.equal(coerceKey('12'), 'hfs#12');
  assert.equal(coerceKey('otro#12'), 'otro#12');
});

test('coerceKey never throws, whatever it is handed', () => {
  const junk = [
    undefined, null, NaN, Infinity, -Infinity, 0, -3, 1.5, true, false,
    '', ' ', '0', '007', '12abc', 'abc', '#', '#12', 'hfs#', 'hfs#0',
    'HFS#12', ' hfs#12', 'hfs#12 ', 'hfs#12#13', '-x#12',
    {}, [], [12], () => {}, Symbol('s'), 10n,
  ];
  for (const v of junk) {
    assert.doesNotThrow(() => coerceKey(v), String(typeof v));
    const out = coerceKey(v);
    assert.ok(out === null || typeof out === 'string', String(typeof v));
  }
});

test('coerceKey returns null — never throws — when the default project itself is invalid', () => {
  assert.equal(coerceKey(12, 'Upper'), null);
  assert.equal(coerceKey(12, ''), null);
  assert.equal(coerceKey(12, null), null);
  // …but an explicit key does not need the default at all, so it still works.
  assert.equal(coerceKey('otro#12', 'Upper'), 'otro#12');
});

test('coerceKey output always survives parseKey: whatever it returns is canonical', () => {
  for (const v of [12, '12', 'hfs#12', 'otro#12', 5, '4242']) {
    const key = coerceKey(v, 'hfs');
    assert.doesNotThrow(() => parseKey(key), String(v));
  }
});

// --- keyOf -----------------------------------------------------------------

test('keyOf builds the key of a task that has its project', () => {
  assert.equal(keyOf({ project: 'hfs', issue: 12 }), 'hfs#12');
  assert.equal(keyOf({ project: 'app-b', issue: '7' }), 'app-b#7');
});

test('keyOf throws when the task has no project — a silent default IS the collision', () => {
  // This is the whole point of the module: task #12 of the new project must
  // never quietly answer to `hfs#12` and overwrite the old one. The store is
  // responsible for stamping `project` when it LOADS a task, not when one is used.
  assert.throws(() => keyOf({ issue: 12 }), TypeError, 'project missing entirely');
  assert.throws(() => keyOf({ project: undefined, issue: 12 }), TypeError);
  assert.throws(() => keyOf({ project: null, issue: 12 }), TypeError);
  assert.throws(() => keyOf({ project: '', issue: 12 }), TypeError);
  assert.throws(() => keyOf({ project: 'Upper', issue: 12 }), TypeError, 'invalid project is no better than none');
});

test('keyOf names the offending task, so the log points at the bad row, not at the caller', () => {
  assert.throws(() => keyOf({ issue: 969 }), /969/);
  assert.throws(() => keyOf({ issue: 969 }), /project/);
});

test('keyOf throws on a missing or malformed issue, and on a non-task', () => {
  assert.throws(() => keyOf({ project: 'hfs' }), TypeError);
  assert.throws(() => keyOf({ project: 'hfs', issue: 0 }), TypeError);
  assert.throws(() => keyOf({ project: 'hfs', issue: '012' }), TypeError);
  for (const bad of [null, undefined, 'hfs#12', 12, true]) {
    assert.throws(() => keyOf(bad), TypeError, String(bad));
  }
});

// --- tasksFileOf -----------------------------------------------------------

test('tasksFileOf: the default project keeps today\'s tasks.json, untouched and unmigrated', () => {
  assert.equal(tasksFileOf(DEFAULT_PROJECT_ID), 'tasks.json');
  assert.equal(tasksFileOf('hfs'), 'tasks.json');
});

test('tasksFileOf: every other project gets its own file', () => {
  assert.equal(tasksFileOf('app-b'), 'tasks.app-b.json');
  assert.equal(tasksFileOf('a'), 'tasks.a.json');
});

test('tasksFileOf throws on an invalid id: this name becomes a path segment', () => {
  for (const bad of ['..', '../../etc', 'a/b', 'Upper', '', null, undefined, 12, {}]) {
    assert.throws(() => tasksFileOf(bad), TypeError, String(bad));
  }
});

test('tasksFileOf is pure: same input, same answer, no side effects', () => {
  assert.equal(tasksFileOf('app-b'), tasksFileOf('app-b'));
});
