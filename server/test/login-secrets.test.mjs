import { DATA_DIR } from './isolate.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './teardown.mjs';
import {
  loginJobHooks, startLoginJob, loginJobView, submitLoginCode, resetLoginJobsForTests,
} from '../src/loginjob.js';
import { loginHooks, loginEvents, resetLoginForTests } from '../src/login.js';

// The URL carries state/PKCE data and the code is a credential: neither may reach
// the err log (stderr / console), the broadcast, the task store or any file in data/.
const URL_SECRET = 'URL-SECRET-STATE-9f3a';
const CODE_SECRET = 'CODE-SECRET-77c1';

const dir = tempDir('hfsmon-loginsecrets-');
const SCRIPT = path.join(dir, 'fake-login.mjs');
writeFileSync(SCRIPT, [
  `const url = 'https://claude.ai/oauth/authorize?state=${URL_SECRET}';`,
  "process.stderr.write('visit ' + url + '\\n');",
  "console.log('Paste code here if prompted > ');",
  "process.stdin.once('data', (b) => { console.error('got ' + b); process.exit(0); });",
].join('\n'));

const original = { ...loginJobHooks, timing: { ...loginJobHooks.timing } };
const originalProbe = loginHooks.probe;
const originalConsole = {};
const captured = [];
const emitted = [];
const onState = (s) => emitted.push(JSON.stringify(s));
let originalStderr;
let logins;
const spawned = [];

const waitFor = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(() => {
  resetLoginJobsForTests();
  resetLoginForTests();
  captured.length = 0;
  emitted.length = 0;
  spawned.length = 0;
  logins = [0, 5_000];
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    originalConsole[k] = console[k];
    console[k] = (...a) => captured.push(a.map(String).join(' '));
  }
  originalStderr = process.stderr.write;
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  loginEvents.on('state', onState);
  loginHooks.probe = async () => 'R=none E=0 T=0';
  Object.assign(loginJobHooks, {
    machineOf: (name) => (name === 'local' ? { name: 'local', kind: 'local' } : null),
    localCommand: () => ({ file: process.execPath, args: [SCRIPT] }),
    spawnLocal: (file, args, opts) => {
      const child = original.spawnLocal(file, args, opts);
      if (file === process.execPath) spawned.push(child);
      return child;
    },
    readLogin: async () => ({ expiresAt: logins.length > 1 ? logins.shift() : logins[0] }),
    authStatus: async () => true,
  });
});

afterEach(async () => {
  for (const c of spawned) { if (c.exitCode === null) await original.killTree(c); }
  process.stderr.write = originalStderr;
  for (const [k, fn] of Object.entries(originalConsole)) console[k] = fn;
  loginEvents.off('state', onState);
  Object.assign(loginJobHooks, original);
  loginJobHooks.timing = { ...original.timing };
  loginHooks.probe = originalProbe;
  resetLoginJobsForTests();
  resetLoginForTests();
});

function filesUnder(root) {
  const out = [];
  for (const name of readdirSync(root)) {
    const p = path.join(root, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

function assertNoSecret(where, text) {
  assert.ok(!text.includes(URL_SECRET), `the login URL leaked into ${where}`);
  assert.ok(!text.includes(CODE_SECRET), `the pasted code leaked into ${where}`);
}

function assertClean() {
  assertNoSecret('the err log (console / process.stderr)', captured.join('\n'));
  assertNoSecret('the broadcast payloads', emitted.join('\n'));
  for (const file of filesUnder(DATA_DIR)) assertNoSecret(`data/${path.basename(file)}`, readFileSync(file, 'utf8'));
}

test('local login: the URL and the code stay out of the err log, the broadcast and data/', async () => {
  const { ticket } = startLoginJob('local');
  await waitFor(() => loginJobView('local', ticket).url);
  assert.ok(loginJobView('local', ticket).url.includes(URL_SECRET), 'the ticket holder does get the URL');
  assertNoSecret('the anonymous job view', JSON.stringify(loginJobView('local')));
  await waitFor(() => loginJobView('local', ticket).state === 'code');
  submitLoginCode('local', ticket, CODE_SECRET);
  await waitFor(() => loginJobView('local', ticket).state === 'done');
  assert.ok(emitted.length > 0, 'the state was broadcast');
  assertClean();
});

test('a failed login keeps the output out of every error it raises', async () => {
  logins = [9_000]; // unchanged expiry: fails after exit 0
  const { ticket } = startLoginJob('local');
  await waitFor(() => loginJobView('local', ticket).state === 'code');
  submitLoginCode('local', ticket, CODE_SECRET);
  await waitFor(() => loginJobView('local', ticket).state === 'failed');
  assertNoSecret('the job error', JSON.stringify(loginJobView('local', ticket)));
  assert.equal(loginJobView('local', ticket).url, null, 'a finished job lets go of the URL');
  assertClean();
});

test('runner login: stderr frames are not copied to process.stderr, and nothing leaks', async () => {
  class FakeWs extends EventEmitter {
    constructor() { super(); this.sent = []; }
    send(t) { this.sent.push(JSON.parse(t)); }
    close() { this.emit('close'); }
    frame(o) { this.emit('message', Buffer.from(JSON.stringify(o))); }
  }
  const sockets = [];
  const box = { name: 'box', kind: 'runner', ws: () => { const w = new FakeWs(); sockets.push(w); return w; } };
  loginJobHooks.machineOf = (name) => (name === 'box' ? box : null);
  const { ticket } = startLoginJob('box');
  await waitFor(() => sockets.length === 1);
  sockets[0].frame({ stderr: `visit https://claude.ai/oauth/authorize?state=${URL_SECRET}\n` });
  sockets[0].frame({ stdout: 'Paste code here if prompted > ' });
  await waitFor(() => loginJobView('box', ticket).state === 'code');
  submitLoginCode('box', ticket, CODE_SECRET);
  sockets[0].frame({ stderr: `echo ${CODE_SECRET}\n` });
  sockets[0].frame({ exit: { code: 0, signal: null } });
  await waitFor(() => loginJobView('box', ticket).state === 'done');
  assertClean();
});
