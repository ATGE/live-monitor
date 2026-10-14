import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PHASES, PHASE_LABEL, normalizePhase, planOfRun } from '../src/phases.js';

/**
 * El contrato de reanudación. La tabla de abajo es el archivo entero: dice, para
 * cada punto de entrada, qué le queda por hacer a la ejecución — y la fila de
 * `pr` es la que ahorra los 25 minutos de Browser QA de la #1125.
 */

// El store es un singleton que lee (y reescribe) su tasks.json al importarse:
// aquí se le da un directorio temporal para no tocar el del tablero vivo.
const DIR = mkdtempSync(path.join(tmpdir(), 'hfsmon-phases-'));
process.env.HFSMON_DATA_DIR = DIR;
const { STATES, store } = await import('../src/store.js');
after(() => {
  store.flush();
  rmSync(DIR, { recursive: true, force: true });
});

test('las diez fases están en orden y todas tienen nombre', () => {
  assert.deepEqual(PHASES, [
    'assigned', 'worktree', 'triage', 'plan_ready', 'fixing', 'testing', 'browser_qa', 'fix_gaps', 'pr', 'demo',
  ]);
  for (const phase of PHASES) assert.equal(typeof PHASE_LABEL[phase], 'string', `${phase} sin etiqueta`);
});

test('la tabla de reanudación, punto de entrada por punto de entrada', () => {
  const table = {
    //              main   wt     triage fix    e2e    qa     gaps   pr     demo
    assigned:     [true,  true,  true,  true,  true,  true,  true,  true,  true],
    worktree:     [true,  true,  true,  true,  true,  true,  true,  true,  true],
    triage:       [true,  false, true,  true,  true,  true,  true,  true,  true],
    plan_ready:   [true,  false, false, true,  true,  true,  true,  true,  true],
    fixing:       [true,  false, false, true,  true,  true,  true,  true,  true],
    testing:      [true,  false, false, false, true,  true,  true,  true,  true],
    browser_qa:   [true,  false, false, false, false, true,  true,  true,  true],
    fix_gaps:     [true,  false, false, false, false, false, true,  true,  true],
    pr:           [false, false, false, false, false, false, false, true,  true],
    demo:         [false, false, false, false, false, false, false, false, true],
  };
  for (const [from, row] of Object.entries(table)) {
    assert.deepEqual(planOfRun(from), {
      mergeMain: row[0], worktree: row[1], triage: row[2], fix: row[3],
      e2e: row[4], qa: row[5], gaps: row[6], pr: row[7], demo: row[8],
    }, `planOfRun(${from})`);
  }
});

test('reanudar en el PR no trae main ni repite el fix, los tests o el QA', () => {
  const todo = planOfRun('pr');
  assert.equal(todo.mergeMain, false, 'traer main invalidaría los tests y el QA de este commit');
  assert.equal(todo.fix, false);
  assert.equal(todo.e2e, false);
  assert.equal(todo.qa, false);
  assert.equal(todo.gaps, false, 'el cierre de huecos va antes del PR');
  assert.equal(todo.pr, true);
  assert.equal(todo.demo, true);
});

test('lo que no nombra ninguna fase se trata como el arranque', () => {
  for (const junk of [null, undefined, '', 'started', 'ready', 'waiting_approval', 'done', 'error', 'cualquier cosa']) {
    assert.deepEqual(planOfRun(junk), planOfRun('assigned'), `planOfRun(${String(junk)})`);
  }
});

test('normalizePhase: «pr_draft» era el estado, la fase es «pr»', () => {
  assert.equal(normalizePhase('pr_draft'), 'pr');
  assert.equal(planOfRun('pr_draft').qa, false, 'y por tanto tampoco repite el QA');
  for (const phase of PHASES) assert.equal(normalizePhase(phase), phase);
  for (const junk of ['started', 'ready', 'done', 'error', '', null, undefined, 42]) {
    assert.equal(normalizePhase(junk), null, `normalizePhase(${String(junk)})`);
  }
});

test('todo estado que además es una fase se traduce a una fase conocida', () => {
  // Los estados que nombran trabajo de la ejecución; el resto son sitios donde
  // la tarea descansa, y no son fases de nada.
  const workStates = ['assigned', 'worktree', 'triage', 'fixing', 'testing', 'pr_draft'];
  for (const state of workStates) {
    assert.ok(STATES.includes(state), `${state} ya no es un estado`);
    assert.ok(PHASES.includes(normalizePhase(state)), `el estado ${state} no tiene fase`);
  }
  for (const state of STATES.filter((s) => !workStates.includes(s))) {
    assert.equal(normalizePhase(state), null, `${state} no debería nombrar una fase`);
  }
});
