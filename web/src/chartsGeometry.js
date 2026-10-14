// Pure geometry for the SVG charts in components/charts/. No JSX, no DOM: the
// components only turn these numbers into elements, and the tests import this
// file directly. Everything is rounded to 2 decimals and defensive against NaN,
// negatives and zero totals (a chart must never throw while the board polls).

const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (Number.isFinite(v) ? v : 0);
const nonNeg = (v) => Math.max(0, num(v));

/** stroke-dasharray pair for a ring of radius `r`: the lit arc and the full circle. */
export function ringDash(percent, r) {
  const radius = nonNeg(r);
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(100, nonNeg(percent));
  return {
    dash: r2((pct / 100) * circumference),
    circumference: r2(circumference),
    percent: r2(pct),
  };
}

/** Point on a circle; 0 deg is 12 o'clock and angles grow clockwise. */
function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [r2(cx + r * Math.cos(rad)), r2(cy + r * Math.sin(rad))];
}

/** SVG path of a clockwise arc from a0 to a1 degrees (0 = top). */
export function arcPath(cx, cy, r, a0, a1) {
  const start = nonNeg(a0);
  const end = Math.max(start, num(a1));
  const sweep = Math.min(end - start, 359.99);
  const [x0, y0] = polar(cx, cy, r, start);
  const [x1, y1] = polar(cx, cy, r, start + sweep);
  return `M${x0} ${y0}A${r2(r)} ${r2(r)} 0 ${sweep > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

/**
 * One arc per slot with an angular gap between neighbours. The arcs add up to
 * 360 minus the gaps. `r` is accepted for symmetry with arcPath (the angles do
 * not depend on it). A single slot is a nearly full circle with one gap.
 */
export function slotArcs(total, r, gapDeg = 9) {
  const n = Math.floor(nonNeg(total));
  if (n === 0) return [];
  const gap = Math.min(nonNeg(gapDeg), 360 / n - 0.01);
  const step = 360 / n;
  const arcs = [];
  for (let i = 0; i < n; i += 1) {
    const a0 = r2(i * step + gap / 2);
    const a1 = r2((i + 1) * step - gap / 2);
    arcs.push({ index: i, a0, a1, sweep: r2(a1 - a0) });
  }
  return arcs;
}

/**
 * Line geometry for a sparkline. The smallest value sits on the bottom edge and
 * the largest on the top edge, both inset by `pad`; equal values are a flat
 * line through the middle. Fewer than two usable values draw nothing.
 */
export function sparkPoints(values, w, h, pad = 4) {
  const vs = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v));
  const empty = { points: [], line: '', area: '', last: null, min: 0, max: 0 };
  if (vs.length < 2) return empty;
  const width = nonNeg(w);
  const height = nonNeg(h);
  const p = Math.min(nonNeg(pad), width / 2, height / 2);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min;
  const innerW = width - 2 * p;
  const innerH = height - 2 * p;
  const points = vs.map((v, i) => ({
    x: r2(p + (i * innerW) / (vs.length - 1)),
    y: span === 0 ? r2(height / 2) : r2(p + innerH - ((v - min) / span) * innerH),
  }));
  const line = points.map((q) => `${q.x},${q.y}`).join(' ');
  const base = r2(height - p);
  const area = `M${points[0].x},${base} L${points.map((q) => `${q.x},${q.y}`).join(' L')} L${points[points.length - 1].x},${base} Z`;
  return { points, line, area, last: points[points.length - 1], min, max };
}

/**
 * Columns for a small bar series. Heights are relative to the largest value;
 * a non-zero value is never thinner than 2 px and a zero is a 1 px base mark
 * (flagged `zero`). The last column is flagged `last` (today).
 */
export function columnRects(values, w, h, gap = 2) {
  const vs = (Array.isArray(values) ? values : []).map(nonNeg);
  const n = vs.length;
  if (n === 0) return [];
  const width = nonNeg(w);
  const height = nonNeg(h);
  const g = Math.min(nonNeg(gap), n > 1 ? width / (n - 1) : 0);
  const bw = (width - g * (n - 1)) / n;
  const max = Math.max(...vs);
  return vs.map((v, i) => {
    const zero = v === 0 || max === 0;
    const bh = zero ? Math.min(1, height) : Math.min(height, Math.max(2, (v / max) * height));
    return {
      x: r2(i * (bw + g)),
      y: r2(height - bh),
      w: r2(bw),
      h: r2(bh),
      zero,
      last: i === n - 1,
    };
  });
}

/**
 * Widths of consecutive parts inside `width`, with `gap` between the parts that
 * are present. A part of 0 takes no room and no gap. The widths add up to
 * `width` minus the gaps (all zero when every part is 0).
 */
export function segmentWidths(parts, width, gap = 2) {
  const ps = (Array.isArray(parts) ? parts : []).map(nonNeg);
  const total = ps.reduce((a, b) => a + b, 0);
  const present = ps.filter((p) => p > 0).length;
  if (total === 0) return ps.map(() => ({ x: 0, w: 0 }));
  const usable = Math.max(0, nonNeg(width) - nonNeg(gap) * (present - 1));
  let x = 0;
  let seen = 0;
  return ps.map((p) => {
    if (p === 0) return { x: r2(x), w: 0 };
    const w = (p / total) * usable;
    const seg = { x: r2(x), w: r2(w) };
    seen += 1;
    x += w + (seen < present ? nonNeg(gap) : 0);
    return seg;
  });
}

export const MAX_UNIT_CELLS = 24;

/**
 * Cells of a unit bar. Up to 24 units: one cell per unit (done, then running,
 * then pending). Beyond that: three proportional stretches. done + running
 * stay within total; whatever is left is pending.
 */
export function unitCells(done, running, total, width, gap = 2) {
  const t = Math.floor(nonNeg(total));
  const d = Math.min(Math.floor(nonNeg(done)), t);
  const r = Math.min(Math.floor(nonNeg(running)), t - d);
  const pending = t - d - r;
  const counts = { done: d, running: r, pending, total: t };
  if (t === 0) return { mode: 'cells', ...counts, cells: [] };
  if (t <= MAX_UNIT_CELLS) {
    const cw = (nonNeg(width) - nonNeg(gap) * (t - 1)) / t;
    const cells = [];
    for (let i = 0; i < t; i += 1) {
      cells.push({
        x: r2(i * (cw + nonNeg(gap))),
        w: r2(cw),
        state: i < d ? 'done' : i < d + r ? 'running' : 'pending',
      });
    }
    return { mode: 'cells', ...counts, cells };
  }
  const states = ['done', 'running', 'pending'];
  const cells = segmentWidths([d, r, pending], width, gap)
    .map((s, i) => ({ ...s, state: states[i] }))
    .filter((s) => s.w > 0);
  return { mode: 'proportional', ...counts, cells };
}
