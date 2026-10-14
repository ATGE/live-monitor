import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { removeWorktree, isProjectWorktree } from '../src/worktree.js';
import { config } from '../src/config.js';
import { localMachine } from '../src/machine.js';

// `localMachine()` rebuilds from config.project, which the fixture points at itself.
const M = () => localMachine();

/**
 * Against real git, because what has to be right here is what git actually
 * does when it half-succeeds — and that is exactly what happened on this
 * board: `git worktree remove` deregistered #942 and #969, then failed on the
 * directory with "Directory not empty" because a file named `nul` survived.
 * From then on git answered "is not a working tree" and the tasks could never
 * drop a worktree that was no longer there.
 */
const git = (args, cwd) => execFileSync(
  'git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' },
);

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'hfsmon-wt-'));
  const repo = path.join(root, 'repo');
  const wtRoot = path.join(root, 'wt');
  mkdirSync(repo);
  mkdirSync(wtRoot);
  git(['init', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'hola\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'seed'], repo);

  // The config object is the live one every module reads; point it here.
  const before = { ...config.project };
  config.project = { ...config.project, repoPath: repo, worktreeRoot: wtRoot };

  return {
    repo,
    root,
    /** A linked worktree of this fixture, on its own branch. */
    add(name) {
      const wt = path.join(wtRoot, name);
      git(['worktree', 'add', '-b', name, wt], repo);
      return wt;
    },
    registered: () => (existsSync(path.join(repo, '.git', 'worktrees'))
      ? readdirSync(path.join(repo, '.git', 'worktrees')) : []),
    cleanup() {
      config.project = before;
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

test('un worktree normal se va del disco y del registro', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const wt = f.add('feat-1');
  assert.equal(await isProjectWorktree(M(), wt), true);

  await removeWorktree(M(), wt);
  assert.equal(existsSync(wt), false);
  assert.deepEqual(f.registered(), []);
});

test('un worktree sucio también: --force, que un árbol compilado nunca está limpio', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const wt = f.add('feat-2');
  writeFileSync(path.join(wt, 'a.txt'), 'editado sin commitear\n');
  mkdirSync(path.join(wt, 'target'));
  writeFileSync(path.join(wt, 'target', 'basura.bin'), 'x');

  await removeWorktree(M(), wt);
  assert.equal(existsSync(wt), false);
});

test('el estado en el que se quedaron #942 y #969: git ya no lo conoce, el directorio sigue ahí', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const wt = f.add('feat-3');
  // Exactly how they were left: deregistered, directory surviving with junk.
  rmSync(path.join(f.repo, '.git', 'worktrees', 'feat-3'), { recursive: true, force: true });
  rmSync(path.join(wt, '.git'), { force: true });
  writeFileSync(path.join(wt, 'sobrante.txt'), 'lo que impidió el borrado\n');
  assert.equal(await isProjectWorktree(M(), wt), false, 'git ya no lo reclama');

  const lineas = [];
  await removeWorktree(M(), wt, { onLine: (l) => lineas.push(l) });   // antes lanzaba «is not a working tree»
  assert.equal(existsSync(wt), false, 'el directorio huérfano se borra');
  assert.ok(lineas.some((l) => /left the directory/.test(l)), 'y lo dice en el log');
});

test('un directorio de otro repositorio no se toca', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const ajeno = path.join(f.root, 'ajeno');
  mkdirSync(ajeno);
  git(['init', '-b', 'main', '.'], ajeno);
  writeFileSync(path.join(ajeno, 'importante.txt'), 'trabajo de otro\n');

  await assert.rejects(() => removeWorktree(M(), ajeno), /another repository/);
  assert.equal(existsSync(path.join(ajeno, 'importante.txt')), true);
});

test('una ruta que ya no existe no es un error: se poda y ya', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const wt = f.add('feat-4');
  rmSync(wt, { recursive: true, force: true });

  await removeWorktree(M(), wt);
  assert.deepEqual(f.registered(), [], 'el registro huérfano se poda');
});

test('el caso real, de punta a punta: un fichero llamado `nul` dentro del worktree', { skip: process.platform !== 'win32' && 'sólo Windows tiene nombres reservados' }, async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const wt = f.add('feat-5');
  // `> nul` bajo bash escribe un fichero en vez de descartar. Sólo se puede
  // crear (y borrar) por la ruta de dispositivo `\\?\`.
  writeFileSync(`\\\\?\\${path.resolve(wt, 'nul')}`, 'salida que alguien creyó descartar\n');
  assert.ok(readdirSync(wt).includes('nul'));

  await removeWorktree(M(), wt);
  assert.equal(existsSync(wt), false, 'ni el fichero reservado ni el directorio sobreviven');
  assert.deepEqual(f.registered(), []);
});
