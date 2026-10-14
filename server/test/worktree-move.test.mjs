import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  createWorktree, removeWorktree, isProjectWorktree, pendingWork, pushBranch,
  worktreePathFor, localBranchExists, dirtyPaths, fetchBranch, aheadBehind,
  fastForwardTo, wipCommit, foreignWorktreeFor, dirSize, WIP_COMMIT_MESSAGE,
} from '../src/worktree.js';
import { WIP_SUBJECT } from '../src/handoff.js';
import { LocalMachine } from '../src/machine.js';
import { createRunner } from '../src/runner/app.js';
import { RunnerMachine } from '../src/runner-client.js';

/**
 * Moving a task means two independent clones talking through origin, so that
 * is the fixture: a bare origin and two clones, A and B, each with its own
 * worktree root — the board's machine and the dev box. Real git throughout:
 * what matters is what git does with an upstream that points at main, a
 * rename, a `target-x/` nobody ignores, or a worktree deleted by hand.
 */
const git = (args, cwd) => execFileSync(
  'git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' },
);

const write = (dir, name, data) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), data);
};

/** A commit made by hand, as Claude would make it in the worktree. */
const commitIn = (wt, name, text, message) => {
  write(wt, name, text);
  git(['add', '--', name], wt);
  git(['commit', '-m', message], wt);
  return git(['rev-parse', 'HEAD'], wt).trim();
};

const upstreamOf = (cwd, branch) => git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], cwd).trim();

function world() {
  const root = mkdtempSync(path.join(tmpdir(), 'hfsmon-move-'));
  // The functions under test run git without the `-c` flags above, so each
  // clone carries them in its own config (linked worktrees share it).
  const configure = (repo) => {
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    git(['config', 'core.autocrlf', 'false'], repo);
  };

  const origin = path.join(root, 'origin.git');
  mkdirSync(origin);
  git(['init', '--bare', '-b', 'main', '.'], origin);
  const seed = path.join(root, 'seed');
  git(['clone', origin, seed], root);
  configure(seed);
  write(seed, 'README.md', '# seed\n');
  write(seed, 'src/lib.rs', 'pub fn a() {}\n');
  write(seed, 'other.txt', 'ajeno\n');
  git(['add', '.'], seed);
  git(['commit', '-m', 'seed'], seed);
  git(['push', '-u', 'origin', 'main'], seed);

  const clone = (name) => {
    const repo = path.join(root, name);
    git(['clone', origin, repo], root);
    configure(repo);
    const wtRoot = path.join(root, `${name}-wt`);
    return { repo, wtRoot, m: new LocalMachine(name, { repoPath: repo, worktreeRoot: wtRoot }) };
  };

  return {
    root,
    a: clone('a'),
    b: clone('b'),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

test('fetchBranch trae una rama que existe y dice «missing» de una que nunca se subió', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const branch = 'feat/1-uno';
  const wtA = await createWorktree(w.a.m, branch);
  const sha = commitIn(wtA, 'src/lib.rs', 'pub fn a() { 1 }\n', 'uno');
  await pushBranch(w.a.m, wtA, branch);

  assert.deepEqual(await fetchBranch(w.b.m, w.b.repo, branch), { ok: true, missing: false });
  assert.equal(git(['rev-parse', `refs/remotes/origin/${branch}`], w.b.repo).trim(), sha,
    'el refspec simple también mueve refs/remotes/origin/<rama>');
  assert.deepEqual(await fetchBranch(w.b.m, w.b.repo, 'feat/404-nunca'), { ok: true, missing: true });

  // Any other failure is a real one.
  const lost = path.join(w.root, 'sin-origin');
  mkdirSync(lost);
  git(['init', '-b', 'main', '.'], lost);
  git(['remote', 'add', 'origin', path.join(w.root, 'no-existe.git')], lost);
  await assert.rejects(() => fetchBranch(w.b.m, lost, branch), /git fetch origin feat\/1-uno failed/);
});

test('dirtyPaths: las dos rutas de un rename, sin repetir, con la / de un directorio sin seguimiento', () => {
  assert.deepEqual(dirtyPaths([
    'R  src/old.rs -> src/new.rs',
    'M src/lib.rs',               // how pendingWork hands ` M src/lib.rs` on: trimmed
    ' M src/lib.rs',
    '?? src/nuevo/',
    'RM a.txt -> b.txt',
    '?? "con comillas.txt"',
  ]), ['src/old.rs', 'src/new.rs', 'src/lib.rs', 'src/nuevo/', 'a.txt', 'b.txt', 'con comillas.txt']);
  assert.deepEqual(dirtyPaths([]), []);
});

test('wipCommit sube solo las rutas de la rama: ni target-x/, ni un fichero ajeno, ni lo que ya estaba en el índice', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const m = w.a.m;
  const branch = 'feat/2-wip';
  const wt = await createWorktree(m, branch);
  commitIn(wt, 'src/lib.rs', 'pub fn a() { 1 }\n', 'trabajo de la rama');

  write(wt, 'src/lib.rs', 'pub fn a() { 2 }\n');
  write(wt, 'src/nuevo.rs', 'pub fn b() {}\n');
  write(wt, 'target-x/debug/basura.bin', 'x');
  write(wt, 'other.txt', 'ajeno y sucio\n');
  write(wt, 'README.md', '# ya en el índice\n');
  git(['add', 'README.md'], wt);

  const paths = dirtyPaths((await pendingWork(m, wt, branch)).dirty);
  assert.deepEqual([...paths].sort(), ['src/lib.rs', 'src/nuevo.rs']);

  const sha = await wipCommit(m, wt, paths);
  assert.equal(sha, git(['rev-parse', 'HEAD'], wt).trim());
  assert.equal(git(['log', '-1', '--format=%B'], wt).trim(), 'wip: uncommitted work', 'mensaje neutro, tal cual');
  assert.deepEqual(git(['show', '--name-only', '--format=', 'HEAD'], wt).trim().split(/\r?\n/).sort(), ['src/lib.rs', 'src/nuevo.rs']);

  const status = git(['status', '--porcelain'], wt);
  assert.match(status, /^M {2}README\.md$/m, 'lo que ya estaba en el índice sigue ahí, sin commitear');
  assert.match(status, /^ M other\.txt$/m);
  assert.match(status, /^\?\? target-x\/$/m);
  assert.doesNotMatch(status, /src\//);

  assert.equal(await wipCommit(m, wt, []), null);
  assert.equal(await wipCommit(m, wt, paths), null, 'sin cambios en esas rutas no hay commit vacío');
  assert.equal(git(['rev-parse', 'HEAD'], wt).trim(), sha);
});

test('wipCommit con un rename y nombres no ASCII: el nombre viejo sale de HEAD y café.rs no llega entrecomillado', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const m = w.a.m;
  const branch = 'feat/3-nombres';
  const wt = await createWorktree(m, branch);
  write(wt, 'src/viejo.rs', 'pub fn v() {}\n');
  write(wt, 'src/niño.rs', 'pub fn n() {}\n');
  git(['add', '.'], wt);
  git(['commit', '-m', 'base de la rama'], wt);

  git(['mv', 'src/viejo.rs', 'src/renombrado.rs'], wt);
  write(wt, 'src/niño.rs', 'pub fn n() { 1 }\n');
  write(wt, 'src/café.rs', 'pub fn c() {}\n');

  const paths = dirtyPaths((await pendingWork(m, wt, branch)).dirty);
  assert.deepEqual([...paths].sort(), ['src/café.rs', 'src/niño.rs', 'src/renombrado.rs', 'src/viejo.rs'].sort());

  assert.ok(await wipCommit(m, wt, paths));
  const tree = git(['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD'], wt).split(/\r?\n/);
  assert.ok(tree.includes('src/renombrado.rs'));
  assert.ok(!tree.includes('src/viejo.rs'), 'el borrado del nombre viejo viaja con el rename');
  assert.ok(tree.includes('src/café.rs'));
  assert.equal(git(['-c', 'core.quotePath=false', 'status', '--porcelain'], wt).trim(), '', 'no queda nada a medias en el índice');
});

test('el asunto del commit WIP es uno solo: el que hace wipCommit y el que el handoff le nombra a la sesión', () => {
  assert.equal(WIP_COMMIT_MESSAGE, WIP_SUBJECT);
});

test('wipCommit no commitea con un merge a medias', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const m = w.a.m;
  const branch = 'feat/12-merge';
  const wt = await createWorktree(m, branch);
  commitIn(wt, 'other.txt', 'versión de la rama\n', 'en la rama');
  commitIn(w.a.repo, 'other.txt', 'versión de main\n', 'en main');
  assert.throws(() => git(['merge', 'main'], wt), 'el merge choca y queda a medias');
  write(wt, 'src/lib.rs', 'pub fn a() { 9 }\n');

  await assert.rejects(() => wipCommit(m, wt, ['src/lib.rs']), /merge in progress/);
});

test('fastForwardTo no actúa sobre un HEAD suelto', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const m = w.a.m;
  const branch = 'feat/13-suelto';
  const wt = await createWorktree(m, branch);
  const sha = commitIn(wt, 'src/lib.rs', 'pub fn a() { 1 }\n', 'subido');
  await pushBranch(m, wt, branch);
  git(['checkout', '--detach'], wt);

  await assert.rejects(() => fastForwardTo(m, wt, branch), /detached HEAD/);
  assert.equal(git(['rev-parse', 'HEAD'], wt).trim(), sha);
});

test('ida y vuelta: A sube, B avanza su worktree viejo y pasa a seguir origin/<rama> aunque naciera de origin/main', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const branch = 'feat/4-viaje';
  const wtB = await createWorktree(w.b.m, branch);
  assert.equal(upstreamOf(wtB, branch), 'origin/main', 'el punto de partida: un pull a secas traería main');

  const wtA = await createWorktree(w.a.m, branch);
  commitIn(wtA, 'src/lib.rs', 'pub fn a() { 1 }\n', 'en A');
  write(wtA, 'src/lib.rs', 'pub fn a() { 2 }\n');
  const sha = await wipCommit(w.a.m, wtA, dirtyPaths((await pendingWork(w.a.m, wtA, branch)).dirty));
  await pushBranch(w.a.m, wtA, branch);

  assert.equal(await aheadBehind(w.b.m, wtB, branch), null, 'sin fetch, B no conoce origin/<rama>');
  await fetchBranch(w.b.m, wtB, branch);
  assert.deepEqual(await aheadBehind(w.b.m, wtB, branch), { ahead: 0, behind: 2 });
  assert.deepEqual(await aheadBehind(w.b.m, w.b.repo, branch), { ahead: 0, behind: 2 }, 'igual desde el checkout principal');

  const r = await fastForwardTo(w.b.m, wtB, branch);
  assert.equal(r.moved, true);
  assert.equal(r.after, sha);
  assert.notEqual(r.before, sha);
  assert.equal(upstreamOf(wtB, branch), `origin/${branch}`);
  assert.deepEqual(await aheadBehind(w.b.m, wtB, branch), { ahead: 0, behind: 0 });
  assert.equal((await fastForwardTo(w.b.m, wtB, branch)).moved, false, 'repetirlo no mueve nada');
});

test('fastForwardTo no pisa un commit de B sin subir; con discardLocal lo descarta y target-x/ sobrevive', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const branch = 'feat/5-divergente';
  const wtA = await createWorktree(w.a.m, branch);
  commitIn(wtA, 'src/lib.rs', 'pub fn a() { 1 }\n', 'primero');
  await pushBranch(w.a.m, wtA, branch);

  const wtB = await createWorktree(w.b.m, branch, { adopt: true });
  const local = commitIn(wtB, 'src/b.rs', 'solo en B\n', 'local de B');
  const remote = commitIn(wtA, 'src/lib.rs', 'pub fn a() { 2 }\n', 'segundo');
  await pushBranch(w.a.m, wtA, branch);
  await fetchBranch(w.b.m, wtB, branch);
  assert.deepEqual(await aheadBehind(w.b.m, wtB, branch), { ahead: 1, behind: 1 });

  await assert.rejects(() => fastForwardTo(w.b.m, wtB, branch), /diverged branches/);
  assert.equal(git(['rev-parse', 'HEAD'], wtB).trim(), local, 'la rechazada no toca nada');

  write(wtB, 'target-x/debug/basura.bin', 'x');
  const r = await fastForwardTo(w.b.m, wtB, branch, { discardLocal: true });
  assert.equal(r.moved, true);
  assert.equal(r.before, local);
  assert.equal(r.after, remote);
  assert.equal(existsSync(path.join(wtB, 'target-x', 'debug', 'basura.bin')), true, 'lo no seguido no se toca');
  assert.deepEqual(await aheadBehind(w.b.m, wtB, branch), { ahead: 0, behind: 0 });
});

test('localBranchExists, y aheadBehind sin rama remota o con el worktree ya borrado', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const m = w.a.m;
  const branch = 'feat/6-local';
  assert.equal(await localBranchExists(m, branch), false);
  const wt = await createWorktree(m, branch);
  assert.equal(wt, worktreePathFor(m, branch));
  assert.equal(await localBranchExists(m, branch), true);

  assert.equal(await aheadBehind(m, wt, branch), null, 'nunca subida: no hay con qué comparar');
  await assert.rejects(() => fastForwardTo(m, wt, branch), /origin\/feat\/6-local branch does not exist/);

  commitIn(wt, 'src/lib.rs', 'pub fn a() { 1 }\n', 'subido');
  await pushBranch(m, wt, branch);
  commitIn(wt, 'src/lib.rs', 'pub fn a() { 2 }\n', 'sin subir');
  await removeWorktree(m, wt);
  assert.deepEqual(await aheadBehind(m, m.repoPath, branch), { ahead: 1, behind: 0 });
});

test('foreignWorktreeFor: la rama en otra ruta o en el checkout principal sí; en su ruta plana o borrada a mano, no', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const m = w.a.m;

  const odd = path.join(w.root, 'otra-parte', 'raro');
  git(['worktree', 'add', '-b', 'feat/7-ajena', odd], w.a.repo);
  const found = await foreignWorktreeFor(m, 'feat/7-ajena');
  assert.ok(found && m.samePath(found, odd), String(found));

  await createWorktree(m, 'feat/8-plana');
  assert.equal(await foreignWorktreeFor(m, 'feat/8-plana'), null, 'donde createWorktree la pondría no es ajena');
  assert.equal(await foreignWorktreeFor(m, 'feat/9-nadie'), null);

  const main = await foreignWorktreeFor(m, 'main');
  assert.ok(main && m.samePath(main, w.a.repo), 'el checkout principal también bloquea el add');

  const gone = path.join(w.root, 'borrado-a-mano');
  git(['worktree', 'add', '-b', 'feat/10-huerfana', gone], w.a.repo);
  rmSync(gone, { recursive: true, force: true });
  assert.equal(await foreignWorktreeFor(m, 'feat/10-huerfana'), null, 'podado, no bloquea');
  const back = await createWorktree(m, 'feat/10-huerfana', { adopt: true });
  assert.equal(await isProjectWorktree(m, back), true, 'y la rama se vuelve a sacar sin quejas');
});

test('dirSize: bytes de un directorio pequeño, null si no existe', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'hfsmon-size-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = new LocalMachine('here');
  write(root, 'a/b.bin', Buffer.alloc(5000));
  write(root, "de o'brien/c.bin", Buffer.alloc(100));

  const size = await dirSize(m, root);
  assert.ok(typeof size === 'number' && size >= 5000, String(size));
  const quoted = await dirSize(m, path.join(root, "de o'brien"));
  assert.ok(typeof quoted === 'number' && quoted >= 100, `una comilla en la ruta: ${quoted}`);
  assert.equal(await dirSize(m, path.join(root, 'no-existe')), null);
});

test('a través del runner: fetchBranch, fastForwardTo y wipCommit con worktree.js tal cual', async (t) => {
  const w = world();
  const TOKEN = 'secreto-de-prueba';
  const runner = createRunner({
    token: TOKEN,
    repoPath: w.b.repo,
    worktreeRoot: w.b.wtRoot,
    attachmentsDir: path.join(w.root, 'attachments'),
    claudeCommand: process.execPath,
  });
  const addr = await runner.listen(0, '127.0.0.1');
  t.after(async () => {
    await runner.close();
    w.cleanup();
  });
  const box = new RunnerMachine('devbox', {
    url: `http://127.0.0.1:${addr.port}`, token: TOKEN, repoPath: w.b.repo, worktreeRoot: w.b.wtRoot,
  });

  const branch = 'feat/11-remota';
  const wtB = await createWorktree(box, branch);
  const wtA = await createWorktree(w.a.m, branch);
  const sha = commitIn(wtA, 'src/lib.rs', 'pub fn a() { 1 }\n', 'desde A');
  await pushBranch(w.a.m, wtA, branch);

  assert.deepEqual(await fetchBranch(box, w.b.repo, branch), { ok: true, missing: false });
  const r = await fastForwardTo(box, wtB, branch);
  assert.equal(r.moved, true);
  assert.equal(r.after, sha);
  assert.equal(upstreamOf(wtB, branch), `origin/${branch}`);

  write(wtB, 'src/lib.rs', 'pub fn a() { 2 }\n');
  write(wtB, 'target-x/o.bin', 'x');
  const paths = dirtyPaths((await pendingWork(box, wtB, branch)).dirty);
  assert.deepEqual(paths, ['src/lib.rs']);
  const wip = await wipCommit(box, wtB, paths);
  assert.equal(wip, git(['rev-parse', 'HEAD'], wtB).trim());
  assert.equal(git(['log', '-1', '--format=%B'], wtB).trim(), 'wip: uncommitted work');
  assert.match(git(['status', '--porcelain'], wtB), /^\?\? target-x\/$/m);

  // And back: the box pushes, A fast-forwards to what it left.
  await pushBranch(box, wtB, branch);
  await fetchBranch(w.a.m, wtA, branch);
  assert.equal((await fastForwardTo(w.a.m, wtA, branch)).after, wip);
});
