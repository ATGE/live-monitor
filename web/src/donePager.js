// Pure helpers for the paginated "Completadas" strip. No React, no DOM.

export const ALL = Infinity;
export const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 10000;

function ts(v) {
  if (v == null || v === '') return NaN;
  return Date.parse(v);
}

// Completion time in ms. The latest of closing.closedAt and every PR's
// mergedAt/closedAt wins; if none exist, doneAt, then createdAt; else 0.
export function completedAt(task) {
  if (!task) return 0;
  const strong = [ts(task.closing?.closedAt)];
  for (const pr of Array.isArray(task.prs) ? task.prs : []) {
    strong.push(ts(pr?.mergedAt), ts(pr?.closedAt));
  }
  const valid = strong.filter(Number.isFinite);
  if (valid.length) return Math.max(...valid);
  for (const v of [task.doneAt, task.createdAt]) {
    const t = ts(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

// New array, most recently completed first; ties broken by issue number desc.
export function sortDone(tasks) {
  return [...(tasks || [])].sort((a, b) => {
    const d = completedAt(b) - completedAt(a);
    if (d !== 0) return d;
    return (Number(b?.issue) || 0) - (Number(a?.issue) || 0);
  });
}

export function normalizePageSize(raw) {
  if (raw === Infinity) return ALL;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'all' || s === 'todas' || s === 'infinity') return ALL;
    if (!/^\d+(\.\d+)?$/.test(s)) return DEFAULT_PAGE_SIZE;
    raw = Number(s);
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_PAGE_SIZE;
  const n = Math.floor(raw);
  if (n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

export function serializePageSize(size) {
  return size === Infinity ? 'all' : String(size);
}

export function pageCount(total, size) {
  if (size === Infinity) return 1;
  return Math.max(1, Math.ceil((Number(total) || 0) / size));
}

export function clampPage(page, pages) {
  const p = Math.floor(Number(page));
  if (!Number.isFinite(p)) return 1;
  return Math.min(Math.max(1, p), Math.max(1, pages));
}

export function pageSlice(items, page, size) {
  const list = items || [];
  if (size === Infinity) return list;
  const start = (page - 1) * size;
  return list.slice(start, start + size);
}

// Page buttons: always first, last and page±1. A single hidden page between
// two shown numbers is shown instead of an ellipsis.
export function pageWindow(page, pages) {
  const set = new Set([1, pages, page - 1, page, page + 1]);
  const nums = [...set].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    if (i > 0) {
      const gap = nums[i] - nums[i - 1];
      if (gap === 2) out.push(nums[i] - 1);
      else if (gap > 2) out.push('…');
    }
    out.push(nums[i]);
  }
  return out;
}
