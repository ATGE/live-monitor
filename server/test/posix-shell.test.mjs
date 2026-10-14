// A plan task's `check` is written by a session whose Bash tool is bash (Git
// Bash on Windows), so the board must run it with bash too — never cmd.exe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGitBash, runPosixShell, _resetGitBashCache } from '../src/exec.js';

const set = (...paths) => {
  const s = new Set(paths.map((p) => p.toLowerCase()));
  return (p) => s.has(p.toLowerCase());
};

test('resolveGitBash honours CLAUDE_CODE_GIT_BASH_PATH first', () => {
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\tools\\git\\usr\\bin\\bash.exe', SystemRoot: 'C:\\Windows' };
  const exists = set('D:\\tools\\git\\usr\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(resolveGitBash({ env, exists }), 'D:\\tools\\git\\usr\\bin\\bash.exe');
});

test('resolveGitBash derives bin\\bash.exe from the git.exe on PATH (cmd, bin, mingw64\\bin)', () => {
  for (const gitDir of ['E:\\Git\\cmd', 'E:\\Git\\bin', 'E:\\Git\\mingw64\\bin']) {
    const env = { Path: `C:\\Windows\\System32;"${gitDir}\\";C:\\other`, SystemRoot: 'C:\\Windows' };
    const exists = set(`${gitDir}\\git.exe`, 'E:\\Git\\bin\\bash.exe');
    assert.equal(resolveGitBash({ env, exists }), 'E:\\Git\\bin\\bash.exe', gitDir);
  }
});

test('resolveGitBash rejects WSL bash under the Windows directory', () => {
  const env = {
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Windows\\System32\\bash.exe',
    PATH: 'C:\\Windows\\System32',
    windir: 'C:\\Windows',
  };
  const exists = set('C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\System32\\git.exe');
  assert.equal(resolveGitBash({ env, exists }), null);
});

test('resolveGitBash rejects WSL bash even with no SystemRoot/windir in env', () => {
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Windows\\System32\\bash.exe', PATH: '' };
  assert.equal(resolveGitBash({ env, exists: set('C:\\Windows\\System32\\bash.exe') }), null);
});

test('resolveGitBash falls back to the default install locations, then null', () => {
  const env = { PATH: '', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', SystemRoot: 'C:\\Windows' };
  assert.equal(
    resolveGitBash({ env, exists: set('C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe') }),
    'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
  );
  assert.equal(resolveGitBash({ env, exists: () => false }), null);
});

test('runPosixShell runs bash syntax (VAR=x cmd, &&) on this platform', async (t) => {
  _resetGitBashCache();
  if (process.platform === 'win32' && !resolveGitBash()) {
    t.skip('no Git Bash on this Windows machine');
    return;
  }
  const r = await runPosixShell('X=1 && echo "$X" && FOO=bar sh -c \'echo $FOO\'', { timeoutMs: 30_000 });
  assert.equal(r.ok, true, r.stderr);
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['1', 'bar']);
});

test('runPosixShell without Git Bash on Windows resolves to a clear error, never cmd', async () => {
  const r = await runPosixShell('echo hi', { platform: 'win32', findBash: () => null });
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no se encontró Git Bash/);
  assert.match(r.stderr, /CLAUDE_CODE_GIT_BASH_PATH/);
});
