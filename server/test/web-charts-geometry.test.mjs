import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// chartsGeometry.js is pure ESM: import it directly, like the other web tests
// that have no browser runner.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const g = await import(pathToFileURL(path.resolve(HERE, '../../web/src/chartsGeometry.js')).href);

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const near = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('ringDash: 0, 42, 100 and over 100 is clipped', () => {
  const r = 22;
  const c = 2 * Math.PI * r;
  assert.equal(g.ringDash(0, r).dash, 0);
  near(g.ringDash(42, r).dash, 0.42 * c);
  near(g.ringDash(100, r).dash, c);
  assert.equal(g.ringDash(250, r).dash, g.ringDash(100, r).dash);
  assert.equal(g.ringDash(-5, r).dash, 0);
  assert.equal(g.ringDash(NaN, r).dash, 0);
});

test('slotArcs: n arcs that add up to 360 minus the gaps', () => {
  for (const [n, gap] of [[6, 9], [1, 9], [4, 12], [24, 3]]) {
    const arcs = g.slotArcs(n, 22, gap);
    assert.equal(arcs.length, n);
    near(sum(arcs.map((a) => a.sweep)), 360 - n * gap, 0.1 * n);
  }
  assert.deepEqual(g.slotArcs(0, 22), []);
  assert.deepEqual(g.slotArcs(NaN, 22), []);
});

test('arcPath: starts at the top and never collapses a full sweep', () => {
  assert.match(g.arcPath(25, 25, 22, 0, 90), /^M25 3A22 22 0 0 1 47 25$/);
  assert.match(g.arcPath(25, 25, 22, 0, 360), /A22 22 0 1 1/);
});

test('sparkPoints: extremes touch the padded border; equal values are centred', () => {
  const s = g.sparkPoints([5, 1, 9], 100, 40, 4);
  assert.equal(s.points.length, 3);
  assert.equal(s.points[0].x, 4);
  assert.equal(s.points[2].x, 96);
  assert.equal(s.points[2].y, 4);
  assert.equal(s.points[1].y, 36);
  const flat = g.sparkPoints([7, 7, 7], 100, 40, 4);
  assert.ok(flat.points.every((p) => p.y === 20));
  assert.deepEqual(g.sparkPoints([3], 100, 40).points, []);
  assert.equal(g.sparkPoints([], 100, 40).line, '');
  assert.equal(g.sparkPoints([1, NaN, 3], 100, 40).points.length, 2);
});

test('columnRects: heights relative to the max, last flagged, zeros are a base mark', () => {
  const cols = g.columnRects([0, 2, 4], 84, 18, 2);
  assert.equal(cols.length, 3);
  assert.equal(cols[0].zero, true);
  assert.equal(cols[0].h, 1);
  assert.equal(cols[2].h, 18);
  assert.equal(cols[2].y, 0);
  assert.equal(cols[1].h, 9);
  assert.equal(cols[2].last, true);
  assert.equal(cols[1].last, false);
  near(cols[2].x + cols[2].w, 84, 0.02);
  assert.ok(g.columnRects([0, 0], 10, 10).every((c) => c.zero));
  assert.deepEqual(g.columnRects([], 10, 10), []);
});

test('unitCells: done + running + pending = total; over 24 is proportional', () => {
  const small = g.unitCells(5, 2, 9, 120, 2);
  assert.equal(small.mode, 'cells');
  assert.equal(small.cells.length, 9);
  assert.equal(small.done + small.running + small.pending, 9);
  assert.deepEqual(small.cells.map((c) => c.state).slice(4, 8), ['done', 'running', 'running', 'pending']);
  near(sum(small.cells.map((c) => c.w)) + 2 * 8, 120, 0.1);

  const big = g.unitCells(10, 5, 30, 120, 2);
  assert.equal(big.mode, 'proportional');
  assert.equal(big.done + big.running + big.pending, 30);
  assert.equal(big.cells.length, 3);
  near(sum(big.cells.map((c) => c.w)) + 2 * 2, 120, 0.1);

  const over = g.unitCells(8, 8, 10, 100);
  assert.equal(over.done + over.running + over.pending, 10);
  assert.equal(g.unitCells(1, 1, 0, 100).cells.length, 0);
  assert.equal(g.unitCells(-3, NaN, 4, 100).pending, 4);
});

test('segmentWidths: add up to the width minus the gaps; zero parts take no room', () => {
  const w = g.segmentWidths([3, 0, 1], 100, 2);
  assert.equal(w[1].w, 0);
  near(w[0].w + w[2].w, 98, 0.02);
  near(w[0].w / w[2].w, 3, 0.05);
  near(w[2].x, w[0].w + 2, 0.02);
  assert.ok(g.segmentWidths([0, 0], 100).every((s) => s.w === 0));
  near(g.segmentWidths([5], 52, 1)[0].w, 52, 0.01);
  assert.ok(g.segmentWidths([-1, NaN], 100).every((s) => s.w === 0));
});
