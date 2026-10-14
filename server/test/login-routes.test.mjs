import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { removeTreeReported, tempDir } from './teardown.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

/**
 * The Claude login routes against the real board in its own process: the
 * state is served as states and timestamps only, a renewal can be neither read
 * nor driven without its ticket, and what the board broadcasts or stores never
 * carries a URL, a code or a ticket. No test here starts a real login.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
let dir;
let dataDir;
let port;
let child;
const log = [];

const url = (p) => `http://127.0.0.1:${port}${p}`;

async function call(method, p, body, headers = {}) {
  const res = await fetch(url(p), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
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

before(async () => {
  dir = tempDir('hfsmon-login-routes-');
  dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = path.join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(dataDir, 'tasks.json'), '{}');

  port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: repo, worktreeRoot: `${repo}-wt` },
    stack: { command: 'npm start' },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: { chatModel: 'sonnet', advisorModel: 'opus', fixModel: 'sonnet', available: [{ id: 'sonnet', label: 'Sonnet' }] },
  }));

  child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, HFSMON_CONFIG: configFile, HFSMON_DATA_DIR: dataDir, HFSMON_NO_AUTOSTART: '1',
      GIT_CEILING_DIRECTORIES: [dir, tmpdir()].join(path.delimiter) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  await removeTreeReported('login-routes', dir);
});

const ALLOWED_KEYS = ['state', 'expiresAt', 'checkedAt', 'job'];

test('GET /api/login serves the state of each machine and nothing else', async () => {
  const r = await call('GET', '/api/login');
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.login, 'object');
  for (const [name, entry] of Object.entries(r.body.login)) {
    assert.ok(['ok', 'expiring', 'expired', 'unknown'].includes(entry.state), `${name}: ${entry.state}`);
    assert.deepEqual(Object.keys(entry).sort(), [...ALLOWED_KEYS].sort(), `${name} carries only states and timestamps`);
  }
  const text = JSON.stringify(r.body);
  assert.doesNotMatch(text, /accessToken|refreshToken|https?:\/\//, 'no token and no URL in the state');
});

test('a login for a machine that does not exist is a 404, and its job cannot be read', async () => {
  const start = await call('POST', '/api/machines/nope/login', { force: true });
  assert.equal(start.status, 404);
  const view = await call('GET', '/api/machines/nope/login/job');
  assert.equal(view.status, 200);
  assert.deepEqual(view.body, { state: null, machine: null });
});

test('the code and cancel routes refuse a call without the ticket', async () => {
  const code = await call('POST', '/api/machines/local/login/code', { code: 'abc' });
  assert.equal(code.status, 403);
  const cancel = await call('POST', '/api/machines/local/login/cancel', {});
  assert.equal(cancel.status, 403);
  const wrong = await call('POST', '/api/machines/local/login/cancel', {}, { 'x-login-ticket': 'not-the-ticket' });
  assert.equal(wrong.status, 403);
});

test('a new socket gets login broadcasts as state only, and tasks.json stays free of login data', async () => {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  ws.on('message', (d) => messages.push(String(d)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await new Promise((r) => { setTimeout(r, 400); });
  ws.close();
  for (const m of messages) {
    const msg = JSON.parse(m);
    if (msg.type !== 'login') continue;
    for (const entry of Object.values(msg.login)) {
      assert.deepEqual(Object.keys(entry).sort(), [...ALLOWED_KEYS].sort());
    }
  }
  const stored = readFileSync(path.join(dataDir, 'tasks.json'), 'utf8');
  assert.doesNotMatch(stored, /ticket|auth\/|oauth/i);
  assert.doesNotMatch(log.join(''), /ticket|https:\/\/claude\.ai/i, 'nothing of a login reaches the board output');
});
