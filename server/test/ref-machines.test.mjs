// The chat's per-machine file chips: grouping, cache, failure cache and the
// concurrency cap. The resolver and the clock are fakes, so no network.

import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefResolver, groupMachines } from '../../web/src/viewer/refMachines.js';

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));
const q = (ref, extra = {}) => ({ project: 'p', issue: 1, machine: 'mi-equipo', ref, ...extra });

test('groupMachines: one per machine, server order kept, line propagated', () => {
  const out = groupMachines([
    { machine: 'mi-equipo', path: 'C:/a' },
    { machine: 'runner-1', path: '/a' },
    { machine: 'mi-equipo', path: 'C:/b' },
  ], 12);
  assert.deepEqual(out, [
    { machine: 'mi-equipo', path: 'C:/a', line: 12 },
    { machine: 'runner-1', path: '/a', line: 12 },
  ]);
  assert.deepEqual(groupMachines(undefined, 3), []);
  assert.equal(groupMachines([{ machine: 'm', path: 'x' }])[0].line, null);
});

test('a cached result is reused and in-flight lookups are deduped', async () => {
  const d = deferred();
  let calls = 0;
  const lookup = createRefResolver({ resolve: () => { calls += 1; return d.promise; } });
  const a = lookup(q('a.js'));
  const b = lookup(q('a.js'));
  assert.equal(a, b);
  d.resolve({ candidates: [] });
  await a;
  assert.equal(lookup(q('a.js')), a);
  assert.equal(calls, 1);
  lookup(q('a.js', { machine: 'other' }));
  await tick();
  assert.equal(calls, 2, 'another machine is another key');
});

test('a success expires after its TTL', async () => {
  let t = 1000; let calls = 0;
  const lookup = createRefResolver({ now: () => t, okTtl: 60_000, resolve: async () => { calls += 1; return { candidates: [] }; } });
  await lookup(q('a.js'));
  t += 59_000;
  await lookup(q('a.js'));
  assert.equal(calls, 1);
  t += 2_000;
  await lookup(q('a.js'));
  assert.equal(calls, 2);
});

test('a failure is cached for ~15 s, then retried', async () => {
  let t = 1000; let calls = 0;
  const lookup = createRefResolver({ now: () => t, failTtl: 15_000, resolve: async () => { calls += 1; throw new Error('down'); } });
  await assert.rejects(lookup(q('a.js')));
  t += 14_000;
  await assert.rejects(lookup(q('a.js')));
  assert.equal(calls, 1, 'no re-probe inside the window');
  t += 2_000;
  await assert.rejects(lookup(q('a.js')));
  assert.equal(calls, 2);
});

test('never more than 4 resolves in flight', async () => {
  const gates = [];
  let inFlight = 0; let peak = 0;
  const lookup = createRefResolver({
    resolve: () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      const d = deferred(); gates.push(d);
      return d.promise.finally(() => { inFlight -= 1; });
    },
  });
  const all = Array.from({ length: 10 }, (_, i) => lookup(q(`f${i}.js`)));
  await tick();
  assert.equal(gates.length, 4);
  for (let done = 0; done < 10; done += 1) {
    gates[done].resolve({ candidates: [] });
    await tick();
    assert.ok(peak <= 4, `peak ${peak}`);
  }
  await Promise.all(all);
  assert.equal(gates.length, 10);
  assert.equal(peak, 4);
});
