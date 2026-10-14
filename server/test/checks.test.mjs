import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeChecks } from '../src/github.js';

/**
 * Los payloads son los de verdad: copiados de `gh pr view --json
 * statusCheckRollup` sobre PRs reales del repo, que es donde aparecen las dos
 * formas distintas y los saltados de rutina.
 */
const checkRun = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, conclusion, state: null });
const statusContext = (context, state) => ({ __typename: 'StatusContext', context, state, status: null, conclusion: null });

test('el caso real del #946: verde con uno en cola es ámbar, no rojo', () => {
  const rollup = [
    checkRun('Test Rust', 'COMPLETED', 'SUCCESS'),
    checkRun('Linting', 'COMPLETED', 'SUCCESS'),
    checkRun('Test Python', 'COMPLETED', 'SUCCESS'),
    checkRun('Test FHIRPath', 'QUEUED', ''),
    checkRun('HTS conformance', 'COMPLETED', 'SKIPPED'),
    checkRun('HTS IG conformance', 'COMPLETED', 'SKIPPED'),
    checkRun('Extended CI', 'COMPLETED', 'SKIPPED'),
    checkRun('Security Audit', 'COMPLETED', 'SUCCESS'),
    statusContext('codecov/patch', 'SUCCESS'),
  ];
  const n = summarizeChecks(rollup);
  assert.equal(n.failed, 0, 'nada roto');
  assert.equal(n.pending, 1, 'el que está en cola');
  assert.equal(n.passed, 8, 'los saltados cuentan como pasados');
  assert.equal(n.total, 9);
});

test('un check en marcha cuenta como pendiente, no como fallo', () => {
  const n = summarizeChecks([checkRun('Test Rust', 'IN_PROGRESS', null)]);
  assert.deepEqual(n, { failed: 0, pending: 1, passed: 0, total: 1 });
});

test('todo lo que no pasó cuenta como fallo', () => {
  for (const conclusion of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    const n = summarizeChecks([checkRun('x', 'COMPLETED', conclusion)]);
    assert.equal(n.failed, 1, conclusion);
  }
});

test('neutral y skipped no son fallos', () => {
  const n = summarizeChecks([
    checkRun('a', 'COMPLETED', 'NEUTRAL'),
    checkRun('b', 'COMPLETED', 'SKIPPED'),
  ]);
  assert.deepEqual(n, { failed: 0, pending: 0, passed: 2, total: 2 });
});

test('la otra forma, StatusContext, se lee por su `state`', () => {
  assert.equal(summarizeChecks([statusContext('codecov/project', 'PENDING')]).pending, 1);
  assert.equal(summarizeChecks([statusContext('codecov/project', 'FAILURE')]).failed, 1);
  assert.equal(summarizeChecks([statusContext('codecov/project', 'ERROR')]).failed, 1);
  assert.equal(summarizeChecks([statusContext('codecov/project', 'SUCCESS')]).passed, 1);
});

test('sin checks no hay semáforo que encender', () => {
  assert.deepEqual(summarizeChecks([]), { failed: 0, pending: 0, passed: 0, total: 0 });
  assert.deepEqual(summarizeChecks(null), { failed: 0, pending: 0, passed: 0, total: 0 });
  assert.deepEqual(summarizeChecks(undefined), { failed: 0, pending: 0, passed: 0, total: 0 });
});

test('un fallo entre muchos verdes manda', () => {
  const n = summarizeChecks([
    checkRun('a', 'COMPLETED', 'SUCCESS'),
    checkRun('b', 'COMPLETED', 'FAILURE'),
    checkRun('c', 'IN_PROGRESS', null),
  ]);
  assert.equal(n.failed, 1);
  assert.equal(n.pending, 1);
  assert.equal(n.passed, 1);
});
