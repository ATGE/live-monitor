import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { removeTreeReported } from './teardown.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

// The metrics routes and the `timing` summary, against the real board: its own
// process, config and data dir (same pattern as routes.test.mjs).

const ROOT = path.resolve(import.meta.dirname, '..', '..');

let dir;
let port;
let child;

const url = (p) => `http://127.0.0.1:${port}${p}`;

async function get(p) {
  const res = await fetch(url(p));
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

const span = (kind, name, from, ms, meta = {}) => ({
  kind, name, startedAt: at(from), endedAt: at(from + ms), ms, attempt: 1, outcome: 'ok', meta,
});

const task = (issue, title, over = {}) => ({
  issue, title, labels: [], url: `https://example.invalid/${issue}`,
  state: 'assigned', log: [{ ts: at(0), phase: 'estado', line: `log de ${title}` }],
  chats: [], ...over,
});

const project = (id, base) => ({
  id, name: id, repoPath: base, worktreeRoot: `${base}-wt`,
  repo: null, assignee: 'nobody', reviewer: 'nobody', overrides: {},
});

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-metrics-api-'));
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const hfsRepo = path.join(dir, 'hfs');
  const betaRepo = path.join(dir, 'beta');
  mkdirSync(hfsRepo, { recursive: true });
  mkdirSync(betaRepo, { recursive: true });

  // #4: finished, 100 s of run of which 20 s waiting inside the test phase.
  const timed = task(4, 'con tiempos', {
    state: 'done',
    createdAt: at(0),
    doneAt: at(200_000),
    timings: [
      span('phase', 'triage', 0, 30_000),
      span('phase', 'testing', 30_000, 70_000),
      span('wait', 'e2e_gate', 40_000, 20_000, { within: 'testing' }),
      span('session', 'fix', 5_000, 10_000),
    ],
  });
  // #5: an old task, written before `timings` existed.
  writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ 4: timed, 5: task(5, 'vieja') }));
  // Same issue number in another project, with a different triage time.
  writeFileSync(path.join(dataDir, 'tasks.beta.json'), JSON.stringify({
    4: task(4, 'abeja', {
      state: 'done', createdAt: at(0), doneAt: at(100_000),
      timings: [span('phase', 'triage', 0, 90_000), span('wait', 'quota_park', 90_000, 10_000, { within: null })],
    }),
  }));
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project('hfs', hfsRepo), project('beta', betaRepo)]));
  writeFileSync(path.join(dataDir, 'boardtimings.json'), JSON.stringify([
    { id: 'x', kind: 'op', name: 'restart', startedAt: at(0), endedAt: at(5_000), ms: 5_000, outcome: 'ok', meta: {} },
  ]));

  port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody', reviewer: 'nobody' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: hfsRepo, worktreeRoot: `${hfsRepo}-wt` },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: { chatModel: 'sonnet', available: ['sonnet'] },
  }));

  child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, HFSMON_CONFIG: configFile, HFSMON_DATA_DIR: dataDir, HFSMON_NO_AUTOSTART: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.once('exit', (code) => log.push(`[exit ${code}]`));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await get('/api/tasks')).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`the board did not start:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 150); });
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  // `rmSync` does not wait for a Windows lock: see teardown.mjs.
  await removeTreeReported('metrics-api', dir);
});

test('timings route returns the spans and the totals of that project\'s task', async () => {
  const r = await get('/api/projects/hfs/tasks/4/timings');
  assert.equal(r.status, 200);
  assert.equal(r.body.timings.length, 4);
  assert.equal(r.body.summary.wallMs, 200_000);
  assert.equal(r.body.summary.runMs, 100_000);
  assert.equal(r.body.summary.waitMs, 20_000);
  assert.equal(r.body.summary.activeMs, 80_000);
  // Issue 4 of the other project is another task.
  const beta = await get('/api/projects/beta/tasks/4/timings');
  assert.equal(beta.body.timings.length, 2);
});

test('an old task without timings answers an empty timeline, and an unknown task 404s', async () => {
  const r = await get('/api/projects/hfs/tasks/5/timings');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.timings, []);
  assert.equal(r.body.summary.runMs, 0);
  assert.equal((await get('/api/projects/hfs/tasks/999/timings')).status, 404);
});

test('publicTask carries a small timing summary and never the spans', async () => {
  const { body } = await get('/api/projects/hfs/tasks');
  const four = body.tasks.find((t) => t.issue === 4);
  assert.equal('timings' in four, false);
  assert.equal(four.timing.runMs, 100_000);
  assert.equal(four.timing.spans, 4);
  const old = body.tasks.find((t) => t.issue === 5);
  assert.equal(old.timing, null);
  // The snapshot goes through the same projection.
  const snap = await get('/api/tasks');
  for (const t of snap.body.tasks) assert.equal('timings' in t, false);
});

test('project metrics: median and p90 per phase and per wait, from that project only', async () => {
  const r = await get('/api/projects/hfs/metrics');
  assert.equal(r.status, 200);
  assert.equal(r.body.tasks, 1);
  assert.equal(r.body.phases.triage.n, 1);
  assert.equal(r.body.phases.triage.median, 30_000);
  assert.equal(r.body.phases.testing.p90, 70_000);
  assert.equal(r.body.waits.e2e_gate.median, 20_000);
  assert.equal(r.body.waits.quota_park, undefined);
  assert.equal(r.body.waitShare, 20_000 / 200_000);
  assert.equal((await get('/api/projects/nope/metrics')).status, 404);
});

test('global metrics span every project and list the board operations', async () => {
  const r = await get('/api/metrics');
  assert.equal(r.status, 200);
  assert.equal(r.body.tasks, 2);
  assert.equal(r.body.phases.triage.n, 2);
  assert.equal(r.body.phases.triage.p90, 90_000);
  assert.equal(r.body.waits.quota_park.n, 1);
  assert.equal(r.body.board.length, 1);
  assert.equal(r.body.board[0].name, 'restart');
});
