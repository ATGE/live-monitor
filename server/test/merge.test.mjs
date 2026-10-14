import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { analyzeMerge, mergeBlockers, mergeMain, mergeInProgress, resolveRef } from '../src/worktree.js';
import { LocalMachine } from '../src/machine.js';

// The fixture repo is not the configured project; only exec on the worktree matters here.
const M = new LocalMachine('test');

/**
 * Against real git. What has to be right here is what git actually does with a
 * dirty tree and with conflicts, and a mock would only prove the mock agrees
 * with itself. Signing is turned off for the fixtures: the real repo signs its
 * commits, but a test must not depend on a key being present.
 */
function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'hfsmon-merge-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');   // stands in for whoever moves main
  // Both flags go on every command, clone included: a clone that checks out
  // CRLF before the config lands makes the next `add` look like a real edit,
  // and the fixture invents conflicts that git would never see in the wild.
  const git = (args, cwd) => execFileSync(
    'git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' },
  );

  mkdirSync(origin);
  git(['init', '--bare', '-b', 'main', '.'], origin);
  git(['clone', origin, work], root);
  const setup = (dir) => {
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    // Windows checks out CRLF by default; the assertions below compare exact
    // contents, and that difference is git's, not the code's.
    git(['config', 'core.autocrlf', 'false'], dir);
  };
  setup(work);
  writeFileSync(path.join(work, 'shared.txt'), 'linea uno\nlinea dos\nlinea tres\n');
  writeFileSync(path.join(work, 'mine.txt'), 'sólo mío\n');
  writeFileSync(path.join(work, '.gitignore'), 'target/\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'seed'], work);
  git(['push', '-u', 'origin', 'main'], work);

  git(['clone', origin, other], root);
  setup(other);

  const api = {
    work,
    git: (args) => git(args, work),
    write: (name, text, dir = work) => {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    },
    read: (name) => readFileSync(path.join(work, name), 'utf8'),
    /** Someone else pushes to main, and our worktree learns about it. */
    mainMoves: (name, text, message = 'desde main') => {
      api.write(name, text, other);
      git(['add', '.'], other);
      git(['commit', '-m', message], other);
      git(['push', 'origin', 'main'], other);
      git(['fetch', 'origin'], work);
    },
    branch: (name) => git(['checkout', '-b', name], work),
    commitAll: (message) => { git(['add', '.'], work); git(['commit', '-m', message], work); },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return api;
}

const mainSha = (r) => resolveRef(M, r.work, 'origin/main');

test('una rama al día no tiene nada que traer', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  const verdict = await analyzeMerge(M, r.work, await mainSha(r));
  assert.equal(verdict.behind, 0);
  assert.equal(verdict.clean, true);
  assert.deepEqual(verdict.conflicts, []);
});

test('main avanza en un archivo ajeno: se integra sola', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/1-mio');
  r.write('mine.txt', 'sólo mío, editado\n');
  r.commitAll('mi trabajo');
  r.mainMoves('otro.txt', 'novedad de main\n');

  const sha = await mainSha(r);
  const verdict = await analyzeMerge(M, r.work, sha);
  assert.equal(verdict.behind, 1);
  assert.equal(verdict.clean, true);

  const before = await resolveRef(M, r.work, 'HEAD');
  const { merged, head } = await mergeMain(M, r.work, { mainSha: sha, branch: 'feat/1-mio' });
  assert.equal(merged, true);
  assert.notEqual(head, before);
  assert.equal(r.read('otro.txt'), 'novedad de main\n', 'lo de main llegó');
  assert.equal(r.read('mine.txt'), 'sólo mío, editado\n', 'lo mío sigue');
});

test('una rama sin commits propios avanza sin crear merge commit', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/2-sin-nada');
  r.mainMoves('otro.txt', 'novedad\n');

  const sha = await mainSha(r);
  assert.equal((await analyzeMerge(M, r.work, sha)).fastForward, true);
  await mergeMain(M, r.work, { mainSha: sha, branch: 'feat/2-sin-nada' });
  const merges = execFileSync('git', ['log', '--merges', '--oneline'], { cwd: r.work }).toString().trim();
  assert.equal(merges, '', 'un fast-forward no deja merge commit');
});

test('conflicto real: lo detecta, lo nombra y NO toca el worktree', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/3-choque');
  r.write('shared.txt', 'linea uno\nMI VERSION\nlinea tres\n');
  r.commitAll('mi cambio');
  r.mainMoves('shared.txt', 'linea uno\nVERSION DE MAIN\nlinea tres\n');

  const sha = await mainSha(r);
  const headBefore = await resolveRef(M, r.work, 'HEAD');
  const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: r.work }).toString();

  const verdict = await analyzeMerge(M, r.work, sha);
  assert.equal(verdict.clean, false);
  assert.deepEqual(verdict.conflicts, ['shared.txt']);

  // Lo que de verdad hay que demostrar: analizar no cambió nada.
  assert.equal(await resolveRef(M, r.work, 'HEAD'), headBefore);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: r.work }).toString(), statusBefore);
  assert.equal(r.read('shared.txt'), 'linea uno\nMI VERSION\nlinea tres\n');
  assert.equal(await mergeInProgress(M, r.work), false);
});

test('tras un merge que choca, el worktree queda limpio y sin merge a medias', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/4-choque');
  r.write('shared.txt', 'linea uno\nMI VERSION\nlinea tres\n');
  r.commitAll('mi cambio');
  r.mainMoves('shared.txt', 'linea uno\nVERSION DE MAIN\nlinea tres\n');

  const sha = await mainSha(r);
  await assert.rejects(() => mergeMain(M, r.work, { mainSha: sha, branch: 'feat/4-choque' }));
  assert.equal(await mergeInProgress(M, r.work), false, 'el merge se abortó');
  assert.equal(r.read('shared.txt'), 'linea uno\nMI VERSION\nlinea tres\n', 'mi versión intacta');
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: r.work }).toString().trim(), '',
    'sin restos del intento',
  );
});

test('un cambio sin commitear en un archivo que main toca bloquea el merge', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/5-sucio');
  r.mainMoves('shared.txt', 'linea uno\nlinea dos\nCAMBIO DE MAIN\n');
  r.write('shared.txt', 'linea uno\nlinea dos\nTRABAJO SIN COMMITEAR\n');

  const sha = await mainSha(r);
  const blockers = await mergeBlockers(M, r.work, sha);
  assert.equal(blockers.blocked, true);
  assert.deepEqual(blockers.overlapping, ['shared.txt']);

  // El merge ni se intenta, y el trabajo sobrevive: éste es el caso que la
  // documentación de git avisa que `--abort` podría no recuperar.
  assert.equal(r.read('shared.txt'), 'linea uno\nlinea dos\nTRABAJO SIN COMMITEAR\n');
});

test('algo en el índice bloquea aunque sea de un archivo que main no toca', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/6-indice');
  r.mainMoves('otro.txt', 'novedad\n');
  r.write('mine.txt', 'a medio hacer\n');
  r.git(['add', 'mine.txt']);

  const blockers = await mergeBlockers(M, r.work, await mainSha(r));
  assert.equal(blockers.blocked, true);
  assert.deepEqual(blockers.staged, ['mine.txt']);
});

test('un directorio nuevo sin trackear donde main va a escribir bloquea', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/7-estorbo');
  r.mainMoves('docs/guia.md', 'guía de main\n');
  r.write('docs/guia.md', 'mi borrador\n');

  const blockers = await mergeBlockers(M, r.work, await mainSha(r));
  // git colapsa un directorio entero sin trackear a `docs/`, y ése es el nombre
  // que se reporta: es el mismo que verás en tu propio `git status`.
  assert.deepEqual(blockers.inTheWay, ['docs/']);
  assert.equal(r.read('docs/guia.md'), 'mi borrador\n');
});

test('un worktree limpio no bloquea nada', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/8-limpio');
  r.mainMoves('otro.txt', 'novedad\n');
  const blockers = await mergeBlockers(M, r.work, await mainSha(r));
  assert.equal(blockers.blocked, false);
});

test('las rutas con acentos y espacios llegan enteras', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/9-acentos');
  r.write('documentación final.txt', 'mi versión\n');
  r.commitAll('con acentos');
  r.mainMoves('documentación final.txt', 'versión de main\n');

  const verdict = await analyzeMerge(M, r.work, await mainSha(r));
  assert.equal(verdict.clean, false);
  assert.deepEqual(verdict.conflicts, ['documentación final.txt']);
});

test('mergeInProgress ve un merge a medias, y lo deja de ver al abortarlo', async (t) => {
  const r = repo();
  t.after(r.cleanup);
  r.branch('feat/10-medias');
  r.write('shared.txt', 'linea uno\nMIA\nlinea tres\n');
  r.commitAll('mi cambio');
  r.mainMoves('shared.txt', 'linea uno\nDE MAIN\nlinea tres\n');

  try { r.git(['merge', '--no-edit', 'origin/main']); } catch { /* conflicto esperado */ }
  assert.equal(await mergeInProgress(M, r.work), true);
  assert.ok(existsSync(path.join(r.work, 'shared.txt')));
  r.git(['merge', '--abort']);
  assert.equal(await mergeInProgress(M, r.work), false);
});
