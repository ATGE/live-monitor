import './isolate.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

let login;
let config;
let machine;
let savedMachines;
let savedHooks;
let clock;
let reads; // name -> queue of probe outcomes (string stdout | Error)
let calls;

before(async () => {
  ({ config } = await import('../src/config.js'));
  machine = await import('../src/machine.js');
  login = await import('../src/login.js');
  savedMachines = config.machines;
  savedHooks = { ...login.loginHooks };
  config.machines = {
    local: { kind: 'local' },
    box: { kind: 'runner', url: 'http://127.0.0.1:1', token: 'x' },
  };
  machine.registerRunnerClient((name) => ({ name, kind: 'runner' }));
});

after(() => {
  config.machines = savedMachines;
  Object.assign(login.loginHooks, savedHooks);
  machine.registerRunnerClient((name, spec) => { throw new Error(`no runner client in tests: ${name} ${spec?.kind}`); });
  login.resetLoginForTests();
});

beforeEach(() => {
  login.resetLoginForTests();
  clock = NOW;
  reads = { local: [], box: [] };
  calls = [];
  Object.assign(login.loginHooks, {
    now: () => clock,
    timeoutMs: 200,
    probe: async (m) => {
      calls.push(m.name);
      const next = reads[m.name].shift();
      if (next instanceof Error) throw next;
      return next ?? 'NOFILE';
    },
  });
});

const probeOut = ({ refresh = NOW + 20 * DAY, expires = NOW + HOUR, tokens = 1 } = {}) =>
  `R=${refresh ?? 'none'} E=${expires} T=${tokens}\n`;

test('parseProbe reads the numbers-only output and nothing else', () => {
  assert.deepEqual(login.parseProbe(`R=1793671476249 E=1791481103249 T=1\n`),
    { refreshAt: 1793671476249, expiresAt: 1791481103249, hasTokens: true });
  assert.deepEqual(login.parseProbe('R=none E=0 T=0'), { refreshAt: null, expiresAt: 0, hasTokens: false });
  for (const bad of ['', 'NOFILE', 'R=abc E=1 T=1', 'sk-ant-secret R=1 E=1 T=1', 'R=1 E=1 T=2', undefined]) {
    assert.equal(login.parseProbe(bad), null, JSON.stringify(bad));
  }
});

test('a blanked credentials file (tokens empty, expiresAt 0) is expired', () => {
  const s = login.loginStateFrom({ refreshAt: NOW - HOUR, expiresAt: 0, hasTokens: false }, NOW);
  assert.equal(s.state, 'expired');
  // Even if the refresh expiry field is gone too.
  assert.equal(login.loginStateFrom({ refreshAt: null, expiresAt: 0, hasTokens: false }, NOW).state, 'expired');
});

test('the 5-day threshold: 4d23h is shown, 5d1h is not', () => {
  const at = (ms) => login.loginStateFrom({ refreshAt: NOW + ms, expiresAt: NOW + HOUR, hasTokens: true }, NOW).state;
  assert.equal(at(4 * DAY + 23 * HOUR), 'expiring');
  assert.equal(at(5 * DAY), 'expiring');
  assert.equal(at(5 * DAY + HOUR), 'ok');
  assert.equal(at(30 * DAY), 'ok');
  assert.equal(at(-HOUR), 'expired');
  assert.equal(at(0), 'expired');
});

test('a missing refresh expiry, or no reading at all, is unknown rather than a guessed date', () => {
  assert.deepEqual(login.loginStateFrom({ refreshAt: null, expiresAt: NOW + HOUR, hasTokens: true }, NOW),
    { state: 'unknown', expiresAt: null });
  assert.deepEqual(login.loginStateFrom(null, NOW), { state: 'unknown', expiresAt: null });
});

test('checkLogin classifies what the machine printed, and publishes only state', async () => {
  reads.local.push(probeOut({ refresh: NOW + 2 * DAY }));
  const events = [];
  login.loginEvents.on('state', (s) => events.push(s));
  const got = await login.checkLogin('local');
  assert.equal(got.state, 'expiring');
  assert.equal(got.expiresAt, NOW + 2 * DAY);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0].local).sort(), ['checkedAt', 'expiresAt', 'job', 'state']);
  login.loginEvents.removeAllListeners('state');
});

test('an unreachable machine, a timeout or garbage output is unknown, never expired', async () => {
  reads.box.push(Object.assign(new Error('box: offline sk-ant-secret'), { code: 'RUNNER_OFFLINE' }));
  assert.equal((await login.checkLogin('box')).state, 'unknown');

  login.resetLoginForTests();
  login.loginHooks.probe = () => new Promise(() => {});
  assert.equal((await login.checkLogin('box')).state, 'unknown');

  login.resetLoginForTests();
  login.loginHooks.probe = async () => 'R=1 E=1 T=1 extra stuff';
  assert.equal((await login.checkLogin('box')).state, 'unknown');
});

test('cache: 24 h after a good read, 10 min after a failed one, force skips it', async () => {
  reads.local.push(probeOut(), probeOut({ refresh: NOW + 2 * DAY }));
  await login.checkLogin('local');
  clock += 23 * HOUR;
  await login.checkLogin('local');
  assert.equal(calls.length, 1, 'cached for a day');
  clock += 2 * HOUR;
  assert.equal((await login.checkLogin('local')).state, 'expiring');
  assert.equal(calls.length, 2);

  login.resetLoginForTests();
  calls.length = 0;
  reads.box.push(new Error('down'), probeOut());
  await login.checkLogin('box');
  clock += 5 * 60_000;
  await login.checkLogin('box');
  assert.equal(calls.length, 1, 'a failure is retried only after 10 min');
  clock += 6 * 60_000;
  assert.equal((await login.checkLogin('box')).state, 'ok');

  reads.box.push(probeOut({ refresh: NOW - DAY }));
  assert.equal((await login.checkLogin('box', { force: true })).state, 'expired');
});

test('checkAllLogins reads every machine in parallel', async () => {
  reads.local.push(probeOut());
  reads.box.push(probeOut({ refresh: NOW + DAY }));
  await login.checkAllLogins();
  const s = login.loginState();
  assert.equal(s.local.state, 'ok');
  assert.equal(s.box.state, 'expiring');
});

test('noteAuthFailure marks the machine expired; setLoginJob keeps only the state', async () => {
  reads.local.push(probeOut());
  await login.checkLogin('local');
  login.noteAuthFailure('local');
  assert.equal(login.loginState().local.state, 'expired');
  login.setLoginJob('local', { state: 'url', url: 'https://example.test/?state=secret', ticket: 't', code: 'c' });
  assert.deepEqual(login.loginState().local.job, { state: 'url' });
  assert.ok(!JSON.stringify(login.loginState()).includes('secret'));
  login.setLoginJob('local', null);
  assert.equal(login.loginState().local.job, null);
});

test('a runner going offline is unknown; coming back re-reads it', async () => {
  const { runnerEvents } = await import('../src/runner-client.js');
  reads.box.push(probeOut({ refresh: NOW + DAY }), probeOut({ refresh: NOW + 20 * DAY }));
  reads.local.push(probeOut());
  login.startLoginChecks();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(login.loginState().box.state, 'expiring');

  runnerEvents.emit('offline', { machine: 'box', online: false });
  assert.equal(login.loginState().box.state, 'unknown');

  runnerEvents.emit('online', { machine: 'box', online: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(login.loginState().box.state, 'ok');
});

test('a failing usage probe triggers a re-read of the laptop only', async () => {
  const { usageEvents } = await import('../src/usage.js');
  reads.local.push(probeOut(), probeOut({ refresh: NOW - HOUR }));
  reads.box.push(probeOut());
  login.startLoginChecks();
  await new Promise((r) => setTimeout(r, 50));
  const before = calls.length;

  usageEvents.emit('state', { error: null });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, before, 'a healthy probe reads nothing');

  usageEvents.emit('state', { error: 'Sin respuesta del CLI en 30 s' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1), 'local');
  assert.equal(login.loginState().local.state, 'expired');
});

test('an auth failure survives a re-read of a file that still looks healthy, until the refresh expiry moves', async () => {
  reads.local.push(probeOut({ refresh: NOW + 20 * DAY }));
  await login.checkLogin('local');
  login.noteAuthFailure('local');
  reads.local.push(probeOut({ refresh: NOW + 20 * DAY }));
  await login.checkLogin('local', { force: true });
  assert.equal(login.loginState().local.state, 'expired', 'revoked server-side: the file is fine, the login is not');
  assert.ok(!JSON.stringify(login.loginState()).includes('failedAt'));
  // A renewal moves the refresh expiry forward: the mark goes away.
  reads.local.push(probeOut({ refresh: NOW + 30 * DAY }));
  await login.checkLogin('local', { force: true });
  assert.equal(login.loginState().local.state, 'ok');
});

test('clearAuthFailure drops the mark after a verified renewal', async () => {
  reads.local.push(probeOut({ refresh: NOW + 20 * DAY }));
  await login.checkLogin('local');
  login.noteAuthFailure('local');
  login.clearAuthFailure('local');
  reads.local.push(probeOut({ refresh: NOW + 20 * DAY }));
  await login.checkLogin('local', { force: true });
  assert.equal(login.loginState().local.state, 'ok');
});
