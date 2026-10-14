import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A break in the web bundle (#17 reached main with a build error) is invisible
// to every other test: only compiling it catches it. This builds into a
// temporary directory, never `web/dist`, which the live board serves.
const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');
const VITE = path.join(WEB, 'node_modules', 'vite', 'bin', 'vite.js');

test('the web bundle builds into a temporary directory', {
  skip: !existsSync(VITE) && 'web/node_modules is not installed (run npm ci in web/)',
  timeout: 300_000,
}, () => {
  const out = mkdtempSync(path.join(tmpdir(), 'hfsmon-web-build-'));
  try {
    const r = spawnSync(process.execPath, [VITE, 'build', '--outDir', out, '--emptyOutDir'], {
      cwd: WEB, encoding: 'utf8', timeout: 280_000,
    });
    assert.equal(r.status, 0, `vite build failed:\n${r.stdout}\n${r.stderr}`);
    assert.ok(readdirSync(out).includes('index.html'), 'the build wrote an index.html');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
