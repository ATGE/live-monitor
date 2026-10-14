import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { overlapReport, toText } from '../../tools/metrics/overlap.mjs';
import { removeTree } from './teardown.mjs';

const made = [];
after(async () => {
  for (const dir of made) await removeTree(dir);
});

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
const sp = (kind, name, from, to, meta = {}) => ({
  kind, name, startedAt: iso(from), endedAt: iso(to), ms: to - from, outcome: 'ok', meta: { cycle: 1, ...meta },
});

// triage 0-100 with the install inside it (20-90); pr 100-200 with the demo
// inside it (110-190) next to compose_pr_body (100-150) and draft_pr (150-200).
const taskOf = (extra = {}) => ({
  issue: 6,
  project: 'hfs',
  log: [],
  createdAt: iso(0),
  doneAt: iso(200),
  metricsCycle: 1,
  timings: [
    sp('phase', 'triage', 0, 100),
    sp('phase', 'pr', 100, 200),
    sp('step', 'prepare_dependencies', 20, 90, { when: 'during_triage' }),
    sp('step', 'compose_pr_body', 100, 150),
    sp('step', 'draft_pr', 150, 200),
    sp('step', 'demo_steps', 110, 190, { overlap: true }),
    sp('session', 'demo', 110, 190),
  ],
  ...extra,
});

test('step spans never enter runMs, and the concurrent time is sum minus union', () => {
  const [r] = overlapReport(taskOf());
  assert.equal(r.runMs, 200);
  assert.ok(r.wallMs >= r.runMs && r.runMs >= r.activeMs);
  assert.deepEqual(r.phases, { triage: 100, pr: 100, demo: null });
  assert.equal(r.stepsSumMs, 70 + 50 + 50 + 80);
  assert.equal(r.stepsUnionMs, 70 + 100);
  assert.equal(r.overlapMs, r.stepsSumMs - r.stepsUnionMs);
  assert.equal(r.overlapMs, 80);
  assert.deepEqual(r.steps.map((s) => s.name), ['prepare_dependencies', 'compose_pr_body', 'draft_pr', 'demo_steps']);
  assert.equal(r.steps[0].when, 'during_triage');
  assert.equal(r.steps[3].overlap, true);
});

test('the install is intersected with the triage phase and the demo with the PR phase', () => {
  const [r] = overlapReport(taskOf());
  assert.equal(r.installVsTriageMs, 70);
  assert.equal(r.demoVsPrMs, 80);
  assert.equal(r.droppedSpans, 0);
});

test('only the phase of the same cycle counts, and several phases are summed', () => {
  const task = taskOf({
    metricsCycle: 2,
    timings: [
      sp('phase', 'triage', 0, 50),
      sp('step', 'prepare_dependencies', 20, 90, { when: 'during_triage' }),
      sp('phase', 'triage', 60, 80),
      // The same clock span in another cycle must not count.
      sp('phase', 'triage', 0, 100, { cycle: 2 }),
      sp('step', 'prepare_dependencies', 0, 100, { when: 'pre_fix', cycle: 2 }),
    ],
  });
  const rows = overlapReport(task);
  assert.equal(rows[0].installVsTriageMs, 30 + 20);
  assert.equal(rows[1].installVsTriageMs, 0);
  assert.equal(rows[1].demoVsPrMs, 0);
});

test('a run that lost spans to the cap says its figures are a lower bound', () => {
  const [r] = overlapReport(taskOf({ timingsDropped: { n: 3, ms: 900 } }));
  assert.equal(r.droppedSpans, 3);
  assert.match(toText([r]), /3 spans dropped/);
});

test('a sequential run has nothing concurrent', () => {
  const task = taskOf({ timings: [sp('phase', 'pr', 0, 100), sp('step', 'compose_pr_body', 0, 40), sp('step', 'draft_pr', 40, 100)] });
  const [r] = overlapReport(task);
  assert.equal(r.overlapMs, 0);
});

test('one row per cycle, and an open step is left out of the sums', () => {
  const task = taskOf({
    metricsCycle: 2,
    metricsCycleStartedAt: iso(300),
    doneAt: iso(400),
    timings: [
      sp('phase', 'pr', 0, 100),
      sp('step', 'draft_pr', 0, 100),
      sp('phase', 'pr', 300, 400, { cycle: 2 }),
      { ...sp('step', 'demo_steps', 300, 400, { cycle: 2 }), endedAt: null, ms: null },
    ],
  });
  const rows = overlapReport(task);
  assert.deepEqual(rows.map((r) => r.cycle), [1, 2]);
  assert.equal(rows[0].wallMs, 100);
  assert.equal(rows[1].stepsSumMs, 0);
  assert.equal(rows[1].steps.length, 1);
});

test('the CLI reads a data dir without writing to it, and rejects a bad directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-overlap-'));
  made.push(dir);
  const file = path.join(dir, 'tasks.json');
  writeFileSync(file, JSON.stringify({ 6: taskOf() }));
  const before = readFileSync(file, 'utf8');
  const script = path.resolve('tools/metrics/overlap.mjs');
  const ok = spawnSync(process.execPath, [script, dir, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const [row] = JSON.parse(ok.stdout);
  assert.equal(row.overlapMs, 80);
  assert.equal(row.installVsTriageMs, 70);
  assert.equal(row.demoVsPrMs, 80);
  const text = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.match(text.stdout, /hfs#6 cycle 1/);
  assert.match(text.stdout, /install vs triage 0\.1s · demo vs pr 0\.1s/);
  assert.match(text.stdout, /= 0\.1s concurrent/);
  assert.equal(readFileSync(file, 'utf8'), before);
  const bad = spawnSync(process.execPath, [script, path.join(dir, 'nope')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
