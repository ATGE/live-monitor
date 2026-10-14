import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMs, formatShare, formatCost, timelineRows, summaryLine, aggregateRows, isEmptyAggregate, detailOf,
  timingsKey, hasOpenSpans, isSmallSample, sealedLines, subagentRows,
} from '../../web/src/metricsView.js';

test('formatMs: ms, seconds, minutes, hours and null', () => {
  assert.equal(formatMs(null), '—');
  assert.equal(formatMs(250), '250 ms');
  assert.equal(formatMs(1500), '1,5 s');
  assert.equal(formatMs(45_000), '45 s');
  assert.equal(formatMs(65_000), '1 min 5 s');
  assert.equal(formatMs(120_000), '2 min');
  assert.equal(formatMs(3_660_000), '1 h 1 min');
});

test('formatShare and formatCost tolerate null', () => {
  assert.equal(formatShare(0.256), '26 %');
  assert.equal(formatShare(null), '—');
  assert.equal(formatCost(null), '—');
  assert.equal(formatCost(0.1234), '$0.123');
  assert.equal(formatCost(12.5), '$12.50');
});

test('timelineRows: old tasks without timings give an empty list', () => {
  assert.deepEqual(timelineRows(undefined), []);
  assert.deepEqual(timelineRows([]), []);
  assert.deepEqual(timelineRows(null), []);
});

test('timelineRows: sorted by start, with offsets and widths in percent', () => {
  const rows = timelineRows([
    { kind: 'wait', name: 'quota_park', startedAt: '2026-01-01T00:01:00.000Z', endedAt: '2026-01-01T00:03:00.000Z', ms: 120_000, attempt: 1, outcome: 'ok', meta: { within: null } },
    { kind: 'phase', name: 'triage', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', ms: 60_000, attempt: 1, outcome: 'ok', meta: {} },
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['triage', 'quota_park']);
  assert.equal(rows[0].left, 0);
  assert.ok(Math.abs(rows[0].width - 33.33) < 0.1);
  assert.ok(Math.abs(rows[1].left - 33.33) < 0.1);
  assert.equal(rows[1].label, '2 min');
  assert.equal(rows[1].kindLabel, 'espera');
});

test('timelineRows: an open span counts up to now', () => {
  const rows = timelineRows([{ kind: 'phase', name: 'fixing', startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, ms: null, meta: {} }],
    Date.parse('2026-01-01T00:00:30.000Z'));
  assert.equal(rows[0].ms, 30_000);
  assert.equal(rows[0].open, true);
});

test('detailOf: says when the answer was sealed with subagents still out', () => {
  assert.equal(detailOf({ meta: { role: 'plan', sealedOpen: 3, answerFrom: 'sealed' } }),
    'plan · sellada con 3 subagente(s) fuera · se quedó con la respuesta sellada');
  assert.equal(detailOf({ meta: { role: 'plan', sealedOpen: 0 } }), 'plan');
  assert.equal(detailOf({ meta: { role: 'plan', sealedOpen: 3 } }), 'plan · sellada con 3 subagente(s) fuera', 'a span from before answerFrom says nothing about the outcome');
});

test('detailOf: tells a rescued session from one that kept the waiting sentence', () => {
  assert.equal(detailOf({ meta: { role: 'plan', sealedOpen: 1, answerFrom: 'post' } }),
    'plan · sellada con 1 subagente(s) fuera · respuesta tomada tras el sello');
  assert.equal(detailOf({ meta: { role: 'plan', sealedEarly: 1, answerFrom: 'post' } }),
    'plan · 1 subagente(s) informaron dentro del turno sellado · respuesta tomada tras el sello');
  assert.equal(detailOf({ meta: { role: 'plan', sealedEarly: 1, answerFrom: 'sealed' } }),
    'plan · 1 subagente(s) informaron dentro del turno sellado · se quedó con la respuesta sellada');
  assert.equal(detailOf({ meta: { role: 'plan', answerFrom: 'sealed' } }), 'plan');
});

test('sealedLines: singular and plural agree, and nothing to say gives []', () => {
  assert.deepEqual(sealedLines(undefined), []);
  assert.deepEqual(sealedLines({ sealedOpen: 0 }), []);
  assert.deepEqual(sealedLines({ sealedOpen: 1, sealedRescued: 1, sealedKept: 1 }), [
    '1 sesión selló su respuesta con subagentes pendientes',
    '1 sesión tomó la respuesta posterior al sello',
    '1 sesión con subagentes pendientes se quedó con la respuesta sellada',
  ]);
  assert.deepEqual(sealedLines({ sealedOpen: 3, sealedRescued: 2, sealedKept: 2 }), [
    '3 sesiones sellaron su respuesta con subagentes pendientes',
    '2 sesiones tomaron la respuesta posterior al sello',
    '2 sesiones con subagentes pendientes se quedaron con la respuesta sellada',
  ]);
});

test('detailOf: an unclosed session says no turn closed the wait', () => {
  assert.equal(detailOf({ meta: { role: 'plan', sealedOpen: 1, answerFrom: 'unclosed' } }),
    'plan · sellada con 1 subagente(s) fuera · ningún turno cerró la espera: la respuesta tomada puede ser la frase de espera');
});

test('detailOf: a window closed by an error result does not say no turn closed it', () => {
  const text = detailOf({ meta: { role: 'plan', sealedOpen: 1, answerFrom: 'error-closed' } });
  assert.equal(text,
    'plan · sellada con 1 subagente(s) fuera · un turno con error cerró la espera: la respuesta tomada puede ser la frase de espera');
  assert.doesNotMatch(text, /ningún turno/);
});

test('sealedLines: the error-closed line sits after the unclosed one, singular and plural', () => {
  assert.deepEqual(sealedLines({ sealedDebt: 2, sealedUnclosed: 1, sealedErrorClosed: 1 }), [
    '2 sesiones sellaron su respuesta con subagentes pendientes',
    '1 sesión tomó un turno posterior pero ninguno cerró la espera',
    '1 sesión tomó un turno posterior y un error cerró la espera',
  ]);
  assert.deepEqual(sealedLines({ sealedErrorClosed: 3, sealedDebt: 3 }).slice(1),
    ['3 sesiones tomaron un turno posterior y un error cerró la espera']);
  assert.deepEqual(sealedLines({ sealedErrorClosed: 0 }), []);
});

test('sealedLines: the first line counts every session that owed; the rest are subsets', () => {
  // Two sessions owed only through sealedEarly (sealedOpen 0): the old first line said nothing.
  // The first line is not always the sum of the others: sessions with debt but no
  // answerFrom (spans recorded before that field existed) count only in the first.
  assert.deepEqual(sealedLines({ sealedOpen: 0, sealedDebt: 2, sealedRescued: 1, sealedKept: 1 }), [
    '2 sesiones sellaron su respuesta con subagentes pendientes',
    '1 sesión tomó la respuesta posterior al sello',
    '1 sesión con subagentes pendientes se quedó con la respuesta sellada',
  ]);
  assert.deepEqual(sealedLines({ sealedDebt: 3, sealedRescued: 1, sealedUnclosed: 1, sealedKept: 1 }), [
    '3 sesiones sellaron su respuesta con subagentes pendientes',
    '1 sesión tomó la respuesta posterior al sello',
    '1 sesión tomó un turno posterior pero ninguno cerró la espera',
    '1 sesión con subagentes pendientes se quedó con la respuesta sellada',
  ]);
  assert.deepEqual(sealedLines({ sealedUnclosed: 2, sealedDebt: 2 }).slice(1), ['2 sesiones tomaron un turno posterior pero ninguno cerró la espera']);
});

test('detailOf and summaryLine', () => {
  assert.equal(
    detailOf({ attempt: 2, meta: { role: 'fix', model: 'sonnet', effort: 'high', turns: 7, costUsd: 0.5, resumed: true } }),
    'fix · sonnet/high · 7 turnos · $0.500 · reanudada · intento 2',
  );
  assert.equal(summaryLine(null), '');
  assert.equal(
    summaryLine({ wallMs: 120_000, runMs: 60_000, activeMs: 50_000, waitMs: 10_000, dropped: { n: 3 } }),
    'total 2 min · ejecución 1 min · activo 50 s · esperando 10 s · 3 tramos antiguos descartados',
  );
});

test('aggregateRows: slowest median first; missing groups give []', () => {
  assert.deepEqual(aggregateRows(undefined), []);
  const rows = aggregateRows({
    triage: { n: 3, median: 1000, p90: 2000, totalMs: 4000 },
    fixing: { n: 3, median: 60_000, p90: 90_000, totalMs: 200_000 },
  });
  assert.deepEqual(rows.map((r) => r.name), ['fixing', 'triage']);
  assert.equal(rows[0].medianLabel, '1 min');
  assert.equal(rows[0].p90Label, '1 min 30 s');
});

test('timingsKey moves with the span count and the dropped ones, not with anything else', () => {
  assert.equal(timingsKey(null), null);
  assert.equal(timingsKey({ spans: 5, dropped: null, runMs: 1 }), '5:0');
  assert.equal(timingsKey({ spans: 5, dropped: null, runMs: 999 }), '5:0');
  // A span closing opens no new one, but the key still moves.
  assert.notEqual(timingsKey({ spans: 5, open: 1 }), timingsKey({ spans: 5, open: 0 }));
  // At the cap the count plateaus; the dropped ones keep the key moving.
  assert.equal(timingsKey({ spans: 500, dropped: { n: 3 } }), '503:0');
  assert.notEqual(timingsKey({ spans: 500, dropped: { n: 4 } }), timingsKey({ spans: 500, dropped: { n: 3 } }));
});

test('hasOpenSpans', () => {
  assert.equal(hasOpenSpans(undefined), false);
  assert.equal(hasOpenSpans([{ endedAt: '2026-01-01T00:00:01.000Z' }]), false);
  assert.equal(hasOpenSpans([{ endedAt: '2026-01-01T00:00:01.000Z' }, { endedAt: null }]), true);
});

test('aggregateRows flags a p90 resting on two samples or fewer', () => {
  assert.equal(isSmallSample(2), true);
  assert.equal(isSmallSample(3), false);
  const rows = aggregateRows({
    a: { n: 2, median: 1, p90: 2, totalMs: 3 },
    b: { n: 3, median: 1, p90: 2, totalMs: 3 },
  });
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.name, r.smallSample])), { a: true, b: false });
});

test('isEmptyAggregate', () => {
  assert.equal(isEmptyAggregate(null), true);
  assert.equal(isEmptyAggregate({ tasks: 0 }), true);
  assert.equal(isEmptyAggregate({ tasks: 2 }), false);
});

test('subagentRows: phases by share, out-of-phase bucket, chats last; old aggregates give []', () => {
  assert.deepEqual(subagentRows(undefined), []);
  assert.deepEqual(subagentRows({}), []);
  const rows = subagentRows({
    total: { sessions: 6, calls: 100, subagents: 5, share: 0.05, nudges: 1, nudgeMs: 4000 },
    phases: {
      triage: { sessions: 2, calls: 40, subagents: 1, share: 0.025, nudges: 0, nudgeMs: 0 },
      none: { sessions: 1, calls: 10, subagents: 0, share: 0, nudges: 0, nudgeMs: 0 },
      demo: { sessions: 3, calls: 50, subagents: 4, share: 0.08, nudges: 1, nudgeMs: 4000 },
    },
    chat: { sessions: 4, calls: 200, subagents: 2, share: 0.01, nudges: 0, nudgeMs: 0 },
  });
  assert.deepEqual(rows.map((r) => r.name), ['demo', 'triage', 'fuera de fase', 'chats']);
  assert.equal(rows[0].shareLabel, '8 %');
  assert.equal(rows[0].nudgeLabel, '4,0 s');
  assert.equal(rows[1].nudgeLabel, '—');
  assert.equal(rows[3].calls, 200);
  const noShare = subagentRows({ phases: { fix: { sessions: 1, calls: 0, subagents: 0, share: null } } });
  assert.equal(noShare[0].shareLabel, '—');
});

test('subagentRows: no chat turns means no chats row, and no calls at all means no table', () => {
  const blank = { sessions: 0, calls: 0, subagents: 0, share: null, nudges: 0, nudgeMs: 0 };
  // `aggregate()` always returns a `chat` object, even with no chat turns.
  assert.deepEqual(subagentRows({ total: blank, phases: {}, chat: blank }), []);
  const phased = { sessions: 2, calls: 40, subagents: 1, share: 0.025, nudges: 0, nudgeMs: 0 };
  const rows = subagentRows({ total: phased, phases: { triage: phased }, chat: blank });
  assert.deepEqual(rows.map((r) => r.name), ['triage']);
  // Only chat turns: the chats row is the table.
  const chatOnly = { sessions: 3, calls: 30, subagents: 0, share: 0, nudges: 0, nudgeMs: 0 };
  assert.deepEqual(subagentRows({ total: blank, phases: {}, chat: chatOnly }).map((r) => r.name), ['chats']);
});
