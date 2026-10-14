// #36 part A: the mutation script never writes into the live tree. It applies a
// real mutant (of `sealnet.js`, whose test needs no `node_modules`) on a copy,
// and the live files are byte-identical before, while the mutant is applied and
// after; the temporary copy is gone and the real `node_modules` is untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMutants, MUTANTS, TESTS } from '../../tools/subagent-probe/mutants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE = ['server/src/sealnet.js', 'server/src/claude.js', 'server/src/pipeline.js'];
const sha = (rel) => createHash('sha256').update(readFileSync(path.join(ROOT, rel))).digest('hex');
const hashes = () => Object.fromEntries(LIVE.map((f) => [f, sha(f)]));

const mutant = (name) => MUTANTS.find((m) => m.name === name);

test('a mutant is applied on a copy: the live tree is byte-identical before, during and after', async () => {
  const modules = path.join(ROOT, 'server', 'node_modules');
  const hadModules = existsSync(modules);
  const modulesBefore = hadModules ? readdirSync(modules).length : 0;
  const before = hashes();
  const during = [];
  const { results, tempDir } = await runMutants({
    root: ROOT,
    mutants: [mutant('never close the window')],
    tests: ['server/test/sealnet.test.mjs'],
    onMutant: ({ dir }) => {
      during.push({ live: hashes(), copy: readFileSync(path.join(dir, 'server/src/sealnet.js'), 'utf8') });
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'RED', 'the mutant makes a sealnet test fail');
  assert.equal(during.length, 1);
  assert.deepEqual(during[0].live, before, 'the live files do not change while the mutant runs');
  assert.ok(!during[0].copy.includes('if (closes) windowOpen = false;'), 'the mutant is in the copy');
  assert.deepEqual(hashes(), before, 'the live files are untouched afterwards');
  assert.ok(!existsSync(tempDir), 'the temporary copy is removed');
  if (hadModules) {
    assert.ok(existsSync(modules), 'the real node_modules is still there');
    assert.equal(readdirSync(modules).length, modulesBefore, 'and nothing was removed from it');
  }
});

test('a pattern that is not in the file exactly once is reported, not applied', async () => {
  const before = hashes();
  const { results } = await runMutants({
    root: ROOT,
    mutants: [{ name: 'ghost', file: 'server/src/sealnet.js', from: 'this text is not in the file', to: 'x' }],
    tests: ['server/test/sealnet.test.mjs'],
  });
  assert.equal(results[0].status, 'UNMATCHED');
  assert.deepEqual(hashes(), before);
});

test('when the unmutated copy does not pass, the run stops instead of calling everything red', async () => {
  let temp = null;
  await assert.rejects(
    runMutants({
      root: ROOT,
      mutants: [mutant('never close the window')],
      tests: ['server/test/this-test-does-not-exist.test.mjs'],
      onMutant: ({ dir }) => { temp = dir; },
    }),
    /unmutated copy does not pass/,
  );
  assert.equal(temp, null, 'no mutant was run');
});

test('every mutant names a file that exists and every listed test exists', () => {
  for (const m of MUTANTS) assert.ok(existsSync(path.join(ROOT, m.file)), `${m.name}: ${m.file}`);
  for (const t of TESTS) assert.ok(existsSync(path.join(ROOT, t)), t);
  const sites = MUTANTS.filter((m) => m.name.startsWith('answerOf site:'));
  assert.equal(sites.length, 7, 'one mutant per answerOf call site of pipeline.js');
  assert.ok(TESTS.includes('server/test/sealed-sites.test.mjs'));
  assert.ok(TESTS.includes('server/test/sealed-guard.test.mjs'));
});
