import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A stack the board believes is running, against real sockets: one server
 * that answers its health path, one port nothing listens on. What is being
 * proved is that `running` gets checked instead of trusted.
 */
const DIR = mkdtempSync(path.join(tmpdir(), 'hfsmon-health-'));
process.env.HFSMON_DATA_DIR = DIR;
const { store } = await import('../src/store.js');
const { config } = await import('../src/config.js');
const { refreshStackHealth, ensureStackRunning } = await import('../src/stack.js');

const listen = (handler) => new Promise((resolve) => {
  const srv = createServer(handler);
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
// Answers the health path the loaded config declares for its services (plus the
// historical `/metadata`), so the test does not depend on which one that is.
const healthPaths = new Set(['/metadata', ...Object.values(config.stack.services).map((s) => s.healthPath)]);
const up = await listen((req, res) => { res.statusCode = healthPaths.has(req.url) ? 200 : 404; res.end('{}'); });
// A port that was free a moment ago and has nothing on it now.
const gone = await listen(() => {});
const deadPort = gone.address().port;
await new Promise((r) => gone.close(r));

after(async () => {
  await new Promise((r) => up.close(r));
  store.flush();
  rmSync(DIR, { recursive: true, force: true });
});

const svc = (label, port) => ({ label, port, host: '127.0.0.1', url: `http://127.0.0.1:${port}`, localUrl: `http://127.0.0.1:${port}`, healthy: true });
const stackWith = (hfsPort, htsPort) => ({
  status: 'running', error: null, host: '127.0.0.1',
  services: { hfs: svc('HFS', hfsPort), hts: svc('HTS', htsPort) },
});
let n = 500;
const taskWith = (stack) => {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: 'x', closed: false }, 'hfs');
  task.stack = stack;
  return task;
};

test('todo responde: sigue en marcha, y lo confirma', async () => {
  const t = taskWith(stackWith(up.address().port, up.address().port));
  assert.equal(await refreshStackHealth(t), true);
  assert.equal(t.stack.status, 'running');
  assert.deepEqual(Object.values(t.stack.services).map((s) => s.healthy), [true, true]);
});

test('uno caído: el enlace se apaga, el stack sigue, y no cuenta como sano', async () => {
  const t = taskWith(stackWith(up.address().port, deadPort));
  assert.equal(await refreshStackHealth(t), false);
  assert.equal(t.stack.status, 'running', 'HFS sigue respondiendo');
  assert.equal(t.stack.services.hfs.healthy, true);
  assert.equal(t.stack.services.hts.healthy, false);
});

test('ninguno responde: el stack pasa a error y queda en el log', async () => {
  const t = taskWith(stackWith(deadPort, deadPort));
  assert.equal(await refreshStackHealth(t), false);
  assert.equal(t.stack.status, 'error');
  assert.match(t.stack.error, /stopped responding/);
  assert.ok(t.log.some((l) => /stopped responding/.test(l.line)));
});

test('un stack que no está en marcha no se pregunta', async () => {
  const t = taskWith({ status: 'starting', services: {}, error: null });
  assert.equal(await refreshStackHealth(t), false);
  assert.equal(t.stack.status, 'starting');
});

test('ensureStackRunning no se fía de «running»: lo detecta caído y lo relanza', async () => {
  // A build that fails at once stands in for cargo: what matters is that the
  // dead stack was noticed, cleared and started again — not the compile.
  const before = config.stack.buildCommand;
  config.stack.buildCommand = 'node -e "process.exit(3)"';
  try {
    const t = taskWith(stackWith(deadPort, deadPort));
    t.worktreePath = DIR;
    t.state = 'pr_draft';
    await assert.rejects(() => ensureStackRunning(t.issue, { timeoutMs: 60_000 }), /the stack did not start/);
    assert.ok(t.log.some((l) => /stopping the servers/.test(l.line)), 'se limpió el stack muerto');
    assert.ok(t.log.some((l) => /building/.test(l.line)), 'y se volvió a arrancar');
  } finally {
    config.stack.buildCommand = before;
  }
});
