import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isIdleWait, idleWaitProblem } from '../src/waitgate.js';

const bg = (command) => ({ command, run_in_background: true });
const fg = (command) => ({ command, run_in_background: false });

test('un sleep a secas en segundo plano se rechaza', () => {
  assert.ok(idleWaitProblem(bg('sleep 60')));
  assert.ok(idleWaitProblem(bg('sleep 90s')));
  assert.ok(idleWaitProblem(bg('  sleep 30  ')));
});

test('esperar y anunciarlo sigue siendo esperar', () => {
  assert.ok(idleWaitProblem(bg('sleep 60; echo listo')));
  assert.ok(idleWaitProblem(bg('sleep 5 && echo "ya"')));
  assert.ok(idleWaitProblem(bg('sleep 10 && date')));
});

test('un bucle que solo duerme también', () => {
  assert.ok(idleWaitProblem(bg('while true; do sleep 2; done')));
  assert.ok(idleWaitProblem(bg('until false; do sleep 5; echo esperando; done')));
});

// The expensive mistake would be the other way round: refusing real work
// because it happens to start with a pause.
test('un sleep que precede a trabajo de verdad pasa', () => {
  assert.equal(idleWaitProblem(bg('sleep 30 && cargo test -p helios-rest')), null);
  assert.equal(idleWaitProblem(bg('sleep 5; curl -s 127.0.0.1:18794/health')), null);
  assert.equal(idleWaitProblem(bg('while ! curl -sf localhost:8080; do sleep 2; done')), null);
});

test('sin sleep no hay nada que mirar', () => {
  assert.equal(idleWaitProblem(bg('cargo test')), null);
  assert.equal(idleWaitProblem(bg('echo hola')), null);
  assert.equal(idleWaitProblem(bg('')), null);
});

test('en primer plano se deja pasar: bloquea un turno y termina, no se acumula', () => {
  assert.equal(idleWaitProblem(fg('sleep 60')), null);
  assert.equal(idleWaitProblem({ command: 'sleep 60' }), null);
});

test('una entrada con otra forma no rompe la compuerta', () => {
  assert.equal(idleWaitProblem(null), null);
  assert.equal(idleWaitProblem(undefined), null);
  assert.equal(idleWaitProblem('sleep 60'), null);
  assert.equal(idleWaitProblem({ run_in_background: true }), null);
});

test('el motivo dice qué hacer en su lugar, no solo que no', () => {
  const why = idleWaitProblem(bg('sleep 60'));
  assert.match(why, /BashOutput/);
  assert.match(why, /primer plano/);
});

test('isIdleWait se puede usar suelta', () => {
  assert.equal(isIdleWait('sleep 3'), true);
  assert.equal(isIdleWait('cargo build'), false);
});
