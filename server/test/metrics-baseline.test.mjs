// The metrics baseline logic is pure: it reaches no board module, so no
// isolate.mjs is needed (same reasoning as prompt-baseline.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_CAP,
  percentile,
  stageSessions,
  stateDurations,
  summarize,
  tasksOf,
  toMarkdown,
  wasTruncated,
} from '../../tools/metrics/lib.mjs';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const est = (min, state) => ({ ts: at(min), phase: 'estado', line: `→ ${state}` });
const line = (min, phase, text) => ({ ts: at(min), phase, line: text });

const finished = () => ({
  issue: 1,
  state: 'done',
  createdAt: at(0),
  doneAt: at(60),
  log: [
    est(0, 'assigned'),
    est(5, 'triage'),
    est(15, 'fixing'),
    line(16, 'fix', 'sesión Claude iniciada (opus)'),
    line(30, 'fix', 'turno terminado (42 turnos)'),
    line(31, 'fix', 'turno terminado (7 turnos)'),
    est(40, 'testing'),
    line(45, 'pr', 'sesión Claude iniciada (opus)'),
    line(50, 'pr', 'turno terminado (9 turnos)'),
    est(55, 'done'),
  ],
});

test('session and turn lines count in English too, next to the Spanish ones', () => {
  const t = finished();
  t.log = [
    est(0, 'assigned'),
    est(15, 'fixing'),
    line(16, 'fix', 'Claude session started (opus, effort high)'),
    line(30, 'fix', 'turn finished (42 turns)'),
    line(31, 'fix', 'turn finished (1 turn)'),
    est(40, 'done'),
  ];
  const s = stageSessions(t);
  assert.equal(s.fix.ms / 60000, 15);
  assert.equal(s.fix.maxTurns, 42);
});

test('percentile uses nearest rank and tolerates empty input', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('stateDurations rebuilds time per state, last state ends at doneAt', () => {
  const d = Object.fromEntries(stateDurations(finished()).map((x) => [x.state, x.ms / 60000]));
  assert.deepEqual(d, { assigned: 5, triage: 10, fixing: 25, testing: 15, done: 5 });
});

test('stageSessions covers pr by its session lines and keeps the largest turn count', () => {
  const s = stageSessions(finished());
  assert.equal(s.fix.ms / 60000, 15);
  assert.equal(s.fix.maxTurns, 42);
  assert.equal(s.pr.ms / 60000, 5);
  assert.equal(s.estado, undefined);
});

test('summarize skips unfinished and truncated tasks for durations', () => {
  const running = { issue: 2, state: 'fixing', createdAt: at(0), log: [est(0, 'fixing')] };
  const cut = finished();
  cut.issue = 3;
  cut.log = [...Array(LOG_CAP - cut.log.length).fill(line(1, 'chat', 'x')), ...cut.log];
  assert.equal(wasTruncated(cut), true);
  const s = summarize([finished(), running, cut]);
  assert.equal(s.tasksTotal, 3);
  assert.equal(s.tasksFinished, 2);
  assert.equal(s.tasksTruncated, 1);
  assert.equal(s.byState.fixing.n, 1);
  assert.equal(s.wall.n, 1);
  assert.equal(s.maxTurnsByStage.fix, 42);
});

test('tasksOf accepts both file shapes and drops junk; markdown renders', () => {
  const t = finished();
  assert.equal(tasksOf({ 1: t, 2: null, 3: { log: 'no' } }).length, 1);
  assert.equal(tasksOf([t]).length, 1);
  const md = toMarkdown(summarize([t]), { generatedAt: '2026-10-05' });
  assert.match(md, /## Time per state/);
  assert.match(md, /\| fixing \| 1 \| 25\.0 min/);
});

// ---- the CLI, run for real ----
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = path.join(import.meta.dirname, '..', '..', 'tools', 'metrics', 'baseline.mjs');
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30_000 });

const doneTask = (n) => ({
  issue: n,
  state: 'done',
  log: [est(0, 'assigned'), est(10, 'fixing'), est(30, 'done')],
  createdAt: at(0),
  doneAt: at(30),
});
const fixtureDir = (files) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-baseline-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
};
const tasksIn = (text) => Number(/Tasks: (\d+);/.exec(text)?.[1]);

test('cli: a directory alone prints the markdown on stdout and exits 0', () => {
  const dir = fixtureDir({ 'tasks.json': { 1: doneTask(1), 2: doneTask(2) } });
  try {
    const r = cli(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^# Metrics baseline/);
    assert.equal(tasksIn(r.stdout), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: --out writes the file, before or after the directory', () => {
  const dir = fixtureDir({ 'tasks.json': { 1: doneTask(1) } });
  try {
    const a = path.join(dir, 'a.md');
    const b = path.join(dir, 'b.md');
    assert.equal(cli(dir, '--out', a).status, 0);
    assert.equal(cli('--out', b, dir).status, 0);
    assert.match(readFileSync(a, 'utf8'), /^# Metrics baseline/);
    assert.equal(tasksIn(readFileSync(b, 'utf8')), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: no arguments, an unknown flag or a lone --out print the usage and exit 1', () => {
  assert.match(cli().stderr, /Usage/);
  assert.equal(cli().status, 1);
  assert.match(cli('--nope').stderr, /Usage/);
  assert.match(cli('--out').stderr, /--out needs a file/);
});

test('cli: a missing directory and a directory without tasks.json exit 1 with a clear message', () => {
  const gone = path.join(tmpdir(), 'hfsmon-baseline-does-not-exist');
  const missing = cli(gone);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot read/);
  const dir = fixtureDir({ 'notes.txt': 'x' });
  try {
    const empty = cli(dir);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /No tasks\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: tasks.hfs.json is ignored, other project files are read', () => {
  const dir = fixtureDir({
    'tasks.json': { 1: doneTask(1) },
    'tasks.hfs.json': { 1: doneTask(1) },
    'tasks.other.json': { 7: doneTask(7) },
  });
  try {
    const r = cli(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(tasksIn(r.stdout), 2);
    assert.match(r.stdout, /from 2 task file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: a file caught mid-write gives a retry message, not a stack trace', () => {
  const dir = fixtureDir({ 'tasks.json': '{"1": {"issue": 1, "log": [' });
  try {
    const r = cli(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /changed while reading.*Retry/s);
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
