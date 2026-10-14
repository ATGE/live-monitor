// Timings recorded by the pipeline: phase spans around the real body of
// `runPipeline`, steps, and the waits (infra backoff, e2e gate, slot).
//
// The body runs for real with fake steps (the `resume.test.mjs` pattern), so
// what is checked is what an actual run would leave in `task.timings`.
import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { settings } = await import('../src/settings.js');
const { saveProjects } = await import('../src/projects.js');
const metrics = await import('../src/metrics.js');
const pipeline = await import('../src/pipeline.js');

before(() => {
  settings.update({ autoStart: false, browserQa: true, maxActiveTasks: 1 });
  saveProjects([
    { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
  ]);
});
after(() => {
  pipeline.retryHooks.backoff = [10_000, 30_000, 90_000];
});

const HEAD = '5835cde9aa11bb22cc33';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const issueOf = () => ({ number: 1, title: 'Something is broken', labels: [], body: '' });

let n = 12000;
function taskOf(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  return Object.assign(task, {
    branch: `fix/${n}-x`, worktreePath: `C:/wt/${n}`, complexity: 'simple', machine: 'local', ...fields,
  });
}

/** The steps `runPipeline` asks for outside itself; every phase takes a few ms. */
function stubs(over = {}) {
  const ms = 15;
  const step = (fn) => async (...args) => { await sleep(ms); return fn?.(...args); };
  return {
    getIssue: async () => issueOf(),
    classifyIssue: async () => ({ state: 'assigned', branches: [], prs: [], reasons: [] }),
    isProjectWorktree: async () => true,
    ensureWorktree: step(),
    bringMain: async () => ({ merged: false, behind: 0, conflicts: [], blocked: null }),
    headCommit: async () => HEAD,
    hasCommits: async () => false,
    continuationContext: async () => '',
    triagePhase: step(),
    prepareDependencies: async () => ({ ok: true }),
    fixPhase: step(),
    testPhase: step(),
    browserQaPhase: step(),
    gapsPhase: step(),
    composePrBody: step(),
    draftPrPhase: step((task) => { task.prNumber = 99; task.prUrl = 'https://github.com/x/pull/99'; }),
    generateDemoSteps: step(),
    ...over,
  };
}

/** A step stub that takes `ms`, for tests that need a deterministic race against the others. */
const slowStep = (ms, fn) => async (...args) => { await sleep(ms); return fn?.(...args); };
/** The demo (one fast step, 5 ms) must end well before the PR steps (40 + 40 ms): margin about 75 ms. */
const demoFirst = () => ({
  generateDemoSteps: slowStep(5),
  composePrBody: slowStep(40),
  draftPrPhase: slowStep(40, (task) => { task.prNumber = 99; task.prUrl = 'https://github.com/x/pull/99'; }),
});

const spansOf = (task, kind) => task.timings.filter((s) => s.kind === kind);
const names = (list) => list.map((s) => s.name);

// ---------------------------------------------------------------------------
// Phase spans

test('a full run leaves one phase span per phase it ran, contiguous and summing to the run', async () => {
  const task = taskOf();
  const t0 = Date.now();
  await pipeline.runPipeline(task, 'assigned', stubs(demoFirst()));
  const t1 = Date.now();

  const phases = spansOf(task, 'phase');
  // The demo runs beside the PR step and, here, ends first: it leaves no phase of its own.
  assert.deepEqual(names(phases), ['assigned', 'worktree', 'triage', 'fixing', 'testing', 'pr']);
  assert.ok(phases.every((s) => s.endedAt && s.outcome === 'ok' && s.ms >= 0), JSON.stringify(phases));

  // Contiguous: each phase starts where the previous ended, give or take a clock tick.
  for (let i = 1; i < phases.length; i += 1) {
    const gap = Date.parse(phases[i].startedAt) - Date.parse(phases[i - 1].endedAt);
    assert.ok(gap >= 0 && gap < 50, `gap of ${gap} ms before ${phases[i].name}`);
  }
  const sum = phases.reduce((acc, s) => acc + s.ms, 0);
  assert.ok(Math.abs(sum - (t1 - t0)) < 1000, `phases add up to ${sum} ms, the run took ${t1 - t0}`);
  assert.equal(metrics.summarize(task).runMs, sum);
  assert.equal(task.timings.every((s) => s.meta.cycle === 1), true, 'every span of a first-cycle task carries cycle 1');
});

test('browser_qa and fix_gaps are phase spans of their own, between testing and pr', async () => {
  const task = taskOf({ browserQa: 'on', fixGaps: 'on' });
  await pipeline.runPipeline(task, 'assigned', stubs(demoFirst()));
  assert.deepEqual(names(spansOf(task, 'phase')), ['assigned', 'worktree', 'triage', 'fixing', 'testing', 'browser_qa', 'fix_gaps', 'pr']);
  assert.ok(spansOf(task, 'phase').every((s) => s.endedAt), 'nothing is left open');
});

test('a new cycle stamps its spans with the next cycle, even after cycleStartedAt is nulled', async () => {
  const task = taskOf();
  await pipeline.runPipeline(task, 'assigned', stubs());
  pipeline.beginNewCycle(task, 'test');
  assert.equal(task.metricsCycle, 2);
  assert.equal(task.metricsCycleStartedAt, task.cycleStartedAt);
  const before = task.timings.length;
  // The real draft PR step nulls `cycleStartedAt`; the metrics cycle must survive that.
  task.cycleStartedAt = null;
  await pipeline.runPipeline(task, 'assigned', stubs());
  const fresh = task.timings.slice(before);
  assert.ok(fresh.length > 0);
  assert.ok(fresh.every((s) => s.meta.cycle === 2), JSON.stringify(fresh.map((s) => [s.name, s.meta.cycle])));
  assert.ok(task.timings.slice(0, before).every((s) => s.meta.cycle === 1));
});

test('beginNewCycle clears a stale slot wait stamp', () => {
  const task = taskOf({ slotWaitSince: '2026-01-01T00:00:00.000Z' });
  pipeline.beginNewCycle(task, 'test');
  assert.equal(task.slotWaitSince, null);
});

test('the demo, the PR body and the draft PR are steps of their own', async () => {
  const task = taskOf();
  await pipeline.runPipeline(task, 'assigned', stubs());
  assert.deepEqual(names(spansOf(task, 'step')), ['demo_steps', 'compose_pr_body', 'draft_pr']);
  assert.ok(spansOf(task, 'step').every((s) => s.ms >= 10 && s.outcome === 'ok'));
});

test('a run resumed at «pr» has one phase span for the whole PR step, not two', async () => {
  const task = taskOf({ phase: 'pr', fixedAt: HEAD, e2ePassedAt: HEAD, qa: { ui: false }, prBody: 'Closes #1' });
  // A deliberately slow demo (200 ms) outlives the PR steps (15 ms: the body is already written, so only the draft step runs), so it leaves its `demo` tail phase.
  await pipeline.runPipeline(task, 'pr', stubs({ generateDemoSteps: slowStep(200) }));
  const phases = names(spansOf(task, 'phase'));
  assert.deepEqual(phases, ['pr', 'demo'], phases.join());
});

test('an error closes the phase it happened in as «error» and is rethrown untouched', async () => {
  const task = taskOf();
  const boom = new Error('triage exploded');
  await assert.rejects(pipeline.runPipeline(task, 'assigned', stubs({ triagePhase: async () => { throw boom; } })), (e) => e === boom);
  const phases = spansOf(task, 'phase');
  assert.deepEqual(names(phases), ['assigned', 'worktree', 'triage']);
  assert.equal(phases.at(-1).outcome, 'error');
  assert.ok(phases.every((s) => s.endedAt), 'nothing is left open');
});

test('the quota closes the phase as «parked»', async () => {
  const task = taskOf();
  await assert.rejects(
    pipeline.runPipeline(task, 'assigned', stubs({ fixPhase: async () => { throw new pipeline.QuotaExhausted('fixing'); } })),
    /./,
  );
  assert.equal(spansOf(task, 'phase').at(-1).name, 'fixing');
  assert.equal(spansOf(task, 'phase').at(-1).outcome, 'parked');
});

test('a task turned manual stops at the boundary and the phase says «paused»', async () => {
  const task = taskOf({ mode: 'manual' });
  await pipeline.runPipeline(task, 'assigned', stubs());
  const phases = spansOf(task, 'phase');
  assert.equal(phases.at(-1).outcome, 'paused');
  assert.ok(phases.every((s) => s.endedAt));
});

test('timing never changes the outcome: a recorder that throws on persist is ignored', async () => {
  const task = taskOf();
  const saved = metrics.metricsHooks.persist;
  metrics.metricsHooks.persist = () => { throw new Error('disk full'); };
  try {
    await pipeline.runPipeline(task, 'assigned', stubs());
  } finally {
    metrics.metricsHooks.persist = saved;
  }
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.phase, null);
});

// ---------------------------------------------------------------------------
// Steps

test('prepareDependencies is a step span wherever it is called from', async () => {
  const task = taskOf();
  const machine = { name: 'fake', path: path.posix, fs: { exists: async () => true }, shell: async () => ({ ok: true, stdout: '', stderr: '' }) };
  const r = await pipeline.prepareDependencies(task, machine, 'pre_fix');
  assert.equal(r.ok, true);
  const [s] = spansOf(task, 'step');
  assert.equal(s.name, 'prepare_dependencies');
  assert.equal(s.outcome, 'ok');
  assert.equal(s.meta.ok, true);
  assert.equal(s.meta.when, 'pre_fix', 'the call site is told apart in meta');
});

test('a step that hits the quota closes as «parked», like the phase around it', async () => {
  const task = taskOf();
  await assert.rejects(
    pipeline.runPipeline(task, 'assigned', stubs({ draftPrPhase: async () => { throw new pipeline.QuotaExhausted('pr'); } })),
    /./,
  );
  const draft = spansOf(task, 'step').find((s) => s.name === 'draft_pr');
  assert.equal(draft.outcome, 'parked');
});

// ---------------------------------------------------------------------------
// Waits

test('an infra retry leaves an «infra_backoff» wait with its attempt and the phase it happened in', async () => {
  pipeline.retryHooks.backoff = [20];
  const task = taskOf();
  metrics.begin(task, { kind: 'phase', name: 'pr' });
  let calls = 0;
  const value = await pipeline.withInfraRetries(task, 'pr', 'el push', async () => {
    calls += 1;
    if (calls === 1) throw new Error('connect ECONNREFUSED 127.0.0.1');
    return 'pushed';
  });
  assert.equal(value, 'pushed');
  const [wait] = spansOf(task, 'wait');
  assert.equal(wait.name, 'infra_backoff');
  assert.equal(wait.attempt, 1);
  assert.equal(wait.meta.within, 'pr');
  assert.ok(wait.ms >= 15, `the span measured the real wait: ${wait.ms} ms`);
  assert.equal(wait.outcome, 'ok');
});

/** A machine whose suite takes `ms`, on a gate shared by name. */
function suiteMachine(ms) {
  return {
    name: 'gate-box',
    path: path.posix,
    fs: { exists: async () => true },
    portFree: async () => true,
    shell: async () => { await sleep(ms); return { ok: true, code: 0, stdout: '', stderr: '' }; },
  };
}

test('the e2e gate wait is a span: the second suite on a machine queues behind the first', async () => {
  settings.update({ maxActiveTasks: 1 });
  const first = taskOf();
  const second = taskOf();
  for (const t of [first, second]) metrics.begin(t, { kind: 'phase', name: 'testing' });
  const machine = suiteMachine(120);
  await Promise.all([
    pipeline.PIPELINE_STEPS.testPhase(first, { machine }),
    pipeline.PIPELINE_STEPS.testPhase(second, { machine }),
  ]);
  const [a] = spansOf(first, 'wait');
  const [b] = spansOf(second, 'wait');
  assert.equal(a.name, 'e2e_gate');
  assert.equal(b.name, 'e2e_gate');
  assert.equal(a.meta.within, 'testing');
  assert.ok(a.ms < 60, `the first one did not wait: ${a.ms} ms`);
  assert.ok(b.ms >= 90, `the second one waited for the suite ahead: ${b.ms} ms`);
  assert.ok(a.endedAt && b.endedAt);
});

test('a task waiting in «assigned» for a slot gets a «slot» wait when it finally starts', async () => {
  const saved = process.env.HFSMON_NO_AUTOSTART;
  delete process.env.HFSMON_NO_AUTOSTART;
  const savedRun = pipeline.pipelineHooks.run;
  const started = [];
  // Leaves the queue, as a real run does: a stub that kept the task `assigned`
  // would be started again by the `tick` of its own `finally`, for ever.
  pipeline.pipelineHooks.run = async (task) => { started.push(task.issue); store.setState(task, 'waiting_approval'); };
  settings.update({ autoStart: true, maxActiveTasks: 1 });
  try {
    // Runs of the tests above leave tasks in an active state; they hold no slot here.
    for (const t of store.all()) if (['worktree', 'triage', 'fixing', 'testing', 'browser_qa', 'fix_gaps'].includes(t.state)) t.state = 'error';
    const busy = taskOf({ state: 'fixing' });
    const queued = taskOf({ state: 'assigned', classified: true });
    pipeline.tick();
    assert.deepEqual(started, [], 'no free slot: nothing starts');
    assert.ok(queued.slotWaitSince, 'the queue noted since when it waits');
    const since = queued.slotWaitSince;
    await sleep(30);
    pipeline.tick();
    assert.equal(queued.slotWaitSince, since, 'noted once, not on every tick');

    busy.state = 'done';
    pipeline.tick();
    await sleep(10);
    assert.deepEqual(started, [queued.issue]);
    const [wait] = spansOf(queued, 'wait');
    assert.equal(wait.name, 'slot');
    assert.equal(wait.meta.within, null);
    assert.equal(wait.startedAt, since);
    assert.ok(wait.ms >= 30, `${wait.ms} ms`);
    assert.equal(queued.slotWaitSince, null);
  } finally {
    pipeline.pipelineHooks.run = savedRun;
    settings.update({ autoStart: false });
    process.env.HFSMON_NO_AUTOSTART = saved;
  }
});
