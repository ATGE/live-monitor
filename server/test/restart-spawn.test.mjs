// The REAL spawnRestart, aimed at a dummy restart.ps1 in a throwaway root: the
// dummy only writes a timestamp to a file. restart.test.mjs replaces this hook,
// so it never sees the launch options; this is the one test that does.
//
// On this Windows a `detached: true` PowerShell exits 0 in ~100 ms without
// running its script (FSD-ZN02, measured again 2026-10-05: the board's restart
// button answered `restarting`, the board stayed up and restart.ps1 never ran).
// Nothing here stops, kills or binds anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeTreeReported, tempDir } from './teardown.mjs';

const dataDir = tempDir('hfsmon-restart-spawn-data-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

const { restartHooks } = await import('../src/restart.js');

const WIN = process.platform === 'win32';

test('spawnRestart really runs restart.ps1 (a detached PowerShell would exit without running it)', { skip: WIN ? false : 'solo Windows' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hfsmon-restart-spawn-'));
  mkdirSync(root, { recursive: true });
  const stamp = path.join(root, 'ran.txt');
  writeFileSync(path.join(root, 'restart.ps1'), `[IO.File]::WriteAllText('${stamp.replace(/'/g, "''")}', (Get-Date).ToString('o'))\r\n`);
  try {
    restartHooks.spawnRestart(root);
    const deadline = Date.now() + 30_000;
    while (!existsSync(stamp) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(existsSync(stamp), 'restart.ps1 never ran: the launch options must not detach PowerShell');
    assert.match(readFileSync(stamp, 'utf8'), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    // The PowerShell it started may still be ending with `root` as its cwd.
    await removeTreeReported('restart-spawn', root, { tolerate: true, timeoutMs: 3000 });
    await removeTreeReported('restart-spawn', dataDir, { tolerate: true, timeoutMs: 3000 });
  }
});
