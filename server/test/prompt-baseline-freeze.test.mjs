// The write side of the prompt baseline: `freeze`.
//
// `prompt-baseline.test.mjs` pins what the templates produce; this file pins
// that rewriting the fixture cannot damage it. A swap that fails halfway must
// put the old directories back, a render that throws must leave the fixture
// alone, and the CLI must be repeatable and leave no `.freeze-tmp` behind.
//
// Everything runs in a temporary directory: the checked-in fixture is only
// ever read (copied), never written.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FIXTURE_DIR,
  REAL_FS,
  REPO_ROOT,
  freezeFixture,
  swapDirs,
} from '../../tools/prompt-baseline/lib.mjs';
import { removeTree } from './teardown.mjs';

const roots = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-freeze-'));
  roots.push(dir);
  return dir;
};
after(async () => {
  for (const dir of roots) await removeTree(dir);
});

const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const read = (file) => readFileSync(file, 'utf8');

/** Every file under `dir` with its text, so two states can be compared whole. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).replaceAll('\\', '/')] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('swapDirs: si el segundo renombrado falla, vuelve todo a como estaba', () => {
  const root = tempDir();
  const a = path.join(root, 'samples');
  const b = path.join(root, 'contracts');
  put(path.join(a, 'old.md'), 'old a');
  put(path.join(b, 'old.md'), 'old b');
  put(path.join(root, 'new', 'samples', 'new.md'), 'new a');
  put(path.join(root, 'new', 'contracts', 'new.md'), 'new b');

  // Calls: 1 old samples aside, 2 new samples in, 3 old contracts aside, 4 new contracts in.
  let calls = 0;
  const failing = {
    ...REAL_FS,
    renameSync: (from, to) => {
      calls += 1;
      if (calls === 4) throw Object.assign(new Error('EPERM: held'), { code: 'EPERM' });
      return REAL_FS.renameSync(from, to);
    },
  };
  assert.throws(() => swapDirs([
    { from: path.join(root, 'new', 'samples'), to: a },
    { from: path.join(root, 'new', 'contracts'), to: b },
  ], path.join(root, 'hold'), failing), /EPERM/);

  assert.equal(read(path.join(a, 'old.md')), 'old a', 'samples is the old one again');
  assert.equal(read(path.join(b, 'old.md')), 'old b', 'contracts is the old one again');
  assert.ok(!existsSync(path.join(a, 'new.md')), 'nothing of the new samples was left in place');
  assert.equal(read(path.join(root, 'new', 'samples', 'new.md')), 'new a', 'the new directories are still whole');
  assert.equal(read(path.join(root, 'new', 'contracts', 'new.md')), 'new b');
});

test('swapDirs: sin fallos, deja los directorios nuevos en su sitio', () => {
  const root = tempDir();
  put(path.join(root, 'samples', 'old.md'), 'old');
  put(path.join(root, 'new', 'samples', 'new.md'), 'new');
  swapDirs([{ from: path.join(root, 'new', 'samples'), to: path.join(root, 'samples') }], path.join(root, 'hold'));
  assert.deepEqual(readdirSync(path.join(root, 'samples')), ['new.md']);
});

test('freeze: un render que lanza deja el fixture intacto y sin .freeze-tmp', () => {
  const dir = tempDir();
  put(path.join(dir, 'samples', 'keep.md'), 'keep samples');
  put(path.join(dir, 'contracts', 'keep.md'), 'keep contracts');
  put(path.join(dir, 'baseline.json'), '{"keep":true}\n');
  const before = snapshot(dir);

  let calls = 0;
  const render = () => {
    calls += 1;
    if (calls === 3) throw new Error('render exploded');
    return 'text';
  };
  const entries = [{ issue: 1, title: 't', labels: [], branch: null }];
  assert.throws(() => freezeFixture({ entries, dir, render }), /render exploded/);

  assert.deepEqual(snapshot(dir), before, 'the fixture is byte-identical');
  assert.ok(!existsSync(path.join(dir, '.freeze-tmp')), 'the scratch directory is gone');
});

test('freeze: el CLI sobre una copia es repetible y no deja .freeze-tmp', { timeout: 120_000 }, () => {
  const dir = tempDir();
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  const run = () => spawnSync(process.execPath, [
    path.join('tools', 'prompt-baseline', 'baseline.mjs'), 'freeze', '--from-fixture', '--fixture', dir,
  ], { cwd: REPO_ROOT, encoding: 'utf8' });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = snapshot(dir);
  const second = run();
  assert.equal(second.status, 0, second.stderr);

  assert.deepEqual(snapshot(dir), afterFirst, 'a second freeze changes nothing');
  assert.ok(!existsSync(path.join(dir, '.freeze-tmp')), 'no scratch directory left');
  assert.ok(Object.keys(afterFirst).some((f) => f.startsWith('samples/')), 'samples were written');
  assert.ok(Object.keys(afterFirst).some((f) => f.startsWith('contracts/')), 'contracts were written');
});
