import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, parseQuery, matchTask, highlightRanges, highlightNumberRange, isExempt,
} from '../../web/src/boardFilter.js';

const task = {
  project: 'hfs', issue: 1172, title: 'Corregir acentuación en Keycloak',
  prs: [{ number: 1180 }], prNumber: 1190,
};
const m = (q, t = task) => matchTask(t, parseQuery(q));

test('normalize strips accents and case', () => {
  assert.equal(normalize('Acentuación'), 'acentuacion');
  assert.equal(normalize(null), '');
});

test('numeric forms match the issue', () => {
  assert.ok(m('1172'));
  assert.ok(m('#1172'));
  assert.ok(m('hfs#1172'));
  assert.ok(!m('app-b#1172'));
  assert.ok(m('117'));
  assert.ok(!m('9999'));
});

test('PR numbers match', () => {
  assert.ok(m('1180'));
  assert.ok(m('1190'));
  assert.ok(m('hfs#118'));
});

test('title matching is accent-insensitive, any order, AND across tokens', () => {
  assert.ok(m('acentuacion'));
  assert.ok(m('keycloak corregir'));
  assert.ok(m('1172 keycloak'));
  assert.ok(!m('1172 postgres'));
  assert.ok(!m('zzz'));
});

test('empty query', () => {
  assert.equal(parseQuery(''), null);
  assert.equal(parseQuery('   \t'), null);
  assert.equal(matchTask(task, null), true);
});

test('highlightRanges over the original text', () => {
  const text = 'Corregir acentuación en Keycloak';
  const r = highlightRanges(text, parseQuery('ACENTUACION key'));
  assert.deepEqual(r.map(([a, b]) => text.slice(a, b)), ['acentuación', 'Key']);
  assert.deepEqual(highlightRanges(text, parseQuery('1172')), []);
  assert.deepEqual(highlightRanges(text, null), []);
  const merged = highlightRanges('abcd', parseQuery('ab bc'));
  assert.deepEqual(merged, [[0, 3]]);
});

test('highlightRanges handles decomposed accents', () => {
  const text = 'acentuación';
  const r = highlightRanges(text, parseQuery('acentuacion'));
  assert.deepEqual(r, [[0, text.length]]);
});

test('highlightNumberRange', () => {
  assert.equal(highlightNumberRange('1172', task, parseQuery('117')), true);
  assert.equal(highlightNumberRange('1172', task, parseQuery('hfs#1172')), true);
  assert.equal(highlightNumberRange('1172', task, parseQuery('other#1172')), false);
  assert.equal(highlightNumberRange('1172', task, parseQuery('1180')), false);
  assert.equal(highlightNumberRange('1172', task, parseQuery('keycloak')), false);
  assert.equal(highlightNumberRange('1172', task, null), false);
});

test('isExempt', () => {
  const a = new Set(['hfs#1172']);
  const o = new Set(['hfs#5']);
  assert.equal(isExempt(task, { awaitingKeys: a, openKeys: o }), true);
  assert.equal(isExempt({ project: 'hfs', issue: 5 }, { awaitingKeys: a, openKeys: o }), true);
  assert.equal(isExempt({ project: 'hfs', issue: 6 }, { awaitingKeys: a, openKeys: o }), false);
});

test('a bare number also matches a number written in the title', () => {
  const task = { issue: 5, project: 'hfs', title: 'Fix 404 error page', prs: [] };
  assert.equal(matchTask(task, parseQuery('404')), true);
  assert.equal(matchTask(task, parseQuery('999')), false);
});
