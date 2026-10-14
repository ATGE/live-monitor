import './isolate.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const FD = 'frontend-design@claude-plugins-official';
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

let up;
let config;
let machine;
let settingsMod;
let savedMachines;
let savedHooks;
let clock;
let listings; // machine name -> listing array | Error
let cliCalls; // [{ machine, args }]
let cliResult; // (machine, args) -> { ok, message } ; may mutate `listings`

before(async () => {
  ({ config } = await import('../src/config.js'));
  machine = await import('../src/machine.js');
  settingsMod = await import('../src/settings.js');
  up = await import('../src/userplugins.js');
  savedMachines = config.machines;
  savedHooks = { ...up.userPluginHooks };
  config.machines = {
    local: { kind: 'local' },
    box: { kind: 'runner', url: 'http://127.0.0.1:1', token: 'x' },
  };
  machine.registerRunnerClient((name) => ({ name, kind: 'runner' }));
});

after(() => {
  config.machines = savedMachines;
  Object.assign(up.userPluginHooks, savedHooks);
  machine.registerRunnerClient((name, spec) => { throw new Error(`no runner client in tests: ${name} ${spec?.kind}`); });
  up.resetUserPluginsForTests();
  settingsMod.settings.update({ requiredPlugins: [...settingsMod.DEFAULT_REQUIRED_PLUGINS] });
});

beforeEach(() => {
  up.resetUserPluginsForTests();
  settingsMod.settings.update({ requiredPlugins: [FD] });
  clock = NOW;
  listings = { local: [{ id: FD, enabled: true }], box: [{ id: FD, enabled: true }] };
  cliCalls = [];
  cliResult = () => ({ ok: true, message: '' });
  Object.assign(up.userPluginHooks, {
    now: () => clock,
    timeoutMs: 200,
    restartPending: () => false,
    upgradeHolds: () => false,
    list: async (m) => {
      const l = listings[m.name];
      if (l instanceof Error) throw l;
      return l;
    },
    cli: async (m, args) => {
      cliCalls.push({ machine: m.name, args });
      return cliResult(m, args);
    },
  });
});

test('parseList keeps user-scope entries and ignores the rest of the CLI output', () => {
  const out = JSON.stringify([
    { id: FD, version: 'abc', scope: 'user', enabled: true, installPath: 'x' },
    { id: 'adobe@synced', scope: 'synced', enabled: true },
    { id: 'off@m', scope: 'user', enabled: false },
  ]);
  assert.deepEqual(up.parseList(out), [{ id: FD, enabled: true }, { id: 'off@m', enabled: false }]);
  assert.equal(up.parseList('not json'), null);
  assert.equal(up.parseList('{}'), null);
  assert.deepEqual(up.parseFallback('[{"id":"a@b","enabled":false}]\n'), [{ id: 'a@b', enabled: false }]);
  assert.equal(up.parseFallback('NOFILE'), null);
});

test('diffRequired separates missing from installed-but-disabled', () => {
  assert.deepEqual(up.diffRequired(['a@m', 'b@m', 'c@m'], [{ id: 'a@m', enabled: true }, { id: 'b@m', enabled: false }]),
    { missing: ['c@m'], disabled: ['b@m'] });
});

test('the default list probe runs the CLI argv, and falls back to the file read when the CLI fails', async () => {
  const calls = [];
  const fake = (cliOk) => ({
    name: 'x', kind: 'runner',
    async exec(file, args) {
      calls.push([file, ...args]);
      if (file === 'claude') return cliOk ? { ok: true, stdout: JSON.stringify([{ id: FD, scope: 'user', enabled: true }]) } : { ok: false, stdout: '', stderr: 'boom' };
      return { ok: true, stdout: `[{"id":"${FD}","enabled":true}]\n` };
    },
  });
  const real = await import('../src/userplugins.js');
  // The seam under test is the default implementation, not the beforeEach double.
  assert.deepEqual(await savedHooks.list.call(real.userPluginHooks, fake(true)), [{ id: FD, enabled: true }]);
  assert.deepEqual(calls[0], ['claude', 'plugin', 'list', '--json']);
  calls.length = 0;
  assert.deepEqual(await savedHooks.list.call(real.userPluginHooks, fake(false)), [{ id: FD, enabled: true }]);
  assert.equal(calls[1][0], 'node');
  assert.equal(calls[1][1], '-e');
  // The fallback script reads installed_plugins.json and only enabledPlugins.
  assert.match(calls[1][2], /installed_plugins\.json/);
  assert.match(calls[1][2], /enabledPlugins/);
});

test('the check reports a missing and a disabled plugin per machine, and nothing for an unreachable one', async () => {
  settingsMod.settings.update({ requiredPlugins: [FD, 'other@m'] });
  listings.local = [{ id: FD, enabled: true }];
  listings.box = new Error('offline');
  await up.checkAllPlugins({ force: true });
  const s = up.pluginsState();
  assert.deepEqual(s.required, [FD, 'other@m']);
  assert.equal(s.machines.local.online, true);
  assert.deepEqual(s.machines.local.missing, ['other@m']);
  assert.deepEqual(s.machines.local.disabled, []);
  assert.equal(s.machines.box.online, false);
  assert.deepEqual(s.machines.box.missing, []);

  listings.local = [{ id: FD, enabled: false }, { id: 'other@m', enabled: true }];
  await up.checkPlugins('local', { force: true });
  assert.deepEqual(up.pluginsState().machines.local.disabled, [FD]);
  assert.deepEqual(up.pluginsState().machines.local.missing, []);
});

test('editing the required list changes what is missing without asking the machines again', async () => {
  let reads = 0;
  up.userPluginHooks.list = async () => { reads += 1; return [{ id: FD, enabled: true }]; };
  await up.checkPlugins('local', { force: true });
  assert.deepEqual(up.pluginsState().machines.local.missing, []);
  settingsMod.settings.update({ requiredPlugins: [FD, 'new@m'] });
  assert.deepEqual(up.pluginsState().machines.local.missing, ['new@m']);
  assert.equal(reads, 1);
});

test('the check is cached unless forced', async () => {
  let reads = 0;
  up.userPluginHooks.list = async () => { reads += 1; return []; };
  await up.checkPlugins('local');
  await up.checkPlugins('local');
  assert.equal(reads, 1);
  await up.checkPlugins('local', { force: true });
  assert.equal(reads, 2);
});

test('startup checks only read: nothing is installed or enabled', async () => {
  listings.local = [];
  listings.box = [{ id: FD, enabled: false }];
  up.startPluginChecks();
  await up.checkAllPlugins();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(cliCalls, []);
  assert.deepEqual(up.pluginsState().machines.local.missing, [FD]);
  assert.deepEqual(up.pluginsState().machines.box.disabled, [FD]);
});

test('an install runs the argv without a shell, re-probes, and ends done', async () => {
  listings.local = [];
  await up.checkPlugins('local', { force: true });
  cliResult = (m) => { listings[m.name] = [{ id: FD, enabled: true }]; return { ok: true, message: '' }; };
  const view = up.startPluginInstall('local', FD);
  assert.equal(view.state, 'installing');
  await up.pluginJobSettled('local');
  assert.deepEqual(cliCalls, [{ machine: 'local', args: ['install', FD, '--scope', 'user', '--json'] }]);
  assert.equal(up.pluginJobView('local').state, 'done');
  assert.deepEqual(up.pluginsState().machines.local.missing, []);
  assert.equal(up.pluginsState().machines.local.job, null);
  assert.equal(up.pluginJobRunning(), false);
});

test('an install that leaves the plugin disabled enables it, then re-probes', async () => {
  listings.local = [];
  await up.checkPlugins('local', { force: true });
  cliResult = (m, args) => {
    listings[m.name] = [{ id: FD, enabled: args[0] === 'enable' }];
    return { ok: true, message: '' };
  };
  up.startPluginInstall('local', FD);
  await up.pluginJobSettled('local');
  assert.deepEqual(cliCalls.map((c) => c.args[0]), ['install', 'enable']);
  assert.equal(up.pluginJobView('local').state, 'done');
});

test('a failed install shows the command message and the machine stays missing', async () => {
  listings.local = [];
  await up.checkPlugins('local', { force: true });
  cliResult = () => ({ ok: false, message: 'git is required\nto clone the marketplace' });
  up.startPluginInstall('local', FD);
  await up.pluginJobSettled('local');
  const v = up.pluginJobView('local');
  assert.equal(v.state, 'failed');
  assert.equal(v.error, 'git is required to clone the marketplace');
  assert.deepEqual(up.pluginsState().machines.local.missing, [FD]);
  assert.equal(up.pluginsState().machines.local.job.state, 'failed');
});

test('an id outside the list, or not a valid id, is rejected and nothing runs', async () => {
  for (const bad of ['other@m', 'a b@m', '--scope@m', undefined, null, 5, '']) {
    assert.throws(() => up.startPluginInstall('local', bad), (e) => e.status === 400, String(bad));
  }
  assert.throws(() => up.startPluginInstall('nope', FD), (e) => e.status === 404);
  assert.deepEqual(cliCalls, []);
});

test('an install is refused while a restart or an upgrade is pending, or one is already running', async () => {
  up.userPluginHooks.restartPending = () => true;
  assert.throws(() => up.startPluginInstall('local', FD), (e) => e.status === 409);
  up.userPluginHooks.restartPending = () => false;
  up.userPluginHooks.upgradeHolds = () => true;
  assert.throws(() => up.startPluginInstall('local', FD), (e) => e.status === 409);
  up.userPluginHooks.upgradeHolds = () => false;
  let release;
  cliResult = () => new Promise((r) => { release = () => r({ ok: true, message: '' }); });
  up.userPluginHooks.cli = async (m, args) => { cliCalls.push({ machine: m.name, args }); return cliResult(m, args); };
  up.startPluginInstall('local', FD);
  assert.equal(up.pluginJobRunning(), true);
  assert.throws(() => up.startPluginInstall('local', FD), (e) => e.status === 409);
  listings.local = [{ id: FD, enabled: true }];
  release();
  await up.pluginJobSettled('local');
  assert.equal(up.pluginJobRunning(), false);
});

test('noteInit corroborates passively: an installed plugin a live session did not load is reported', async () => {
  await up.checkPlugins('local', { force: true });
  up.noteInit({ machine: 'local', skills: [], plugins: undefined }); // a frame without the list says nothing
  assert.deepEqual(up.pluginsState().machines.local.notLoaded, []);
  up.noteInit({ machine: 'local', plugins: [{ name: 'hfs-ux', path: '/x' }] });
  assert.deepEqual(up.pluginsState().machines.local.notLoaded, [FD]);
  up.noteInit({ machine: 'local', plugins: [{ name: 'frontend-design', path: '/y' }] });
  assert.deepEqual(up.pluginsState().machines.local.notLoaded, []);
});

test('the routes: GET /api/plugins and POST install validate and answer with the job', async () => {
  const app = express();
  app.use(express.json());
  app.use(up.userPluginsRouter());
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    listings.local = [];
    await up.checkPlugins('local', { force: true });
    const got = await (await fetch(`${base}/api/plugins`)).json();
    assert.deepEqual(got.required, [FD]);
    assert.deepEqual(got.machines.local.missing, [FD]);
    const post = (name, body) => fetch(`${base}/api/machines/${name}/plugins/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await post('local', { id: 'evil@m' })).status, 400);
    assert.equal((await post('ghost', { id: FD })).status, 404);
    assert.deepEqual(cliCalls, []);
    cliResult = (m) => { listings[m.name] = [{ id: FD, enabled: true }]; return { ok: true, message: '' }; };
    const ok = await post('local', { id: FD });
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).id, FD);
    await up.pluginJobSettled('local');
    assert.equal((await (await fetch(`${base}/api/machines/local/plugins/job`)).json()).state, 'done');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('pluginEvents emits the public state when it changes and nothing else', async () => {
  const seen = [];
  const on = (s) => seen.push(s);
  up.pluginEvents.on('state', on);
  try {
    await up.checkPlugins('local', { force: true });
    const n = seen.length;
    await up.checkPlugins('local', { force: true }); // identical state: no new event
    assert.equal(seen.length, n);
    assert.ok(seen[0].machines.local);
    assert.equal(JSON.stringify(seen).includes('installPath'), false);
  } finally {
    up.pluginEvents.off('state', on);
  }
});
