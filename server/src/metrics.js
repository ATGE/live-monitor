// Span recorder: how long each thing a task does takes, and what it waits for.
//
// A span is { kind, name, startedAt, endedAt, ms, attempt, outcome, meta } and
// lives in `task.timings`, apart from `task.log` and capped on its own.
//
// This module is pure on purpose: no `fs`, no `store`, no `pipeline`. `claude.js`
// and `quota.js` import it, and neither may reach the store (that would close a
// circle, see quota.js). Persistence goes through `metricsHooks.persist`, which
// the store wires at load. It never throws: timing a process must not be able
// to break it. `span()` rethrows the error of the wrapped function untouched.
//
// Hierarchy, so sums never count twice:
//   phase  contiguous within a run (worktree, triage, fixing, ...). The only
//          kind that adds up to the run time.
//   step, session, chat, op   children of a phase (or free-standing); never summed.
//   wait   time spent not working. `meta.within` is the phase it happened in
//          (e2e gate, infra backoff, subagent grace) or null (slot, quota park).
//
// Timing any new process is one wrap: `await span(task, { kind: 'step', name: 'x' }, () => work())`.

export const SPAN_KINDS = ['phase', 'step', 'session', 'wait', 'chat', 'op'];

/** Spans kept per task. Past it, closed non-phase spans are evicted oldest first. */
export const MAX_SPANS = 500;

/**
 * Seams. `persist(task)` schedules a write of the task without broadcasting it;
 * `now()` is the clock, in epoch milliseconds; `outcomeOfError(e)` names the
 * outcome a step closes with when it throws (the pipeline maps a quota stop to
 * 'parked' and a mode switch to 'paused', as it does for phases).
 */
export const metricsHooks = {
  persist: () => {},
  now: () => Date.now(),
  outcomeOfError: () => 'error',
};

const iso = (ms) => new Date(ms).toISOString();
const isOpen = (s) => s.endedAt == null;

/** The cycle every new span is stamped with: a durable integer, never cleared. */
const cycleOf = (task) => (Number.isInteger(task?.metricsCycle) ? task.metricsCycle : 1);

/** The phase span open on this task right now, by name; null when none is. */
export function openPhaseOf(task) {
  const list = Array.isArray(task?.timings) ? task.timings : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].kind === 'phase' && list[i].endedAt == null) return list[i].name;
  }
  return null;
}

function timingsOf(task) {
  if (!Array.isArray(task.timings)) task.timings = [];
  return task.timings;
}

function persist(task) {
  try { metricsHooks.persist(task); } catch { /* recording never breaks the caller */ }
}

/**
 * Keeps `timings` within MAX_SPANS. Evicts the oldest closed span that is not
 * a phase (sessions and steps first, then the other kinds), and adds what it
 * dropped to `task.timingsDropped = { n, ms }`. Phases and open spans stay, so a
 * long task still covers every phase it ran.
 */
function trim(task) {
  const list = task.timings;
  while (list.length > MAX_SPANS) {
    let at = list.findIndex((s) => !isOpen(s) && (s.kind === 'session' || s.kind === 'step'));
    if (at < 0) at = list.findIndex((s) => !isOpen(s) && s.kind !== 'phase');
    if (at < 0) return;
    const [gone] = list.splice(at, 1);
    const dropped = task.timingsDropped ?? { n: 0, ms: 0 };
    task.timingsDropped = { n: dropped.n + 1, ms: dropped.ms + (gone.ms ?? 0) };
  }
}

/**
 * Opens a span and stores it at once with `endedAt: null`, so one that is open
 * when the board dies survives (`closeOrphans` closes it on the next boot).
 * `desc` is { kind, name, attempt?, ...meta }. Returns the span, or null.
 */
export function begin(task, { kind, name, attempt = 1, ...meta } = {}) {
  try {
    if (!task || !SPAN_KINDS.includes(kind) || !name) return null;
    meta.cycle = cycleOf(task);
    const s = { kind, name, startedAt: iso(metricsHooks.now()), endedAt: null, ms: null, attempt, outcome: null, meta };
    timingsOf(task).push(s);
    trim(task);
    persist(task);
    return s;
  } catch {
    return null;
  }
}

/** Closes a span from `begin`. `extra.outcome` defaults to 'ok'; the rest merges into `meta`. */
export function end(task, s, { outcome = 'ok', ...meta } = {}) {
  try {
    if (!task || !s || !isOpen(s)) return s ?? null;
    const at = metricsHooks.now();
    s.endedAt = iso(at);
    s.ms = Math.max(0, at - Date.parse(s.startedAt));
    s.outcome = outcome;
    Object.assign(s.meta, meta);
    persist(task);
    return s;
  } catch {
    return s ?? null;
  }
}

/**
 * Wraps `fn` in a span. `fn` receives the span (null if recording failed), so
 * it can add `meta` by itself. A throw closes the span as 'error' and is rethrown as is.
 */
export async function span(task, desc, fn) {
  const s = begin(task, desc);
  try {
    const value = await fn(s);
    end(task, s, { outcome: 'ok' });
    return value;
  } catch (e) {
    let outcome = 'error';
    try { outcome = metricsHooks.outcomeOfError(e) || 'error'; } catch { /* keep 'error' */ }
    end(task, s, { outcome, error: String(e?.message ?? e).slice(0, 200) });
    throw e;
  }
}

/** Stores a span that is already complete: { kind, name, startedAt, endedAt, attempt?, outcome?, meta? }. */
export function record(task, full) {
  try {
    if (!task || !full || !SPAN_KINDS.includes(full.kind) || !full.name) return null;
    const started = Date.parse(full.startedAt);
    const ended = Date.parse(full.endedAt);
    if (Number.isNaN(started) || Number.isNaN(ended)) return null;
    const s = {
      kind: full.kind,
      name: full.name,
      startedAt: iso(started),
      endedAt: iso(ended),
      ms: Math.max(0, ended - started),
      attempt: full.attempt ?? 1,
      outcome: full.outcome ?? 'ok',
      meta: { ...(full.meta ?? {}), cycle: cycleOf(task) },
    };
    timingsOf(task).push(s);
    trim(task);
    persist(task);
    return s;
  } catch {
    return null;
  }
}

/**
 * Closes every span left open by a dead process as 'interrupted' at `at` (an ISO
 * string; pass the task's last update, not the boot time, so the span does not
 * swallow the time the board was off). Idempotent. Returns how many it closed.
 */
export function closeOrphans(task, at) {
  try {
    if (!Array.isArray(task?.timings)) return 0;
    let n = 0;
    for (const s of task.timings) {
      if (!isOpen(s)) continue;
      const from = Date.parse(s.startedAt);
      const to = Number.isNaN(Date.parse(at)) ? from : Math.max(from, Date.parse(at));
      s.endedAt = iso(to);
      s.ms = to - from;
      s.outcome = 'interrupted';
      n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * Gives a task saved before `metricsCycle` existed its cycle numbers. Spans
 * from those days carry `meta.cycle` as the ISO start of their cycle, or null
 * (the first cycle, and everything recorded after `cycleStartedAt` was nulled
 * at the draft PR), so null cannot be read as "cycle 1". The boundaries are
 * the distinct ISO values plus `task.cycleStartedAt`; a span belongs to the
 * cycle that began last before it started. Also gives each old
 * `subagent_grace` the phase that held it, or null. Idempotent: it does
 * nothing once `metricsCycle` is an integer. Returns true when it ran.
 */
export function migrateCycles(task) {
  try {
    if (!task || Number.isInteger(task.metricsCycle)) return false;
    const spans = Array.isArray(task.timings) ? task.timings : [];
    const marks = new Set();
    for (const s of spans) {
      const c = s.meta?.cycle;
      if (typeof c === 'string' && !Number.isNaN(Date.parse(c))) marks.add(c);
    }
    if (typeof task.cycleStartedAt === 'string' && !Number.isNaN(Date.parse(task.cycleStartedAt))) marks.add(task.cycleStartedAt);
    const bounds = [...marks].sort((a, b) => Date.parse(a) - Date.parse(b));
    const phases = spans.filter((s) => s.kind === 'phase');
    for (const s of spans) {
      const at = Date.parse(s.startedAt);
      s.meta = s.meta ?? {};
      s.meta.cycle = 1 + bounds.filter((b) => Date.parse(b) <= at).length;
      if (s.kind === 'wait' && s.name === 'subagent_grace') {
        const holder = phases.find((p) => at >= Date.parse(p.startedAt) && (p.endedAt == null || at <= Date.parse(p.endedAt)));
        s.meta.within = holder ? holder.name : null;
      }
    }
    task.metricsCycle = 1 + bounds.length;
    task.metricsCycleStartedAt = bounds.length ? bounds[bounds.length - 1] : null;
    return true;
  } catch {
    return false;
  }
}

const sum = (list, pick) => list.reduce((acc, s) => acc + (pick(s) ?? 0), 0);

/** The span's length; one still open counts up to `now`. */
function lengthOf(s, now) {
  if (s.ms != null) return s.ms;
  const from = Date.parse(s.startedAt);
  return Number.isNaN(from) ? 0 : Math.max(0, now - from);
}

/**
 * Total length covered by the spans, counting overlaps once, clipped to
 * [from, to] (a NaN bound clips nothing). Waits of parallel sessions overlap;
 * a plain sum of them could pass the wall time.
 */
function unionMs(list, now, from, to) {
  const spans = [];
  for (const s of list) {
    const a = Date.parse(s.startedAt);
    if (Number.isNaN(a)) continue;
    spans.push([Math.max(a, Number.isNaN(from) ? a : from), Math.min(a + lengthOf(s, now), Number.isNaN(to) ? Infinity : to)]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let edge = -Infinity;
  for (const [a, b] of spans) {
    if (b <= a) continue;
    const start = Math.max(a, edge);
    if (b > start) total += b - start;
    edge = Math.max(edge, b);
  }
  return total;
}

/** The cycle a span belongs to; an unnumbered one (not migrated) counts as the first. */
const cycleOfSpan = (s) => (Number.isInteger(s.meta?.cycle) ? s.meta.cycle : 1);

/** The four totals of a set of spans between `from` and `to`. */
function figures(phases, waits, from, to, now) {
  const end = [...phases, ...waits].reduce((m, s) => Math.max(m, Date.parse(s.startedAt) + lengthOf(s, now) || 0), to);
  const runMs = sum(phases, (s) => lengthOf(s, now));
  const inside = waits.filter((s) => s.meta?.within);
  return {
    wallMs: Number.isNaN(from) || Number.isNaN(to) ? null : Math.max(0, end - from),
    runMs,
    waitMs: unionMs(waits, now, from, end),
    activeMs: Math.max(0, runMs - unionMs(inside, now, from, end)),
  };
}

function groupBy(list, now) {
  const out = {};
  for (const s of list) {
    const g = (out[s.name] ??= { n: 0, ms: 0 });
    g.n += 1;
    g.ms += lengthOf(s, now);
  }
  return out;
}

/**
 * The numbers of one task, for its current cycle (`task.metricsCycle`, 1 for a
 * task never reopened).
 *   wallMs    from the start of the cycle (creation, for the first) to done, or to now while it runs
 *   runMs     sum of the cycle's phase spans, i.e. the time the pipeline was running
 *   waitMs    time covered by the cycle's wait spans, overlaps counted once
 *   activeMs  runMs minus the waits that happened inside a phase
 * Rest between runs (waiting for a person at pr_draft, say) is neither a phase
 * nor a wait, so it shows in wallMs and in none of the others.
 * `life` has the same four numbers over every cycle, from creation: a
 * different question, kept under its own name so the two are never mixed.
 */
export function summarize(task) {
  const spans = Array.isArray(task?.timings) ? task.timings : [];
  const now = metricsHooks.now();
  const cycle = Number.isInteger(task?.metricsCycle) ? task.metricsCycle : 1;
  const mine = spans.filter((s) => cycleOfSpan(s) === cycle);
  const phases = mine.filter((s) => s.kind === 'phase');
  const waits = mine.filter((s) => s.kind === 'wait');
  const created = Date.parse(task?.createdAt ?? '');
  const from = Date.parse(task?.metricsCycleStartedAt ?? task?.createdAt ?? '');
  const to = task?.doneAt ? Date.parse(task.doneAt) : now;
  return {
    cycle,
    ...figures(phases, waits, from, to, now),
    byPhase: groupBy(phases, now),
    byWait: groupBy(waits, now),
    dropped: task?.timingsDropped ?? null,
    life: figures(spans.filter((s) => s.kind === 'phase'), spans.filter((s) => s.kind === 'wait'), created, to, now),
  };
}

/** Nearest-rank percentile (p in 0..1) of a list of numbers; null when empty. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** Median; the mean of the two middle values when the count is even. */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stats(values) {
  return { n: values.length, median: median(values), p90: percentile(values, 0.9), totalMs: values.reduce((a, b) => a + b, 0) };
}

const blankShare = () => ({ sessions: 0, calls: 0, subagents: 0, share: null, nudges: 0, nudgeMs: 0 });

/** `fix:t1` and `plan:t1` are one stage per task of a plan; the config decides per stage, not per task. */
const stageOf = (s) => {
  const stage = String(s.meta?.stage ?? s.name ?? 'session');
  return /^(fix|plan):./.test(stage) ? `${stage.slice(0, stage.indexOf(':'))}:*` : stage;
};

/** Tool calls of a session span: the uncapped `toolCalls`, else the sum of the (capped) `toolCounts`. */
function callsOf(s) {
  if (Number.isFinite(s.meta?.toolCalls)) return s.meta.toolCalls;
  return Object.values(s.meta?.toolCounts ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

/**
 * The phase a session span ran in: the one stamped at its start (`meta.within`,
 * null when it ran outside any phase), else, for old spans, the phase of the
 * same cycle whose time contains the span's start. 'none' when neither.
 */
function phaseOfSession(s, phases) {
  if (s.meta && 'within' in s.meta) return s.meta.within ?? 'none';
  const at = Date.parse(s.startedAt);
  const cycle = cycleOfSpan(s);
  const holder = phases.find((p) => cycleOfSpan(p) === cycle && at >= Date.parse(p.startedAt) && (p.endedAt == null || at <= Date.parse(p.endedAt)));
  return holder ? holder.name : 'none';
}

/** Adds one span to a `{ sessions, calls, subagents, nudges, nudgeMs }` entry; a nudge is not a session of its own. */
function addShare(entry, s) {
  entry.calls += callsOf(s);
  entry.subagents += Number(s.meta?.subagents) || 0;
  if (s.meta?.nudge === true) {
    entry.nudges += 1;
    entry.nudgeMs += s.ms ?? 0;
  } else {
    entry.sessions += 1;
  }
}

/**
 * Subagent share of the session spans of `tasks`, in total and per phase and
 * stage, plus the chat turns that recorded their tool calls. `share` is
 * subagents / calls (null without calls). Calls include those made inside
 * subagents, and `trim` evicts session spans first, so long tasks undercount.
 */
function subagentShare(tasks) {
  const total = blankShare();
  const phases = {};
  const stages = {};
  const chat = blankShare();
  for (const task of tasks ?? []) {
    const spans = Array.isArray(task?.timings) ? task.timings : [];
    const phaseSpans = spans.filter((s) => s.kind === 'phase');
    for (const s of spans) {
      if (s.kind === 'session') {
        addShare(total, s);
        addShare((phases[phaseOfSession(s, phaseSpans)] ??= blankShare()), s);
        addShare((stages[stageOf(s)] ??= blankShare()), s);
      } else if (s.kind === 'chat' && Number.isFinite(s.meta?.toolCalls)) {
        addShare(chat, s);
      }
    }
  }
  const finish = (e) => ({ ...e, share: e.calls > 0 ? e.subagents / e.calls : null });
  const finishAll = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, finish(v)]));
  return { total: finish(total), phases: finishAll(phases), stages: finishAll(stages), chat: finish(chat) };
}

/**
 * Across tasks: median and p90 of closed spans per phase and per wait kind, and
 * the share of wall time spent waiting. `waitShare` is null when no task has a wall time.
 * `subagents` is the subagent share per phase and stage (see `subagentShare`).
 */
export function aggregate(tasks) {
  const phases = {};
  const waits = {};
  let wallMs = 0;
  let waitMs = 0;
  let counted = 0;
  let sealedOpen = 0;
  let sealedRescued = 0;
  let sealedKept = 0;
  let sealedUnclosed = 0;
  let sealedErrorClosed = 0;
  let sealedDebt = 0;
  for (const task of tasks ?? []) {
    const spans = Array.isArray(task?.timings) ? task.timings : [];
    if (!spans.length) continue;
    counted += 1;
    for (const s of spans) {
      // A session whose answer was sealed with subagents still out (#21).
      if (s.kind === 'session' && s.meta?.sealedOpen > 0) sealedOpen += 1;
      // Of the sessions that owed a later answer (subagents out at the seal, or
      // reported inside the sealed turn): the ones that took it, the ones that
      // adopted a later turn without any turn closing the window (`unclosed`), the
      // ones where an error result closed the window after such a turn
      // (`error-closed`), and the ones that kept the waiting sentence. `sealedDebt`
      // counts every session that owed, so it can exceed the sum of the other four.
      if (s.kind === 'session') {
        // Every session that owed a later answer, whatever came of it.
        if (s.meta?.sealedOpen > 0 || s.meta?.sealedEarly > 0) sealedDebt += 1;
        if (s.meta?.answerFrom === 'post') sealedRescued += 1;
        // Adopted a later result, but none closed the window: it may still be the waiting sentence.
        else if (s.meta?.answerFrom === 'unclosed') sealedUnclosed += 1;
        // Same, but an error result (never adopted) closed the window afterwards.
        else if (s.meta?.answerFrom === 'error-closed') sealedErrorClosed += 1;
        else if (s.meta?.answerFrom === 'sealed' && (s.meta.sealedOpen > 0 || s.meta.sealedEarly > 0)) sealedKept += 1;
      }
      if (s.ms == null) continue;
      if (s.kind === 'phase') (phases[s.name] ??= []).push(s.ms);
      else if (s.kind === 'wait') (waits[s.name] ??= []).push(s.ms);
    }
    const sm = summarize(task);
    if (sm.wallMs != null) {
      wallMs += sm.wallMs;
      waitMs += sm.waitMs;
    }
  }
  const stat = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, stats(v)]));
  return {
    tasks: counted,
    phases: stat(phases),
    waits: stat(waits),
    wallMs,
    waitMs,
    waitShare: wallMs > 0 ? waitMs / wallMs : null,
    sealedOpen,
    sealedRescued,
    sealedKept,
    sealedUnclosed,
    sealedErrorClosed,
    sealedDebt,
    subagents: subagentShare(tasks),
  };
}
