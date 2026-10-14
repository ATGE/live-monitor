// «Reiniciar tablero», server side. The router runs for real on an ephemeral
// port; restartHooks are replaced, so nothing spawns restart.ps1, closes a real
// session or flushes the live store. Only setInterval is mocked, for the wait timer.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tempDir } from './teardown.mjs';
import express from 'express';

const dataDir = tempDir('hfsmon-restart-');
mkdirSync(dataDir, { recursive: true });
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

const { restartRouter, restartHooks, restartDecision, restartPending, checkWaiting, busyList, WAIT_POLL_MS } = await import('../src/restart.js');

const original = { ...restartHooks };
const flush = () => new Promise((r) => setImmediate(r));
let server;
let base;
let calls;
let busy;
let upgrading;
let failSpawn;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(restartRouter());
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(restartHooks, original);
  await new Promise((r) => server.close(r));
});

/** Each test starts from idle, with fake hooks that record their calls in order. */
async function fresh({ platform = 'win32', busyNow = [], upgradingNow = false, spawnError = null } = {}) {
  calls = [];
  busy = busyNow;
  upgrading = upgradingNow;
  failSpawn = spawnError;
  restartHooks.stillAliveMs = original.stillAliveMs;
  Object.assign(restartHooks, {
    platform: () => platform,
    upgrading: () => upgrading,
    loginBusy: () => false,
    busy: () => busy,
    closeSessions: async () => { calls.push('close'); },
    flush: () => { calls.push('flush'); },
    spawnRestart: () => {
      calls.push('spawn');
      if (failSpawn) throw failSpawn;
    },
  });
  // Clears a waiting state left by a previous test, whatever the upgrade flag says.
  const wasUpgrading = upgrading;
  upgrading = false;
  await post('/api/restart/cancel');
  upgrading = wasUpgrading;
  calls = [];
}

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const TASK_REASON = { project: 'hfs', issue: 12, text: '#12 está ejecutando un plan' };
const CHAT_REASON = { project: 'hfs', issue: null, text: 'el chat de proyecto hfs@pc: «x» está en marcha' };

test('GET reports idle with nothing busy, and supported on win32', async () => {
  await fresh();
  const r = await get('/api/restart');
  assert.equal(r.status, 200);
  const { startedAt, ...rest } = r.body;
  assert.deepEqual(rest, { state: 'idle', busy: [], supported: true, lastFailure: null }, 'state/busy/supported unchanged; no failure is null');
  assert.equal(new Date(startedAt).toISOString(), startedAt, 'startedAt is an ISO time');
  assert.equal((await get('/api/restart')).body.startedAt, startedAt, 'it is the process start: stable across polls');
});

test('startedAt is byte-identical across polls made apart', async () => {
  await fresh();
  const a = (await get('/api/restart')).body.startedAt;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await get('/api/restart')).body.startedAt, a);
});

/** Waits for a real (short) still-alive timer: stillAliveMs is shrunk for the test. */
const afterStillAlive = () => new Promise((r) => setTimeout(r, restartHooks.stillAliveMs + 40));

test('when the still-alive timer fires, GET reports the failure with its fields', async () => {
  await fresh();
  restartHooks.stillAliveMs = 20;
  const before = Date.now();
  assert.equal((await post('/api/restart', { force: true })).status, 202);
  await afterStillAlive();
  const r = (await get('/api/restart')).body;
  assert.equal(r.state, 'idle');
  assert.equal(r.lastFailure.reason, 'still-alive');
  assert.equal(r.lastFailure.afterMs, 20);
  assert.ok(new Date(r.lastFailure.at).getTime() >= before, 'at is an ISO time of the failure');
  assert.deepEqual(Object.keys(r.lastFailure).sort(), ['afterMs', 'at', 'reason']);
});

test('a new POST /api/restart clears the failure, and a failed spawn records its own', async () => {
  await fresh();
  restartHooks.stillAliveMs = 20;
  await post('/api/restart', { force: true });
  await afterStillAlive();
  assert.equal((await get('/api/restart')).body.lastFailure.reason, 'still-alive');
  restartHooks.stillAliveMs = 60_000;
  await post('/api/restart', { force: true });
  assert.equal((await get('/api/restart')).body.lastFailure, null, 'a retry starts clean');

  await fresh({ spawnError: new Error('no powershell') });
  assert.equal((await post('/api/restart', { force: true })).status, 500);
  const f = (await get('/api/restart')).body.lastFailure;
  assert.equal(f.reason, 'error');
  assert.match(f.message, /no powershell/);
  await fresh();
  await post('/api/restart', { force: true });
  assert.equal((await get('/api/restart')).body.lastFailure, null);
});

test('GET lists what is busy and reports unsupported off win32', async () => {
  await fresh({ platform: 'linux', busyNow: [{ id: 'hfs#12', title: 'x', kind: 'task' }] });
  const r = await get('/api/restart');
  assert.equal(r.status, 200);
  assert.equal(r.body.supported, false);
  assert.deepEqual(r.body.busy, [{ id: 'hfs#12', title: 'x', kind: 'task' }]);
});

test('busyList maps task and project-chat reasons to id, title and kind', () => {
  const out = busyList([TASK_REASON, CHAT_REASON]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'task');
  assert.equal(out[0].title, TASK_REASON.text);
  assert.equal(out[1].kind, 'project-chat');
  assert.equal(out[1].title, CHAT_REASON.text);
  assert.equal(typeof out[1].id, 'string');
});

test('restartDecision: refuses during an upgrade, restarts when forced or idle, waits otherwise', () => {
  assert.equal(restartDecision({ force: true, busy: [{}], upgrading: true }), 'refuse');
  assert.equal(restartDecision({ force: false, busy: [], upgrading: true }), 'refuse');
  assert.equal(restartDecision({ force: true, busy: [{}], upgrading: false }), 'now');
  assert.equal(restartDecision({ force: false, busy: [], upgrading: false }), 'now');
  assert.equal(restartDecision({ force: false, busy: [{}], upgrading: false }), 'wait');
});

test('POST without force and with busy work waits, and spawns nothing', async () => {
  await fresh({ busyNow: [{ id: 'hfs#12', title: 'x', kind: 'task' }] });
  const r = await post('/api/restart', { force: false });
  assert.deepEqual(r, { status: 202, body: { state: 'waiting' } });
  assert.deepEqual(calls, []);
  assert.equal((await get('/api/restart')).body.state, 'waiting');
  await post('/api/restart/cancel');
});

test('the wait timer restarts once busy empties, with sessions closed and the store flushed first', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await fresh({ busyNow: [{ id: 'hfs#12', title: 'x', kind: 'task' }] });
  await post('/api/restart', { force: false });

  t.mock.timers.tick(WAIT_POLL_MS);
  await flush();
  assert.deepEqual(calls, [], 'still busy: nothing happens');

  busy = [];
  t.mock.timers.tick(WAIT_POLL_MS);
  await flush();
  await flush();
  assert.deepEqual(calls, ['close', 'flush', 'spawn']);
  assert.equal((await get('/api/restart')).body.state, 'restarting');
});

test('force=true with busy work closes sessions, flushes and spawns now, in that order', async () => {
  await fresh({ busyNow: [{ id: 'hfs#12', title: 'x', kind: 'task' }] });
  const r = await post('/api/restart', { force: true });
  assert.deepEqual(r, { status: 202, body: { state: 'restarting' } });
  assert.deepEqual(calls, ['close', 'flush', 'spawn']);
  assert.equal((await get('/api/restart')).body.state, 'restarting');
});

test('a plain POST with nothing busy restarts now', async () => {
  await fresh();
  const r = await post('/api/restart', {});
  assert.equal(r.status, 202);
  assert.deepEqual(calls, ['close', 'flush', 'spawn']);
});

test('a failed spawn answers 500 and a later attempt is not blocked', async () => {
  await fresh({ spawnError: new Error('no powershell') });
  const r = await post('/api/restart', { force: true });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /no powershell/);
  assert.equal((await get('/api/restart')).body.state, 'idle', 'a failed spawn leaves nothing restarting');
  await fresh();
  assert.equal((await post('/api/restart', { force: true })).status, 202);
  assert.deepEqual(calls, ['close', 'flush', 'spawn']);
});

test('cancel stops a waiting restart and its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await fresh({ busyNow: [{ id: 'hfs#12', title: 'x', kind: 'task' }] });
  await post('/api/restart', { force: false });
  const r = await post('/api/restart/cancel');
  assert.deepEqual(r, { status: 200, body: { state: 'idle' } });

  busy = [];
  t.mock.timers.tick(WAIT_POLL_MS * 3);
  await flush();
  assert.deepEqual(calls, [], 'a cancelled wait never restarts');
});

test('cancel with nothing waiting answers idle', async () => {
  await fresh();
  assert.deepEqual(await post('/api/restart/cancel'), { status: 200, body: { state: 'idle' } });
});

test('POST answers 501 outside win32, and spawns nothing', async () => {
  await fresh({ platform: 'linux' });
  const r = await post('/api/restart', { force: true });
  assert.equal(r.status, 501);
  assert.equal(r.body.supported, false);
  assert.deepEqual(calls, []);
});

test('POST and cancel answer 409 while an upgrade runs, and spawn nothing', async () => {
  await fresh({ busyNow: [{ id: 'hfs#12', title: 'x', kind: 'task' }], upgradingNow: true });
  const p = await post('/api/restart', { force: true });
  assert.equal(p.status, 409);
  assert.ok(Array.isArray(p.body.busy));
  const c = await post('/api/restart/cancel');
  assert.equal(c.status, 409);
  assert.deepEqual(calls, []);
});

test('login: restartDecision refuses while a login renewal runs', () => {
  assert.equal(restartDecision({ force: true, busy: [], upgrading: false, renewing: true }), 'refuse');
  assert.equal(restartDecision({ force: false, busy: [TASK_REASON], upgrading: false, renewing: true }), 'refuse');
  assert.equal(restartDecision({ force: true, busy: [], upgrading: false, renewing: false }), 'now');
});

test('login: POST answers 409 with its own message while a login renews, and spawns nothing', async () => {
  await fresh();
  restartHooks.loginBusy = () => true;
  const r = await post('/api/restart', { force: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /login/);
  assert.ok(Array.isArray(r.body.busy));
  assert.deepEqual(calls, []);
  assert.equal(restartPending(), false, 'a refused request leaves no restart pending');
  restartHooks.loginBusy = () => false;
});

test('login: restartPending is true while a restart waits and false after cancel', async () => {
  await fresh({ busyNow: [TASK_REASON] });
  assert.equal(restartPending(), false);
  assert.equal((await post('/api/restart', { force: false })).body.state, 'waiting');
  assert.equal(restartPending(), true);
  await post('/api/restart/cancel');
  assert.equal(restartPending(), false);
});

test('login: a waiting restart gives up once a login renewal begins', async () => {
  await fresh({ busyNow: [TASK_REASON] });
  await post('/api/restart', { force: false });
  assert.equal(restartPending(), true);
  restartHooks.loginBusy = () => true;
  assert.equal(await checkWaiting(), 'idle');
  restartHooks.loginBusy = () => false;
  assert.deepEqual(calls, []);
});

test('login: GET body keeps its shape', async () => {
  await fresh();
  assert.deepEqual(Object.keys((await get('/api/restart')).body).sort(), ['busy', 'lastFailure', 'startedAt', 'state', 'supported']);
});

test('a POST refused with 409 or 501 keeps an existing lastFailure', async () => {
  await fresh();
  restartHooks.stillAliveMs = 20;
  await post('/api/restart', { force: true });
  await afterStillAlive();
  assert.equal((await get('/api/restart')).body.lastFailure.reason, 'still-alive');
  restartHooks.stillAliveMs = 60_000;
  upgrading = true;
  assert.equal((await post('/api/restart', { force: true })).status, 409);
  assert.equal((await get('/api/restart')).body.lastFailure.reason, 'still-alive');
  upgrading = false;
  restartHooks.platform = () => 'linux';
  assert.equal((await post('/api/restart', { force: true })).status, 501);
  assert.equal((await get('/api/restart')).body.lastFailure.reason, 'still-alive');
  await fresh();
  await post('/api/restart', { force: true });
  assert.equal((await get('/api/restart')).body.lastFailure, null, 'an accepted POST clears it');
});
