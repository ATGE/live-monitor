// A repository with no commits at all cannot give a worktree a commit to branch
// from, and GitHub cannot open a PR against a base that does not exist. The
// first time (app-c, 2026-10-02) the card said git's own «invalid reference:
// origin/master». These tests run REAL git against temp repositories — an empty
// one with an empty bare `origin` — because the classification is a reading of
// refs and a fake that answers '0' to everything would prove nothing about it.
import './isolate.mjs';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config, DATA_DIR } from '../src/config.js';

// Commits made by the board and by this file need an identity.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
});

const ROOT = mkdtempSync(path.join(tmpdir(), 'empty-repo-'));
// The temp tree is removed at the end; Windows holds files a moment longer.
after(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitOk = (cwd, ...args) => {
  try { execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }); return true; } catch { return false; }
};

let n = 0;
/** A checkout (`-b <branch>`, unborn) with an empty bare origin; `base` is the registry's. */
function makeRepo({ branch = 'master', base = 'main', origin = true } = {}) {
  n += 1;
  const dir = path.join(ROOT, `p${n}`);
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', branch);
  if (origin) {
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
  }
  return { id: `er${n}`, repo, remote, wt: path.join(dir, 'wt'), base };
}

const made = [];
const mk = (opts) => { const r = makeRepo(opts); made.push(r); return r; };

// Every project must be in the registry before `projects.js` first reads it.
const specs = {
  empty: mk(),
  baseMissing: mk(),
  remoteEmpty: mk(),
  noRemote: mk({ origin: false }),
  normal: mk({ base: 'main' }),
  boot: mk(),
  bootPushFails: mk(),
  bootNotEmpty: mk(),
  bootDirty: mk(),
  bootDouble: mk(),
  bootPre: mk(),
  bootRace: mk(),
  bootMoving: mk(),
  bootRetryFail: mk(),
};

writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify([
  {
    id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot,
    repo: 'HeliosSoftware/hfs', assignee: 'eterceros', reviewer: 'reviewer-user', overrides: {},
  },
  ...made.map((m) => ({
    id: m.id, name: m.id, repoPath: m.repo, worktreeRoot: m.wt,
    repo: `eterceros/${m.id}`, assignee: 'eterceros', reviewer: 'reviewer-user', overrides: {}, baseBranch: m.base,
  })),
], null, 2), 'utf8');

// The runner the refusal test needs is declared here, on a port nobody listens
// on (the refusal happens before any call), not taken from the real config.json.
// Set before `machine.js` first builds its registry.
const savedMachines = config.machines;
config.machines = {
  devbox: { kind: 'runner', url: 'http://127.0.0.1:9', token: 'test-token', repoPath: '/srv/hfs', worktreeRoot: '/srv/hfs-wt' },
};
after(() => {
  if (savedMachines === undefined) delete config.machines; else config.machines = savedMachines;
});

const { machineFor, machineOf, machines } = await import('../src/machine.js');
const { createWorktree, RepoStateError, classifyRepoState, isSafeBranchName } = await import('../src/worktree.js');
const { store } = await import('../src/store.js');
const { keyOf } = await import('../src/keys.js');
const pipeline = await import('../src/pipeline.js');

const commitFile = (cwd, name = 'a.txt') => {
  writeFileSync(path.join(cwd, name), 'x');
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', 'c');
};

async function wtError(spec, base = spec.base) {
  const machine = machineFor('local', spec.id);
  try {
    await createWorktree(machine, 'feat/1-x', { base });
  } catch (e) {
    return e;
  }
  return null;
}

test('empty repository and empty origin: empty_repo, in Spanish, with the base', async () => {
  const e = await wtError(specs.empty);
  assert.ok(e instanceof RepoStateError, e?.message);
  assert.equal(e.code, 'empty_repo');
  assert.deepEqual(e.info.base, 'main');
  assert.match(e.message, /El repositorio está vacío/);
  assert.doesNotMatch(e.message, /invalid reference|fatal/);
});

test('origin has other branches but not the base: base_missing lists them', async () => {
  const s = specs.baseMissing;
  commitFile(s.repo);
  git(s.repo, 'push', '-q', 'origin', 'master:trunk');
  git(s.repo, 'push', '-q', 'origin', 'master:main2');
  const e = await wtError(s, 'main');
  assert.equal(e?.code, 'base_missing');
  assert.deepEqual([...e.info.remoteHeads].sort(), ['main2', 'trunk']);
  assert.equal(e.info.base, 'main');
  assert.match(e.message, /La rama base «main» no existe en origin\. Ramas del remoto: (trunk, main2|main2, trunk)\. Corrige la rama base del proyecto\./);
});

test('local commits but an empty origin: remote_empty with the exact command, no write', async () => {
  const s = specs.remoteEmpty;
  commitFile(s.repo);
  const e = await wtError(s, 'main');
  assert.equal(e?.code, 'remote_empty');
  assert.match(e.message, /git push -u origin main/);
});

test('no origin at all: no_remote (the fetch fails first)', async () => {
  const e = await wtError(specs.noRemote);
  assert.equal(e?.code, 'no_remote');
  assert.match(e.message, /git remote add origin <url>/);
});

test('a normal repository is untouched: the worktree is created', async () => {
  const s = specs.normal;
  commitFile(s.repo);
  git(s.repo, 'push', '-q', 'origin', 'master:main');
  const machine = machineFor('local', s.id);
  const wt = await createWorktree(machine, 'feat/1-x', { base: 'main' });
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/1-x');
});

// ---------------------------------------------------------------------------
// bootstrapRepo

let issueNo = 100;
function taskOf(spec, state = 'assigned') {
  issueNo += 1;
  const t = store.addTask({ number: issueNo, title: 't', labels: [], url: `https://x/${issueNo}`, closed: false }, spec.id);
  t.machine = 'local';
  t.state = state;
  return t;
}

const refusal = (status, code) => (e) => {
  assert.equal(e.status, status, e.message);
  assert.equal(e.code, code);
  return true;
};

test('bootstrapRepo: no confirm, no write (400)', async () => {
  const s = specs.boot;
  const t = taskOf(s);
  await assert.rejects(() => pipeline.bootstrapRepo(keyOf(t)), refusal(400, 'confirm_required'));
  await assert.rejects(() => pipeline.bootstrapRepo(keyOf(t), { confirm: 'true' }), refusal(400, 'confirm_required'));
  assert.equal(gitOk(s.repo, 'rev-parse', '--verify', '-q', 'HEAD'), false);
});

test('bootstrapRepo: a runner task is refused (409 runner_not_supported)', async () => {
  const runner = Object.keys(machines()).find((k) => machines()[k].kind === 'runner');
  assert.equal(runner, 'devbox', 'the runner declared by this file must be there');
  const t = taskOf(specs.boot);
  t.machine = runner;
  await assert.rejects(() => pipeline.bootstrapRepo(keyOf(t), { confirm: true }), refusal(409, 'runner_not_supported'));
});

test('bootstrapRepo: initial commit on the base, pushed with upstream, exact commands in order', async () => {
  const s = specs.boot;
  const t = taskOf(s);
  t.errorCode = 'empty_repo';
  t.errorInfo = { base: 'main' };
  const calls = [];
  const proto = Object.getPrototypeOf(machineOf(t));
  const exec = proto.exec;
  proto.exec = function spy(file, args, opts) { calls.push([file, ...args]); return exec.call(this, file, args, opts); };
  try {
    const out = await pipeline.bootstrapRepo(keyOf(t), { confirm: true });
    assert.equal(out.ok, true);
    assert.equal(out.base, 'main');
  } finally {
    proto.exec = exec;
  }
  const writes = calls.filter((c) => ['symbolic-ref', 'commit', 'push'].includes(c[1]) && !c.includes('-q'));
  assert.deepEqual(writes, [
    ['git', 'symbolic-ref', 'HEAD', 'refs/heads/main'],
    ['git', 'commit', '--allow-empty', '-m', 'Initial commit',
      '-m', 'Created by hfs-monitor so the repository has a base branch for worktrees and pull requests.'],
    ['git', 'push', '-u', 'origin', 'refs/heads/main:refs/heads/main'],
  ]);
  assert.ok(calls.every((c) => c[0] === 'git'));
  assert.equal(git(s.repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(git(s.remote, 'log', '--format=%s', 'main'), 'Initial commit');
  assert.equal(git(s.repo, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main');
  assert.equal(t.errorCode, null);
  assert.equal(t.errorInfo, null);
  assert.ok(t.log.some((l) => /initial commit created/.test(l.line)));
});

test('bootstrapRepo: a repository that is not empty answers 409 no_longer_empty and writes nothing', async () => {
  const s = specs.bootNotEmpty;
  commitFile(s.repo);
  git(s.repo, 'push', '-q', 'origin', 'master:main');
  const before = git(s.repo, 'rev-parse', 'HEAD');
  await assert.rejects(() => pipeline.bootstrapRepo(keyOf(taskOf(s)), { confirm: true }), refusal(409, 'no_longer_empty'));
  assert.equal(git(s.repo, 'rev-parse', 'HEAD'), before);
});

test('bootstrapRepo: something staged refuses with 409 index_not_clean', async () => {
  const s = specs.bootDirty;
  writeFileSync(path.join(s.repo, 'staged.txt'), 'x');
  git(s.repo, 'add', 'staged.txt');
  await assert.rejects(() => pipeline.bootstrapRepo(keyOf(taskOf(s)), { confirm: true }), refusal(409, 'index_not_clean'));
  assert.equal(gitOk(s.repo, 'rev-parse', '--verify', '-q', 'HEAD'), false, 'no commit was made');
});

test('bootstrapRepo: a rejected push answers 502 and leaves the repository as it was', async () => {
  const s = specs.bootPushFails;
  const hook = path.join(s.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "no pushes today" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  await assert.rejects(() => pipeline.bootstrapRepo(keyOf(taskOf(s)), { confirm: true }), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /Could not push the initial commit/);
    return true;
  });
  assert.equal(gitOk(s.repo, 'rev-parse', '--verify', '-q', 'HEAD'), false, 'the local commit was rolled back');
  assert.equal(git(s.repo, 'symbolic-ref', 'HEAD'), 'refs/heads/master', 'HEAD is where it was');
  assert.equal(git(s.remote, 'for-each-ref'), '');
});

test('bootstrapRepo: a double click makes one commit', async () => {
  const s = specs.bootDouble;
  const t = taskOf(s);
  const [a, b] = await Promise.all([
    pipeline.bootstrapRepo(keyOf(t), { confirm: true }),
    pipeline.bootstrapRepo(keyOf(t), { confirm: true }),
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(git(s.remote, 'rev-list', '--count', 'main'), '1');
});

test('ensureWorktree on an empty repository: the task keeps the code and throws the Spanish text', async () => {
  const t = taskOf(specs.empty);
  t.branch = 'feat/1-x';
  await assert.rejects(() => pipeline.ensureWorktree(keyOf(t)), /El repositorio está vacío/);
  assert.equal(t.errorCode, 'empty_repo');
  assert.deepEqual(t.errorInfo, { base: 'main' });
  assert.equal(t.state, 'assigned', 'the errand puts the card back; the pipeline sets error');
});

// ---------------------------------------------------------------------------
// Safety: refspecs, rollback, order of effects

/** Runs `fn` with every machine exec recorded; `after(args)` runs once a call returns. */
async function spied(t, fn, after) {
  const calls = [];
  const proto = Object.getPrototypeOf(machineOf(t));
  const exec = proto.exec;
  proto.exec = async function spy(file, args, opts) {
    calls.push([file, ...args]);
    const r = await exec.call(this, file, args, opts);
    after?.(args);
    return r;
  };
  try { return { calls, result: await fn().then((v) => ({ v }), (e) => ({ e })) }; } finally { proto.exec = exec; }
}
const gitWrites = (calls) => calls.filter((c) => ['symbolic-ref', 'commit', 'push', 'update-ref'].includes(c[1]) && !c.includes('-q'));

test('isSafeBranchName refuses what could become a refspec or an option', () => {
  for (const bad of ['+main', '-x', 'main:other', 'a..b', '@', '', '/a', 'a/', 'a b', 'x.lock', 'a@{1}']) {
    assert.equal(isSafeBranchName(bad), false, JSON.stringify(bad));
  }
  for (const ok of ['main', 'master', 'release/1.0', 'a@b', 'feat+x']) assert.equal(isSafeBranchName(ok), true, ok);
});

// The other layer: the registry itself refuses these before any task can carry
// them. saveProjects validates before it writes, so a refusal leaves the file alone.
test('the registry refuses a base branch of +main or @ (validated before writing)', async () => {
  const { saveProjects } = await import('../src/projects.js');
  const s = specs.normal;
  for (const baseBranch of ['+main', '@']) {
    assert.throws(() => saveProjects([{
      id: 'badbase', name: 'badbase', repoPath: s.repo, worktreeRoot: s.wt,
      repo: 'eterceros/badbase', assignee: 'eterceros', reviewer: 'reviewer-user', overrides: {}, baseBranch,
    }]), /baseBranch/, JSON.stringify(baseBranch));
  }
});

test('classifyRepoState: an unreadable ref store is unknown (null), never empty_repo', async () => {
  const s = specs.bootPre;
  const machine = machineFor('local', s.id);
  const proto = Object.getPrototypeOf(machine);
  const exec = proto.exec;
  proto.exec = async function failing(file, args, opts) {
    if (args[0] === 'for-each-ref') return { ok: false, code: 128, stdout: '', stderr: 'fatal: boom' };
    return exec.call(this, file, args, opts);
  };
  try {
    assert.equal(await classifyRepoState(machine, 'main'), null);
  } finally {
    proto.exec = exec;
  }
});

test('bootstrapRepo: a branch of that name already there refuses (409) and is left alone; so is an unrelated one', async () => {
  const s = specs.bootPre;
  commitFile(s.repo);
  git(s.repo, 'branch', 'main');
  git(s.repo, 'branch', 'unrelated');
  const refs = git(s.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
  await assert.rejects(() => pipeline.bootstrapRepo(keyOf(taskOf(s)), { confirm: true }), refusal(409, 'no_longer_empty'));
  assert.equal(git(s.repo, 'for-each-ref', '--format=%(refname) %(objectname)'), refs);
  assert.equal(git(s.remote, 'for-each-ref'), '');
});

test('bootstrapRepo: a failed push deletes only OUR commit: a ref that moved meanwhile stays', async () => {
  const s = specs.bootRace;
  const g = `${s.repo.split(path.sep).join('/')}/.git`;
  const hook = path.join(s.remote, 'hooks', 'pre-receive');
  const unset = '-u GIT_DIR -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_QUARANTINE_PATH';
  writeFileSync(hook, [
    '#!/bin/sh',
    `G="${g}"`,
    `M=$(env ${unset} git --git-dir="$G" rev-parse refs/heads/main)`,
    `T=$(env ${unset} git --git-dir="$G" commit-tree -p "$M" -m moved "$M^{tree}")`,
    `env ${unset} git --git-dir="$G" update-ref refs/heads/main "$T"`,
    'echo "no" >&2',
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(hook, 0o755);
  await assert.rejects(() => pipeline.bootstrapRepo(keyOf(taskOf(s)), { confirm: true }), (e) => e.status === 502);
  assert.equal(git(s.repo, 'log', '-1', '--format=%s', 'refs/heads/main'), 'moved', 'the other commit survived');
  assert.equal(git(s.repo, 'symbolic-ref', 'HEAD'), 'refs/heads/master', 'HEAD is where it was');
});

test('bootstrapRepo: a task being moved is refused (409) before any write', async () => {
  const s = specs.bootMoving;
  const t = taskOf(s);
  t.moving = { step: 'chats', from: 'local', to: 'x' };
  const { calls, result } = await spied(t, () => pipeline.bootstrapRepo(keyOf(t), { confirm: true }));
  assert.equal(result.e?.status, 409);
  assert.deepEqual(gitWrites(calls), []);
  assert.equal(git(s.remote, 'for-each-ref'), '');
  assert.equal(gitOk(s.repo, 'rev-parse', '--verify', '-q', 'HEAD'), false);
});

test('bootstrapRepo: a retry that refuses after the push is reported, not thrown', async () => {
  const s = specs.bootRetryFail;
  const t = taskOf(s, 'error');
  const { result } = await spied(t, () => pipeline.bootstrapRepo(keyOf(t), { confirm: true }), (args) => {
    if (args[0] === 'push') t.moving = { step: 'chats', from: 'local', to: 'x' };
  });
  assert.ok(result.v, result.e?.message);
  assert.equal(result.v.ok, true);
  assert.equal(result.v.retried, false);
  assert.match(result.v.retryError, /moving to another machine/);
  assert.equal(git(s.remote, 'log', '--format=%s', 'main'), 'Initial commit');
  assert.ok(t.log.some((l) => /could not be retried/.test(l.line)));
});
