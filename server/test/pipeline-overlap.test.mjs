// Overlapped steps of `runPipeline` (#6): the dependency install runs while the
// triage session works, and the demo steps are written while the PR body is
// composed and the PR is opened.
//
// The real body runs with fake steps that sleep for real (60-150 ms) and log
// `<name>:start` / `<name>:end`, so what is asserted is the order the events
// happened in and, with a wide margin, that the total is close to the longest
// step rather than the sum. Written to be red against the sequential body.
//
// Contract this file pins (see the plan of #6):
// - the install runs as `prepareDependencies(task, undefined, 'during_triage')`,
//   started after `bringMain` and awaited on every way out of the triage and
//   before `enter('fixing')`; a failed early install is retried once as
//   `'pre_fix'` before `dependencyError`;
// - the demo runs as a `demo_steps` step span (`meta.overlap: true`) launched
//   before `compose_pr_body`; phases stay contiguous, the demo phase exists
//   only if the demo outlives the PR; `task.phase = null` when both are done;
// - `task.demoAt = HEAD` marks a finished demo and gates it on resume;
// - `config.pipeline.overlapInstall` / `overlapDemo` (default on, `false` = off).
import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
  delete config.pipeline;
});

const HEAD = '5835cde9aa11bb22cc33';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const issueOf = () => ({ number: 1, title: 'Something is broken', labels: [], body: '' });

let n = 14000;
function taskOf(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  return Object.assign(task, {
    branch: `fix/${n}-x`, worktreePath: `C:/wt/${n}`, complexity: 'simple', machine: 'local', ...fields,
  });
}

/** A task parked at the PR: the fix, tests and QA are paid for on HEAD. */
const atPr = (fields = {}) => taskOf({ phase: 'pr', fixedAt: HEAD, e2ePassedAt: HEAD, qa: { ui: false }, ...fields });

/**
 * Fake steps that log what happened. `plan` gives each step's duration;
 * `over` replaces whole steps. Every timed step logs `<name>:start`/`:end`,
 * the install as `deps.<when>:start`/`:end`.
 */
function rig(plan = {}, over = {}) {
  const ev = [];
  const at = {};
  const mark = (name) => { ev.push(name); at[name] = performance.now(); };
  const ms = { bringMain: 5, triage: 20, install: 20, fix: 5, compose: 20, draft: 20, demo: 20, ...plan };
  const timed = (name, dur, fn) => async (...args) => {
    mark(`${name}:start`);
    try {
      await sleep(dur);
      return await fn?.(...args);
    } finally {
      mark(`${name}:end`);
    }
  };
  const whens = [];
  const steps = {
    ev,
    at,
    whens,
    getIssue: async () => issueOf(),
    classifyIssue: async () => ({ state: 'assigned', branches: [], prs: [], reasons: [] }),
    isProjectWorktree: async () => true,
    ensureWorktree: async () => {},
    bringMain: timed('bringMain', ms.bringMain, async () => ({ merged: false, behind: 0, conflicts: [], blocked: null })),
    headCommit: async () => HEAD,
    hasCommits: async () => false,
    continuationContext: async () => '',
    triagePhase: timed('triage', ms.triage),
    // Opens the same step span the real `prepareDependencies` does, so a test can
    // tell whether the run left it open when it gave up.
    prepareDependencies: async (task, machine, when) => {
      whens.push(when);
      // The pre-fix install, early or not, is the slow one; the later ones are quick.
      const early = when === 'during_triage' || when === 'pre_fix';
      return metrics.span(task, { kind: 'step', name: 'prepare_dependencies', when }, () => timed(`deps.${when}`, early ? ms.install : 2, async () => ({ ok: true }))());
    },
    fixPhase: timed('fix', ms.fix),
    testPhase: async () => {},
    browserQaPhase: async () => {},
    gapsPhase: async () => {},
    composePrBody: timed('compose', ms.compose),
    draftPrPhase: timed('draft', ms.draft, (task) => { task.prNumber = 99; task.prUrl = 'https://github.com/x/pull/99'; }),
    generateDemoSteps: timed('demo', ms.demo, (task) => { task.demoSteps = ['step 1']; }),
    ...over,
  };
  return steps;
}

const idx = (steps, e) => {
  const i = steps.ev.indexOf(e);
  assert.ok(i >= 0, `${e} never happened: ${steps.ev.join(' ')}`);
  return i;
};
/** `a` happened, and before `b` did. */
const before_ = (steps, a, b) => assert.ok(idx(steps, a) < idx(steps, b), `${a} should come before ${b}: ${steps.ev.join(' ')}`);

const spansOf = (task, kind) => task.timings.filter((s) => s.kind === kind);
const names = (list) => list.map((s) => s.name);

/** Run `fn` with the overlap flags set, and restore the config. */
async function withFlags(flags, fn) {
  config.pipeline = flags;
  try {
    return await fn();
  } finally {
    delete config.pipeline;
  }
}

/** Runs `fn` making sure no rejection is left unhandled. */
async function noStrayRejections(fn) {
  const stray = [];
  const watcher = (e) => stray.push(e);
  process.on('unhandledRejection', watcher);
  try {
    const value = await fn();
    await sleep(60);
    assert.deepEqual(stray.map((e) => e?.message ?? String(e)), [], 'no unhandled rejection');
    return value;
  } finally {
    process.off('unhandledRejection', watcher);
  }
}

// ---------------------------------------------------------------------------
// Install during the triage

test('the install starts after bringMain, runs during the triage and ends before the fix', async () => {
  const task = taskOf();
  const steps = rig({ triage: 150, install: 140 });
  await pipeline.runPipeline(task, 'assigned', steps);

  before_(steps, 'bringMain:end', 'deps.during_triage:start');
  before_(steps, 'triage:start', 'deps.during_triage:end');
  before_(steps, 'deps.during_triage:start', 'triage:end');
  before_(steps, 'deps.during_triage:end', 'fix:start');
  before_(steps, 'triage:end', 'fix:start');
  // The install already done and green is not repeated before the fix.
  assert.equal(steps.whens.includes('pre_fix'), false, steps.whens.join(','));
  assert.equal(steps.whens[0], 'during_triage');
  // Close to the longest of the two (150 ms), well under the sum (290 ms): the bound
  // sits 70 ms from each, so a loaded clock does not flip it (the ordering above is the proof).
  const window = steps.at['fix:start'] - steps.at['triage:start'];
  assert.ok(window < 220, `triage + install took ${Math.round(window)} ms`);
});

test('a slow install holds the fix back: it never starts before the install ends', async () => {
  const task = taskOf();
  const steps = rig({ triage: 30, install: 120 });
  await pipeline.runPipeline(task, 'assigned', steps);
  before_(steps, 'triage:end', 'deps.during_triage:end');
  before_(steps, 'deps.during_triage:end', 'fix:start');
});

test('a run resumed at «fixing» skips the triage and keeps the sequential pre-fix install', async () => {
  const task = taskOf({ phase: 'fixing' });
  const steps = rig();
  await pipeline.runPipeline(task, 'fixing', steps);
  assert.equal(steps.ev.includes('triage:start'), false);
  assert.equal(steps.whens[0], 'pre_fix', steps.whens.join(','));
  before_(steps, 'deps.pre_fix:end', 'fix:start');
});

test('an early install that fails is retried once before the fix, as «pre_fix»', async () => {
  const task = taskOf();
  const steps = rig({}, {});
  // First call fails (the one during the triage), the retry is green.
  steps.prepareDependencies = async (t, m, when) => {
    steps.whens.push(when);
    return steps.whens.length === 1 ? { ok: false, stage: 'install', tail: 'ENETUNREACH' } : { ok: true };
  };
  await pipeline.runPipeline(task, 'assigned', steps);
  assert.deepEqual(steps.whens, ['during_triage', 'pre_fix', 'post_fix']);
  assert.ok(steps.ev.includes('fix:start'));
});

test('an install that fails twice stops the run before the fix, as it does today', async () => {
  const task = taskOf();
  const steps = rig();
  steps.prepareDependencies = async (t, m, when) => { steps.whens.push(when); return { ok: false, stage: 'install', tail: 'boom' }; };
  await assert.rejects(pipeline.runPipeline(task, 'assigned', steps), /dependencies/i);
  assert.equal(steps.ev.includes('fix:start'), false);
  assert.deepEqual(steps.whens, ['during_triage', 'pre_fix']);
});

test('a triage that fails waits for the install in flight and rethrows its own error', async () => {
  const task = taskOf();
  const boom = new Error('triage exploded');
  const steps = rig({ install: 80 }, { triagePhase: async () => { steps.ev.push('triage:start'); await sleep(20); throw boom; } });
  await noStrayRejections(async () => {
    await assert.rejects(pipeline.runPipeline(task, 'assigned', steps), (e) => e === boom);
    // Not orphaned: the install ended before the run gave up.
    assert.ok(steps.ev.includes('deps.during_triage:end'), steps.ev.join(' '));
  });
  assert.equal(steps.ev.includes('fix:start'), false);
});

test('a triage that fails while the install also fails leaves no unhandled rejection', async () => {
  const task = taskOf();
  const boom = new Error('triage exploded');
  const steps = rig({}, {
    triagePhase: async () => { await sleep(10); throw boom; },
    prepareDependencies: async (t, m, when) => {
      steps.whens.push(when);
      steps.ev.push(`deps.${when}:start`);
      await sleep(30);
      throw new Error('install exploded');
    },
  });
  await noStrayRejections(async () => {
    await assert.rejects(pipeline.runPipeline(task, 'assigned', steps), (e) => e === boom);
  });
  assert.ok(steps.ev.includes('deps.during_triage:start'), steps.ev.join(' '));
});

test('the quota in the triage parks on «triage» after the install in flight ends', async () => {
  const task = taskOf();
  const steps = rig({ install: 80 }, { triagePhase: async () => { steps.ev.push('triage:start'); await sleep(20); throw new pipeline.QuotaExhausted('triage'); } });
  await noStrayRejections(async () => {
    await assert.rejects(pipeline.runPipeline(task, 'assigned', steps), (e) => e instanceof pipeline.QuotaExhausted && e.resumeFrom === 'triage');
    assert.ok(steps.ev.includes('deps.during_triage:end'), steps.ev.join(' '));
  });
});

test('a task turned manual during the triage pauses only after the install in flight ends', async () => {
  const task = taskOf();
  const steps = rig({ install: 80 }, {
    triagePhase: async (t) => { steps.ev.push('triage:start'); await sleep(20); t.mode = 'manual'; steps.ev.push('triage:end'); },
  });
  await noStrayRejections(async () => {
    await pipeline.runPipeline(task, 'assigned', steps);
    assert.ok(steps.ev.includes('deps.during_triage:end'), steps.ev.join(' '));
  });
  assert.equal(steps.ev.includes('fix:start'), false);
  assert.equal(spansOf(task, 'phase').at(-1).outcome, 'paused');
});

test('a manual task pauses before the triage without starting any install', async () => {
  const task = taskOf({ mode: 'manual' });
  const steps = rig();
  await pipeline.runPipeline(task, 'assigned', steps);
  assert.deepEqual(steps.whens, []);
});

test('with overlapInstall off the install runs after the triage, as before', async () => {
  const task = taskOf();
  const steps = rig({ triage: 40, install: 40 });
  await withFlags({ overlapInstall: false }, () => pipeline.runPipeline(task, 'assigned', steps));
  assert.equal(steps.whens[0], 'pre_fix', steps.whens.join(','));
  before_(steps, 'triage:end', 'deps.pre_fix:start');
  before_(steps, 'deps.pre_fix:end', 'fix:start');
});

const logLines = (task, phase) => task.log.filter((l) => l.phase === phase).map((l) => l.line);

test('a run whose fix is already done does not start an install next to the triage', async () => {
  // Resumed past the fix with no complexity on record: the triage runs, but the
  // fix is not ahead, so there is nothing for an early install to prepare.
  const task = taskOf({ phase: 'testing', complexity: null, fixedAt: HEAD, e2ePassedAt: HEAD, qa: { ui: false } });
  const steps = rig();
  await pipeline.runPipeline(task, 'testing', steps);
  assert.ok(steps.ev.includes('triage:start'), steps.ev.join(' '));
  assert.deepEqual(steps.whens, [], steps.whens.join(','));
});

test('an early install that throws, with the triage fine, is retried as «pre_fix» and leaves no stray rejection', async () => {
  const task = taskOf();
  const steps = rig();
  steps.prepareDependencies = async (t, m, when) => {
    steps.whens.push(when);
    if (when === 'during_triage') {
      await sleep(15);
      throw new Error('install exploded');
    }
    return { ok: true };
  };
  await noStrayRejections(() => pipeline.runPipeline(task, 'assigned', steps));
  assert.deepEqual(steps.whens, ['during_triage', 'pre_fix', 'post_fix']);
  assert.ok(steps.ev.includes('fix:start'), steps.ev.join(' '));
  // And the run says it retried, which is what the line is for.
  assert.ok(logLines(task, 'deps').some((l) => /retried before the fix/.test(l)), logLines(task, 'deps').join(' | '));
});

test('a green early install is not announced as retried', async () => {
  const task = taskOf();
  await pipeline.runPipeline(task, 'assigned', rig());
  assert.equal(logLines(task, 'deps').some((l) => /retried before the fix/.test(l)), false);
});

test('a triage that ends first says it is waiting for the install, and the card says so while it waits', async () => {
  const task = taskOf();
  const boom = new Error('triage exploded');
  let during;
  const steps = rig({ install: 80 }, { triagePhase: async () => { await sleep(10); throw boom; } });
  const plain = steps.prepareDependencies;
  steps.prepareDependencies = async (t, m, when) => {
    const done = await plain(t, m, when);
    during = t.waitingOn;
    return done;
  };
  await noStrayRejections(async () => {
    await assert.rejects(pipeline.runPipeline(task, 'assigned', steps), (e) => e === boom);
  });
  assert.equal(during, 'install', 'while the run waits, the task says what for');
  assert.equal(task.waitingOn, null, 'and the note is gone when the wait ends');
  assert.ok(logLines(task, 'deps').some((l) => /triage finished with the install still running/.test(l)), logLines(task, 'deps').join(' | '));
});

test('a triage that ends after the install leaves no waiting note at all', async () => {
  const task = taskOf();
  let during = 'unset';
  const steps = rig({ triage: 60, install: 10 });
  steps.triagePhase = async (t) => { await sleep(60); during = t.waitingOn; };
  await pipeline.runPipeline(task, 'assigned', steps);
  assert.equal(during ?? null, null);
  assert.equal(task.waitingOn ?? null, null);
  assert.equal(logLines(task, 'deps').some((l) => /triage finished with the install still running/.test(l)), false);
});

test('a new task is born with waitingOn null, not undefined', () => {
  assert.equal(taskOf().waitingOn, null);
});

test('the waiting note is persisted when it is set and again when it is cleared', async () => {
  const task = taskOf();
  const seen = [];
  const touch = store.touch;
  store.touch = function patched(t, ...rest) {
    if (t === task) seen.push(t.waitingOn ?? null);
    return touch.call(this, t, ...rest);
  };
  try {
    const steps = rig({ install: 80 }, { triagePhase: async () => { await sleep(10); throw new Error('triage exploded'); } });
    await noStrayRejections(async () => {
      await assert.rejects(pipeline.runPipeline(task, 'assigned', steps), /triage exploded/);
    });
  } finally {
    store.touch = touch;
  }
  const on = seen.indexOf('install');
  assert.ok(on >= 0, `no touch carried the note: ${JSON.stringify(seen)}`);
  assert.ok(seen.slice(on + 1).includes(null), `no touch after the note was cleared: ${JSON.stringify(seen)}`);
  assert.equal(task.waitingOn, null);
});

test('a log that throws while the wait is announced neither skips the wait nor leaves the note set', async () => {
  const task = taskOf();
  const addLog = store.addLog;
  store.addLog = function patched(t, phase, line, ...rest) {
    if (t === task && /triage finished with the install still running/.test(String(line))) throw new Error('disk full');
    return addLog.call(this, t, phase, line, ...rest);
  };
  const steps = rig({ install: 80 }, { triagePhase: async () => { await sleep(10); throw new Error('triage exploded'); } });
  try {
    await noStrayRejections(async () => {
      // The error of the triage is the one that surfaces, not the one of the log.
      await assert.rejects(pipeline.runPipeline(task, 'assigned', steps), /triage exploded/);
    });
  } finally {
    store.addLog = addLog;
  }
  assert.ok(steps.ev.includes('deps.during_triage:end'), `the install was not awaited: ${steps.ev.join(' ')}`);
  assert.equal(task.waitingOn ?? null, null);
});

test('a project that disappears before the triage stops the run before any triage session starts', async () => {
  const task = taskOf();
  const entry = { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} };
  const steps = rig();
  const bring = steps.bringMain;
  // The project is unregistered right after the last step that runs before the triage.
  steps.bringMain = async (...args) => {
    const out = await bring(...args);
    saveProjects([{ ...entry, id: 'elsewhere', name: 'elsewhere' }]);
    return out;
  };
  try {
    await noStrayRejections(async () => {
      await assert.rejects(pipeline.runPipeline(task, 'assigned', steps), /no project is registered/);
    });
  } finally {
    saveProjects([entry]);
  }
  assert.equal(steps.ev.includes('triage:start'), false, 'no triage session was left running with no owner');
  assert.deepEqual(steps.whens, []);
});

test('a HEAD read that fails at the start of the PR step is recorded against «pr», not the phase before', async () => {
  const task = taskOf({ phase: 'testing', fixedAt: HEAD, e2ePassedAt: HEAD, qa: { ui: false } });
  const steps = rig();
  let reads = 0;
  // The first read is the tests gate; the second is the demo's, before the PR.
  steps.headCommit = async () => {
    reads += 1;
    if (reads >= 2) throw new Error('websocket closed');
    return HEAD;
  };
  await assert.rejects(pipeline.runPipeline(task, 'testing', steps), /websocket closed/);
  assert.equal(reads, 2, 'it failed on the PR step\'s read');
  assert.equal(task.phase, 'pr', 'Retry resumes at the PR, not at a QA or a fix already paid for');
});

// ---------------------------------------------------------------------------
// Demo next to the PR

test('the demo is written while the PR body is composed and the PR opened', async () => {
  const task = atPr();
  const steps = rig({ compose: 80, draft: 80, demo: 200 });
  const t0 = performance.now();
  await pipeline.runPipeline(task, 'pr', steps);
  const total = performance.now() - t0;

  before_(steps, 'demo:start', 'compose:end');
  before_(steps, 'demo:start', 'draft:end');
  before_(steps, 'compose:end', 'draft:start');
  // Close to the demo alone (200 ms), well under the sum (360 ms): the bound sits 80 ms
  // from each, so a loaded clock does not flip it (the ordering above is the proof).
  assert.ok(total < 280, `the PR step took ${Math.round(total)} ms`);
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.phase, null);
  assert.equal(task.prNumber, 99);
  assert.equal(task.demoAt, HEAD);
});

test('while only the demo is left the card says «demo», and the run ends with no phase', async () => {
  const task = atPr();
  let seen = null;
  const steps = rig({ compose: 20, draft: 20, demo: 120 }, {});
  const demo = steps.generateDemoSteps;
  steps.generateDemoSteps = async (t, i) => {
    const r = await demo(t, i);
    seen = { phase: t.phase, state: t.state };
    return r;
  };
  await pipeline.runPipeline(task, 'pr', steps);
  assert.deepEqual(seen, { phase: 'demo', state: 'pr_draft' });
  assert.equal(task.phase, null);
});

test('with overlapDemo off the demo starts after the PR is open, in a phase of its own', async () => {
  const task = atPr();
  const steps = rig({ compose: 30, draft: 30, demo: 30 });
  await withFlags({ overlapDemo: false }, () => pipeline.runPipeline(task, 'pr', steps));
  before_(steps, 'draft:end', 'demo:start');
  assert.deepEqual(names(spansOf(task, 'phase')), ['pr', 'demo']);
});

test('a demo that fails in its own way never stops the PR', async () => {
  const task = atPr();
  const steps = rig({ compose: 40, draft: 40 }, {
    generateDemoSteps: async () => { steps.ev.push('demo:start'); await sleep(20); throw new Error('no data to demo'); },
  });
  await pipeline.runPipeline(task, 'pr', steps);
  before_(steps, 'demo:start', 'draft:end');
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.phase, null);
  assert.equal(task.prNumber, 99);
  assert.notEqual(task.demoAt, HEAD, 'a demo that failed is not a demo that is done');
  assert.ok(JSON.stringify(task.log).includes('no data to demo'), 'the failure is logged');
});

test('a PR that fails keeps the demo that finished and rethrows its own error', async () => {
  const task = atPr();
  const boom = new Error('push rejected');
  const steps = rig({ compose: 10, demo: 80 }, { draftPrPhase: async () => { steps.ev.push('draft:start'); await sleep(20); throw boom; } });
  await noStrayRejections(async () => {
    await assert.rejects(pipeline.runPipeline(task, 'pr', steps), (e) => e === boom);
  });
  assert.ok(steps.ev.includes('demo:end'), steps.ev.join(' '));
  assert.deepEqual(task.demoSteps, ['step 1']);
  assert.equal(task.demoAt, HEAD);
  assert.equal(task.phase, 'pr', 'a retry resumes at the PR');
});

test('the quota in the PR parks on «pr» after the demo ends, and the demo is kept', async () => {
  const task = atPr();
  const steps = rig({ compose: 10, demo: 80 }, { draftPrPhase: async () => { steps.ev.push('draft:start'); await sleep(20); throw new pipeline.QuotaExhausted('pr'); } });
  await noStrayRejections(async () => {
    await assert.rejects(pipeline.runPipeline(task, 'pr', steps), (e) => e instanceof pipeline.QuotaExhausted && e.resumeFrom === 'pr');
  });
  assert.ok(steps.ev.includes('demo:end'), steps.ev.join(' '));
  assert.equal(task.demoAt, HEAD);
  assert.equal(task.phase, 'pr');
});

test('the quota in the demo does not interrupt the PR; it parks on «demo» once the PR is open', async () => {
  const task = atPr();
  const steps = rig({ compose: 40, draft: 40 }, {
    generateDemoSteps: async () => { steps.ev.push('demo:start'); await sleep(20); throw new pipeline.QuotaExhausted('demo'); },
  });
  await noStrayRejections(async () => {
    await assert.rejects(pipeline.runPipeline(task, 'pr', steps), (e) => e instanceof pipeline.QuotaExhausted && e.resumeFrom === 'demo');
  });
  before_(steps, 'demo:start', 'draft:end');
  assert.ok(steps.ev.includes('draft:end'), 'the PR was opened');
  assert.equal(task.prNumber, 99, 'the result of the PR step is not lost');
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.phase, 'demo');
  assert.notEqual(task.demoAt, HEAD);
});

test('the quota in both steps parks on «pr»', async () => {
  const task = atPr();
  const steps = rig({ compose: 10 }, {
    draftPrPhase: async () => { await sleep(40); throw new pipeline.QuotaExhausted('pr'); },
    generateDemoSteps: async () => { steps.ev.push('demo:start'); await sleep(20); throw new pipeline.QuotaExhausted('demo'); },
  });
  await noStrayRejections(async () => {
    await assert.rejects(pipeline.runPipeline(task, 'pr', steps), (e) => e instanceof pipeline.QuotaExhausted && e.resumeFrom === 'pr');
  });
  assert.ok(steps.ev.includes('demo:start'));
});

test('a quota in the PR body stops before the draft and still lets the demo finish', async () => {
  const task = atPr();
  const steps = rig({ demo: 60 }, { composePrBody: async () => { steps.ev.push('compose:start'); await sleep(10); throw new pipeline.QuotaExhausted('pr'); } });
  await noStrayRejections(async () => {
    await assert.rejects(pipeline.runPipeline(task, 'pr', steps), (e) => e instanceof pipeline.QuotaExhausted && e.resumeFrom === 'pr');
  });
  assert.equal(steps.ev.includes('draft:start'), false);
  assert.ok(steps.ev.includes('demo:end'), steps.ev.join(' '));
});

test('a task with the demo off does not start one', async () => {
  const task = atPr({ demo: 'off' });
  const steps = rig();
  await pipeline.runPipeline(task, 'pr', steps);
  assert.equal(steps.ev.includes('demo:start'), false);
  assert.equal(task.phase, null);
});

// ---------------------------------------------------------------------------
// Resume

test('resumed at «pr» with the demo already done on this commit, the demo is not repeated', async () => {
  const task = atPr({ prBody: 'Closes #1', demoAt: HEAD });
  const steps = rig();
  await pipeline.runPipeline(task, 'pr', steps);
  assert.equal(steps.ev.includes('demo:start'), false, steps.ev.join(' '));
  assert.ok(steps.ev.includes('draft:end'));
  assert.equal(task.phase, null);
});

test('resumed at «pr» with a demo from an older commit, the demo runs again', async () => {
  const task = atPr({ prBody: 'Closes #1', demoAt: 'deadbeef00' });
  const steps = rig();
  await pipeline.runPipeline(task, 'pr', steps);
  assert.ok(steps.ev.includes('demo:end'), steps.ev.join(' '));
  assert.equal(task.demoAt, HEAD);
});

test('resumed at «demo» after a quota, only the demo runs', async () => {
  const task = atPr({ phase: 'demo', prNumber: 99, prUrl: 'https://github.com/x/pull/99', state: 'pr_draft' });
  const steps = rig();
  await pipeline.runPipeline(task, 'demo', steps);
  assert.deepEqual(steps.ev, ['demo:start', 'demo:end']);
  assert.equal(task.demoAt, HEAD);
  assert.equal(task.phase, null);
});

// ---------------------------------------------------------------------------
// Span accounting

function assertContiguous(phases) {
  for (let i = 1; i < phases.length; i += 1) {
    const gap = Date.parse(phases[i].startedAt) - Date.parse(phases[i - 1].endedAt);
    assert.ok(gap >= 0 && gap < 50, `gap of ${gap} ms before ${phases[i].name}`);
  }
}

test('an overlapped run keeps the phases contiguous and runMs free of double counting', async () => {
  const task = taskOf();
  const steps = rig({ triage: 60, install: 50, compose: 40, draft: 40, demo: 150 });
  const t0 = Date.now();
  await pipeline.runPipeline(task, 'assigned', steps);
  const wall = Date.now() - t0;

  const phases = spansOf(task, 'phase');
  assert.deepEqual(names(phases), ['assigned', 'worktree', 'triage', 'fixing', 'testing', 'pr', 'demo']);
  assert.ok(phases.every((s) => s.endedAt && s.outcome === 'ok'), JSON.stringify(phases));
  assertContiguous(phases);
  const sum = phases.reduce((acc, s) => acc + s.ms, 0);
  assert.ok(Math.abs(sum - wall) < 1000, `phases add up to ${sum} ms, the run took ${wall}`);

  const summary = metrics.summarize(task);
  assert.equal(summary.runMs, sum);
  assert.ok(summary.wallMs >= summary.runMs, `wallMs ${summary.wallMs} < runMs ${summary.runMs}`);
  assert.ok(summary.runMs >= summary.activeMs, `runMs ${summary.runMs} < activeMs ${summary.activeMs}`);

  const steps_ = spansOf(task, 'step');
  const demo = steps_.find((s) => s.name === 'demo_steps');
  assert.ok(demo, names(steps_).join(','));
  assert.equal(demo.meta.overlap, true);
  assert.equal(steps.whens[0], 'during_triage', steps.whens.join(','));
  // The rig opens the span the real step does: the early one is recorded, closed and green.
  const early = steps_.find((s) => s.name === 'prepare_dependencies' && s.meta.when === 'during_triage');
  assert.ok(early && early.endedAt && early.outcome === 'ok', JSON.stringify(steps_));
});

test('a demo that ends before the PR leaves no demo phase, but its step span is recorded', async () => {
  const task = atPr();
  const steps = rig({ compose: 60, draft: 60, demo: 20 });
  await pipeline.runPipeline(task, 'pr', steps);
  const phases = spansOf(task, 'phase');
  assert.deepEqual(names(phases), ['pr']);
  assert.ok(phases.every((s) => s.endedAt && s.outcome === 'ok'));
  const demo = spansOf(task, 'step').find((s) => s.name === 'demo_steps');
  assert.ok(demo && demo.endedAt && demo.outcome === 'ok', JSON.stringify(spansOf(task, 'step')));
  const summary = metrics.summarize(task);
  assert.equal(summary.runMs, phases.reduce((acc, s) => acc + s.ms, 0));
  assert.ok(summary.wallMs >= summary.runMs && summary.runMs >= summary.activeMs);
});

test('an error with the install in flight leaves no span open', async () => {
  const task = taskOf();
  const boom = new Error('triage exploded');
  const steps = rig({ install: 60 }, { triagePhase: async () => { await sleep(10); throw boom; } });
  await assert.rejects(pipeline.runPipeline(task, 'assigned', steps), (e) => e === boom);
  // The install (60 ms) outlives the triage (10 ms): it is on record, and it is
  // closed by the time the run gives up because the run waited for it.
  assert.ok(task.timings.some((s) => s.name === 'prepare_dependencies'), 'the install span exists');
  assert.ok(task.timings.every((s) => s.endedAt), JSON.stringify(task.timings.filter((s) => !s.endedAt)));
  const summary = metrics.summarize(task);
  assert.ok(summary.wallMs >= summary.runMs && summary.runMs >= summary.activeMs);
});
