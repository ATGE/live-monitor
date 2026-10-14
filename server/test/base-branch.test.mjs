// Changing a project's base branch from the board (app-c, 2026-10-03: the
// repository was empty, the base was `master`, Edson wanted `main`, and the only
// way was editing projects.json and restarting). These tests run REAL git
// against temp repositories with a local bare origin, because the remote's
// answer is the whole point: a fake that always says «main exists» would prove
// nothing about the 409.
//
// The data directory is chosen BEFORE any import: data-dir.test.mjs checks that
// statically, and `projects.js` writes in it.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tempDir } from './teardown.mjs';

process.env.HFSMON_DATA_DIR = tempDir('hfsmon-basebranch-data-');
process.env.HFSMON_NO_AUTOSTART = '1';

const { test, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { execFileSync } = await import('node:child_process');

const { config, DATA_DIR } = await import('../src/config.js');

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
});

const ROOT = mkdtempSync(path.join(tmpdir(), 'base-branch-'));
// The data dir is not removed here: the store persists late (`beforeExit`, after
// the `after` hooks) and would log an ENOENT. `tempDir` removes it at process exit.
after(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let n = 0;
/** A checkout on `master` with a bare `origin` (empty, or holding `heads`). */
function makeRepo({ heads = [], origin = 'bare' } = {}) {
  n += 1;
  const dir = path.join(ROOT, `p${n}`);
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'master');
  if (origin === 'bare') {
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
  } else {
    // Nothing listens there: the connection is refused at once. The credentials
    // in the URL must never come back in an error.
    git(repo, 'remote', 'add', 'origin', origin);
  }
  if (heads.length) {
    writeFileSync(path.join(repo, 'a.txt'), 'x');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'c');
    for (const h of heads) git(repo, 'push', '-q', 'origin', `master:${h}`);
  }
  return { id: `bb${n}`, repo, remote, wt: path.join(dir, 'wt') };
}

// Every project is in the registry before `projects.js` first reads it.
const specs = {
  withHeads: makeRepo({ heads: ['trunk', 'develop'] }),
  empty: makeRepo(),
  unreachable: makeRepo({ origin: 'http://user:s3cr3t-token@127.0.0.1:1/x.git' }),
  retry: makeRepo({ heads: ['trunk'] }),
  retryThrows: makeRepo({ heads: ['trunk'] }),
  guard: makeRepo(),
  boot: makeRepo(),
};

writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify([
  {
    id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot,
    repo: 'HeliosSoftware/hfs', assignee: 'eterceros', reviewer: 'reviewer-user', overrides: {},
  },
  ...Object.values(specs).map((s) => ({
    id: s.id, name: s.id, repoPath: s.repo, worktreeRoot: s.wt,
    repo: `eterceros/${s.id}`, assignee: 'eterceros', reviewer: 'reviewer-user', overrides: {}, baseBranch: 'main',
  })),
], null, 2), 'utf8');

const { baseBranchOf, projectOf } = await import('../src/projects.js');
const { store } = await import('../src/store.js');
const { keyOf } = await import('../src/keys.js');
const pipeline = await import('../src/pipeline.js');

// The pipeline body never runs: a retry only has to reach `startPipeline`.
const runs = [];
pipeline.pipelineHooks.run = (task, from) => new Promise(() => { runs.push({ key: keyOf(task), from }); });

const onDisk = (id) => JSON.parse(readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf8')).find((p) => p.id === id);

let issueNo = 500;
function taskOf(spec, fields = {}) {
  issueNo += 1;
  const t = store.addTask({ number: issueNo, title: 't', labels: [], url: `https://x/${issueNo}`, closed: false }, spec.id);
  t.machine = 'local';
  Object.assign(t, fields);
  return t;
}
const errored = (spec, code = 'base_missing', info = { base: 'main', remoteHeads: ['trunk'] }) =>
  taskOf(spec, { state: 'error', error: 'La rama base «main» no existe en origin', errorCode: code, errorInfo: info });

const refusal = (status, code) => (e) => {
  assert.equal(e.status, status, e.message);
  assert.equal(e.code, code);
  return true;
};

test('a valid change persists and is live: no restart, the registry file and baseBranchOf agree', async () => {
  const s = specs.withHeads;
  assert.equal(baseBranchOf(s.id), 'main');
  const out = await pipeline.changeBaseBranch(s.id, 'trunk');
  assert.equal(out.ok, true);
  assert.deepEqual(out.project, { id: s.id, baseBranch: 'trunk' });
  assert.equal(out.retried, false);
  assert.match(out.note, /New tasks will create their worktree/);
  assert.match(out.note, /tasks in progress will merge and open their PR against it/);
  assert.equal(baseBranchOf(s.id), 'trunk', 'live, in the same process');
  assert.equal(projectOf(s.id).baseBranch, 'trunk');
  assert.equal(onDisk(s.id).baseBranch, 'trunk');
  // The other projects keep theirs.
  assert.equal(baseBranchOf(specs.empty.id), 'main');
});

test('invalid names are refused (400 bad_base) and change nothing', async () => {
  const s = specs.withHeads;
  const before = baseBranchOf(s.id);
  for (const bad of ['+main', '@', 'a..b', '-x', 'a b', 'x.lock', '', 'main:other']) {
    await assert.rejects(() => pipeline.changeBaseBranch(s.id, bad), refusal(400, 'bad_base'), JSON.stringify(bad));
  }
  await assert.rejects(() => pipeline.changeBaseBranch(s.id, undefined), refusal(400, 'bad_base'));
  await assert.rejects(() => pipeline.changeBaseBranch(s.id, 7), refusal(400, 'bad_base'));
  assert.equal(baseBranchOf(s.id), before);
  assert.equal(onDisk(s.id).baseBranch, before);
});

test('the remote has branches but not that one: 409 base_not_on_remote with the heads, nothing changed', async () => {
  const s = specs.withHeads;
  const before = baseBranchOf(s.id);
  await assert.rejects(() => pipeline.changeBaseBranch(s.id, 'nope'), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'base_not_on_remote');
    assert.equal(e.message, 'Branch «nope» does not exist on origin.');
    assert.deepEqual([...e.remoteHeads].sort(), ['develop', 'trunk']);
    return true;
  });
  assert.equal(baseBranchOf(s.id), before);
  assert.equal(onDisk(s.id).baseBranch, before);
});

test('an empty remote accepts the name: the bootstrap will create it', async () => {
  const s = specs.empty;
  const out = await pipeline.changeBaseBranch(s.id, 'trunk-to-be');
  assert.equal(out.project.baseBranch, 'trunk-to-be');
  assert.equal(baseBranchOf(s.id), 'trunk-to-be');
  assert.equal(git(s.remote, 'for-each-ref'), '', 'nothing was written to the remote');
});

test('an unreachable remote: 502 remote_unreachable, credentials redacted, nothing changed', async () => {
  const s = specs.unreachable;
  await assert.rejects(() => pipeline.changeBaseBranch(s.id, 'trunk'), (e) => {
    assert.equal(e.status, 502);
    assert.equal(e.code, 'remote_unreachable');
    assert.doesNotMatch(e.message, /s3cr3t-token/);
    return true;
  });
  assert.equal(baseBranchOf(s.id), 'main');
  assert.equal(onDisk(s.id).baseBranch, 'main');
});

test('an unknown project is 404; an unknown task of the project too, even if the number exists elsewhere', async () => {
  await assert.rejects(() => pipeline.changeBaseBranch('nadie', 'main'), refusal(404, 'unknown_project'));
  const s = specs.retry;
  const other = errored(specs.withHeads);
  await assert.rejects(() => pipeline.changeBaseBranch(s.id, 'trunk', other.issue + 1000), refusal(404, 'not_found'));
  await assert.rejects(() => pipeline.changeBaseBranch(s.id, 'trunk', 'abc'), refusal(400, 'bad_issue'));
  assert.equal(baseBranchOf(s.id), 'main');
});

test('retries ONLY the given task, and only when it is in an eligible error', async () => {
  const s = specs.retry;
  const mine = errored(s);
  const sibling = errored(s);
  const otherCode = errored(s, 'remote_empty', { base: 'main' });
  const notError = taskOf(s, { state: 'assigned', errorCode: null });
  runs.length = 0;

  const out = await pipeline.changeBaseBranch(s.id, 'trunk', mine.issue);
  assert.equal(out.retried, true);
  assert.deepEqual(runs.map((r) => r.key), [keyOf(mine)]);
  assert.equal(mine.errorCode, null);
  assert.equal(mine.error, null);
  assert.equal(mine.lastError, null);
  assert.equal(sibling.state, 'error');
  assert.equal(sibling.errorCode, 'base_missing', 'other tasks keep their error');

  // Not an error the base can cure: the base changes, the task is left alone.
  runs.length = 0;
  const b = await pipeline.changeBaseBranch(s.id, 'trunk', otherCode.issue);
  assert.equal(b.retried, false);
  assert.equal(otherCode.errorCode, 'remote_empty');
  const c = await pipeline.changeBaseBranch(s.id, 'trunk', notError.issue);
  assert.equal(c.retried, false);
  assert.equal(notError.state, 'assigned');
  assert.deepEqual(runs, []);
});

test('a retry that refuses leaves the code, shows the live base on the card, and says so', async () => {
  const s = specs.retryThrows;
  const t = errored(s);
  t.moving = { step: 'chats', from: 'local', to: 'x' };
  const out = await pipeline.changeBaseBranch(s.id, 'trunk', t.issue);
  assert.equal(out.ok, true);
  assert.equal(out.retried, false);
  assert.match(out.retryError, /moving to another machine/);
  assert.equal(baseBranchOf(s.id), 'trunk');
  assert.equal(t.errorCode, 'base_missing');
  assert.equal(t.errorInfo.base, 'trunk');
  assert.deepEqual(t.errorInfo.remoteHeads, ['trunk']);
  assert.equal(t.state, 'error');
});

test('the guard: two quick changes queue in order, and bootstrapRepo is refused meanwhile', async () => {
  const s = specs.guard;
  const t = errored(s, 'empty_repo', { base: 'main' });
  const first = pipeline.changeBaseBranch(s.id, 'one');
  const second = pipeline.changeBaseBranch(s.id, 'two');
  // In flight: the bootstrap reads the base before its own guard, so it waits outside.
  await assert.rejects(() => pipeline.bootstrapRepo(keyOf(t), { confirm: true }), refusal(409, 'base_change_in_progress'));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.project.baseBranch, 'one');
  assert.equal(b.project.baseBranch, 'two');
  assert.equal(baseBranchOf(s.id), 'two', 'the last one wins; they never interleaved');
  // Settled: the guard is gone.
  assert.equal((await pipeline.changeBaseBranch(s.id, 'three')).project.baseBranch, 'three');
});

test('a change during a bootstrap is refused (409 bootstrap_in_progress) and the bootstrap is unaffected', async () => {
  const s = specs.boot;
  const t = errored(s, 'empty_repo', { base: 'main' });
  const boot = pipeline.bootstrapRepo(keyOf(t), { confirm: true });
  await assert.rejects(() => pipeline.changeBaseBranch(s.id, 'other'), refusal(409, 'bootstrap_in_progress'));
  const out = await boot;
  assert.equal(out.base, 'main');
  assert.equal(baseBranchOf(s.id), 'main');
  assert.equal(git(s.remote, 'log', '--format=%s', 'main'), 'Initial commit');
});
