// A config reload must not be able to wipe what a test injected into `config`.
//
// Incident 1 of #22: the suite shared the real config.json, `config.js` polled it
// every 2 s, and an edit made mid-run made `reload()` delete every key of `config`
// (the simulated `machines` a test had set) and refill it from the real file.
//
// Under test `config.js` loads the checked-in fixture and does NOT watch it, so
// there is nothing to reload. This file proves both halves:
//
//  1. in this process (fixture, unwatched), bumping the file's mtime past two
//     watcher intervals leaves an injected `config.machines` untouched;
//  2. in a child with an explicit HFSMON_CONFIG (the way the real board runs, and
//     the way the board-spawning tests run) the watcher is still there: the same
//     injection IS wiped by the same touch. That is the production behaviour
//     this change must keep, and it is also what test 1 would look like if the
//     unwatched branch of `config.js` were removed.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, configEvents, CONFIG_FILE, CONFIG_IS_TEST_FIXTURE } from '../src/config.js';

// A ref'd timer: the watchers are unref'd, so without one the process could exit
// while the test waits for a poll that would never be allowed to happen.
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const INJECTED = { box: { kind: 'runner', url: 'http://127.0.0.1:9', token: 'test-token', repoPath: '/r', worktreeRoot: '/w' } };

test('under test the config is the fixture and an injected machines survives an mtime touch', async () => {
  assert.ok(CONFIG_IS_TEST_FIXTURE, `expected the checked-in fixture, got ${CONFIG_FILE}`);

  const saved = config.machines;
  const events = [];
  const onChange = () => events.push('change');
  configEvents.on('change', onChange);
  config.machines = INJECTED;

  const before = statSync(CONFIG_FILE);
  try {
    // Well past both watcher intervals (2 s each) and a full poll after the touch.
    const later = new Date(Date.now() + 60_000);
    utimesSync(CONFIG_FILE, later, later);
    await wait(5000);
    assert.equal(config.machines, INJECTED, 'a reload replaced the injected machines');
    assert.deepEqual(events, [], 'the config was reloaded under test');
  } finally {
    utimesSync(CONFIG_FILE, before.atime, before.mtime);
    configEvents.off('change', onChange);
    if (saved === undefined) delete config.machines; else config.machines = saved;
  }
});

test('with an explicit HFSMON_CONFIG the watcher still reloads, and wipes what was injected', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'config-reload-'));
  try {
    const file = path.join(dir, 'config.json');
    copyFileSync(CONFIG_FILE, file);

    const script = path.join(dir, 'child.mjs');
    writeFileSync(script, `
      import { utimesSync } from 'node:fs';
      const { config, configEvents } = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)});
      config.machines = { box: { kind: 'runner' } };
      let changed = false;
      configEvents.on('change', () => { changed = true; });
      // Let watchFile take its first stat before the file moves.
      await new Promise((r) => { setTimeout(r, 500); });
      const later = new Date(Date.now() + 60_000);
      utimesSync(process.env.HFSMON_CONFIG, later, later);
      for (let i = 0; i < 80 && !changed; i += 1) await new Promise((r) => { setTimeout(r, 100); });
      console.log(JSON.stringify({ changed, machines: config.machines ?? null }));
    `);

    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, HFSMON_CONFIG: file },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}: ${stderr}`))));
    });

    const result = JSON.parse(out.trim().split('\n').pop());
    assert.equal(result.changed, true, 'the explicit config file was not watched');
    assert.equal(result.machines, null, 'the reload did not replace the injected machines');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
