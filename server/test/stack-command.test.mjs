import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { removeTreeReported } from './teardown.mjs';

/**
 * Command-based stack services, for real: small node servers started through
 * the local machine, so the cmd.exe / sh wrapper, `{port}` substitution and the
 * process-tree kill are exercised rather than assumed. The processes are only
 * ever ended by the pids they wrote down.
 */
const DIR = mkdtempSync(path.join(tmpdir(), 'hfsmon-stackcmd-'));
process.env.HFSMON_DATA_DIR = DIR;
const { store } = await import('../src/store.js');
const { config } = await import('../src/config.js');
const { ensureStackRunning, startStack, stopStack, stackProblem, stackHooks, publicStack } = await import('../src/stack.js');
const { serviceEnv } = await import('../src/stack-env.js');
const { localMachine, procTools } = await import('../src/machine.js');
const net = await import('node:net');

const SERVER = `
const http = require('http'), fs = require('fs'), path = require('path');
const name = process.argv[2];
const port = Number(process.argv[3] || process.env.MOCK_PORT);
http.createServer((q, r) => r.end('ok')).listen(port, '127.0.0.1', () => {
  fs.writeFileSync(path.join(__dirname, 'rec-' + name + '.json'), JSON.stringify({
    pid: process.pid, cwd: process.cwd(), port, argv: process.argv.slice(3), seen: process.env.SEEN_PORT,
  }));
});
`;

/**
 * A stop command: `node stop.cjs <name> <mode> ...`. Every run appends a line to
 * `stop-<name>.log` beside the script (cwd, the SEEN_PORT it got, its argv, and
 * whether the panel server was still alive: the order the board promises).
 * `fail` exits 3, `slow` ends after a moment, `hang` writes its pid and never ends.
 */
const STOP = `
const fs = require('fs'), path = require('path');
const [name, mode] = process.argv.slice(2);
let panelAlive = null;
try {
  const pid = JSON.parse(fs.readFileSync(path.join(__dirname, 'rec-panel.json'), 'utf8')).pid;
  try { process.kill(pid, 0); panelAlive = true; } catch { panelAlive = false; }
} catch { /* no panel record */ }
fs.appendFileSync(path.join(__dirname, 'stop-' + name + '.log'), JSON.stringify({
  cwd: process.cwd(), seen: process.env.SEEN_PORT, argv: process.argv.slice(2), panelAlive,
}) + '\\n');
if (mode === 'fail') process.exit(3);
if (mode === 'slow') setTimeout(() => process.exit(0), 800);
else if (mode === 'hang') {
  fs.writeFileSync(path.join(__dirname, 'hang-' + name + '.pid'), String(process.pid));
  setInterval(() => {}, 1000);
}
`;

const pids = new Set();
const real = (p) => realpathSync.native(p).toLowerCase();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};

/** A git repo with the test server and an `app/` + `app/svc/` folder: the "worktree". */
function worktree(label) {
  const wt = path.join(DIR, label);
  mkdirSync(path.join(wt, 'app', 'svc'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: wt });
  writeFileSync(path.join(wt, 'srv.cjs'), SERVER);
  writeFileSync(path.join(wt, 'stop.cjs'), STOP);
  return wt;
}
let n = 700;
const tasks = [];
function taskIn(wt) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: 'x', closed: false }, 'hfs');
  task.worktreePath = wt;
  task.state = 'pr_draft';
  tasks.push(task);
  return task;
}
/** Writes down every pid a test server recorded in this worktree, so cleanup can reach it. */
const collect = (wt) => {
  let names = [];
  try { names = readdirSync(wt).filter((f) => /^rec-.*\.json$/.test(f)); } catch { /* no worktree */ }
  for (const f of names) {
    try { pids.add(JSON.parse(readFileSync(path.join(wt, f), 'utf8')).pid); } catch { /* half-written */ }
  }
};
// A service without a health path counts as up as soon as its port answers, which can be a
// moment before the process finished writing its record: wait for a readable one.
const rec = async (wt, name) => {
  let rec = null;
  assert.ok(await until(() => {
    try { rec = JSON.parse(readFileSync(path.join(wt, `rec-${name}.json`), 'utf8')); return true; } catch { return false; }
  }, 10_000), `the ${name} service wrote its record`);
  pids.add(rec.pid);
  return rec;
};
/** True when nothing listens on the port any more: one connection attempt, no polling. */
const closed = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(true));
});

const hfsStack = config.stack;
// Look often instead of every 3 s: the services answer within a second, and the
// fixed sleeps made the test mostly waiting (and slow enough to trip under load).
stackHooks.pollMs = 200;
// A slice of the range per process, so two suites running at once do not fight
// for the same ports between `portFree` (0.0.0.0) and the service's bind.
const SLICE = 29100 + (process.pid % 8) * 10;
const PORTS = { from: SLICE, to: SLICE + 9 };
// Above the 60 s health deadline of `base()`, so a slow start reports the health
// warning rather than the start loop giving up first.
const START_MS = 120_000;
const NODE_INSTALL = `node -e "require('fs').appendFileSync('installs.txt','x')"`;
const base = () => ({
  cwd: 'app',
  installCommand: NODE_INSTALL,
  healthTimeoutMinutes: 1,
  portRange: PORTS,
  primary: 'panel',
  services: {
    mock: { label: 'Mock', command: 'node ../../srv.cjs mock', cwd: 'svc', portEnv: 'MOCK_PORT', env: { SEEN_PORT: '{port}' }, healthPath: '/health' },
    panel: { label: 'Panel', command: 'node ../srv.cjs panel "{port}"' },
  },
});
/** `base()` where the panel service also declares a stop command (`mode` per `STOP`). */
const withStop = (mode = 'ok', over = {}) => {
  const stack = base();
  stack.services.panel = {
    ...stack.services.panel,
    env: { SEEN_PORT: '{port}' },
    stopCommand: `node ../stop.cjs panel ${mode} {port}`,
    ...over,
  };
  return stack;
};
const stopLog = (wt, name) => {
  try { return readFileSync(path.join(wt, `stop-${name}.log`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
/** What `task.stack` looks like after a board restart: no handles, a stop record per service. */
const restarted = (stop) => ({
  status: 'error', error: 'The board restarted', host: '127.0.0.1',
  services: { panel: { label: 'Panel', port: PORTS.to, healthy: false, stop: { cwd: DIR, env: {}, timeoutMs: 20_000, machine: 'local', ...stop } } },
});
const withStack = async (stack, fn) => {
  config.stack = stack;
  try { return await fn(); } finally { config.stack = hfsStack; }
};

after(async () => {
  config.stack = hfsStack;
  // Stop what the board still holds first, with the stack each task ran under.
  for (const t of tasks) {
    if (t.stack) await stopStack(t.issue).catch(() => {});
  }
  // Then only the recorded pids that are still alive: a dead pid may be reused.
  for (const pid of pids) {
    if (!alive(pid)) { pids.delete(pid); continue; }
    if (!(await until(() => !alive(pid), 1500))) { try { process.kill(pid); } catch { /* gone */ } }
  }
  store.flush();
  // Daemons ran with their cwd inside DIR; a tree that is still ending holds it on Windows.
  await removeTreeReported('stack-command', DIR, { tolerate: true, timeoutMs: 3000 });
});

test('servicios por comando: shell, cwd, {port}, primary primero, sin build, instala una vez', async () => {
  const wt = worktree('wt-a');
  const t = taskIn(wt);
  try { await withStack(base(), async () => {
    await ensureStackRunning(t.issue, { timeoutMs: START_MS });
    collect(wt);
    assert.deepEqual(Object.keys(t.stack.services), ['panel', 'mock'], 'primary primero');
    assert.equal(t.stack.status, 'running');
    assert.ok(!t.log.some((l) => /building/.test(l.line)), 'sin buildCommand no hay build');

    const panel = await rec(wt, 'panel');
    const mock = await rec(wt, 'mock');
    assert.equal(panel.port, t.stack.services.panel.port);
    assert.deepEqual(panel.argv, [String(panel.port)], '{port} sustituido en el comando, comillas incluidas');
    assert.equal(real(panel.cwd), real(path.join(wt, 'app')), 'cwd del stack');
    assert.equal(real(mock.cwd), real(path.join(wt, 'app', 'svc')), 'cwd del servicio');
    assert.equal(mock.port, t.stack.services.mock.port, 'portEnv entrega el puerto');
    assert.equal(mock.seen, String(mock.port), '{port} sustituido en env');
    assert.equal(readFileSync(path.join(wt, 'app', 'installs.txt'), 'utf8'), 'x');

    // Stopping ends the whole tree: node is a grandchild of cmd.exe / sh.
    const ports = [panel.port, mock.port];
    await stopStack(t.issue);
    // stopStack waits for the trees: no polling, one look.
    assert.deepEqual(await Promise.all(ports.map(closed)), [true, true], 'los puertos quedan cerrados al volver stopStack');
    assert.ok(await until(() => !alive(panel.pid) && !alive(mock.pid)), 'los procesos hijos murieron');

    // Same lockfile (none): the marker skips the install.
    await ensureStackRunning(t.issue, { timeoutMs: START_MS });
    assert.equal(readFileSync(path.join(wt, 'app', 'installs.txt'), 'utf8'), 'x', 'no se reinstala');
    assert.ok(t.log.some((l) => /skipping the install/.test(l.line)));
    assert.ok(!existsSync(path.join(wt, 'app', '.board-stack-installed')), 'la marca no ensucia el árbol');
    const again = [await rec(wt, 'panel'), await rec(wt, 'mock')];
    await stopStack(t.issue);
    assert.ok(await until(() => again.every((r) => !alive(r.pid))));

    // A changed lockfile installs again.
    writeFileSync(path.join(wt, 'app', 'package-lock.json'), '{"v":1}');
    await ensureStackRunning(t.issue, { timeoutMs: START_MS });
    assert.equal(readFileSync(path.join(wt, 'app', 'installs.txt'), 'utf8'), 'xx');
    const last = [await rec(wt, 'panel'), await rec(wt, 'mock')];
    await stopStack(t.issue);
    assert.ok(await until(() => last.every((r) => !alive(r.pid))));
  }); } finally { collect(wt); }
});

test('la instalación que falla da un error claro con el final de la salida', async () => {
  const wt = worktree('wt-b');
  const t = taskIn(wt);
  const stack = { ...base(), installCommand: `node -e "console.log('out-qrs');console.error('boom-xyz');process.exit(2)"` };
  await withStack(stack, async () => {
    await assert.rejects(() => ensureStackRunning(t.issue, { timeoutMs: START_MS }), /the stack did not start: dependency install failed: [\s\S]*out-qrs[\s\S]*boom-xyz/);
    assert.ok(!existsSync(path.join(wt, 'rec-panel.json')), 'ningún servicio llegó a arrancar');
  });
});

test('un stack con forma hfs sigue igual: compila y pide el binario', async () => {
  const wt = worktree('wt-c');
  const t = taskIn(wt);
  const stack = {
    buildCommand: `node -e "console.log('built')"`, profile: 'debug', healthTimeoutMinutes: 1,
    portRange: PORTS,
    services: { hfs: { label: 'HFS', binName: 'hfs', portEnv: 'HFS_SERVER_PORT', healthPath: '/metadata' } },
  };
  assert.equal(stackProblem(stack), null);
  await withStack(stack, async () => {
    await assert.rejects(() => ensureStackRunning(t.issue, { timeoutMs: START_MS }), /not found after building/);
    assert.ok(t.log.some((l) => /building \(debug\)/.test(l.line)));
  });
});

test('la configuración real de hfs pasa la validación', () => {
  assert.equal(stackProblem(config.stack), null);
});

test('la validación rechaza lo que no se puede ejecutar', () => {
  const svc = { label: 'S', command: 'x' };
  const ok = (extra, services = { a: svc }) => ({ services, ...extra });
  assert.equal(stackProblem(ok({})), null);
  for (const cwd of ['/abs', 'C:\\x', 'C:x', '\\\\srv\\share', '../up', 'a/../..', 'a\\..\\b', '']) {
    assert.match(stackProblem(ok({ cwd })), /^cwd /, `cwd ${JSON.stringify(cwd)}`);
  }
  assert.match(stackProblem(ok({}, { a: { ...svc, cwd: '../x' } })), /«a»: cwd/);
  assert.match(stackProblem(ok({}, { a: { ...svc, cwd: '/x' } })), /«a»: cwd/);
  assert.match(stackProblem(ok({}, { a: { label: 'S', command: 'x', binName: 'y' } })), /exactamente uno/);
  assert.match(stackProblem(ok({}, { a: { label: 'S' } })), /exactamente uno/);
  assert.match(stackProblem(ok({ primary: 'zzz' })), /primary «zzz»/);
  assert.match(stackProblem(ok({}, { a: { ...svc, healthPath: 'health' } })), /«a»: healthPath debe empezar por «\/»/);
  assert.equal(stackProblem(ok({}, { a: { ...svc, healthPath: '/health' } })), null);
  assert.match(stackProblem(ok({}, { 1: svc })), /solo con dígitos/);
  assert.match(stackProblem(ok({ portRange: { from: 5, to: 1 } })), /portRange/);
  assert.match(stackProblem({ services: {} }), /al menos un servicio/);
});

test('un cwd inválido es un 409 con el motivo al arrancar', async () => {
  const t = taskIn(worktree('wt-d'));
  await withStack({ ...base(), cwd: '../fuera' }, async () => {
    await assert.rejects(
      async () => ensureStackRunning(t.issue, { timeoutMs: 5_000 }),
      (e) => e.status === 409 && /invalid config\.stack: cwd/.test(e.message),
    );
  });
});

test('matar un handle ya terminado no lanza taskkill ni señales (pid reutilizable)', async () => {
  const daemon = localMachine().daemon;
  const win = localMachine().platform === 'win32';
  const calls = [];
  const realSpawn = procTools.spawn;
  const realKill = process.kill;
  procTools.spawn = (...a) => { calls.push(a[0]); return realSpawn(...a); };
  const handle = daemon.spawn(process.execPath, { cwd: DIR, args: ['-e', ''] });
  pids.add(handle.pid);
  try {
    await new Promise((r) => handle.on('exit', r));
    if (!win) process.kill = (...a) => { calls.push(`kill:${a[0]}`); return realKill(...a); };
    await handle.kill();
    assert.deepEqual(calls, [], 'no se tocó ningún pid');
  } finally {
    procTools.spawn = realSpawn;
    process.kill = realKill;
  }
  // A live one does go through the tree kill, and kill() settles once it is dead.
  procTools.spawn = (...a) => { calls.push(a[0]); return realSpawn(...a); };
  const live = daemon.spawn(process.execPath, { cwd: DIR, args: ['-e', 'setInterval(()=>{},1000)'] });
  pids.add(live.pid);
  try {
    assert.ok(await until(() => alive(live.pid), 5000));
    await live.kill();
    assert.equal(alive(live.pid), false, 'muerto al volver kill()');
    if (win) assert.deepEqual(calls, ['taskkill']);
  } finally {
    procTools.spawn = realSpawn;
  }
});

// The tree kill is `taskkill /T` on Windows: a grandchild must go with its parent.
// (`run` in exec.js does not do this, see exec.js; machine.test.mjs skips its POSIX twins.)
test('kill() de un daemon mata también al nieto (Windows)', { skip: process.platform !== 'win32' && 'solo Windows: en POSIX lo cubre machine.test.mjs', timeout: 20_000 }, async () => {
  const grandchildFile = path.join(DIR, 'grandchild.pid');
  const parent = `
    const { spawn } = require('child_process');
    const fs = require('fs');
    // detached: without it the grandchild also dies on a plain kill of the parent
    // (measured), and the test could not tell \`/T\` from its absence.
    const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });
    fs.writeFileSync(${JSON.stringify(grandchildFile)}, String(g.pid));
    setInterval(() => {}, 1000);
  `;
  const handle = localMachine().daemon.spawn(process.execPath, { cwd: DIR, args: ['-e', parent] });
  pids.add(handle.pid);
  let grandchild = null;
  try {
    assert.ok(await until(() => existsSync(grandchildFile), 10_000), 'the parent started its child');
    grandchild = Number(readFileSync(grandchildFile, 'utf8'));
    pids.add(grandchild);
    assert.ok(alive(grandchild), 'the grandchild is running before the kill');
    await handle.kill();
    assert.ok(await until(() => !alive(grandchild), 5000), 'the grandchild died with its parent');
  } finally {
    // Only the pids this test started, and only if they are still there.
    for (const pid of [handle.pid, grandchild]) {
      if (pid && alive(pid)) { try { process.kill(pid); } catch { /* gone */ } }
    }
  }
});

test('serviceEnv sustituye {port} y conserva la regla de HFS_BASE_URL', () => {
  assert.deepEqual(
    serviceEnv('mock', { env: { A: 'http://x:{port}/y', B: 'fijo' }, portEnv: 'P' }, 18090),
    { A: 'http://x:18090/y', B: 'fijo', P: '18090' },
  );
  assert.equal(serviceEnv('hfs', { env: {}, portEnv: 'P' }, 18091).HFS_BASE_URL, 'http://127.0.0.1:18091');
});

test('stopCommand y stopTimeoutSeconds: la validación los rechaza si no valen', () => {
  const svc = { label: 'S', command: 'x' };
  const ok = (over) => ({ services: { a: { ...svc, ...over } } });
  assert.equal(stackProblem(ok({ stopCommand: 'docker compose -p x-{port} down', stopTimeoutSeconds: 30 })), null);
  assert.equal(stackProblem(ok({})), null, 'sin stopCommand sigue valiendo');
  for (const stopCommand of ['', '  ', 5, null, {}]) {
    assert.match(stackProblem(ok({ stopCommand })), /«a»: stopCommand debe ser un texto no vacío/, JSON.stringify(stopCommand));
  }
  assert.match(stackProblem({ services: { a: { label: 'S', binName: 'hfs', stopCommand: 'x' } } }), /«a»: stopCommand solo vale en un servicio con command/);
  for (const stopTimeoutSeconds of [0, -1, 'x', NaN, null, Infinity]) {
    assert.match(stackProblem(ok({ stopTimeoutSeconds })), /«a»: stopTimeoutSeconds debe ser un número positivo/, String(stopTimeoutSeconds));
  }
});

test('parar corre la orden de parada con {port}, env y cwd resueltos, antes de matar el proceso', async () => {
  const wt = worktree('wt-s1');
  const t = taskIn(wt);
  try { await withStack(withStop(), async () => {
    await ensureStackRunning(t.issue, { timeoutMs: START_MS });
    collect(wt);
    const panel = await rec(wt, 'panel');
    const saved = t.stack.services.panel.stop;
    assert.equal(saved.command, `node ../stop.cjs panel ok ${panel.port}`, '{port} sustituido al arrancar');
    assert.equal(saved.timeoutMs, 120_000, 'por omisión 120 s');
    assert.equal(saved.env.SEEN_PORT, String(panel.port), 'el env ya resuelto');
    assert.equal(real(saved.cwd), real(path.join(wt, 'app')));
    assert.equal(typeof saved.machine, 'string');
    assert.equal(t.stack.services.mock.stop, undefined, 'solo el servicio que la declara');
    assert.equal(publicStack(t.stack).services.panel.stop, undefined, 'el navegador no ve el registro');
    assert.equal(stopLog(wt, 'panel').length, 0, 'no corre antes de parar');

    await stopStack(t.issue);
    const runs = stopLog(wt, 'panel');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].seen, String(panel.port), 'el env llegó a la orden');
    assert.deepEqual(runs[0].argv, ['panel', 'ok', String(panel.port)]);
    assert.equal(real(runs[0].cwd), real(path.join(wt, 'app')), 'cwd del registro');
    assert.equal(runs[0].panelAlive, true, 'corre antes de matar el proceso');
    assert.equal(t.stack, null);
    assert.ok(await until(() => !alive(panel.pid)), 'y después el proceso muere');
  }); } finally { collect(wt); }
});

test('el registro no cambia si la configuración se edita después de arrancar', async () => {
  const wt = worktree('wt-s2');
  const t = taskIn(wt);
  try { await withStack(withStop(), async () => {
    await ensureStackRunning(t.issue, { timeoutMs: START_MS });
    collect(wt);
    config.stack.services.panel.stopCommand = 'node ../stop.cjs edited ok';
    await stopStack(t.issue);
    assert.equal(stopLog(wt, 'panel').length, 1, 'corrió lo guardado');
    assert.equal(stopLog(wt, 'edited').length, 0, 'no lo editado');
  }); } finally { collect(wt); }
});

test('un stack como queda tras un reinicio (error, registro, sin handles) se limpia al parar', async () => {
  const wt = worktree('wt-s3');
  const t = taskIn(wt);
  t.stack = restarted({ command: 'node stop.cjs hand ok', cwd: wt });
  await stopStack(t.issue);
  assert.equal(stopLog(wt, 'hand').length, 1, 'la orden guardada corrió');
  assert.equal(t.stack, null);
});

test('una orden de parada que falla deja el registro, el stack en error y lanza; el segundo intento la repite', async () => {
  const wt = worktree('wt-s4');
  const t = taskIn(wt);
  t.stack = restarted({ command: 'node stop.cjs boom fail', cwd: wt });
  await assert.rejects(() => stopStack(t.issue), /could not stop everything: panel: the stop command failed \(exit code 3\)/);
  assert.equal(t.stack.status, 'error');
  assert.match(t.stack.error, /try again/);
  assert.ok(t.stack.services.panel.stop, 'el registro sigue');
  await assert.rejects(() => stopStack(t.issue), /exit code 3/);
  assert.equal(stopLog(wt, 'boom').length, 2, 'el segundo Parar la corrió otra vez');
  t.stack.services.panel.stop.command = 'node stop.cjs boom ok';
  await stopStack(t.issue);
  assert.equal(stopLog(wt, 'boom').length, 3);
  assert.equal(t.stack, null, 'con éxito el stack desaparece');
});

test('una orden de parada colgada se corta al llegar a su tiempo', { timeout: 30_000 }, async () => {
  const wt = worktree('wt-s5');
  const t = taskIn(wt);
  const graceBefore = stackHooks.stopGraceMs;
  stackHooks.stopGraceMs = 300;
  t.stack = restarted({ command: 'node stop.cjs stuck hang', cwd: wt, timeoutMs: 500 });
  const began = Date.now();
  try {
    await assert.rejects(() => stopStack(t.issue), /could not stop everything: panel: /);
    assert.ok(Date.now() - began < 15_000, 'no esperó indefinidamente');
    assert.ok(t.stack.services.panel.stop, 'el registro se conserva');
    assert.equal(t.stack.status, 'error');
  } finally {
    stackHooks.stopGraceMs = graceBefore;
    // The global cleanup would run the hanging command again: nothing is owed now.
    t.stack = null;
    // Only the pid the hung command wrote down, if it is still there.
    try {
      const pid = Number(readFileSync(path.join(wt, 'hang-stuck.pid'), 'utf8'));
      pids.add(pid);
      if (alive(pid)) process.kill(pid);
    } catch { /* it never started, or is gone */ }
  }
});

test('dos paradas a la vez: la segunda se rechaza con 409 y la primera termina', async () => {
  const wt = worktree('wt-s6');
  const t = taskIn(wt);
  t.stack = restarted({ command: 'node stop.cjs slow slow', cwd: wt });
  const first = stopStack(t.issue);
  assert.equal(t.stack.status, 'stopping', 'la tarjeta lo sabe mientras dura');
  await assert.rejects(() => stopStack(t.issue), (e) => e.status === 409 && /already stopping/.test(e.message));
  assert.throws(() => startStack(t.issue), (e) => e.status === 409 && /being stopped/.test(e.message));
  await first;
  assert.equal(t.stack, null);
});

test('si la carpeta del registro ya no existe, la orden corre desde el repo de la máquina', async () => {
  const wt = worktree('wt-s7');
  const t = taskIn(wt);
  // The fixture's repoPath does not exist: give the machine a real one for this test.
  const repo = path.join(DIR, 'repo-s7');
  mkdirSync(repo, { recursive: true });
  const repoBefore = config.project.repoPath;
  config.project.repoPath = repo;
  t.stack = restarted({ command: `node "${path.join(wt, 'stop.cjs')}" gone ok`, cwd: path.join(DIR, 'ya-no-existe') });
  try {
    await stopStack(t.issue);
  } finally { config.project.repoPath = repoBefore; }
  const [run] = stopLog(wt, 'gone');
  assert.equal(real(run.cwd), real(repo));
});

test('un registro de una máquina que no existe falla y se queda', async () => {
  const wt = worktree('wt-s8');
  const t = taskIn(wt);
  t.stack = restarted({ command: 'node stop.cjs far ok', cwd: wt, machine: 'no-such-box' });
  await assert.rejects(() => stopStack(t.issue), /could not stop everything: panel: .*no-such-box/);
  assert.ok(t.stack.services.panel.stop);
  t.stack = null;
});

test('startStack corre las sobras del stack anterior antes de lanzar, y no arranca si fallan', async () => {
  const wt = worktree('wt-s9');
  const t = taskIn(wt);
  try { await withStack(base(), async () => {
    t.stack = restarted({ command: 'node stop.cjs old fail', cwd: wt });
    startStack(t.issue);
    assert.deepEqual(t.stack.leftover.map((r) => r.name), ['panel'], 'el nuevo stack hereda lo que se debía');
    assert.ok(await until(() => t.stack.status === 'error', 20_000));
    assert.match(t.stack.error, /the previous stack could not be cleaned up: panel: .*exit code 3/);
    assert.equal(t.stack.leftover.length, 1, 'sigue pendiente');
    assert.ok(!existsSync(path.join(wt, 'rec-panel.json')), 'no se lanzó nada');

    // Once it can succeed, the next start cleans first and then launches.
    t.stack.leftover[0].command = 'node stop.cjs old ok';
    startStack(t.issue);
    assert.ok(await until(() => t.stack.status === 'running', START_MS));
    collect(wt);
    assert.equal(t.stack.leftover, undefined, 'las sobras se vaciaron');
    assert.equal(stopLog(wt, 'old').length, 2, 'primero falló, luego corrió bien');
    await stopStack(t.issue);
  }); } finally { collect(wt); }
});

test('un arranque que falla corre las órdenes de parada ya guardadas', async () => {
  const wt = worktree('wt-s10');
  const t = taskIn(wt);
  // The panel launches (and saves its stop record); the next service has no binary to run.
  const stack = withStop('ok');
  stack.services = { panel: stack.services.panel, extra: { label: 'Extra', binName: 'no-such-binary' } };
  try { await withStack(stack, async () => {
    await assert.rejects(() => ensureStackRunning(t.issue, { timeoutMs: START_MS }), /the stack did not start: .*not found/);
    collect(wt);
    assert.equal(stopLog(wt, 'panel').length, 1, 'la limpieza corrió en el catch');
    assert.equal(t.stack.services.panel.stop, undefined, 'y su registro se consumió');
    t.stack = null;
  }); } finally { collect(wt); }
});

test('publicStack quita los registros de parada y las sobras, y deja lo demás', () => {
  const stack = {
    status: 'error', error: 'x', host: 'h',
    services: { a: { label: 'A', port: 1, healthy: true, stop: { env: { TOKEN: 's3cret' } } } },
    leftover: [{ name: 'b', env: { TOKEN: 's3cret' } }],
  };
  const out = publicStack(stack);
  assert.ok(!JSON.stringify(out).includes('s3cret'));
  assert.deepEqual(out, { status: 'error', error: 'x', host: 'h', services: { a: { label: 'A', port: 1, healthy: true } } });
  assert.ok(stack.services.a.stop && stack.leftover, 'no toca el original');
  assert.equal(publicStack(null), null);
});
