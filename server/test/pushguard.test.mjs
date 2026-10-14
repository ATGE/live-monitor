// The push guard: a Stop hook for interactive chats that tells the assistant to push
// commits left ahead of the remote. Pure module, so the tests drive it with a real
// temporary repository (bare remote included) and an injected runner for failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { chatStopHooks } from '../src/pushguard.js';
import { tempDir } from './teardown.mjs';

const FLAGS = ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid'];
const git = (cwd, ...args) => execFileSync('git', [...FLAGS, ...IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

/** The same shape as machine.exec: never throws, resolves { ok, code, stdout, stderr }. */
const realExec = async (file, args, { cwd } = {}) => {
  const r = spawnSync(file, args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

let counter = 0;
/** A clone on `branch` tracking a bare origin, with one pushed commit. */
function repoOn(branch = 'feat/x') {
  const root = tempDir('hfsmon-pushguard-');
  const origin = path.join(root, `origin${counter++}.git`);
  const work = path.join(root, `work${counter}`);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  if (branch !== 'main') {
    git(work, 'checkout', '-q', '-b', branch);
    git(work, 'push', '-q', '-u', 'origin', branch);
  }
  return work;
}

const commit = (work, msg = 'more') => git(work, 'commit', '-q', '--allow-empty', '-m', msg);

function guard({ dir, planMode = false, exec = realExec, baseBranch = 'main' } = {}) {
  const logs = [];
  const task = { worktreePath: dir };
  const chat = { planMode };
  const hooks = chatStopHooks(task, chat, { exec, log: (l) => logs.push(l), baseBranch });
  return { logs, task, chat, run: (input = {}) => hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop', stop_hook_active: false, ...input }) };
}

test('the set carries exactly one Stop matcher and nothing else', () => {
  const { chat } = guard({ dir: 'x' });
  const hooks = chatStopHooks({ worktreePath: 'x' }, chat, { exec: realExec, log() {}, baseBranch: 'main' });
  assert.deepEqual(Object.keys(hooks), ['Stop']);
  assert.equal(hooks.Stop.length, 1);
  assert.equal(hooks.Stop[0].hooks.length, 1);
});

test('ahead by 1: blocks, and the reason names the branch, upstream and count', async () => {
  const work = repoOn('feat/x');
  commit(work);
  const g = guard({ dir: work });
  const out = await g.run();
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /feat\/x/);
  assert.match(out.reason, /origin\/feat\/x/);
  assert.match(out.reason, /\b1 commit\b/);
  assert.match(out.reason, /push/i);
  assert.equal(g.logs.length, 1);
  assert.match(g.logs[0], /push guard: blocked, 1 commit ahead of origin\/feat\/x/);
});

test('ahead by 2 is counted in the plural', async () => {
  const work = repoOn('feat/x');
  commit(work, 'a');
  commit(work, 'b');
  const g = guard({ dir: work });
  const out = await g.run();
  assert.match(out.reason, /\b2 commits\b/);
});

test('stop_hook_active: returns {} even though the branch is ahead', async () => {
  const work = repoOn('feat/x');
  commit(work);
  const g = guard({ dir: work });
  assert.deepEqual(await g.run({ stop_hook_active: true }), {});
  assert.equal(g.logs.length, 1);
});

test('a subagent stop is left alone', async () => {
  const work = repoOn('feat/x');
  commit(work);
  const g = guard({ dir: work });
  assert.deepEqual(await g.run({ agent_id: 'sub-1' }), {});
});

test('not ahead: returns {} and logs that there is nothing to push', async () => {
  const g = guard({ dir: repoOn('feat/x') });
  assert.deepEqual(await g.run(), {});
  assert.deepEqual(g.logs, ['push guard: nothing to push']);
});

test('no upstream: returns {}', async () => {
  const work = repoOn('feat/x');
  git(work, 'checkout', '-q', '-b', 'local-only');
  commit(work);
  const g = guard({ dir: work });
  assert.deepEqual(await g.run(), {});
  assert.equal(g.logs.length, 1);
});

test('detached HEAD: returns {}', async () => {
  const work = repoOn('feat/x');
  commit(work);
  git(work, 'checkout', '-q', '--detach');
  const g = guard({ dir: work });
  assert.deepEqual(await g.run(), {});
  assert.equal(g.logs.length, 1);
});

test('uncommitted changes only: returns {}', async () => {
  const work = repoOn('feat/x');
  execFileSync(process.execPath, ['-e', "require('fs').writeFileSync('dirty.txt', 'x')"], { cwd: work });
  git(work, 'add', 'dirty.txt');
  const g = guard({ dir: work });
  assert.deepEqual(await g.run(), {});
});

test('plan mode: returns {} without running git', async () => {
  const work = repoOn('feat/x');
  commit(work);
  let calls = 0;
  const g = guard({ dir: work, planMode: true, exec: async (...a) => { calls++; return realExec(...a); } });
  assert.deepEqual(await g.run(), {});
  assert.equal(calls, 0);
});

test('plan mode is read when the hook fires, not when it is built', async () => {
  const work = repoOn('feat/x');
  commit(work);
  const g = guard({ dir: work });
  g.chat.planMode = true;
  assert.deepEqual(await g.run(), {});
});

test('the worktree path is read when the hook fires', async () => {
  const stale = repoOn('feat/x');
  const fresh = repoOn('feat/y');
  commit(fresh);
  const g = guard({ dir: stale });
  g.task.worktreePath = fresh;
  assert.equal((await g.run()).decision, 'block');
});

test('the base branch is skipped: pushing it is an explicit act', async () => {
  const work = repoOn('main');
  commit(work);
  const g = guard({ dir: work, baseBranch: 'main' });
  assert.deepEqual(await g.run(), {});
  assert.equal(g.logs.length, 1);
  // ...but a project whose base is another branch is guarded on main.
  assert.equal((await guard({ dir: work, baseBranch: 'develop' }).run()).decision, 'block');
});

test('no working directory: returns {}', async () => {
  const g = guard({ dir: undefined });
  assert.deepEqual(await g.run(), {});
  assert.equal(g.logs.length, 1);
});

test('git calls go through the injected runner with no shell and a 2 s timeout', async () => {
  const work = repoOn('feat/x');
  commit(work);
  const seen = [];
  const g = guard({ dir: work, exec: async (file, args, opts) => { seen.push({ file, args, opts }); return realExec(file, args, opts); } });
  await g.run();
  assert.ok(seen.length >= 2);
  for (const s of seen) {
    assert.equal(s.file, 'git');
    assert.equal(s.opts.cwd, work);
    assert.equal(s.opts.timeoutMs, 2000);
  }
  assert.deepEqual(seen[0].args, ['rev-parse', '--abbrev-ref', 'HEAD', '@{u}']);
  assert.deepEqual(seen[1].args, ['rev-list', '--count', '@{u}..HEAD']);
});

test('git failing: returns {} and logs', async () => {
  const work = repoOn('feat/x');
  commit(work);
  const g = guard({ dir: work, exec: async () => ({ ok: false, code: -1, stdout: '', stderr: 'spawn git ENOENT' }) });
  assert.deepEqual(await g.run(), {});
  assert.equal(g.logs.length, 1);
  assert.match(g.logs[0], /push guard:/);
});

test('git timing out: returns {} and logs', async () => {
  const work = repoOn('feat/x');
  commit(work);
  const g = guard({ dir: work, exec: async () => ({ ok: false, code: -2, stdout: '', stderr: '[timeout after 2000ms]' }) });
  assert.deepEqual(await g.run(), {});
  assert.equal(g.logs.length, 1);
});

test('the runner throwing never blocks a turn', async () => {
  const work = repoOn('feat/x');
  commit(work);
  const g = guard({ dir: work, exec: async () => { throw new Error('boom'); } });
  assert.deepEqual(await g.run(), {});
  assert.match(g.logs.join('\n'), /boom/);
});

test('garbage from git (a count that is not a number) lets the turn stop', async () => {
  const exec = async (file, args) => (args[0] === 'rev-parse'
    ? { ok: true, code: 0, stdout: 'feat/x\norigin/feat/x\n', stderr: '' }
    : { ok: true, code: 0, stdout: 'many\n', stderr: '' });
  assert.deepEqual(await guard({ dir: 'x', exec }).run(), {});
});

test('a log that throws never changes the answer', async () => {
  const work = repoOn('feat/x');
  commit(work);
  const hooks = chatStopHooks({ worktreePath: work }, { planMode: false }, { exec: realExec, log() { throw new Error('log down'); }, baseBranch: 'main' });
  const out = await hooks.Stop[0].hooks[0]({ stop_hook_active: false });
  assert.equal(out.decision, 'block');
  const skip = await hooks.Stop[0].hooks[0]({ stop_hook_active: true });
  assert.deepEqual(skip, {});
});
