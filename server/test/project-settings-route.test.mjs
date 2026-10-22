import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { removeTree } from './teardown.mjs';

/**
 * `POST /api/projects/:project/settings` and the `browserQaProjectOn` field of
 * the public task, against the real board in its own process (same scaffold as
 * `routes-wave2.test.mjs`).
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
let dir;
let dataDir;
let port;
let child;

const url = (p) => `http://127.0.0.1:${port}${p}`;

async function call(method, p, body) {
  const res = await fetch(url(p), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});

const task = (issue, title) => ({
  issue, title, labels: [], url: `https://example.invalid/${issue}`,
  state: 'assigned', log: [{ ts: '2026-09-30T00:00:00.000Z', phase: 'estado', line: title }], chats: [],
});

const project = (id, base) => ({
  id, name: id, repoPath: base, worktreeRoot: `${base}-wt`,
  repo: null, assignee: 'nobody', overrides: {},
});

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-pset-'));
  dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const one = path.join(dir, 'one');
  const two = path.join(dir, 'two');
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });

  writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ 5: task(5, 'en hfs') }));
  writeFileSync(path.join(dataDir, 'tasks.docs.json'), JSON.stringify({ 5: task(5, 'en docs') }));
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project('hfs', one), project('docs', two)]));

  port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: one, worktreeRoot: `${one}-wt` },
    stack: { command: 'npm start' },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: {
      chatModel: 'sonnet', advisorModel: 'opus', fixModel: 'sonnet',
      available: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }],
    },
  }));

  child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, HFSMON_CONFIG: configFile, HFSMON_DATA_DIR: dataDir, HFSMON_NO_AUTOSTART: '1',
      GIT_CEILING_DIRECTORIES: [dir, tmpdir()].join(path.delimiter) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.once('exit', (code) => log.push(`[exit ${code}]`));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await call('GET', '/api/tasks')).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`el tablero no levantó:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 150); });
  }

  // startPolling() runs an initial GitHub sync even with HFSMON_NO_AUTOSTART=1.
  // Drain it before the WebSocket assertions: late store.task messages from
  // startup are not caused by the settings POST being tested below.
  const pollDeadline = Date.now() + 30_000;
  for (;;) {
    const { body } = await call('GET', '/api/tasks');
    if (body.poll?.lastPollAt && body.poll.running === false) break;
    if (Date.now() > pollDeadline) {
      throw new Error(`initial GitHub poll did not finish:\n${log.join('')}`);
    }
    await new Promise((r) => { setTimeout(r, 150); });
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  await removeTree(dir);
});

const browserQaProjectOn = async (p) => {
  const { body } = await call('GET', '/api/tasks');
  return body.tasks.find((t) => t.project === p && t.issue === 5).browserQaProjectOn;
};

test('POST …/settings answers 200 with the snapshot carrying the project overlay', async () => {
  const res = await call('POST', '/api/projects/hfs/settings', { approvePlan: true, pollIntervalMinutes: 7 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.projects.hfs, { approvePlan: true, pollIntervalMinutes: 7 });
  assert.equal(typeof res.body.maxActiveTasks, 'number', 'the full settings snapshot, not just the overlay');
  assert.equal(res.body.approvePlan, false, 'the board-wide value is untouched');
  const again = await call('GET', '/api/settings');
  assert.deepEqual(again.body.projects.hfs, { approvePlan: true, pollIntervalMinutes: 7 });
});

test('POST …/settings with null removes the override', async () => {
  const res = await call('POST', '/api/projects/hfs/settings', { approvePlan: null });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.projects.hfs, { pollIntervalMinutes: 7 });
  const last = await call('POST', '/api/projects/hfs/settings', { pollIntervalMinutes: null });
  assert.equal(last.body.projects.hfs, undefined, 'an empty overlay is dropped');
});

test('POST …/settings refuses a board-wide key and an invalid value with 400, changing nothing', async () => {
  const wide = await call('POST', '/api/projects/hfs/settings', { maxActiveTasks: 2 });
  assert.equal(wide.status, 400);
  assert.match(wide.body.error, /maxActiveTasks/);
  const bad = await call('POST', '/api/projects/hfs/settings', { pollIntervalMinutes: 0 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /pollIntervalMinutes/);
  const after = await call('GET', '/api/settings');
  assert.equal(after.body.projects.hfs, undefined);
});

test('POST …/settings answers 404 for a project that is not registered, and stores nothing', async () => {
  const res = await call('POST', '/api/projects/ghost/settings', { browserQa: false });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /ghost/);
  const after = await call('GET', '/api/settings');
  assert.equal(after.body.projects.ghost, undefined);
});

test('the public task carries browserQaProjectOn, following the project and not the other projects', async () => {
  assert.equal(await browserQaProjectOn('hfs'), true);
  assert.equal(await browserQaProjectOn('docs'), true);

  await call('POST', '/api/projects/docs/settings', { browserQa: false });
  assert.equal(await browserQaProjectOn('docs'), false);
  assert.equal(await browserQaProjectOn('hfs'), true, 'no leak into the other project');

  await call('POST', '/api/projects/docs/settings', { browserQa: null });
  assert.equal(await browserQaProjectOn('docs'), true, 'back to the board value');
});

test('a project settings change re-broadcasts the tasks with the new browserQaProjectOn; an unrelated change does not', async () => {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  ws.on('message', (b) => { try { msgs.push(JSON.parse(String(b))); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const settle = () => new Promise((r) => { setTimeout(r, 400); });
  try {
    await settle();
    msgs.length = 0;
    await call('POST', '/api/projects/docs/settings', { browserQa: false });
    await settle();
    const tasks = msgs.filter((m) => m.type === 'task' && m.task.project === 'docs');
    assert.ok(tasks.length > 0, 'the tasks of the board are sent again');
    assert.ok(tasks.every((m) => m.task.browserQaProjectOn === false), 'carrying the new value');

    msgs.length = 0;
    const wide = await call('POST', '/api/settings', { maxActiveTasks: 2 });
    assert.equal(wide.status, 200);
    await settle();
    assert.ok(msgs.some((m) => m.type === 'settings'), 'the settings broadcast still goes out');
    assert.equal(msgs.filter((m) => m.type === 'task').length, 0, 'no task broadcast for a key the cards do not depend on');
  } finally {
    ws.close();
    await call('POST', '/api/projects/docs/settings', { browserQa: null });
    await call('POST', '/api/settings', { maxActiveTasks: 1 });
  }
});
