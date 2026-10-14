import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { deleteLocalBranch, localBranchExists } from '../src/worktree.js';
import { LocalMachine } from '../src/machine.js';

/**
 * Against real git, because what has to be right here is what `git branch -d`
 * actually refuses and what it lets through — a stub would only prove the stub
 * agrees with itself. In particular: that git keeps refusing a branch whose
 * worktree directory was deleted by hand until someone prunes.
 */
const git = (args, cwd) => execFileSync(
  'git',
  ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
  { cwd, stdio: 'pipe', encoding: 'utf8' },
);

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'hfsmon-branch-'));
  const repo = path.join(root, 'repo');
  const wtRoot = path.join(root, 'wt');
  const origin = path.join(root, 'origin.git');
  mkdirSync(repo);
  mkdirSync(wtRoot);
  git(['init', '--bare', '-b', 'main', origin], root);
  git(['init', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'hola\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'seed'], repo);
  // Con `origin/main`, porque la guarda de `deleteLocalBranch` cuenta contra
  // esa referencia: un checkout sin remoto no es el checkout del proyecto.
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-q', 'origin', 'main'], repo);

  // The machine is built straight from the fixture's paths: nothing here reads
  // `config.project`, so the live board's configuration is left alone.
  const machine = new LocalMachine('test', { repoPath: repo, worktreeRoot: wtRoot });

  return {
    repo,
    wtRoot,
    machine,
    git: (args) => git(args, repo),
    /** A branch cut from main with no commits of its own. */
    branch(name) {
      git(['branch', name], repo);
      return name;
    },
    /** A branch with one commit of its own, unmerged and with no upstream. */
    withCommit(name) {
      git(['checkout', '-b', name], repo);
      writeFileSync(path.join(repo, 'a.txt'), 'trabajo propio\n');
      git(['commit', '-am', 'work'], repo);
      git(['checkout', 'main'], repo);
      return name;
    },
    /** A linked worktree holding `name`, the way `createWorktree` would. */
    worktree(name) {
      const wt = path.join(wtRoot, name.replaceAll('/', '-'));
      git(['worktree', 'add', wt, name], repo);
      return wt;
    },
    /** `pushBranch`: the upstream moves to `origin/<name>` and `-d` stops guarding. */
    push(name) {
      git(['push', '-q', '-u', 'origin', name], repo);
      return name;
    },
    /** A checkout with no `origin/main` to count against. */
    dropOrigin() {
      git(['remote', 'remove', 'origin'], repo);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

test('una rama que no existe no es un error: la limpieza es idempotente', async (t) => {
  const f = fixture();
  t.after(f.cleanup);

  const r = await deleteLocalBranch(f.machine, 'feat/1-nunca-existio');
  assert.deepEqual(
    { deleted: r.deleted, reason: r.reason },
    { deleted: false, reason: 'missing' },
  );
  assert.ok(r.message, 'siempre hay algo que contar en el log');
});

test('una rama sin commits propios se borra', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.branch('feat/2-sin-cambios');

  const r = await deleteLocalBranch(f.machine, 'feat/2-sin-cambios');
  assert.equal(r.deleted, true, r.message);
  assert.equal(r.reason, null);
  assert.equal(await localBranchExists(f.machine, 'feat/2-sin-cambios'), false);
});

test('una rama con un commit propio sin mergear y sin upstream se respeta', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.withCommit('feat/3-con-trabajo');

  const r = await deleteLocalBranch(f.machine, 'feat/3-con-trabajo');
  assert.equal(r.deleted, false);
  assert.equal(r.reason, 'unmerged', r.message);
  // La guarda de dentro llega antes que `git branch -d`, así que el motivo lo
  // cuenta ella y dice cuántos commits son.
  assert.match(r.message, /1 commit/);
  assert.doesNotMatch(r.message, /hint:/i, 'el consejo de usar -D no se repite en el log');
  assert.equal(await localBranchExists(f.machine, 'feat/3-con-trabajo'), true);
});

test('la guarda no necesita worktree: rama con commits propios y worktree ya borrado', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  // El caso del cierre sin PR: el worktree se va primero, así que el llamante
  // no puede correr ni `hasCommits` ni `pendingWork` (las dos piden wtPath).
  f.withCommit('feat/7-sin-worktree');
  const wt = f.worktree('feat/7-sin-worktree');
  rmSync(wt, { recursive: true, force: true, maxRetries: 3 });
  f.git(['worktree', 'prune']);
  assert.equal(existsSync(wt), false);

  const r = await deleteLocalBranch(f.machine, 'feat/7-sin-worktree');
  assert.equal(r.deleted, false);
  assert.equal(r.reason, 'unmerged', r.message);
  assert.equal(await localBranchExists(f.machine, 'feat/7-sin-worktree'), true);
});

test('una rama subida con commits propios tampoco se borra, aunque `-d` la dejaría ir', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.withCommit('feat/8-subida');
  f.push('feat/8-subida');

  // Con upstream `origin/feat/8-subida` la rama es ancestro de sí misma y
  // `git branch -d` la borraría sin mirar. Quien dice que no es la guarda.
  const r = await deleteLocalBranch(f.machine, 'feat/8-subida');
  assert.equal(r.deleted, false);
  assert.equal(r.reason, 'unmerged', r.message);
  assert.equal(await localBranchExists(f.machine, 'feat/8-subida'), true);
});

test('sin `origin/main` que contar no se borra nada: error, y la rama sigue ahí', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.branch('feat/9-sin-origin');
  f.dropOrigin();

  // No se puede medir, así que no se adivina: negarse cuesta una línea de log,
  // borrar a ciegas cuesta el trabajo.
  const r = await deleteLocalBranch(f.machine, 'feat/9-sin-origin');
  assert.equal(r.deleted, false);
  assert.equal(r.reason, 'error', r.message);
  assert.equal(await localBranchExists(f.machine, 'feat/9-sin-origin'), true);
});

test('llamar dos veces seguidas no lanza: la segunda dice missing', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.branch('feat/4-dos-veces');

  const primera = await deleteLocalBranch(f.machine, 'feat/4-dos-veces');
  const segunda = await deleteLocalBranch(f.machine, 'feat/4-dos-veces');
  assert.equal(primera.deleted, true, primera.message);
  assert.deepEqual(
    { deleted: segunda.deleted, reason: segunda.reason },
    { deleted: false, reason: 'missing' },
  );
});

test('una rama con worktree vivo no se borra: checked-out', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.branch('feat/5-en-uso');
  const wt = f.worktree('feat/5-en-uso');
  assert.ok(existsSync(wt));

  const r = await deleteLocalBranch(f.machine, 'feat/5-en-uso');
  assert.equal(r.deleted, false);
  assert.equal(r.reason, 'checked-out', r.message);
  assert.equal(await localBranchExists(f.machine, 'feat/5-en-uso'), true);
});

test('un worktree borrado a mano sigue bloqueando el -d hasta que se poda', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.branch('feat/6-registro-huerfano');
  const wt = f.worktree('feat/6-registro-huerfano');
  // Exactamente lo que deja media limpieza: el directorio se va, el registro no.
  rmSync(wt, { recursive: true, force: true, maxRetries: 3 });
  assert.equal(existsSync(wt), false);

  // Sin el `git worktree prune` de dentro, git aquí responde «cannot delete
  // branch … used by worktree at …» por una ruta que ya no existe.
  const r = await deleteLocalBranch(f.machine, 'feat/6-registro-huerfano');
  assert.equal(r.deleted, true, r.message);
  assert.equal(await localBranchExists(f.machine, 'feat/6-registro-huerfano'), false);
});
