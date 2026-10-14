/**
 * Pure figures for the KPI strip: no React, no DOM, no clock of its own (every
 * function that needs "now" takes it), so node can test it with fixed dates.
 */
import { BUSY_STATES } from './status.js';
import { completedAt } from './donePager.js';
import { dayKey, hhmm, parseTs } from './time.js';
import { strings } from './i18n/index.js';

export const OPEN_ORDER = ['running', 'waiting', 'queued', 'review', 'error'];
// `label` is a getter over the catalog (`shared.open`): `openByState` spreads the
// entry, which reads the text of the language in use at that moment.
const openEntry = (key, icon) => ({ get label() { return strings().shared.open[key]; }, icon });
export const OPEN_META = {
  running: openEntry('running', 'dot'),
  waiting: openEntry('waiting', 'help-circle'),
  queued: openEntry('queued', 'circle'),
  review: openEntry('review', 'eye'),
  error: openEntry('error', 'x-circle'),
};

const REVIEW_STATES = ['pr_draft', 'ready', 'waiting_approval', 'plan_ready'];

/**
 * The one bucket an open task counts in, so the legend adds up to the total.
 * States and reasons overlap (a `fixing` task with a question is both running
 * and waiting), hence a priority: error > waiting > running > review > queued.
 * Manual tasks at rest fall into `queued`; `unconfirmed` ones do not, because
 * the server adds the reason 'modo' to `awaitingYou` (server/src/index.js,
 * `awaitingYou`), so they count as `waiting`. `done` is not open.
 */
export function openBucket(task) {
  if (!task || task.state === 'done') return null;
  if (task.state === 'error') return 'error';
  if ((task.awaitingYou ?? []).length > 0) return 'waiting';
  if (BUSY_STATES.includes(task.state)) return 'running';
  if (REVIEW_STATES.includes(task.state)) return 'review';
  return 'queued';
}

/** Open tasks per bucket; `segments` holds only the non-empty ones, `zero` the empty keys. */
export function openByState(tasks) {
  const counts = Object.fromEntries(OPEN_ORDER.map((k) => [k, 0]));
  let total = 0;
  for (const t of tasks ?? []) {
    const b = openBucket(t);
    if (!b) continue;
    counts[b] += 1;
    total += 1;
  }
  const segments = OPEN_ORDER.filter((k) => counts[k] > 0).map((key) => ({ key, n: counts[key], ...OPEN_META[key] }));
  const zero = OPEN_ORDER.filter((k) => counts[k] === 0);
  return { total, counts, segments, zero };
}

/** Sum of every task's `running` counters; `pending` is what has not started yet. */
export function agentsSummary(tasks) {
  const out = { running: 0, done: 0, total: 0, pending: 0, commands: 0, servers: 0 };
  for (const t of tasks ?? []) {
    const r = t?.running;
    if (!r) continue;
    out.running += r.agents?.running ?? 0;
    out.done += r.agents?.done ?? 0;
    out.total += r.agents?.total ?? 0;
    out.commands += r.commands ?? 0;
    out.servers += r.servers ?? 0;
  }
  out.pending = Math.max(0, out.total - out.done - out.running);
  return out;
}

export const SESSION_MS = 5 * 3600e3;
export const WEEK_MS = 7 * 24 * 3600e3;
const HOUR_MS = 3600e3;

/**
 * Linear estimate of a quota window, from one usage row and `now` (epoch ms).
 * The window start is taken as `resetsAt - windowMs` and consumption is assumed
 * even since then; the real 5 h window opens with the first message, so this is
 * an approximation, not a measurement. `ratePerHour` is the average so far,
 * `budgetPerHour` the most that can still be spent per hour to reach the reset,
 * and `exhaustAt` (epoch ms) is set only when the average rate empties the
 * window before `resetsAt`. Null without `resetsAt` or a known window.
 */
export function quotaPace(row, now) {
  if (!row || row.resetsAt == null) return null;
  const windowMs = row.group === 'session' ? SESSION_MS : row.group === 'weekly' ? WEEK_MS : null;
  if (!windowMs) return null;
  const percent = Number(row.percent) || 0;
  const startAt = row.resetsAt - windowMs;
  const elapsedH = Math.max(0, (now - startAt) / HOUR_MS);
  const leftH = Math.max(0, (row.resetsAt - now) / HOUR_MS);
  const ratePerHour = elapsedH < 0.05 ? null : percent / elapsedH;
  const budgetPerHour = leftH > 0 ? (100 - percent) / leftH : null;
  let exhaustAt = null;
  if (ratePerHour && ratePerHour > 0) {
    const at = startAt + (100 / ratePerHour) * HOUR_MS;
    if (at < row.resetsAt) exhaustAt = at;
  }
  return { windowMs, startAt, elapsedH, leftH, ratePerHour, budgetPerHour, exhaustAt };
}

/** Pace is hidden when the usage figures are stale or only inferred from events. */
export function paceTrusted(usage) {
  return Boolean(usage) && !usage.stale && usage.source !== 'events';
}

/**
 * Nearest-rank percentile (p in 0..1) of an ascending list; null when empty.
 * Same formula as `percentile` in server/src/metrics.js (which sorts first).
 */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * Wall-clock durations of the newest `n` finished tasks that have timing data.
 * `considered` is how many `done` tasks there were to look at, for «n de 20».
 */
export function recentDurations(tasks, n = 20) {
  const done = (tasks ?? []).filter((t) => t?.state === 'done');
  const withTiming = done.filter((t) => t.timing?.wallMs != null);
  const newest = withTiming.sort((a, b) => completedAt(b) - completedAt(a)).slice(0, n);
  const values = newest.map((t) => t.timing.wallMs).reverse();
  const sorted = [...values].sort((a, b) => a - b);
  let median = null;
  if (sorted.length) {
    const mid = sorted.length >> 1;
    median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return { values, n: values.length, considered: done.length, median, p90: percentile(sorted, 0.9) };
}

/** True when `completedAt` came from a real event, not the `createdAt` last resort. */
function hasRealCompletion(task) {
  if (Number.isFinite(parseTs(task.closing?.closedAt)?.getTime())) return true;
  for (const pr of Array.isArray(task.prs) ? task.prs : []) {
    if (parseTs(pr?.mergedAt) || parseTs(pr?.closedAt)) return true;
  }
  return Boolean(parseTs(task.doneAt));
}

/**
 * Finished tasks per local day over the last `days` days, today included,
 * oldest first. Tasks whose only date is `createdAt` are skipped: they would
 * show a false spike on the day they were created.
 */
export function completedByDay(tasks, days = 14, now = Date.now()) {
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0); // noon keeps the subtraction clear of DST edges
    d.setDate(d.getDate() - i);
    keys.push(dayKey(d));
  }
  const byDay = new Map(keys.map((k) => [k, 0]));
  const endings = { merged: 0, noPr: 0, issueClosed: 0 };
  let total = 0;
  for (const t of tasks ?? []) {
    if (t?.state !== 'done' || !hasRealCompletion(t)) continue;
    const key = dayKey(completedAt(t));
    if (!byDay.has(key)) continue;
    byDay.set(key, byDay.get(key) + 1);
    total += 1;
    const merged = (t.prs ?? []).some((p) => p?.state === 'MERGED');
    if (t.closedWithoutPr) endings.noPr += 1;
    if (merged) endings.merged += 1;
    if (t.issueClosed && !merged && !t.closedWithoutPr) endings.issueClosed += 1;
  }
  return { total, days: keys.map((day) => ({ day, n: byDay.get(day) })), endings };
}

// The weekday names are time.js's (`shared.time.days`), indexed by Date#getDay (Sunday first).

/** «jue 09:00», in the reader's time zone; null when the stamp is unreadable. */
export function weekdayStamp(ts) {
  const d = parseTs(ts);
  return d ? `${strings().shared.time.days[d.getDay()]} ${hhmm(d)}` : null;
}
