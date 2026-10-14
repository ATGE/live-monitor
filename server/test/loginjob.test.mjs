import './isolate.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { tempDir } from './teardown.mjs';
import {
  loginJobHooks, startLoginJob, loginJobView, submitLoginCode, cancelLoginJob,
  loginJobRunning, loginJobRouter, resetLoginJobsForTests,
} from '../src/loginjob.js';
import { loginHooks, resetLoginForTests, loginState } from '../src/login.js';

const dir = tempDir('hfsmon-loginjob-');
const SCRIPT = path.join(dir, 'fake-login.mjs');
writeFileSync(SCRIPT, [
  "const mode = process.env.FAKE_MODE;",
  "const url = 'https://claude.ai/oauth/authorize?code=true&state=SECRET-STATE-XYZ';",
  "process.stderr.write('Opening browser to sign in...\\n');",
  "console.log('If the browser did not open, visit: ' + url);",
  "if (mode === 'code') { console.log('Paste code here if prompted > '); process.stdin.once('data', () => process.exit(0)); }",
  "else if (mode === 'hang') setInterval(() => {}, 1000);",
  "else if (mode === 'fail') process.exit(3);",
  "else setTimeout(() => process.exit(0), 150);",
].join('\n'));

const original = { ...loginJobHooks, timing: { ...loginJobHooks.timing } };
const originalProbe = loginHooks.probe;
const spawned = [];
const local = { name: 'local', kind: 'local' };
let logins; // what readLogin answers, in order
let statusOk;

const waitFor = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${fn}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stateOf = (name, ticket) => loginJobView(name, ticket).state;

beforeEach(() => {
  resetLoginJobsForTests();
  resetLoginForTests();
  spawned.length = 0;
  logins = [0, 5_000];
  statusOk = true;
  process.env.FAKE_MODE = 'url';
  loginHooks.probe = async () => 'R=none E=0 T=0';
  Object.assign(loginJobHooks, {
    machineOf: (name) => (name === 'local' ? local : null),
    localCommand: () => ({ file: process.execPath, args: [SCRIPT] }),
    spawnLocal: (file, args, opts) => {
      const child = original.spawnLocal(file, args, opts);
      if (file === process.execPath) spawned.push(child);
      return child;
    },
    readLogin: async () => ({ expiresAt: logins.length > 1 ? logins.shift() : logins[0] }),
    authStatus: async () => statusOk,
    busy: () => [],
    restartPending: () => false,
    upgradeHolds: () => false,
  });
  loginJobHooks.timing.timeoutMs = 10_000;
  loginJobHooks.timing.waitPollMs = 30;
});

afterEach(async () => {
  for (const c of spawned) { if (c.exitCode === null) await original.killTree(c); }
  Object.assign(loginJobHooks, original);
  loginJobHooks.timing = { ...original.timing };
  loginHooks.probe = originalProbe;
  resetLoginJobsForTests();
  resetLoginForTests();
});

test('a URL-only login: the ticket holder gets the URL and success needs a new expiry', async () => {
  const { ticket } = startLoginJob('local');
  await waitFor(() => loginJobView('local', ticket).url);
  assert.match(loginJobView('local', ticket).url, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
  assert.equal(loginJobView('local', ticket).needsCode, false);
  await waitFor(() => stateOf('local', ticket) === 'done');
});

test('the code field appears only when the command asks for a code, and the code reaches stdin', async () => {
  process.env.FAKE_MODE = 'code';
  const { ticket } = startLoginJob('local');
  await waitFor(() => stateOf('local', ticket) === 'code');
  assert.equal(loginJobView('local', ticket).needsCode, true);
  assert.throws(() => submitLoginCode('local', ticket, 'a\nb'), { status: 400 });
  submitLoginCode('local', ticket, 'THE-CODE');
  await waitFor(() => stateOf('local', ticket) === 'done');
  assert.throws(() => submitLoginCode('local', ticket, 'again'), { status: 409 });
});

test('exit 0 with an unchanged expiry is a failure, not a success', async () => {
  logins = [7_000];
  const { ticket } = startLoginJob('local');
  await waitFor(() => stateOf('local', ticket) === 'failed');
  assert.match(loginJobView('local', ticket).error, /no quedó guardado/);
});

test('exit 0 with a new expiry but no session in claude auth status is a failure', async () => {
  statusOk = false;
  const { ticket } = startLoginJob('local');
  await waitFor(() => stateOf('local', ticket) === 'failed');
  assert.match(loginJobView('local', ticket).error, /sin sesión/);
});

test('a non-zero exit fails with a fixed message that does not echo the output', async () => {
  process.env.FAKE_MODE = 'fail';
  const { ticket } = startLoginJob('local');
  await waitFor(() => stateOf('local', ticket) === 'failed');
  const { error } = loginJobView('local', ticket);
  assert.equal(error, 'El comando de login terminó con error');
  assert.ok(!error.includes('SECRET'));
});

test('the timeout kills the command', async () => {
  process.env.FAKE_MODE = 'hang';
  loginJobHooks.timing.timeoutMs = 400;
  const { ticket } = startLoginJob('local');
  await waitFor(() => spawned.length === 1 && spawned[0].pid);
  const pid = spawned[0].pid;
  await waitFor(() => stateOf('local', ticket) === 'failed');
  assert.match(loginJobView('local', ticket).error, /tiempo/);
  await waitFor(() => !alive(pid));
});

test('cancel kills the command', async () => {
  process.env.FAKE_MODE = 'hang';
  const { ticket } = startLoginJob('local');
  await waitFor(() => loginJobView('local', ticket).url);
  const pid = spawned[0].pid;
  assert.ok(loginJobRunning());
  const view = await cancelLoginJob('local', ticket);
  assert.equal(view.state, 'cancelled');
  await waitFor(() => !alive(pid));
  assert.equal(loginJobRunning(), false);
});

test('the public state of a job carries only {state}, and the job view without a ticket carries no URL', async () => {
  process.env.FAKE_MODE = 'hang';
  const { ticket } = startLoginJob('local');
  await waitFor(() => loginJobView('local', ticket).url);
  assert.deepEqual(loginState().local.job, { state: 'url' });
  assert.deepEqual(loginJobView('local'), { state: 'url', machine: 'local' });
  assert.throws(() => loginJobView('local', 'wrong'), { status: 403 });
});

test('only one login per machine at a time', async () => {
  process.env.FAKE_MODE = 'hang';
  startLoginJob('local');
  assert.throws(() => startLoginJob('local'), { status: 409 });
});

test('busy work on THAT machine: it waits, lists it, and starts when it frees up; force starts now', async () => {
  let busy = [{ id: 'hfs#12', title: '#12 está ejecutando un plan', kind: 'task' }];
  loginJobHooks.busy = (name) => (name === 'local' ? busy : []);
  const { ticket, job } = startLoginJob('local');
  assert.equal(job.state, 'waiting');
  assert.deepEqual(loginJobView('local', ticket).busy, busy);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(stateOf('local', ticket), 'waiting');
  assert.equal(spawned.length, 0);
  busy = [];
  await waitFor(() => stateOf('local', ticket) === 'done');

  logins = [5_000, 9_000];
  busy = [{ id: 'x', title: 'x', kind: 'task' }];
  const forced = startLoginJob('local', { force: true });
  await waitFor(() => stateOf('local', forced.ticket) === 'done');
});

test('mutual exclusion with restart and upgrade, at the start and while waiting', async () => {
  loginJobHooks.restartPending = () => true;
  assert.throws(() => startLoginJob('local'), { status: 409, message: /reinicio/ });
  loginJobHooks.restartPending = () => false;
  loginJobHooks.upgradeHolds = () => true;
  assert.throws(() => startLoginJob('local'), { status: 409, message: /updating/ });
  loginJobHooks.upgradeHolds = () => false;

  loginJobHooks.busy = () => [{ id: 'a', title: 'a', kind: 'task' }];
  const { ticket } = startLoginJob('local');
  loginJobHooks.upgradeHolds = () => true;
  await waitFor(() => stateOf('local', ticket) === 'failed');
  assert.equal(spawned.length, 0);
});

test('an unknown machine is a 404', () => {
  assert.throws(() => startLoginJob('nope'), { status: 404 });
});

// --- the runner route: the /claude socket driven directly -------------------

class FakeWs extends EventEmitter {
  constructor(first) { super(); this.first = first; this.sent = []; this.closed = false; }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; this.emit('close'); }
  frame(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function fakeRunner() {
  const box = { name: 'box', kind: 'runner', sockets: [], ws(route, first) { const w = new FakeWs(first); w.route = route; box.sockets.push(w); return w; } };
  return box;
}

test('on a runner the login goes through /claude: URL, code frame, and success after the re-read', async () => {
  const box = fakeRunner();
  loginJobHooks.machineOf = (name) => (name === 'box' ? box : null);
  const { ticket } = startLoginJob('box');
  const ws = await waitFor(() => box.sockets[0]);
  assert.equal(ws.route, '/claude');
  assert.deepEqual(ws.first, { start: { args: ['auth', 'login'] } });
  ws.frame({ stderr: 'visit https://claude.ai/oauth/authorize?state=ABC\n' });
  ws.frame({ stdout: 'Paste code here if prompted > ' });
  await waitFor(() => stateOf('box', ticket) === 'code');
  assert.equal(loginJobView('box', ticket).url, 'https://claude.ai/oauth/authorize?state=ABC');
  submitLoginCode('box', ticket, 'RUNNER-CODE');
  assert.deepEqual(ws.sent.at(-1), { stdin: 'RUNNER-CODE\n' });
  ws.frame({ exit: { code: 0, signal: null } });
  await waitFor(() => stateOf('box', ticket) === 'done');
});

test('on a runner, cancel sends the kill frame and closes the socket', async () => {
  const box = fakeRunner();
  loginJobHooks.machineOf = (name) => (name === 'box' ? box : null);
  const { ticket } = startLoginJob('box');
  const ws = await waitFor(() => box.sockets[0]);
  ws.frame({ stdout: 'https://claude.ai/x\n' });
  await cancelLoginJob('box', ticket);
  assert.deepEqual(ws.sent.at(-1), { kill: true });
  assert.equal(ws.closed, true);
  assert.equal(stateOf('box', ticket), 'cancelled');
});

test('on a runner, a spawn error frame or a dropped socket fails the job', async () => {
  const box = fakeRunner();
  loginJobHooks.machineOf = (name) => (name === 'box' ? box : null);
  const a = startLoginJob('box');
  const ws = await waitFor(() => box.sockets[0]);
  ws.frame({ error: 'spawn claude ENOENT' });
  await waitFor(() => stateOf('box', a.ticket) === 'failed');
  assert.equal(loginJobView('box', a.ticket).error, 'Se perdió la conexión con el comando de login');
});

// --- the router ------------------------------------------------------------

async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use(loginJobRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
const call = async (base, method, p, { body, ticket } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(ticket ? { 'x-login-ticket': ticket } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

test('router: 202 with a ticket, the URL only with the ticket, 403 for a wrong one, 409 for a second start', async () => {
  process.env.FAKE_MODE = 'hang';
  await withApp(async (base) => {
    const started = await call(base, 'POST', '/api/machines/local/login', { body: {} });
    assert.equal(started.status, 202);
    const { ticket } = started.body;
    assert.match(ticket, /^[0-9a-f]{32}$/);
    await waitFor(async () => (await call(base, 'GET', '/api/machines/local/login/job', { ticket })).body.url);

    const anon = await call(base, 'GET', '/api/machines/local/login/job');
    assert.equal(anon.status, 200);
    assert.equal(anon.body.url, undefined);
    assert.ok(!JSON.stringify(anon.body).includes('claude.ai'));

    assert.equal((await call(base, 'GET', '/api/machines/local/login/job', { ticket: 'bad' })).status, 403);
    assert.equal((await call(base, 'POST', '/api/machines/local/login/cancel', { ticket: 'bad' })).status, 403);
    assert.equal((await call(base, 'POST', '/api/machines/local/login', { body: {} })).status, 409);
    assert.equal((await call(base, 'POST', '/api/machines/local/login/code', { ticket, body: { code: 'x' } })).status, 409);

    const cancelled = await call(base, 'POST', '/api/machines/local/login/cancel', { ticket });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.state, 'cancelled');
  });
});

test('router: the 409 for restart carries the busy list', async () => {
  loginJobHooks.restartPending = () => true;
  loginJobHooks.busy = () => [{ id: 'a', title: 'a', kind: 'task' }];
  await withApp(async (base) => {
    const r = await call(base, 'POST', '/api/machines/local/login', { body: {} });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.busy, [{ id: 'a', title: 'a', kind: 'task' }]);
  });
});
