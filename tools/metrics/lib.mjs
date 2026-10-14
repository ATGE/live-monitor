/**
 * Pure logic of the metrics baseline: rebuild phase durations from `task.log`
 * timestamps for tasks that already finished. No I/O and no board modules, so
 * the test can import it freely. The CLI (`baseline.mjs`) does the reading.
 *
 * What the log can and cannot tell us:
 *  - State changes are `{ phase: 'estado', line: '→ <state>' }`; `enter()` writes
 *    nothing, so `pr` and `demo` have no state of their own.
 *  - Those two (and every other stage) are approximated from the session lines
 *    of the stage: first `sesión Claude iniciada` to last `turno terminado`.
 *  - `task.log` is capped at 3000 lines, so long tasks lost their early lines;
 *    such tasks are flagged and left out of the per-state numbers.
 */

/** Mirrors `MAX_LOG_LINES` in the store; a log this long has been truncated. */
export const LOG_CAP = 3000;

// Session and turn lines are matched in both languages: stored logs predate the
// English wording.
const STATE_RE = /^→ ([a-z_]+)/;
const SESSION_START_RE = /^(?:sesión Claude iniciada|Claude session started)/;
const TURN_END_RE = /^(?:turno terminado|turn finished) \((\d+) (?:turnos?|turns?)\)/;

const ms = (iso) => Date.parse(iso);

/** Nearest-rank percentile of a numeric array (p in 0..100); null when empty. */
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[Math.min(rank, v.length) - 1];
}

/** The tasks of one parsed tasks file (an object keyed by issue, or an array). */
export function tasksOf(data) {
  const list = Array.isArray(data) ? data : Object.values(data ?? {});
  return list.filter((t) => t && typeof t === 'object' && Array.isArray(t.log));
}

export const isFinished = (task) => task.state === 'done' || Boolean(task.doneAt);

/**
 * Time spent in each state, from consecutive `estado` entries. The last state
 * lasts until `doneAt` (or the last log line). Returns [{ state, ms }].
 */
export function stateDurations(task) {
  const marks = [];
  for (const e of task.log) {
    if (e.phase !== 'estado') continue;
    const m = STATE_RE.exec(e.line ?? '');
    if (m && Number.isFinite(ms(e.ts))) marks.push({ state: m[1], at: ms(e.ts) });
  }
  const end = Number.isFinite(ms(task.doneAt))
    ? ms(task.doneAt)
    : ms(task.log[task.log.length - 1]?.ts);
  const out = [];
  marks.forEach((mark, i) => {
    const next = i + 1 < marks.length ? marks[i + 1].at : end;
    if (Number.isFinite(next) && next >= mark.at) out.push({ state: mark.state, ms: next - mark.at });
  });
  return out;
}

/**
 * Per log stage (the `phase` field of the entry), the span from the first
 * session start to the last turn end, plus the largest turn count seen.
 * Returns { [stage]: { ms, maxTurns, sessions } }.
 */
export function stageSessions(task) {
  const stages = {};
  for (const e of task.log) {
    if (e.phase === 'estado') continue;
    const start = SESSION_START_RE.test(e.line ?? '');
    const end = TURN_END_RE.exec(e.line ?? '');
    if (!start && !end) continue;
    const at = ms(e.ts);
    if (!Number.isFinite(at)) continue;
    const s = (stages[e.phase] ??= { first: null, last: null, maxTurns: 0, sessions: 0 });
    if (start) {
      s.sessions += 1;
      if (s.first === null || at < s.first) s.first = at;
    }
    if (end) {
      s.maxTurns = Math.max(s.maxTurns, Number(end[1]));
      if (s.last === null || at > s.last) s.last = at;
    }
  }
  const out = {};
  for (const [stage, s] of Object.entries(stages)) {
    out[stage] = {
      ms: s.first !== null && s.last !== null && s.last >= s.first ? s.last - s.first : null,
      maxTurns: s.maxTurns,
      sessions: s.sessions,
    };
  }
  return out;
}

export const wasTruncated = (task) => task.log.length >= LOG_CAP;

const stats = (values) => ({
  n: values.length,
  medianMs: percentile(values, 50),
  p90Ms: percentile(values, 90),
});

/** Aggregate finished tasks into the numbers the baseline reports. */
export function summarize(tasks) {
  const finished = tasks.filter(isFinished);
  const byState = {};
  const byStage = {};
  const maxTurns = {};
  const wall = [];
  let truncated = 0;
  for (const t of finished) {
    const cut = wasTruncated(t);
    if (cut) truncated += 1;
    if (!cut) {
      for (const d of stateDurations(t)) (byState[d.state] ??= []).push(d.ms);
      const start = ms(t.createdAt);
      const end = ms(t.doneAt);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) wall.push(end - start);
    }
    // Turn counts and session spans survive truncation as lower bounds.
    for (const [stage, s] of Object.entries(stageSessions(t))) {
      maxTurns[stage] = Math.max(maxTurns[stage] ?? 0, s.maxTurns);
      if (s.ms !== null && !cut) (byStage[stage] ??= []).push(s.ms);
    }
  }
  const map = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, stats(v)]));
  return {
    tasksTotal: tasks.length,
    tasksFinished: finished.length,
    tasksTruncated: truncated,
    wall: stats(wall),
    byState: map(byState),
    byStage: map(byStage),
    maxTurnsByStage: maxTurns,
  };
}

const fmt = (x) => {
  if (x === null || x === undefined) return '—';
  const min = x / 60000;
  return min < 90 ? `${min.toFixed(1)} min` : `${(min / 60).toFixed(2)} h`;
};

/** The summary as a markdown document (what gets committed as "before"). */
export function toMarkdown(summary, { source = 'server/data', generatedAt = '' } = {}) {
  const rows = (o) =>
    Object.entries(o)
      .sort((a, b) => (b[1].medianMs ?? 0) - (a[1].medianMs ?? 0))
      .map(([k, s]) => `| ${k} | ${s.n} | ${fmt(s.medianMs)} | ${fmt(s.p90Ms)} |`);
  const head = '| name | n | median | p90 |\n|---|---|---|---|';
  const turns = Object.entries(summary.maxTurnsByStage)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `| ${k} | ${n} |`);
  return [
    '# Metrics baseline ("before" numbers for issues 2 and 3)',
    '',
    `Generated by \`tools/metrics/baseline.mjs\` from ${source}${generatedAt ? ` on ${generatedAt}` : ''}.`,
    'Read-only: rebuilt from `task.log` timestamps of finished tasks.',
    'Usage: `npm run metrics:baseline -- <data-dir> [--out <file.md>]` (the directory is mandatory).',
    '',
    `- Tasks: ${summary.tasksTotal}; finished: ${summary.tasksFinished}; log truncated (cap ${LOG_CAP}, excluded from durations): ${summary.tasksTruncated}`,
    `- Wall time (created to done): n=${summary.wall.n}, median ${fmt(summary.wall.medianMs)}, p90 ${fmt(summary.wall.p90Ms)}`,
    '',
    '## Time per state (consecutive `estado` entries)',
    '',
    head,
    ...rows(summary.byState),
    '',
    '## Time per stage (first session start to last turn end; approximation, covers pr and demo)',
    '',
    head,
    ...rows(summary.byStage),
    '',
    '## Largest turn count seen per stage (input for the maxTurns caps)',
    '',
    '| stage | max turns |\n|---|---|',
    ...turns,
    '',
  ].join('\n');
}
