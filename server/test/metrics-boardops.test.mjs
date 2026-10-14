// Spans of the board's own long operations: a restart is opened before the
// board dies and closed by the next boot; move and upgrade steps carry their end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tempDir } from './teardown.mjs';
import express from 'express';

const dataDir = tempDir('hfsmon-boardops-');
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

const { restartRouter, restartHooks } = await import('../src/restart.js');
const { boardSpans, beginBoardSpan } = await import('../src/boardtimings.js');

const upgrade = await import('../src/upgrade.js');

const original = { ...restartHooks };
let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(restartRouter());
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(restartHooks, original);
  await new Promise((r) => server.close(r));
});

const post = (p) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

test('a restart writes its start before the spawn and leaves it open', async () => {
  let seenAtSpawn = null;
  Object.assign(restartHooks, {
    platform: () => 'win32',
    upgrading: () => false,
    busy: () => [],
    closeSessions: async () => {},
    flush: () => {},
    spawnRestart: () => { seenAtSpawn = boardSpans().filter((s) => s.name === 'restart'); },
  });
  const r = await post('/api/restart');
  assert.equal(r.status, 202);
  assert.equal(seenAtSpawn.length, 1, 'the span exists when the script is launched');
  const open = boardSpans().filter((s) => s.name === 'restart');
  assert.equal(open.length, 1);
  assert.equal(open[0].endedAt, null, 'the old board cannot close it');
});

test('a failed restart closes its span as error', async () => {
  Object.assign(restartHooks, {
    spawnRestart: () => { throw new Error('no powershell'); },
  });
  const r = await post('/api/restart');
  assert.equal(r.status, 500);
  const failed = boardSpans().filter((s) => s.name === 'restart' && s.outcome === 'error');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].meta.error, 'no powershell');
});

test('mounting the router at the next boot closes the open restart as ok', () => {
  assert.equal(boardSpans().filter((s) => s.name === 'restart' && s.endedAt == null).length, 1);
  restartRouter();
  const spans = boardSpans().filter((s) => s.name === 'restart');
  assert.equal(spans.filter((s) => s.endedAt == null).length, 0);
  const closed = spans.find((s) => s.outcome === 'ok');
  assert.ok(closed, 'the boot is the end of the restart');
  assert.ok(closed.ms >= 0);
});

const upgradeSpans = (jobId) => boardSpans().filter((s) => s.name.startsWith('upgrade') && s.meta.job === jobId);

async function jobWith(id, state, over = {}) {
  const value = {
    id, state, target: { sdk: '0.0.1', cli: '0.0.1' }, previous: { sdk: '0.0.0', cli: '0.0.0', laptopCli: '0.0.0' },
    onlyLaptop: false, force: false, requestedAt: new Date().toISOString(), startedAt: null, endedAt: null,
    step: null, steps: [], failedStep: null, error: null, runners: {},
    laptop: { commit: null, pushed: null, pushError: null, rolledBack: false },
    scriptPid: null, boardPid: null, logTail: [], acknowledged: false, ...over,
  };
  writeFileSync(upgrade.jobFile(), JSON.stringify(value));
  return upgrade.resumeOnBoot();
}

test('an upgrade job and its steps are recorded as board spans, and a failed handover closes them', async () => {
  const savedSpawn = upgrade.upgradeHooks.spawnScript;
  const savedExit = upgrade.upgradeHooks.exit;
  upgrade.upgradeHooks.spawnScript = async () => { throw new Error('powershell no está'); };
  upgrade.upgradeHooks.exit = () => {};
  try {
    await jobWith('ub-fail', 'waiting', { onlyLaptop: true });
    await upgrade.startRunning({ now: true });
    await upgrade.upgradeRun();
    assert.equal(upgrade.getUpgradeJob().state, 'failed');
    const spans = upgradeSpans('ub-fail');
    const jobSpan = spans.find((s) => s.name === 'upgrade');
    assert.ok(jobSpan, 'the job has a span');
    assert.equal(jobSpan.outcome, 'failed');
    assert.equal(jobSpan.meta.failedStep, 'laptop_launch');
    assert.ok(jobSpan.ms >= 0);
    const step = spans.find((s) => s.name === 'upgrade:laptop_launch');
    assert.ok(step, 'and so does each step');
    assert.equal(step.outcome, 'failed');
    assert.equal(spans.filter((s) => s.endedAt == null).length, 0);
    assert.ok(upgrade.getUpgradeJob().steps.every((s) => s.endedAt), 'step.endedAt is kept');
  } finally {
    upgrade.upgradeHooks.spawnScript = savedSpawn;
    upgrade.upgradeHooks.exit = savedExit;
  }
});

test('a board that restarts mid-job closes the cut job and step spans as interrupted', async () => {
  const at = new Date().toISOString();
  const opened = [
    beginBoardSpan({ name: 'upgrade', job: 'ub-cut' }),
    beginBoardSpan({ name: 'upgrade:runner_code', job: 'ub-cut' }),
  ];
  assert.ok(opened.every(Boolean));
  const job = await jobWith('ub-cut', 'running', {
    startedAt: at, step: 'runner_code', steps: [{ name: 'runner_code', state: 'running', detail: 'box', at }],
  });
  assert.equal(job.state, 'failed');
  assert.ok(job.steps[0].endedAt, 'the cut step gets an end');
  const spans = upgradeSpans('ub-cut');
  assert.equal(spans.length, 2);
  for (const s of spans) {
    assert.equal(s.outcome, 'interrupted');
    assert.notEqual(s.endedAt, null);
  }
});

test('a job handed to the laptop keeps its span open until the next board adopts the result', async () => {
  beginBoardSpan({ name: 'upgrade', job: 'ub-lap' });
  await jobWith('ub-lap', 'laptop', { scriptPid: process.pid, step: 'laptop_start' });
  assert.equal(upgradeSpans('ub-lap')[0].endedAt, null, 'still open while the script works');
  writeFileSync(upgrade.jobFile(), JSON.stringify({ ...upgrade.getUpgradeJob(), state: 'done', endedAt: new Date().toISOString() }));
  const until = Date.now() + 5000;
  while (upgradeSpans('ub-lap')[0].endedAt == null && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(upgradeSpans('ub-lap')[0].outcome, 'ok');
});

for (const state of ['done', 'failed']) {
  test(`a board that boots on a ${state} job closes its open upgrade span at the job's real end`, async () => {
    const id = `ub-boot-${state}`;
    const orphan = `ub-old-${state}`;
    beginBoardSpan({ name: 'upgrade', job: orphan });
    beginBoardSpan({ name: 'upgrade', job: id });
    const endedAt = new Date(Date.now() + 5000).toISOString();
    const over = state === 'failed' ? { failedStep: 'laptop_start', error: 'x' } : {};
    await jobWith(id, state, { startedAt: new Date().toISOString(), endedAt, ...over });
    const mine = upgradeSpans(id).find((s) => s.name === 'upgrade');
    assert.equal(mine.outcome, state === 'done' ? 'ok' : 'failed');
    assert.equal(mine.endedAt, endedAt, 'the end is the job end, not boot time');
    assert.ok(mine.ms >= 4000 && mine.ms <= 6000, `length follows the job end, got ${mine.ms}`);
    if (state === 'failed') assert.equal(mine.meta.failedStep, 'laptop_start');
    const old = upgradeSpans(orphan).find((s) => s.name === 'upgrade');
    assert.equal(old.outcome, 'interrupted', 'an older job open span is not stretched to this boot');
    assert.equal(old.ms, 0);
  });
}

test('a cut job closes only its own span by name, not another job', async () => {
  beginBoardSpan({ name: 'upgrade', job: 'ub-other' });
  const at = new Date().toISOString();
  beginBoardSpan({ name: 'upgrade', job: 'ub-cut2' });
  await jobWith('ub-cut2', 'running', { startedAt: at, step: 'runner_code', steps: [] });
  assert.equal(upgradeSpans('ub-cut2').find((s) => s.name === 'upgrade').outcome, 'interrupted');
  assert.equal(upgradeSpans('ub-cut2').find((s) => s.name === 'upgrade').meta.failedStep, 'runner_code');
  assert.equal(upgradeSpans('ub-other').find((s) => s.name === 'upgrade').endedAt, null);
});

test('a restart whose board is still alive after the spawn closes its span as error', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const savedAlive = restartHooks.stillAliveMs;
  Object.assign(restartHooks, {
    stillAliveMs: 20,
    platform: () => 'win32',
    upgrading: () => false,
    busy: () => [],
    closeSessions: async () => {},
    flush: () => {},
    spawnRestart: () => {},
  });
  try {
    const before = boardSpans().filter((s) => s.name === 'restart').length;
    const r = await post('/api/restart');
    assert.equal(r.status, 202);
    const until = Date.now() + 3000;
    let mine;
    while (Date.now() < until) {
      mine = boardSpans().filter((s) => s.name === 'restart').slice(before)[0];
      if (mine?.endedAt) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.equal(mine.outcome, 'error');
    assert.match(mine.meta.error, /still running/);
    // Nothing else records the failure: the web reads "still answering" as "it came back".
    const lines = errors.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith('[restart]'));
    assert.deepEqual(lines, ['[restart] restart.ps1 no detuvo el tablero en 20 ms; ver hfs-monitor.restart.log']);
  } finally {
    restartHooks.stillAliveMs = savedAlive;
  }
});
