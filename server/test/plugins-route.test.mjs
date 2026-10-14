import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { removeTree, tempDir } from './teardown.mjs';

/**
 * `POST /api/projects/:project/design`, `GET /api/plugins` and the install
 * route's refusals, against the real board in its own process (same scaffold as
 * `project-settings-route.test.mjs`). Nothing here installs a plugin.
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

const project = (id, base) => ({
  id, name: id, repoPath: base, worktreeRoot: `${base}-wt`,
  repo: null, assignee: 'nobody', overrides: {},
});

before(async () => {
  dir = tempDir('hfsmon-plug-');
  dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const one = path.join(dir, 'one');
  mkdirSync(one, { recursive: true });

  writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({}));
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project('hfs', one)]));

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
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  await removeTree(dir);
});

const registry = async () => (await call('GET', '/api/projects')).body.projects.find((p) => p.id === 'hfs');

test('POST …/design stores false, answers {project:{id,design}}, and true/null drop the field', async () => {
  assert.equal(Object.hasOwn(await registry(), 'design'), false, 'absent until declared');

  const off = await call('POST', '/api/projects/hfs/design', { design: false });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, { project: { id: 'hfs', design: false } });
  assert.equal((await registry()).design, false);

  const on = await call('POST', '/api/projects/hfs/design', { design: true });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, { project: { id: 'hfs', design: true } });
  assert.equal(Object.hasOwn(await registry(), 'design'), false, 'the default is not stored');

  await call('POST', '/api/projects/hfs/design', { design: false });
  const reset = await call('POST', '/api/projects/hfs/design', { design: null });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body, { project: { id: 'hfs', design: true } });
  assert.equal(Object.hasOwn(await registry(), 'design'), false);
});

test('POST …/design answers 404 for an unknown project and 400 for a value that is not a boolean', async () => {
  const ghost = await call('POST', '/api/projects/ghost/design', { design: false });
  assert.equal(ghost.status, 404);
  assert.match(ghost.body.error, /ghost/);

  for (const bad of ['yes', 1, {}, undefined]) {
    const res = await call('POST', '/api/projects/hfs/design', bad === undefined ? {} : { design: bad });
    assert.equal(res.status, 400, `design: ${JSON.stringify(bad)}`);
  }
  assert.equal(Object.hasOwn(await registry(), 'design'), false, 'a refusal changes nothing');
});

test('GET /api/plugins answers the required list and a map of machines', async () => {
  const res = await call('GET', '/api/plugins');
  assert.equal(res.status, 200);
  assert.ok(res.body.required.includes('frontend-design@claude-plugins-official'));
  assert.equal(typeof res.body.machines, 'object');
});

test('the plugin install route refuses what is not in the list or not a machine, installing nothing', async () => {
  const outside = await call('POST', '/api/machines/local/plugins/install', { id: 'other@somewhere' });
  assert.equal(outside.status, 400);
  const bad = await call('POST', '/api/machines/local/plugins/install', { id: '--scope@x' });
  assert.equal(bad.status, 400);
  const nobody = await call('POST', '/api/machines/ghost/plugins/install', { id: 'frontend-design@claude-plugins-official' });
  assert.equal(nobody.status, 404);
});
