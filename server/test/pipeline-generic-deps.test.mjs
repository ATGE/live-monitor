// Dependencias de un proyecto sin suite (`e2e: null`): qué manifiestos se
// reconocen, con qué comando, qué marca deja cada ecosistema y qué se cuenta
// en el log cuando algo falla.
//
// Misma máquina de mentira que `prepare-deps.test.mjs`: `fs` y `shell`, nada de
// disco ni de binarios de verdad.
import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { saveProjects } = await import('../src/projects.js');
const { prepareDependencies } = await import('../src/pipeline.js');

const OTHER = 'generic-deps';
const entries = () => [
  { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
  { id: OTHER, name: 'Generic', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: 'eterceros/generic', assignee: config.github.assignee, reviewer: null, overrides: { e2e: null, stack: null } },
];
before(() => saveProjects(entries()));
after(() => saveProjects(entries()));

let n = 7500;
function taskOf() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, OTHER);
  task.worktreePath = `/wt/${n}`;
  task.branch = `fix/${n}`;
  return task;
}

/** `present`: paths relative to the worktree that exist; the rest do not. */
function fakeMachine(task, present, { platform = 'linux', shell, pathMod = path.posix } = {}) {
  const root = task.worktreePath;
  const have = new Set(present.map((p) => pathMod.join(root, p)));
  const calls = { shell: [], writes: [], mkdirs: [] };
  return {
    calls,
    name: 'fake',
    platform,
    path: pathMod,
    fs: {
      exists: async (p) => have.has(p),
      mkdir: async (p) => { calls.mkdirs.push(p); },
      writeFile: async (p) => { calls.writes.push(p); have.add(p); },
    },
    shell: async (command, opts) => {
      calls.shell.push({ command, cwd: opts?.cwd });
      return shell ? shell(command) : { ok: true, code: 0, stdout: '', stderr: '' };
    },
  };
}
const logOf = (task) => task.log.filter((l) => l.phase === 'deps').map((l) => l.line);

test('sin manifiestos: nada que instalar', async () => {
  const task = taskOf();
  const m = fakeMachine(task, []);
  assert.deepEqual(await prepareDependencies(task, m), { ok: true });
  assert.deepEqual(m.calls.shell, []);
});

test('package.json en web/ (un nivel) se instala allí, y también el de la raíz', async () => {
  const task = taskOf();
  const m = fakeMachine(task, ['package.json', 'web/package.json']);
  assert.deepEqual(await prepareDependencies(task, m), { ok: true });
  assert.deepEqual(m.calls.shell.map((c) => [c.command, c.cwd]), [
    ['npm install', `/wt/${task.issue}`],
    ['npm install', `/wt/${task.issue}/web`],
  ]);
});

test('client/ y frontend/ también; un subnivel más hondo no se mira', async () => {
  const task = taskOf();
  const m = fakeMachine(task, ['client/package.json', 'frontend/package.json', 'apps/web/package.json']);
  await prepareDependencies(task, m);
  assert.deepEqual(m.calls.shell.map((c) => c.cwd), [`/wt/${task.issue}/client`, `/wt/${task.issue}/frontend`]);
});

test('la marca de npm de cada carpeta se respeta por separado', async () => {
  const task = taskOf();
  const m = fakeMachine(task, ['package.json', 'node_modules/.package-lock.json', 'web/package.json']);
  await prepareDependencies(task, m);
  assert.deepEqual(m.calls.shell.map((c) => c.cwd), [`/wt/${task.issue}/web`], 'solo web/ carece de marca');
});

test('requirements.txt: crea .venv, instala con el python del venv y deja la marca', async () => {
  const task = taskOf();
  const m = fakeMachine(task, ['requirements.txt']);
  assert.deepEqual(await prepareDependencies(task, m), { ok: true });
  assert.deepEqual(m.calls.shell.map((c) => c.command), [
    'python3 -m venv .venv',
    '".venv/bin/python" -m pip install -r requirements.txt',
  ]);
  assert.deepEqual(m.calls.writes, [`/wt/${task.issue}/.venv/.board-installed`]);

  // Segunda vez: la marca existe, no se instala nada.
  m.calls.shell.length = 0;
  assert.deepEqual(await prepareDependencies(task, m), { ok: true });
  assert.deepEqual(m.calls.shell, []);
  assert.ok(logOf(task).some((l) => /already installed/.test(l)));
});

test('en Windows el venv se crea con `python` y se usa Scripts y python.exe con barras invertidas y comillas', async () => {
  const task = taskOf();
  const m = fakeMachine(task, ['requirements.txt'], { platform: 'win32', pathMod: path.win32 });
  await prepareDependencies(task, m);
  assert.deepEqual(m.calls.shell.map((c) => c.command), [
    'python -m venv .venv',
    String.raw`".venv\Scripts\python.exe" -m pip install -r requirements.txt`,
  ]);
});

test('un .venv que ya existe se reutiliza: no se vuelve a crear', async () => {
  const task = taskOf();
  const m = fakeMachine(task, ['requirements.txt', '.venv']);
  await prepareDependencies(task, m);
  assert.deepEqual(m.calls.shell.map((c) => c.command), ['".venv/bin/python" -m pip install -r requirements.txt']);
});

test('pyproject.toml sin requirements instala el proyecto en el venv', async () => {
  const task = taskOf();
  const m = fakeMachine(task, ['pyproject.toml', '.venv']);
  await prepareDependencies(task, m);
  assert.deepEqual(m.calls.shell.map((c) => c.command), ['".venv/bin/python" -m pip install -e .']);
});

test('Cargo.toml: cargo fetch y su propia marca', async () => {
  const task = taskOf();
  const m = fakeMachine(task, ['Cargo.toml']);
  assert.deepEqual(await prepareDependencies(task, m), { ok: true });
  assert.deepEqual(m.calls.shell.map((c) => c.command), ['cargo fetch']);
  assert.deepEqual(m.calls.writes, [`/wt/${task.issue}/target/.board-fetched`]);
});

test('un fallo devuelve etapa install y el log trae las últimas 20 líneas, no más', async () => {
  const task = taskOf();
  const output = Array.from({ length: 50 }, (_, i) => `linea ${i + 1}`).join('\n');
  const m = fakeMachine(task, ['requirements.txt', '.venv'], {
    shell: async () => ({ ok: false, code: 1, stdout: '', stderr: output }),
  });
  const r = await prepareDependencies(task, m);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'install');
  assert.deepEqual(m.calls.writes, [], 'una instalación rota no deja marca');
  const line = logOf(task).find((l) => /failed/.test(l));
  assert.ok(line, JSON.stringify(logOf(task)));
  assert.match(line, /linea 50/);
  assert.match(line, /linea 31/);
  assert.doesNotMatch(line, /linea 30\b/);
});

test('el primer fallo detiene el resto de ecosistemas', async () => {
  const task = taskOf();
  const m = fakeMachine(task, ['package.json', 'Cargo.toml'], {
    shell: async (c) => (c === 'npm install' ? { ok: false, code: 1, stdout: '', stderr: 'E404' } : { ok: true, code: 0, stdout: '', stderr: '' }),
  });
  const r = await prepareDependencies(task, m);
  assert.equal(r.ok, false);
  assert.deepEqual(m.calls.shell.map((c) => c.command), ['npm install']);
});
