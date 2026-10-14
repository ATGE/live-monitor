import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completedAt, sortDone, ALL, DEFAULT_PAGE_SIZE, normalizePageSize,
  serializePageSize, pageCount, clampPage, pageSlice, pageWindow,
} from '../../web/src/donePager.js';

const iso = (s) => Date.parse(s);

test('completedAt: PR/closing timestamps beat doneAt, then createdAt, then 0', () => {
  const t = {
    doneAt: '2026-05-01T00:00:00Z',
    closing: { closedAt: '2026-03-01T00:00:00Z' },
    prs: [{ mergedAt: '2026-04-01T00:00:00Z' }, { closedAt: '2026-02-01T00:00:00Z' }],
    createdAt: '2026-01-01T00:00:00Z',
  };
  assert.equal(completedAt(t), iso('2026-04-01T00:00:00Z'));
  assert.equal(completedAt({ ...t, prs: [], closing: { closedAt: '2026-03-01T00:00:00Z' } }), iso('2026-03-01T00:00:00Z'));
  assert.equal(completedAt({ ...t, prs: [], closing: null }), iso('2026-05-01T00:00:00Z'));
  assert.equal(completedAt({ createdAt: '2026-01-01T00:00:00Z' }), iso('2026-01-01T00:00:00Z'));
  assert.equal(completedAt({ doneAt: 'garbage', createdAt: '2026-01-01T00:00:00Z' }), iso('2026-01-01T00:00:00Z'));
  assert.equal(completedAt({}), 0);
  assert.equal(completedAt(null), 0);
});

test('sortDone: desc by completion, tie by issue desc, no mutation', () => {
  const a = { issue: 1, doneAt: '2026-01-02T00:00:00Z' };
  const b = { issue: 2, doneAt: '2026-01-03T00:00:00Z' };
  const c = { issue: 9, doneAt: '2026-01-02T00:00:00Z' };
  const input = [a, b, c];
  const out = sortDone(input);
  assert.deepEqual(out.map((x) => x.issue), [2, 9, 1]);
  assert.deepEqual(input.map((x) => x.issue), [1, 2, 9]);
  assert.notEqual(out, input);
});

test('normalizePageSize', () => {
  assert.equal(normalizePageSize('50'), 50);
  assert.equal(normalizePageSize(50), 50);
  assert.equal(normalizePageSize('0'), DEFAULT_PAGE_SIZE);
  assert.equal(normalizePageSize(-3), DEFAULT_PAGE_SIZE);
  assert.equal(normalizePageSize('abc'), DEFAULT_PAGE_SIZE);
  assert.equal(normalizePageSize('Todas'), ALL);
  assert.equal(normalizePageSize('ALL'), ALL);
  assert.equal(normalizePageSize(Infinity), ALL);
  assert.equal(normalizePageSize(12.7), 12);
  assert.equal(normalizePageSize(99999), 10000);
  assert.equal(normalizePageSize(null), DEFAULT_PAGE_SIZE);
  assert.equal(normalizePageSize(NaN), DEFAULT_PAGE_SIZE);
  assert.equal(normalizePageSize(undefined), DEFAULT_PAGE_SIZE);
});

test('serializePageSize round-trips', () => {
  for (const s of [1, 25, 50, 10000, Infinity]) {
    assert.equal(normalizePageSize(serializePageSize(s)), s);
  }
  assert.equal(serializePageSize(Infinity), 'all');
  assert.equal(serializePageSize(20), '20');
});

test('pageCount', () => {
  assert.equal(pageCount(0, 50), 1);
  assert.equal(pageCount(50, 50), 1);
  assert.equal(pageCount(51, 50), 2);
  assert.equal(pageCount(551, 50), 12);
  assert.equal(pageCount(551, Infinity), 1);
});

test('clampPage', () => {
  assert.equal(clampPage(5, 3), 3);
  assert.equal(clampPage(0, 3), 1);
  assert.equal(clampPage(-2, 3), 1);
  assert.equal(clampPage(NaN, 3), 1);
  assert.equal(clampPage(2, 3), 2);
  assert.equal(clampPage(7, 12), 7);
});

test('pageSlice', () => {
  const items = Array.from({ length: 11 }, (_, i) => i + 1);
  assert.deepEqual(pageSlice(items, 1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageSlice(items, 2, 5), [6, 7, 8, 9, 10]);
  assert.deepEqual(pageSlice(items, 3, 5), [11]);
  assert.deepEqual(pageSlice(items, 1, Infinity), items);
});

test('pageWindow', () => {
  assert.deepEqual(pageWindow(5, 12), [1, '…', 4, 5, 6, '…', 12]);
  assert.deepEqual(pageWindow(2, 4), [1, 2, 3, 4]);
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(1, 12), [1, 2, '…', 12]);
  assert.deepEqual(pageWindow(12, 12), [1, '…', 11, 12]);
  assert.deepEqual(pageWindow(4, 12), [1, 2, 3, 4, 5, '…', 12]);
});

test('the default page size is 15', () => {
  assert.equal(DEFAULT_PAGE_SIZE, 15);
  assert.equal(normalizePageSize('abc'), 15);
});
