import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withRetries, isTransient, lastLines, BACKOFF_MS } from '../src/retry.js';

test('un intento y hasta tres reintentos, cada uno con el fallo del anterior', async () => {
  const seen = [];
  const r = await withRetries(async (n, previous) => {
    seen.push([n, previous?.output ?? null]);
    return n < 3 ? { ok: false, failure: { kind: 'check', output: `fallo ${n}` } } : { ok: true, value: 42 };
  });
  assert.deepEqual(seen, [[1, null], [2, 'fallo 1'], [3, 'fallo 2']]);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.equal(r.value, 42);
});

test('agotados: devuelve el último fallo con los intentos, o relanza el error si fue una excepción', async () => {
  const r = await withRetries(async () => ({ ok: false, failure: { kind: 'session', output: 'no' } }), { max: 2 });
  assert.deepEqual(r, { ok: false, failure: { kind: 'session', output: 'no' }, attempts: 3 });
  await assert.rejects(withRetries(async () => { throw new Error('ECONNREFUSED'); }, { max: 1 }), /ECONNREFUSED/);
});

test('la espera crece y es inyectable; lo no transitorio no se reintenta', async () => {
  const waits = [];
  const onRetry = [];
  await withRetries(async (n) => ({ ok: n === 4 }), { max: 3, backoff: BACKOFF_MS, wait: async (ms) => waits.push(ms), onRetry: (n) => onRetry.push(n) });
  assert.deepEqual(waits, [10_000, 30_000, 90_000]);
  assert.deepEqual(onRetry, [1, 2, 3]);

  let calls = 0;
  await assert.rejects(withRetries(async () => { calls += 1; throw new Error('CONFLICT (content): merge conflict in a.rs'); }, {
    max: 3, shouldRetry: (f) => isTransient(f.error),
  }), /CONFLICT/);
  assert.equal(calls, 1, 'un conflicto de merge no se reintenta');
});

test('isTransient distingue el mundo que se movió de lo que no va a cambiar', () => {
  assert.equal(isTransient(new Error('listen EADDRINUSE: address already in use :::18080')), true);
  assert.equal(isTransient(new Error('el stack no arrancó: hfs no responde en el puerto 18080')), true);
  assert.equal(isTransient(new Error('fatal: unable to access https://github.com: Could not resolve host')), true);
  assert.equal(isTransient(new Error('CONFLICT (content): Merge conflict in x.rs')), false);
  assert.equal(isTransient(new Error('Hay un merge a medias en el worktree')), false);
  assert.equal(isTransient(new Error('permission denied')), false);
});

test('isTransient reads the English board messages the same way as the Spanish ones', () => {
  assert.equal(isTransient(new Error('the stack did not start: hfs is not responding on port 18080')), true);
  assert.equal(isTransient(new Error('The stack did not start: a port the suite needs was already in use')), true);
  assert.equal(isTransient(new Error('box: no response in 30 s')), true);
  assert.equal(isTransient(new Error('merge in progress in this worktree: resolve or abort it first')), false);
  assert.equal(isTransient(new Error('branch does not exist in this clone: feat/6-local')), false);
  assert.equal(isTransient(new Error('conflict in 3 file(s)')), false);
});

test('lastLines recorta al final y quita las vacías', () => {
  assert.equal(lastLines('a\n\nb\nc\n', 2), 'b\nc');
});
