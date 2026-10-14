// The viewer keeps the live config, its local overlay and the data folder
// secret by absolute path, because HFSMON_CONFIG and HFSMON_DATA_DIR can move
// them anywhere, including under a folder it serves. Those variables are read
// once at import, so each case runs in a child process that moves them inside
// a served root. Values are fake and the child prints only statuses.
import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempDir, removeTree } from './teardown.mjs';

const href = (rel) => new URL(rel, import.meta.url).href;

function runChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, HFSMON_NO_AUTOSTART: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}: ${stderr}`))));
  });
}

test('HFSMON_CONFIG y HFSMON_DATA_DIR dentro de una raíz servida: config, overlay y datos responden 404', async () => {
  const dir = realpathSync(tempDir('hfsmon-board-env-'));
  try {
    const served = path.join(dir, 'served');
    const config = path.join(served, 'moved', 'app-config.json');
    const overlay = path.join(served, 'moved', 'app-config.local.json');
    const data = path.join(served, 'moved-data');
    const files = {
      config, overlay, dataFile: path.join(data, 'frasco.json'), ordinary: path.join(served, 'ordinary.json'),
    };
    mkdirSync(path.dirname(config), { recursive: true });
    mkdirSync(data, { recursive: true });
    // A complete, fake config: the board does not load without its limits.
    copyFileSync(new URL('./fixtures/config.test.json', import.meta.url), config);
    writeFileSync(overlay, '{"access":{"token":"falso-no-es-un-token"}}');
    writeFileSync(files.dataFile, '{"token":"falso-no-es-un-token"}');
    writeFileSync(files.ordinary, '{"ok":1}');

    const script = path.join(dir, 'child.mjs');
    writeFileSync(script, `
      import path from 'node:path';
      const { config } = await import(${JSON.stringify(href('../src/config.js'))});
      const files = await import(${JSON.stringify(href('../src/files.js'))});
      config.machines = { local: { kind: 'local', repoPath: ${JSON.stringify(served)}, worktreeRoot: ${JSON.stringify(path.join(dir, 'wt'))} } };
      // The board runs from somewhere else, so only the absolute places protect these.
      files.filesHooks.boardRoot = () => path.join(${JSON.stringify(dir)}, 'board-elsewhere');
      const out = {};
      for (const [label, p] of Object.entries(${JSON.stringify(files)})) {
        try {
          await files.readAllowed({ machine: 'local', path: p });
          out[label] = 200;
        } catch (e) {
          out[label] = e.status ?? 'error';
        }
      }
      console.log(JSON.stringify(out));
      process.exit(0);
    `);

    const out = await runChild(script, { HFSMON_CONFIG: config, HFSMON_DATA_DIR: data });
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { config: 404, overlay: 404, dataFile: 404, ordinary: 200 });
  } finally {
    await removeTree(dir);
  }
});
