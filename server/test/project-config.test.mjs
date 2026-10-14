// Un proyecto que no es hfs, y las tres fases que hoy darían por supuesto que sí.
//
// `configFor(id)` existía y no lo llamaba nadie: los `overrides` del registro
// eran inertes y todas las fases leían el `config` global, que siempre lleva el
// `e2e` y el `stack` de hfs. La consecuencia concreta era que un proyecto de
// Python + Vite —sin Playwright y sin binario servidor— habría corrido
// `cargo build --release` dentro de un repositorio sin `Cargo.toml`.
//
// Aquí se registra ese proyecto con `overrides: { e2e: null, stack: null }` y se
// comprueba lo que tiene que pasar entonces:
//
//   1. `testPhase` sale con su línea de log y no toca la máquina.
//   2. `browserQaPhase` (es decir, `runQaOnce`) devuelve sin levantar nada.
//   3. `ensureStackRunning` —el botón, no el pipeline— responde su 409.
//
// `isolate.mjs` va primero y a propósito: `store.js`, `settings.js` y
// `projects.js` escriben en el directorio de datos, y sin él esta prueba
// escribiría en el tablero vivo.
import './isolate.mjs';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { saveProjects, configFor } = await import('../src/projects.js');
const { PIPELINE_STEPS } = await import('../src/pipeline.js');
const { ensureStackRunning, stackConfig } = await import('../src/stack.js');

const OTHER = 'app-b';

before(() => {
  // El registro completo: hfs tal y como lo sembraría `projects.js`, y al lado
  // un proyecto que declara explícitamente que no tiene ni suite ni servidores.
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
      overrides: { e2e: null, stack: null },
    },
  ]);
});

let n = 4000;
/** Una tarea del otro proyecto, con lo mínimo que piden las fases. */
function taskOf() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, OTHER);
  task.worktreePath = 'C:/tmp/no-existe';
  task.branch = `fix/${n}`;
  return task;
}

const linesOf = (task, phase) => task.log.filter((l) => l.phase === phase).map((l) => l.line);

test('el registro deja el proyecto sin e2e y sin stack, no con los de hfs', () => {
  const cfg = configFor(OTHER);
  assert.equal(cfg.e2e, null, 'un proyecto que declara e2e no hereda NADA del de hfs');
  assert.equal(cfg.stack, null);
  // Y lo que no sobrescribe lo sigue heredando, que es lo que hace útil al registro.
  assert.equal(cfg.claude.fixModel, config.claude.fixModel);
  // hfs, mientras tanto, sigue exactamente igual.
  assert.equal(configFor('hfs').e2e.testCommand, config.e2e.testCommand);
  assert.equal(stackConfig(OTHER), null);
  assert.ok(stackConfig('hfs'));
});

test('testPhase se salta la fase en vez de correr la suite de hfs', async () => {
  const task = taskOf();
  // Si la fase no se saltara, `machineOf` + `machine.shell` intentarían
  // `cargo build --release` en un directorio que no existe: esto terminaría mal
  // en vez de terminar callado.
  await PIPELINE_STEPS.testPhase(task);
  assert.ok(linesOf(task, 'e2e').some((l) => /defines no config\.e2e/.test(l)),
    `se esperaba la línea del salto; hubo: ${JSON.stringify(linesOf(task, 'e2e'))}`);
  // Ninguna orden salió hacia la máquina.
  assert.equal(linesOf(task, 'e2e').some((l) => /cargo|running|installing|ejecutando|instalando/.test(l)), false);
});

test('Browser QA no aplica sin stack: runQaOnce devuelve null y nadie levanta nada', async () => {
  const task = taskOf();
  // `browserQaPhase` es quien llama a `runQaOnce`, y trata el `null` como «no
  // hay UI»: vuelve sin pedir otra ronda de fix.
  await PIPELINE_STEPS.browserQaPhase(task, { number: task.issue, title: task.title, body: '' });
  assert.ok(linesOf(task, 'qa').some((l) => /defines no config\.stack/.test(l)),
    `se esperaba la línea del salto; hubo: ${JSON.stringify(linesOf(task, 'qa'))}`);
  // Sin marca: cada reanudación vuelve a entrar y vuelve a saltar, que cuesta
  // una línea de log y mantiene `ranAtHead` significando «se pagó un QA aquí».
  assert.equal(task.qa?.ranAtHead, undefined);
});

test('ensureStackRunning sí se queja: el botón pide servidores que no existen', async () => {
  const task = taskOf();
  await assert.rejects(
    () => ensureStackRunning(`${OTHER}#${task.issue}`),
    (e) => {
      assert.match(e.message, /no define config\.stack/);
      assert.equal(e.status, 409);
      return true;
    },
  );
});

test('hfs no se entera de nada: su testPhase sigue leyendo su propia suite', async () => {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = 'C:/tmp/no-existe';
  // No se ejecuta —no hay worktree— pero tampoco se salta: la fase de hfs
  // sigue entrando en el cuerpo, que es lo que el salto no debe tocar.
  assert.equal(configFor(task.project).e2e.relativeCwd, config.e2e.relativeCwd);
});
