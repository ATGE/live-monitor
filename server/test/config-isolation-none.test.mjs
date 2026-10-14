import './isolate.mjs';
// Issue #18: `node --test --test-isolation=none server/test/x.test.mjs` defines no
// NODE_TEST_CONTEXT and leaves argv[1] relative, so config.js used to load the
// real config (tokens, watchers) in that mode. The child below runs exactly that,
// with the variables that would mask the bug removed from its environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('--test-isolation=none with a relative path still runs on the fixture', { timeout: 60_000 }, async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.HFSMON_CONFIG;

  const { code, output } = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-isolation=none', 'server/test/config-isolation.test.mjs'],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('error', reject);
    child.on('close', (c) => resolve({ code: c, output: text }));
  });

  assert.equal(code, 0, `the child must see the fixture, not the real config:\n${output.slice(-2000)}`);
});
