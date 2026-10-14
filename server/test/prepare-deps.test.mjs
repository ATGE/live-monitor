// La preparación de dependencias de un worktree: la sonda, la exclusión mutua y
// quién paga un install roto.
//
// Las tres cosas que aquí se comprueban salieron de la misma tarea real:
//
//   1. La sonda se derivaba de `relativeCwd` (`<worktree>/<relativeCwd>/node_modules`).
//      Para un proyecto cuyo `relativeCwd` es `.` y cuyo comando instala en
//      `web/`, esa sonda NO PUEDE ser cierta nunca: el install se relanzaba en
//      cada intento y en cada ronda de reparación. Ahora es una clave propia,
//      `e2e.installedMarker`, y por defecto vale lo que antes derivaba.
//   2. Nadie preparaba nada antes del fix, así que un subagente del fix instaló
//      a mano y otro empezó a la vez («Another session has started installing
//      them in the meantime»). Ahora hay un paso del pipeline, con un mutex por
//      worktree y la sonda DENTRO de la sección crítica.
//   3. Un install roto se le entregaba al fix como «los tests fallaron», y se
//      comía una de sus dos iteraciones. Ahora el install devuelve su etapa y la
//      etapa decide, sin mirar el texto.
//
// `isolate.mjs` va primero y a propósito: `store.js`, `settings.js` y
// `projects.js` escriben en el directorio de datos.
import './isolate.mjs';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { saveProjects, configFor } = await import('../src/projects.js');
const { PIPELINE_STEPS, prepareDependencies, infrastructureFailure, hasNoVerification } = await import('../src/pipeline.js');
const { overridesOf } = await import('../src/profiles.js');

// El proyecto del caso: la suite vive en la raíz, pero el install es de `web/`.
const OTHER = 'app-b';
const MARKER = 'web/node_modules/.package-lock.json';

before(() => {
  saveProjects([
    {
      id: 'hfs',
      name: 'hfs',
      repoPath: config.project.repoPath,
      worktreeRoot: config.project.worktreeRoot,
      repo: config.github.repo ?? null,
      assignee: config.github.assignee,
      reviewer: config.github.reviewer,
      overrides: {},
    },
    {
      id: OTHER,
      name: 'External App B',
      repoPath: config.project.repoPath,
      worktreeRoot: config.project.worktreeRoot,
      repo: 'eterceros/app-b',
      assignee: config.github.assignee,
      reviewer: null,
      overrides: {
        e2e: {
          relativeCwd: '.',
          installCommand: 'npm install --prefix web',
          installedMarker: MARKER,
          testCommand: 'npm test',
          env: { CI: '1' },
        },
        stack: null,
      },
    },
  ]);
});

let n = 7000;
/** Una tarea con worktree propio: el mutex es por worktree y no debe cruzarse. */
function taskOf(project = OTHER) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, project);
  task.worktreePath = `/wt/${n}`;
  task.branch = `fix/${n}`;
  return task;
}

/**
 * Una máquina de mentira con lo único que toca este paso: `fs.exists` y
 * `shell`. Del patrón `diffMachine()` de `opencode.test.mjs`: registra las
 * llamadas en vez de tocar un disco o un binario de verdad.
 */
// Por defecto la marca y el manifiesto NO están en disco, y todo lo demás (el
// cwd de instalación) sí: un test que quiera otra cosa pasa su propio `exists`.
const defaultExists = (p) => !/node_modules|package.json$/.test(p);
function fakeMachine({ exists = defaultExists, shell } = {}) {
  const calls = { exists: [], shell: [] };
  return {
    calls,
    name: 'fake',
    path: path.posix,
    fs: {
      exists: async (p) => { calls.exists.push(p); return exists(p, calls); },
    },
    shell: async (command, opts) => {
      calls.shell.push({ command, cwd: opts?.cwd, env: opts?.env, timeoutMs: opts?.timeoutMs });
      return shell ? shell(command, opts, calls) : { ok: true, code: 0, stdout: '', stderr: '' };
    },
  };
}

const linesOf = (task, phase) => task.log.filter((l) => l.phase === phase).map((l) => l.line);

// ---------------------------------------------------------------------------
// (a) La sonda: una clave propia, y por defecto lo que antes se derivaba

test('con la marca en disco no se instala nada', async () => {
  const task = taskOf();
  const machine = fakeMachine({ exists: () => true });
  const r = await prepareDependencies(task, machine);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(machine.calls.shell, [], 'la marca está: ningún comando sale hacia la máquina');
  assert.deepEqual(machine.calls.exists, [`/wt/${task.issue}/${MARKER}`],
    'la sonda es `installedMarker` relativo al worktree, no `relativeCwd` + node_modules');
  assert.ok(linesOf(task, 'deps').some((l) => /already installed/.test(l)), JSON.stringify(linesOf(task, 'deps')));
});

test('sin `installedMarker` la sonda sigue siendo `relativeCwd`/node_modules: hfs no cambia', async () => {
  const task = taskOf('hfs');
  assert.equal(configFor('hfs').e2e.installedMarker, undefined, 'hfs no declara la clave: se prueba el valor por defecto');
  const machine = fakeMachine({ exists: () => true });
  await prepareDependencies(task, machine);

  assert.deepEqual(machine.calls.exists, [`/wt/${task.issue}/${config.e2e.relativeCwd}/node_modules`]);
});

test('sin la marca instala, en el `relativeCwd` del proyecto y con su env', async () => {
  const task = taskOf();
  const machine = fakeMachine();
  const r = await prepareDependencies(task, machine);

  assert.deepEqual(r, { ok: true });
  assert.equal(machine.calls.shell.length, 1);
  assert.equal(machine.calls.shell[0].command, 'npm install --prefix web');
  assert.equal(machine.calls.shell[0].cwd, `/wt/${task.issue}`, 'el cwd sigue saliendo de `relativeCwd`; solo la sonda cambió');
  assert.deepEqual(machine.calls.shell[0].env, { CI: '1' });
});

test('un proyecto sin `installCommand` no instala ni prueba la sonda', async () => {
  const task = taskOf();
  // El mismo proyecto sin comando de install: no hay paso de dependencias.
  saveProjects([
    { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
    { id: OTHER, name: 'External App B', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: 'eterceros/app-b', assignee: config.github.assignee, reviewer: null, overrides: { e2e: { testCommand: 'npm test' }, stack: null } },
  ]);
  const machine = fakeMachine();
  try {
    assert.deepEqual(await prepareDependencies(task, machine), { ok: true });
    assert.deepEqual(machine.calls.exists, []);
    assert.deepEqual(machine.calls.shell, []);
  } finally {
    // El registro vuelve a como lo dejó `before`: los demás tests lo comparten.
    saveProjects([
      { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
      { id: OTHER, name: 'External App B', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: 'eterceros/app-b', assignee: config.github.assignee, reviewer: null, overrides: { e2e: { relativeCwd: '.', installCommand: 'npm install --prefix web', installedMarker: MARKER, testCommand: 'npm test', env: { CI: '1' } }, stack: null } },
    ]);
  }
});

test('un proyecto aidlc no pasa por la autodetección: con package.json en la raíz no instala ni sondea', async () => {
  // Un proyecto nacido con el perfil, junto a los dos que comparte el archivo.
  saveProjects([
    { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
    { id: OTHER, name: 'External App B', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: 'eterceros/app-b', assignee: config.github.assignee, reviewer: null, overrides: { e2e: { relativeCwd: '.', installCommand: 'npm install --prefix web', installedMarker: MARKER, testCommand: 'npm test', env: { CI: '1' } }, stack: null } },
    { id: 'aidlc-proj', name: 'Aidlc', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: 'eterceros/aidlc-proj', assignee: config.github.assignee, reviewer: null, overrides: overridesOf('aidlc') },
  ]);
  const task = taskOf('aidlc-proj');
  const machine = fakeMachine({ exists: (p) => p === `/wt/${task.issue}/package.json` });
  assert.deepEqual(await prepareDependencies(task, machine), { ok: true });
  assert.deepEqual(machine.calls.shell, [], 'ningún comando: e2e vacío no autodetecta');
  assert.deepEqual(machine.calls.exists, []);
  assert.equal(hasNoVerification(task), true, 'sin testCommand la verificación es «ninguna»');
});

// ---------------------------------------------------------------------------
// (b) Exclusión mutua por worktree, con la sonda dentro

test('dos llamadas a la vez instalan UNA sola vez: la sonda va dentro de la sección crítica', async () => {
  const task = taskOf();
  let installed = false;
  const machine = fakeMachine({
    // La marca aparece cuando el install termina, como la escribe npm.
    exists: (p) => (/node_modules/.test(p) ? installed : true),
    shell: async () => {
      // Un install que tarda: sin mutex, la segunda llamada ya habría leído la
      // sonda en falso y estaría instalando encima del mismo árbol.
      await new Promise((r) => setTimeout(r, 20));
      installed = true;
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });

  const [a, b] = await Promise.all([prepareDependencies(task, machine), prepareDependencies(task, machine)]);

  assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
  assert.equal(machine.calls.shell.length, 1, `el install corrió ${machine.calls.shell.length} veces`);
  assert.equal(machine.calls.exists.length, 3, 'la primera prueba marca y cwd, la segunda solo la marca: en serie');
  assert.equal(linesOf(task, 'deps').filter((l) => /installing dependencies/.test(l)).length, 1);
  assert.equal(linesOf(task, 'deps').filter((l) => /already installed/.test(l)).length, 1, 'la segunda se encuentra el trabajo hecho');
});

test('dos worktrees distintos no se esperan entre ellos: el mutex es por worktree', async () => {
  const one = taskOf();
  const two = taskOf();
  let running = 0;
  let together = 0;
  const machine = fakeMachine({
    shell: async () => {
      running += 1;
      together = Math.max(together, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });

  await Promise.all([prepareDependencies(one, machine), prepareDependencies(two, machine)]);
  assert.equal(together, 2, 'la exclusión es por worktree, no por máquina');
});

// ---------------------------------------------------------------------------
// (c) La etapa decide, nunca el texto

test('el install roto devuelve su etapa, y la etapa es infraestructura', async () => {
  const task = taskOf();
  const machine = fakeMachine({
    shell: async () => ({ ok: false, code: 1, stdout: '', stderr: 'npm error code EUNSUPPORTEDPROTOCOL' }),
  });
  const r = await prepareDependencies(task, machine);

  assert.equal(r.ok, false);
  assert.equal(r.stage, 'install');
  assert.match(r.tail, /EUNSUPPORTEDPROTOCOL/);
  assert.ok(infrastructureFailure(r), 'con etapa `install` no hace falta mirar el texto');
});

test('⚠️ un rojo real de tests NO es infraestructura, aunque diga «npm error»', () => {
  // Esta línea la imprime TODO `npm test` que falla. Un patrón `/npm error/`
  // clasificaría cada rojo real como infraestructura y el bucle de fix no
  // correría jamás: por eso la decisión es por etapa.
  const red = {
    ok: false,
    tail: [
      '  1 failed',
      '    [chromium] › ui/search.spec.ts:12:3 › busca por nombre',
      'npm error Lifecycle script "test" failed',
      'npm error code 1',
    ].join('\n'),
  };
  assert.equal(infrastructureFailure(red), null, 'sin etapa, un fallo de la suite es cosa del fix');
});

test('`prepareCommand` tampoco es infraestructura: compila el código del fix', () => {
  assert.equal(infrastructureFailure({ ok: false, tail: 'error[E0308]: mismatched types' }), null);
});

test('las señales de entorno de la suite siguen reconociéndose por su texto', () => {
  assert.match(infrastructureFailure({ ok: false, tail: 'thread main has overflowed its stack' }), /overflowed its stack/);
  assert.match(infrastructureFailure({ ok: false, tail: 'Error: listen EADDRINUSE: address already in use' }), /port/);
});

test('un install roto sale por infraestructura sin gastar una iteración del fix', async () => {
  const task = taskOf();
  const machine = fakeMachine({
    shell: async () => ({ ok: false, code: 1, stdout: '', stderr: 'npm error code ERESOLVE' }),
  });

  // El cuerpo real de la fase, con la máquina falsa: falla antes de la cola de
  // suites, antes de la suite y antes de cualquier ronda de reparación.
  await assert.rejects(
    () => PIPELINE_STEPS.testPhase(task, { machine }),
    (e) => {
      assert.match(e.message, /dependencies/);
      assert.match(e.message, /This is not a fix failure/);
      return true;
    },
  );

  assert.equal(machine.calls.shell.length, 1, 'ni la suite ni el `prepareCommand` llegaron a ejecutarse');
  assert.equal(task.fixIterations, 0, 'ninguna iteración del fix se ha gastado');
  assert.equal(linesOf(task, 'e2e').some((l) => /running: |ejecutando/.test(l)), false);
});

// ---------------------------------------------------------------------------
// (d) El cwd de instalación y los proyectos sin suite (`e2e: null`)

const BASE = () => [
  { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
  { id: OTHER, name: 'External App B', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: 'eterceros/app-b', assignee: config.github.assignee, reviewer: null, overrides: { e2e: { relativeCwd: '.', installCommand: 'npm install --prefix web', installedMarker: MARKER, testCommand: 'npm test', env: { CI: '1' } }, stack: null } },
];
/** Corre `fn` con OTHER declarado con `overrides`, y deja el registro como estaba. */
async function withOther(overrides, fn) {
  const [hfs, other] = BASE();
  saveProjects([hfs, { ...other, overrides }]);
  try { await fn(); } finally { saveProjects(BASE()); }
}

test('un cwd de instalación inexistente falla con etapa install y no llama al shell', async () => {
  const task = taskOf();
  await withOther({ e2e: { relativeCwd: 'nope', installCommand: 'npm install', testCommand: 'npm test' }, stack: null }, async () => {
    const machine = fakeMachine({ exists: (p) => !/node_modules|nope/.test(p) });
    const r = await prepareDependencies(task, machine);
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'install');
    assert.match(r.tail, /the install directory \/wt\/\d+\/nope does not exist/);
    assert.match(r.tail, /e2e.relativeCwd/);
    assert.deepEqual(machine.calls.shell, []);
    assert.ok(linesOf(task, 'deps').some((l) => /does not exist/.test(l)));
  });
});

test('e2e null con package.json ejecuta `npm install` en la raíz del worktree', async () => {
  const task = taskOf();
  await withOther({ e2e: null, stack: null }, async () => {
    // Solo el de la raíz: web/, client/ y frontend/ también se miran ahora.
    const machine = fakeMachine({ exists: (p) => p === `/wt/${task.issue}/package.json` });
    assert.deepEqual(await prepareDependencies(task, machine), { ok: true });
    assert.equal(machine.calls.shell.length, 1);
    assert.equal(machine.calls.shell[0].command, 'npm install');
    assert.equal(machine.calls.shell[0].cwd, `/wt/${task.issue}`);
    assert.equal(machine.calls.shell[0].timeoutMs, 20 * 60 * 1000);
    assert.deepEqual(machine.calls.shell[0].env, {});
  });
});

test('e2e null sin package.json: nada que instalar y el shell no se llama', async () => {
  const task = taskOf();
  await withOther({ e2e: null, stack: null }, async () => {
    const machine = fakeMachine({ exists: () => false });
    assert.deepEqual(await prepareDependencies(task, machine), { ok: true });
    assert.deepEqual(machine.calls.shell, []);
    assert.ok(linesOf(task, 'deps').some((l) => /no dependency manifest/.test(l)));
  });
});

test('e2e null con la marca presente no reinstala', async () => {
  const task = taskOf();
  await withOther({ e2e: null, stack: null }, async () => {
    const machine = fakeMachine({ exists: () => true });
    assert.deepEqual(await prepareDependencies(task, machine), { ok: true });
    assert.deepEqual(machine.calls.shell, []);
    assert.ok(machine.calls.exists.includes(`/wt/${task.issue}/node_modules/.package-lock.json`));
  });
});

test('e2e null: un install roto devuelve etapa install', async () => {
  const task = taskOf();
  await withOther({ e2e: null, stack: null }, async () => {
    const machine = fakeMachine({
      exists: (p) => p.endsWith('/package.json'),
      shell: async () => ({ ok: false, code: 1, stdout: '', stderr: 'npm error code E404' }),
    });
    const r = await prepareDependencies(task, machine);
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'install');
    assert.match(r.tail, /E404/);
  });
});

test('el installCommand explícito sigue igual: marca, cwd del proyecto y su env', async () => {
  const task = taskOf();
  const machine = fakeMachine();
  assert.deepEqual(await prepareDependencies(task, machine), { ok: true });
  assert.deepEqual(machine.calls.exists, [`/wt/${task.issue}/${MARKER}`, `/wt/${task.issue}`]);
  assert.equal(machine.calls.shell[0].command, 'npm install --prefix web');
  assert.deepEqual(machine.calls.shell[0].env, { CI: '1' });
});
