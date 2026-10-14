import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeReported } from './teardown.mjs';

/**
 * restart.ps1 and stop.ps1 run for real inside a throwaway copy of the repo
 * (start.ps1 too, whatever version is in the tree: only its exit-code contract
 * is relied on). The board is a stub `server\src\index.js` that answers
 * `/api/upgrade`; `npm` is a fake that always succeeds. Every stop.ps1 /
 * restart.ps1 call gets an EMPTY sweep range (1..0): the real one holds the
 * live board's stacks, and nothing here may touch a process it did not start.
 */

const WIN = process.platform === 'win32';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SANDBOX_ROOT = process.env.HFSMON_RESTART_SANDBOX || path.join(os.tmpdir(), 'hfsmon-restart-sandbox');
const SKIP = WIN ? false : 'solo Windows';
const SWEEP = ['-PortFrom', '1', '-PortTo', '0'];

const FAKE_BOARD = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
// Safety net: a board left behind by a failed test ends itself.
setTimeout(() => process.exit(0), 5 * 60 * 1000);
if (cfg.dies) { console.error('boom: fake board refuses to start'); process.exit(1); }
// Alive but silent for a while, then dead: the case restart's own fail-fast catches.
if (cfg.dieAfterMs) { setTimeout(() => { console.error('boom: fake board died late'); process.exit(1); }, cfg.dieAfterMs); return; }
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/upgrade')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"job":null}');
    return;
  }
  res.writeHead(404);
  res.end();
});
// listenDelayMs: a slow board, so two restarts can overlap.
setTimeout(() => srv.listen(cfg.port, '127.0.0.1'), cfg.listenDelayMs || 0);
`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await delay(200);
  }
}

async function answers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/upgrade`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const readPid = (ctx) => {
  try {
    return Number.parseInt(fs.readFileSync(path.join(ctx.repo, '.hfs-monitor.pid'), 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
};

function makeSandbox(name, port, config = {}, npmExit = 0) {
  const dir = path.join(SANDBOX_ROOT, `${Date.now().toString(36)}-${name}`);
  const repo = path.join(dir, 'repo');
  const tools = path.join(dir, 'tools');
  for (const d of [repo, tools, path.join(repo, 'server', 'src'), path.join(repo, 'server', 'node_modules'),
    path.join(repo, 'web', 'node_modules')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const f of ['start.ps1', 'stop.ps1', 'restart.ps1']) fs.copyFileSync(path.join(REPO, f), path.join(repo, f));
  fs.writeFileSync(path.join(repo, 'config.json'), JSON.stringify({ port, ...config }));
  fs.writeFileSync(path.join(repo, 'server', 'src', 'index.js'), FAKE_BOARD);
  fs.writeFileSync(path.join(tools, 'npm.cmd'), `@echo off\r\nexit /b ${npmExit}\r\n`);

  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_|GIT_|CLAUDE|ANTHROPIC_|HFSMON_)/i.test(k) || /^INIT_CWD$/i.test(k)) continue;
    env[k] = v;
  }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  env[pathKey] = [tools, env[pathKey] ?? ''].join(';');
  return { dir, repo, port, env, children: [] };
}

async function cleanup(ctx) {
  for (const c of ctx.children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  const pid = readPid(ctx);
  // Own pid file in a sandbox this test created: the board it names is ours.
  if (pid && alive(pid)) { try { process.kill(pid); } catch { /* gone */ } }
  await delay(300);
  // A handle may linger; the next run uses a new folder.
  await removeTreeReported('restart-ps1', ctx.dir, { tolerate: true, timeoutMs: 3000 });
}

/** A board started by hand, with its pid file written after the spawn. */
async function startOldBoard(ctx) {
  const child = spawn(process.execPath, [path.join(ctx.repo, 'server', 'src', 'index.js')],
    { cwd: path.join(ctx.repo, 'server'), stdio: 'ignore', windowsHide: true });
  ctx.children.push(child);
  fs.writeFileSync(path.join(ctx.repo, '.hfs-monitor.pid'), String(child.pid));
  assert.ok(await waitFor(() => answers(ctx.port), 15_000), 'the old board answers');
  return child;
}

/** Runs a script with PIPED stdio and resolves on `close` (EOF on the pipes), not `exit`. */
function runPiped(ctx, script, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.repo, script), ...args],
      { cwd: ctx.repo, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${script} did not close its pipes in ${timeoutMs} ms:\n${output}`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output, ms: Date.now() - t0 }); });
  });
}

describe('restart.ps1 / stop.ps1 (sandbox)', { skip: SKIP }, () => {
  test('restarts a running board: old pid gone, new one answers, pipes close, exit 0', async () => {
    const port = await freePort();
    const ctx = makeSandbox('ok', port);
    try {
      const old = await startOldBoard(ctx);
      const oldPid = old.pid;
      const r = await runPiped(ctx, 'restart.ps1', ['-Port', String(port), ...SWEEP]);
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /El tablero responde en http:\/\/localhost:\d+ \(PID \d+\)/, r.output);
      const newPid = readPid(ctx);
      assert.ok(newPid > 0 && newPid !== oldPid, 'a new pid is in the pid file');
      assert.ok(alive(newPid), 'the new board is alive');
      assert.ok(await waitFor(async () => !alive(oldPid), 5000), 'the old board is gone');
      assert.ok(await answers(port), 'the new board answers');
    } finally {
      await cleanup(ctx);
    }
  });

  test('a board that dies at once fails fast, with the err-log tail', async () => {
    const port = await freePort();
    const ctx = makeSandbox('dies', port, { dies: true });
    try {
      const r = await runPiped(ctx, 'restart.ps1', ['-Port', String(port), '-StartTimeoutSeconds', '60', ...SWEEP]);
      assert.equal(r.code, 1, r.output);
      assert.ok(r.ms < 45_000, `failed fast (${r.ms} ms)`);
      assert.match(r.output, /boom: fake board refuses to start/, r.output);
      assert.doesNotMatch(r.output, /El tablero responde/);
    } finally {
      await cleanup(ctx);
    }
  });

  test('a board that starts and dies a moment later is caught by the health check, well before its timeout', async () => {
    const port = await freePort();
    const ctx = makeSandbox('dies-late', port, { dieAfterMs: 3000 });
    try {
      const r = await runPiped(ctx, 'restart.ps1', ['-Port', String(port), '-StartTimeoutSeconds', '90', ...SWEEP]);
      assert.equal(r.code, 1, r.output);
      assert.ok(r.ms < 60_000, `failed fast (${r.ms} ms)`);
      assert.match(r.output, /boom: fake board died late/, r.output);
      assert.doesNotMatch(r.output, /El tablero responde/);
    } finally {
      await cleanup(ctx);
    }
  });

  test('stop.ps1 with a reused pid (a live node that started after the pid file) kills nothing', async () => {
    const port = await freePort();
    const ctx = makeSandbox('reuse', port);
    try {
      const old = await startOldBoard(ctx);
      const pidFile = path.join(ctx.repo, '.hfs-monitor.pid');
      // The file claims to have been written 60 s before this node started.
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(pidFile, past, past);
      const r = await runPiped(ctx, 'stop.ps1', SWEEP);
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /Archivo \.pid obsoleto/, r.output);
      assert.ok(!fs.existsSync(pidFile), 'the stale pid file is removed');
      assert.ok(alive(old.pid) && await answers(port), 'the node process was not killed');
    } finally {
      await cleanup(ctx);
    }
  });

  test('stop.ps1 with a stale pid file (a live non-node process) kills nothing and removes the file', async () => {
    const port = await freePort();
    const ctx = makeSandbox('stale', port);
    // The test's own short-lived, self-terminating process; it is not node.
    const other = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 60'], { stdio: 'ignore', windowsHide: true });
    ctx.children.push(other);
    try {
      assert.ok(await waitFor(() => alive(other.pid), 5000));
      const pidFile = path.join(ctx.repo, '.hfs-monitor.pid');
      fs.writeFileSync(pidFile, String(other.pid));
      const r = await runPiped(ctx, 'stop.ps1', SWEEP);
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /Archivo \.pid obsoleto/, r.output);
      assert.ok(!fs.existsSync(pidFile), 'the stale pid file is removed');
      assert.ok(alive(other.pid), 'the unrelated process was not killed');
    } finally {
      await cleanup(ctx);
    }
  });

  test('a live upgrade lock makes restart exit non-zero at once, with the lock message', async () => {
    const port = await freePort();
    const ctx = makeSandbox('lock', port);
    try {
      // A board holds the port: without the exit-code propagation restart would
      // wait the whole port timeout and blame the port.
      const old = await startOldBoard(ctx);
      // The test process itself is the (live) lock holder.
      fs.writeFileSync(path.join(ctx.repo, '.hfs-monitor.upgrading'),
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      const r = await runPiped(ctx, 'restart.ps1', ['-Port', String(port), ...SWEEP]);
      assert.notEqual(r.code, 0, r.output);
      assert.match(r.output, /se esta actualizando/, r.output);
      assert.ok(r.ms < 20_000, `exited at once, not after the 30 s port wait (${r.ms} ms)`);
      assert.ok(alive(old.pid) && await answers(port), 'the board was left alone');
    } finally {
      await cleanup(ctx);
    }
  });

  test('start.ps1 exit 2 (failed web build) is passed through after the board answers; -Port is read from config.json', async () => {
    const port = await freePort();
    const ctx = makeSandbox('exit2', port, {}, 1);
    try {
      await startOldBoard(ctx);
      // No -Port: resolved from the sandbox's config.json.
      const r = await runPiped(ctx, 'restart.ps1', [...SWEEP]);
      assert.equal(r.code, 2, r.output);
      assert.ok(r.output.includes(`El tablero responde en http://localhost:${port} (PID`), r.output);
      assert.ok(await answers(port), 'the board answers');
    } finally {
      await cleanup(ctx);
    }
  });

  test('a second restart while one runs is refused and leaves the first one intact', async () => {
    const port = await freePort();
    const ctx = makeSandbox('overlap', port, { listenDelayMs: 8000 });
    try {
      await startOldBoard(ctx);
      const log = path.join(ctx.repo, 'hfs-monitor.restart.log');
      const first = runPiped(ctx, 'restart.ps1', ['-Port', String(port), '-StartTimeoutSeconds', '90', ...SWEEP]);
      assert.ok(await waitFor(() => fs.existsSync(log) && /Reiniciando/.test(fs.readFileSync(log, 'utf8')), 60_000), 'the first worker started');
      const second = await runPiped(ctx, 'restart.ps1', ['-Port', String(port), ...SWEEP]);
      assert.equal(second.code, 1, second.output);
      assert.match(second.output, /Ya hay un reinicio en curso; este se descarta\./, second.output);
      const r = await first;
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /El tablero responde/, r.output);
      const text = fs.readFileSync(log, 'utf8');
      assert.match(text, /Reiniciando/);
      assert.match(text, /El tablero responde/);
      assert.ok(await answers(port), 'the board answers');
    } finally {
      await cleanup(ctx);
    }
  });

  test('a restart whose whole process tree is killed mid-way still finishes (detached worker)', async () => {
    const port = await freePort();
    const ctx = makeSandbox('detach', port);
    try {
      const old = await startOldBoard(ctx);
      const oldPid = old.pid;
      // root node -> powershell (restart front), like a restart typed inside the board.
      const rootScript = `
        const { spawn } = require('child_process');
        spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',${JSON.stringify(path.join(ctx.repo, 'restart.ps1'))},
          '-Port','${port}','-PortFrom','1','-PortTo','0'], { stdio: 'ignore', windowsHide: true });
        setInterval(() => {}, 1000);`;
      const root = spawn(process.execPath, ['-e', rootScript], { cwd: ctx.repo, env: ctx.env, stdio: 'ignore', windowsHide: true });
      ctx.children.push(root);
      const log = path.join(ctx.repo, 'hfs-monitor.restart.log');
      const result = path.join(ctx.repo, '.hfs-monitor.restart.result');
      // The worker's first line: it is running and about to stop the board.
      assert.ok(await waitFor(() => fs.existsSync(log) && /Reiniciando/.test(fs.readFileSync(log, 'utf8')), 60_000), 'the worker started');
      // Kill the root, the front and whatever hangs from them: the whole tree.
      execFileSync('taskkill', ['/PID', String(root.pid), '/T', '/F'], { stdio: 'ignore' });
      assert.ok(await waitFor(() => fs.existsSync(result), 120_000), 'the worker still wrote its result');
      assert.equal(fs.readFileSync(result, 'utf8').trim(), '0', fs.readFileSync(log, 'utf8'));
      assert.match(fs.readFileSync(log, 'utf8'), /El tablero responde/);
      const newPid = readPid(ctx);
      assert.ok(newPid > 0 && newPid !== oldPid && alive(newPid), 'a new board is up');
      assert.ok(await answers(port), 'the new board answers');
    } finally {
      await cleanup(ctx);
    }
  });
});
