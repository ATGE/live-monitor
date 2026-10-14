import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrList } from '../src/github.js';

// `normalizePrList` is the only piece of the PR-cycle contract that does not
// touch `gh` — everything else in github.js is a thin wrapper around a
// command. These tests exercise the shape and sort rules against payloads
// shaped like `gh pr list --json number,url,title,state,isDraft,createdAt,
// mergedAt,closedAt` without spawning anything.

const pr = (over) => ({
  number: 1, url: 'https://github.com/x/y/pull/1', title: 't',
  state: 'OPEN', isDraft: false, createdAt: '2026-01-01T00:00:00Z',
  mergedAt: null, closedAt: null, ...over,
});

test('isDraft folds into state, and the raw isDraft flag does not leak through', () => {
  const [out] = normalizePrList([pr({ isDraft: true, state: 'OPEN' })]);
  assert.equal(out.state, 'DRAFT');
  assert.equal(out.isDraft, undefined);
});

test('a non-draft OPEN/MERGED/CLOSED state passes through unchanged', () => {
  for (const state of ['OPEN', 'MERGED', 'CLOSED']) {
    const [out] = normalizePrList([pr({ state, isDraft: false })]);
    assert.equal(out.state, state);
  }
});

test('newest createdAt sorts first, regardless of input order', () => {
  const oldest = pr({ number: 1, createdAt: '2026-01-01T00:00:00Z' });
  const middle = pr({ number: 2, createdAt: '2026-06-01T00:00:00Z' });
  const newest = pr({ number: 3, createdAt: '2026-09-01T00:00:00Z' });
  const out = normalizePrList([oldest, newest, middle]);
  assert.deepEqual(out.map((p) => p.number), [3, 2, 1]);
});

test('carries mergedAt/closedAt through untouched, defaulting missing fields to null', () => {
  const [out] = normalizePrList([{ number: 5, url: 'u', state: 'MERGED', isDraft: false, createdAt: '2026-01-01T00:00:00Z', mergedAt: '2026-02-01T00:00:00Z' }]);
  assert.equal(out.mergedAt, '2026-02-01T00:00:00Z');
  assert.equal(out.closedAt, null);
  assert.equal(out.title, '');
});

test('a PR with no createdAt sorts as if it were the oldest, not first or thrown out', () => {
  const noDate = pr({ number: 9, createdAt: null });
  const dated = pr({ number: 10, createdAt: '2026-01-01T00:00:00Z' });
  const out = normalizePrList([noDate, dated]);
  assert.deepEqual(out.map((p) => p.number), [10, 9]);
});

test('empty and nullish input both come back as an empty list', () => {
  assert.deepEqual(normalizePrList([]), []);
  assert.deepEqual(normalizePrList(null), []);
  assert.deepEqual(normalizePrList(undefined), []);
});
