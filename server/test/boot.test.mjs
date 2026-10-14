import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * What the board believes after a restart, read from a tasks.json written the
 * way the previous run left it. Its own process and data dir: the store is a
 * singleton that reads the file once, at import.
 */
const DIR = mkdtempSync(path.join(tmpdir(), 'hfsmon-boot-'));
process.env.HFSMON_DATA_DIR = DIR;
const base = (issue, over) => ({ issue, title: 't', labels: [], url: 'x', state: 'pr_draft', log: [], chats: [], ...over });
writeFileSync(path.join(DIR, 'tasks.json'), JSON.stringify({
  1: base(1, { stack: { status: 'running', error: null, services: { hfs: { label: 'HFS', port: 18080, healthy: true }, hts: { label: 'HTS', port: 18081, healthy: true } } } }),
  2: base(2, { stack: { status: 'starting', error: null, services: {} } }),
  3: base(3, { stack: null }),
  // A move cut halfway: its `worktree` state is only the move's busy marker.
  4: base(4, {
    state: 'worktree', prevState: null, error: null, machine: 'box', worktreePath: '/home/user/hfs-wt/feat-4',
    moving: { from: 'local', to: 'box', sourceWt: 'C:\\src\\hfs-wt\\feat-4', saved: { state: 'error', prevState: 'testing', error: 'x' }, step: 'build_target', error: null },
    prewarm: { machine: 'box', startedAt: '2026-09-14T10:00:00.000Z', endedAt: null, ok: null },
  }),
  // One that had already failed stays as it was.
  5: base(5, { state: 'started', moving: { from: 'local', to: 'box', saved: { state: 'started' }, step: 'source_git', error: 'push rechazado' } }),
  // Cut after arriving: it stays where it arrived, and the retry picks up from `chats`.
  6: base(6, {
    state: 'worktree', machine: 'box', worktreePath: '/home/user/hfs-wt/feat-6',
    moving: { from: 'local', to: 'box', sourceWt: 'C:\\src\\hfs-wt\\feat-6', saved: { state: 'pr_draft' }, step: 'chats', error: null },
  }),
  // The restart caught it mid-fix: the phase is where Retry has to come back to.
  7: base(7, { state: 'fixing' }),
  // A PR parked on its title, waiting for you to edit it on the card.
  8: base(8, {
    state: 'error', prevState: 'browser_qa', phase: 'pr', error: 'No se publica el título del PR…',
    prPark: { proposal: 'fix: el título larguísimo', problems: ['el texto supera 256 caracteres (265)'], at: '2026-09-15T20:30:21.000Z' },
  }),
  // Written before the phase had a name of its own.
  9: base(9, { state: 'error', phase: 'pr_draft' }),
  // Los `demoSteps` envenenados: la sesión de demo murió contra el límite de
  // la cuenta y el aviso se guardó como si fueran los pasos de validación.
  10: base(10, { demoSteps: ["You've hit your session limit · resets 4:30pm (UTC)", "", "Try again later."].join(String.fromCharCode(10)) }),
  // Y unos pasos de verdad, que no se tocan.
  11: base(11, { demoSteps: ["## Preparación", "", "1. Pulsa «▶️ Iniciar HFS»."].join(String.fromCharCode(10)) }),
  // The board died while a failed triage waited for its install: nothing is
  // waiting any more, whatever the file says.
  12: base(12, { state: 'triage', waitingOn: 'install' }),
  // The board died half-way through a stop: its saved stop commands are still owed.
  13: base(13, { stack: { status: 'stopping', error: null, services: { app: { label: 'App', port: 18082, healthy: true, stop: { command: 'x', cwd: '.', env: {}, timeoutMs: 1000, machine: 'local' } } } } }),
}));
const { store } = await import('../src/store.js');
after(() => {
  store.flush();
  rmSync(DIR, { recursive: true, force: true });
});

test('un stack que figuraba en marcha no sobrevive a un reinicio del tablero, y lo dice', () => {
  const { stack } = store.get(1);
  assert.equal(stack.status, 'error', 'antes seguía «running» con los procesos muertos');
  assert.match(stack.error, /restarted/);
  assert.match(stack.error, /Stop stack/, 'dice qué pulsar');
  assert.deepEqual(Object.values(stack.services).map((s) => s.healthy), [false, false], 'ningún enlace en verde a nada');
});

test('el mensaje del reinicio no afirma que los servidores pararon', () => {
  assert.doesNotMatch(store.get(1).stack.error, /stopped with it/);
  assert.match(store.get(1).stack.error, /may still be running/);
});

test('una parada cortada por el reinicio vuelve como error y conserva sus órdenes de parada', () => {
  const { stack } = store.get(13);
  assert.equal(stack.status, 'error', 'antes seguía «stopping» para siempre');
  assert.match(stack.error, /restarted/);
  assert.match(stack.error, /Stop stack/);
  assert.equal(stack.services.app.stop.command, 'x', 'el registro sigue ahí para el próximo Parar');
  assert.equal(stack.services.app.healthy, false);
});

test('el que arrancaba sigue como antes, y una tarea sin stack no se toca', () => {
  assert.equal(store.get(2).stack.status, 'error');
  assert.match(store.get(2).stack.error, /while the stack was starting/);
  assert.equal(store.get(3).stack, null);
});

test('una tarea cortada en una fase vuelve como error sabiendo en qué fase estaba', () => {
  const t = store.get(7);
  assert.equal(t.state, 'error');
  assert.equal(t.prevState, 'fixing');
  assert.equal(t.phase, 'fixing', 'Reintentar reanuda en el fix, no en la cola');
  assert.match(t.error, /restarted/);
});

test('el aparcadero del PR sobrevive al reinicio, con su fase', () => {
  const t = store.get(8);
  assert.equal(t.phase, 'pr', 'el reinicio no lo devuelve al Browser QA que dice prevState');
  assert.equal(t.prPark.proposal, 'fix: el título larguísimo');
  assert.deepEqual(t.prPark.problems, ['el texto supera 256 caracteres (265)']);
  assert.equal(store.get(9).phase, 'pr', '«pr_draft» guardado como fase se traduce al arrancar');
  assert.equal(store.get(1).phase, null, 'una tarea sin fase guardada no se inventa ninguna');
});

test('una mudanza cortada por el reinicio devuelve la tarjeta a su estado y queda fallida para reintentarla', () => {
  const t = store.get(4);
  assert.equal(t.state, 'error', 'el estado de antes, no el «worktree» de la mudanza');
  assert.equal(t.prevState, 'testing', 'Reintentar sigue sabiendo desde dónde');
  assert.equal(t.error, 'x', 'y su error no se pisa con «el servidor se reinició»');
  assert.match(t.moving.error, /Retry move/);
  assert.equal(t.moving.step, 'build_target', 'el paso se conserva para el reintento');
  assert.equal(t.prewarm.ok, null, 'el cargo build murió con el tablero: ni bien ni mal');
  assert.ok(t.prewarm.endedAt);
  assert.equal(t.machine, 'local', 'sin llegar, la tarea sigue en su máquina de origen');
  assert.equal(t.worktreePath, 'C:\\src\\hfs-wt\\feat-4', 'con su worktree, no la ruta de la otra');

  const arrived = store.get(6);
  assert.equal(arrived.state, 'pr_draft');
  assert.equal(arrived.machine, 'box', 'ya había llegado: se queda allí');
  assert.equal(arrived.worktreePath, '/home/user/hfs-wt/feat-6');
  assert.match(arrived.moving.error, /Retry move/);

  const failed = store.get(5);
  assert.equal(failed.state, 'started');
  assert.equal(failed.moving.error, 'push rechazado', 'una mudanza ya fallida no se toca');
  assert.deepEqual(store.get(3).places, {}, 'y toda tarea tiene su mapa de sitios');
  assert.equal(store.get(3).moving, null);
});

test('unos `demoSteps` que son el aviso de límite se limpian al arrancar; los buenos se quedan', () => {
  assert.equal(store.get(10).demoSteps, null, 'no son instrucciones que nadie pueda seguir');
  assert.match(store.get(11).demoSteps, /Iniciar HFS/);
});

test('la espera por la instalación no sobrevive a un reinicio', () => {
  assert.equal(store.get(12).waitingOn, null, 'el proceso que esperaba murió con el tablero');
  assert.equal(store.get(1).waitingOn, null, 'y toda tarea tiene el campo');
});

test('toda tarea arranca con su marcador de cuota, aunque se escribiera antes de que existiera', () => {
  assert.equal(store.get(1).quotaPark, null);
  assert.equal(store.get(10).quotaPark, null);
});
