// Pure formatting for the timeline panel and the metrics dialog. No React here,
// so the server suite can import it. Everything tolerates tasks and payloads
// without timings (old tasks): the answer is an empty list, never a throw.
// The words come from the catalog (`shared.metrics`), read at call time.
import { fill, plural, strings } from './i18n/index.js';
import { formatNumber } from './i18n/format.js';

const words = () => strings().shared.metrics;

/** 1500 -> «1,5 s» (the decimal mark follows the language), 65000 -> «1 min 5 s», 3 660 000 -> «1 h 1 min». null -> «—». */
export function formatMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** 0.256 -> «26 %»; null -> «—». */
export function formatShare(share) {
  if (share == null || Number.isNaN(share)) return '—';
  return fill(strings().shared.percent, { n: Math.round(share * 100) });
}

/** Cost in dollars; null stays «—» (the SDK did not say). */
export function formatCost(usd) {
  if (usd == null || Number.isNaN(usd)) return '—';
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

const lengthOf = (s, now) => {
  if (s.ms != null) return s.ms;
  const from = Date.parse(s.startedAt);
  return Number.isNaN(from) ? 0 : Math.max(0, now - from);
};

// The labels are getters over the catalog: the object keeps its shape, the text follows the language.
export const KIND_LABELS = {
  get phase() { return words().kind.phase; },
  get step() { return words().kind.step; },
  get session() { return words().kind.session; },
  get wait() { return words().kind.wait; },
  get chat() { return words().kind.chat; },
  get op() { return words().kind.op; },
};

/**
 * The rows of the timeline: spans in start order, each with its length (an
 * open one counts up to `now`), its offset from the first span and its share
 * of the whole line, ready to draw as a bar. Tasks without timings give [].
 */
export function timelineRows(timings, now = Date.now()) {
  const spans = (Array.isArray(timings) ? timings : []).filter((s) => s && Date.parse(s.startedAt) >= 0);
  if (!spans.length) return [];
  const sorted = [...spans].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const t0 = Date.parse(sorted[0].startedAt);
  const t1 = Math.max(...sorted.map((s) => Date.parse(s.startedAt) + lengthOf(s, now)));
  const total = Math.max(1, t1 - t0);
  return sorted.map((s) => {
    const ms = lengthOf(s, now);
    const offset = Date.parse(s.startedAt) - t0;
    return {
      kind: s.kind,
      kindLabel: Object.hasOwn(words().kind, s.kind) ? words().kind[s.kind] : s.kind,
      name: s.name,
      attempt: s.attempt ?? 1,
      outcome: s.outcome ?? null,
      open: s.endedAt == null,
      ms,
      label: formatMs(ms),
      startLabel: new Date(s.startedAt).toISOString().slice(11, 19),
      left: (offset / total) * 100,
      width: Math.max(0.5, (ms / total) * 100),
      detail: detailOf(s),
    };
  });
}

/** A short line of what a span carries in `meta`: model, turns, cost, what it waited inside. */
export function detailOf(s) {
  const m = s?.meta ?? {};
  const w = words();
  const parts = [];
  if (m.within) parts.push(fill(w.within, { name: m.within }));
  if (m.role) parts.push(m.role);
  if (m.model) parts.push(m.effort ? `${m.model}/${m.effort}` : m.model);
  if (m.turns != null) parts.push(plural(m.turns, w.turns));
  if (m.costUsd != null) parts.push(formatCost(m.costUsd));
  if (m.resumed) parts.push(w.resumed);
  if (m.sealedOpen > 0) parts.push(fill(w.sealedOpen, { n: m.sealedOpen }));
  if (m.sealedEarly > 0) parts.push(fill(w.sealedEarly, { n: m.sealedEarly }));
  if (m.answerFrom === 'post') parts.push(w.answerPost);
  else if (m.answerFrom === 'unclosed') parts.push(w.answerUnclosed);
  else if (m.answerFrom === 'error-closed') parts.push(w.answerErrorClosed);
  else if (m.answerFrom === 'sealed' && (m.sealedOpen > 0 || m.sealedEarly > 0)) parts.push(w.answerSealed);
  if (s?.attempt > 1) parts.push(fill(w.attempt, { n: s.attempt }));
  return parts.join(' · ');
}

/** The one-line summary of a task for the panel header: run, active and waiting time. */
export function summaryLine(timing) {
  if (!timing) return '';
  const w = words();
  const bits = [];
  if (timing.wallMs != null) bits.push(fill(w.summaryTotal, { value: formatMs(timing.wallMs) }));
  if (timing.runMs != null) bits.push(fill(w.summaryRun, { value: formatMs(timing.runMs) }));
  if (timing.activeMs != null) bits.push(fill(w.summaryActive, { value: formatMs(timing.activeMs) }));
  if (timing.waitMs != null) bits.push(fill(w.summaryWaiting, { value: formatMs(timing.waitMs) }));
  if (timing.dropped?.n) bits.push(plural(timing.dropped.n, w.summaryDropped));
  return bits.join(' · ');
}

/**
 * Rows of the aggregate table, from `aggregate()` output ({ phases, waits }):
 * one per phase or wait kind, slowest median first. Missing groups give [].
 */
export function aggregateRows(group) {
  return Object.entries(group ?? {})
    .map(([name, s]) => ({
      name,
      n: s.n ?? 0,
      median: s.median ?? null,
      p90: s.p90 ?? null,
      totalMs: s.totalMs ?? 0,
      medianLabel: formatMs(s.median),
      p90Label: formatMs(s.p90),
      smallSample: isSmallSample(s.n),
      totalLabel: formatMs(s.totalMs),
    }))
    .sort((a, b) => (b.median ?? -1) - (a.median ?? -1) || a.name.localeCompare(b.name));
}

/**
 * Rows of the subagent-share table, from `aggregate().subagents`
 * ({ phases, chat }): phases by share (highest first), the out-of-phase bucket
 * (`none`) after them and the chats last, only when they made calls. An old
 * aggregate without the key, or one with no phases and no chat calls, gives [].
 */
export function subagentRows(sub) {
  const row = (name, s, rank) => ({
    name,
    rank,
    sessions: s.sessions ?? 0,
    calls: s.calls ?? 0,
    subagents: s.subagents ?? 0,
    share: s.share ?? null,
    shareLabel: formatShare(s.share),
    nudges: s.nudges ?? 0,
    nudgeMs: s.nudgeMs ?? 0,
    nudgeLabel: s.nudges > 0 ? formatMs(s.nudgeMs) : '—',
  });
  const rows = Object.entries(sub?.phases ?? {})
    .map(([name, s]) => (name === 'none' ? row(words().outOfPhase, s, 1) : row(name, s, 0)));
  // `aggregate()` always returns a chat object; with no chat calls (turns that used no tools included) it is skipped.
  if (sub?.chat?.calls > 0) rows.push(row(words().chats, sub.chat, 2));
  return rows
    .sort((a, b) => a.rank - b.rank || (b.share ?? -1) - (a.share ?? -1) || a.name.localeCompare(b.name))
    .map(({ rank, ...r }) => r);
}

/**
 * What the timeline panel keys its refetch on: the span count plus the spans
 * the cap already dropped (the count alone plateaus at the cap) and how many
 * are open (a span closing opens none). Unlike
 * `updatedAt` it does not move on every log line. null without timings.
 */
export function timingsKey(timing) {
  if (!timing) return null;
  return `${(timing.spans ?? 0) + (timing.dropped?.n ?? 0)}:${timing.open ?? 0}`;
}

/** True when any span is still open, so its length has to advance on the client. */
export const hasOpenSpans = (timings) =>
  Array.isArray(timings) && timings.some((s) => s && s.endedAt == null);

/** With this many samples or fewer, the nearest-rank p90 is the maximum. */
export const P90_SMALL_SAMPLE = 2;

/** True when a p90 rests on so few samples that it equals the maximum. */
export const isSmallSample = (n) => (n ?? 0) <= P90_SMALL_SAMPLE;

/**
 * The caption lines about sessions sealed with subagents owed: how many owed,
 * and of those how many took the later answer, took a turn that never closed
 * the wait, took one and had an error close it, or kept the sealed one. Singular and plural
 * agree with the count; an aggregate without any (or an old one) gives [].
 */
export function sealedLines(agg) {
  const lines = [];
  const rescued = agg?.sealedRescued ?? 0;
  const kept = agg?.sealedKept ?? 0;
  const unclosed = agg?.sealedUnclosed ?? 0;
  const errorClosed = agg?.sealedErrorClosed ?? 0;
  // Sessions that owed a later answer, whether a subagent was out at the seal or
  // had already reported inside the sealed turn; an older aggregate only has sealedOpen.
  const debt = agg?.sealedDebt ?? agg?.sealedOpen ?? 0;
  const w = words();
  if (debt > 0) lines.push(plural(debt, w.sealedDebt));
  if (rescued > 0) lines.push(plural(rescued, w.sealedRescued));
  if (unclosed > 0) lines.push(plural(unclosed, w.sealedUnclosed));
  if (errorClosed > 0) lines.push(plural(errorClosed, w.sealedErrorClosed));
  if (kept > 0) lines.push(plural(kept, w.sealedKept));
  return lines;
}

/** True when an aggregate has nothing to show yet (no task has timings). */
export const isEmptyAggregate = (agg) => !agg || !(agg.tasks > 0);
