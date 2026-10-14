import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { pendingWork } from '../src/worktree.js';
import { LocalMachine } from '../src/machine.js';

const M = new LocalMachine('test');

/**
 * Against real git, not a mock: what this has to get right is exactly what git
 * reports, and a stub would only prove the stub agrees with itself.
 *
 * The layout mirrors the real one — a bare "origin" the clone tracks — so
 * `origin/<branch>..HEAD` means the same thing here as it does in a worktree.
 */
function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'hfsmon-git-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' });

  mkdirSync(origin);
  git(['init', '--bare', '-b', 'main', '.'], origin);
  git(['clone', origin, work], root);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['config', 'user.name', 'Test'], work);
  writeFileSync(path.join(work, 'README.md'), '# seed\n');
  // Build output must not count as pending work: only what git tracks does.
  writeFileSync(path.join(work, '.gitignore'), 'target/\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'seed'], work);
  git(['push', '-u', 'origin', 'main'], work);

  return {
    work,
    git: (args) => git(args, work),
    write: (name, text) => {
      mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
      writeFileSync(path.join(work, name), text);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('una rama al día no tiene nada pendiente', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  assert.deepEqual(await pendingWork(M, r.work, 'main'), { dirty: [], otherDirty: 0, unpushed: 0, behind: 0 });
});

test('cuenta los commits que faltan por subir', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.write('a.txt', 'uno');
  r.git(['add', '.']);
  r.git(['commit', '-m', 'one']);
  r.write('b.txt', 'dos');
  r.git(['add', '.']);
  r.git(['commit', '-m', 'two']);

  const { dirty, unpushed } = await pendingWork(M, r.work, 'main');
  assert.equal(unpushed, 2, 'dos commits locales sin subir');
  assert.deepEqual(dirty, [], 'el árbol está limpio');
});

test('ve sin commitear lo que la propia rama estaba editando', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.git(['checkout', '-b', 'feat/1-trabajo']);
  r.write('src/lib.rs', 'fn uno() {}\n');
  r.git(['add', '.']);
  r.git(['commit', '-m', 'work']);
  r.write('src/lib.rs', 'fn uno() {}\nfn dos() {}\n');   // seguido a mano, sin commitear

  const { dirty, otherDirty } = await pendingWork(M, r.work, 'feat/1-trabajo');
  assert.equal(dirty.length, 1, dirty.join(' | '));
  assert.ok(dirty[0].endsWith('src/lib.rs'), dirty[0]);
  assert.equal(otherDirty, 0);
});

test('ignora lo sucio que la rama no toca, y lo cuenta aparte', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.git(['checkout', '-b', 'feat/2-otra-cosa']);
  r.write('src/lib.rs', 'fn uno() {}\n');
  r.git(['add', '.']);
  r.git(['commit', '-m', 'work']);
  // Lo que de verdad pasa en los worktrees: specs regeneradas por la
  // compilación y salidas de tests, en archivos que esta rama nunca tocó.
  r.write('README.md', '# reescrito por el build\n');
  r.write('tests/data/salida.json', '{}');

  const { dirty, otherDirty } = await pendingWork(M, r.work, 'feat/2-otra-cosa');
  assert.deepEqual(dirty, [], 'no debe frenar por ruido ajeno a la rama');
  assert.equal(otherDirty, 2);
});

test('un archivo nuevo dentro de un directorio que la rama creó sí cuenta', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.git(['checkout', '-b', 'feat/3-dir']);
  r.write('crates/nuevo/uno.rs', 'fn a() {}\n');
  r.git(['add', '.']);
  r.git(['commit', '-m', 'work']);
  r.write('crates/nuevo/dos.rs', 'fn b() {}\n');

  const { dirty } = await pendingWork(M, r.work, 'feat/3-dir');
  assert.equal(dirty.length, 1, dirty.join(' | '));
});

test('un directorio nuevo entero junto a lo que la rama edita cuenta; uno en la raíz, como target-x/, no', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.git(['checkout', '-b', 'feat/4-modulo']);
  r.write('crates/core/lib.rs', 'mod nuevo;\n');
  r.write('Cargo.toml', '[workspace]\n');
  r.git(['add', '.']);
  r.git(['commit', '-m', 'work']);
  r.write('crates/core/nuevo/mod.rs', 'pub fn n() {}\n');   // un módulo nuevo: `?? crates/core/nuevo/`
  r.write('target-x/debug/hfs.exe', 'binario');            // salida sin ignorar, junto a Cargo.toml

  const { dirty, otherDirty } = await pendingWork(M, r.work, 'feat/4-modulo');
  assert.deepEqual(dirty, ['?? crates/core/nuevo/']);
  assert.equal(otherDirty, 1, 'target-x/ no viaja aunque la rama toque la raíz');
});

test('no confunde la basura de compilación con trabajo pendiente', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.write('target/debug/hfs.exe', 'binario');

  assert.deepEqual(await pendingWork(M, r.work, 'main'), { dirty: [], otherDirty: 0, unpushed: 0, behind: 0 });
});

test('una rama que aún no existe en origin cuenta como pendiente de subir', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.git(['checkout', '-b', 'feat/999-nueva']);
  r.write('c.txt', 'tres');
  r.git(['add', '.']);
  r.git(['commit', '-m', 'three']);

  const { unpushed } = await pendingWork(M, r.work, 'feat/999-nueva');
  // `origin/feat/999-nueva` no existe: null, no 0 — "no sé" nunca debe leerse
  // como "no hay nada que subir".
  assert.equal(unpushed, null);
});
