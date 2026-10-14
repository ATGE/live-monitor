// «Cerrar huecos» wired into the pipeline: the tri-state switch, the loop in
// `gapsPhase` and where `runPipeline` calls it.
//
// The Claude calls go through `fixHooks.runClaude` (the same seam the fix phase
// uses), and the two phases a round reuses — the closing fix and the suite —
// through `gapsHooks`, so nothing reaches git, gh or a real session. gaps.js has
// its own tests; what is checked here is the wiring: which session is resumed,
// what a round does with each kind of verdict, and what never blocks the PR.
import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { settings } = await import('../src/settings.js');
const { saveProjects } = await import('../src/projects.js');
const { keyOf } = await import('../src/keys.js');
const pipeline = await import('../src/pipeline.js');
const { gapsPhase, gapsHooks, fixHooks, fixGapsWanted, setFixGaps, maxGapRoundsOf, QuotaExhausted } = pipeline;

const entries = () => [
  { id: 'hfs', name: 'hfs', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: config.github.repo ?? null, assignee: config.github.assignee, reviewer: config.github.reviewer, overrides: {} },
  { id: 'plain', name: 'plain', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: 'eterceros/plain', assignee: config.github.assignee, reviewer: null, overrides: { e2e: null, stack: null } },
];

const realRun = fixHooks.runClaude;
const realGaps = { ...gapsHooks };
const savedLimits = config.limits;
before(() => {
  saveProjects(entries());
  settings.update({ autoStart: false });
});
after(() => {
  fixHooks.runClaude = realRun;
  Object.assign(gapsHooks, realGaps);
  config.limits = savedLimits;
  saveProjects(entries());
});

let n = 9500;
function taskOf(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'plain');
  task.worktreePath = `/wt/${n}`;
  task.branch = `fix/${n}-thing`;
  task.chats[0].sessionId = 'fix-session';
  return Object.assign(task, fields);
}
const issueOf = (task) => ({ number: task.issue, title: `Issue ${task.issue}`, body: 'Something is broken.' });

const verdictLine = (v) => `Revisé mi trabajo.\nGAPS_VERDICT: ${JSON.stringify(v)}`;
const CLEAN = { evidence: 'yes', evidenceNotes: 'test verde', gaps: [] };
const gap = (id, over = {}) => ({ id, summary: `hueco ${id}`, needsHuman: false, fix: `arregla ${id}`, ...over });

/** Scripts the session: each call answers with the next reply and is recorded. */
function script(replies) {
  const calls = [];
  const queue = [...replies];
  fixHooks.runClaude = async (options) => {
    calls.push(options);
    const r = queue.shift();
    const resultText = typeof r === 'string' ? r : (r?.resultText ?? '');
    return { ok: true, resultText, sessionId: 'fix-session', toolCounts: {}, ...(typeof r === 'object' ? r : {}) };
  };
  return calls;
}

/** The two reused phases, recorded. `order` is the sequence of everything that ran. */
function phases(task) {
  const order = [];
  gapsHooks.fixPhase = async (t, issue, brief, opts) => { order.push({ step: 'fix', state: t.state, brief, opts }); };
  gapsHooks.testPhase = async (t) => { order.push({ step: 'test', state: t.state }); };
  gapsHooks.headCommit = async () => 'abc123';
  return order;
}

/** Runs `fn` with `limits.maxGapRounds` set to `n`, so a test never depends on the config's own value. */
async function withGapRounds(n, fn) {
  config.limits = { ...savedLimits, maxGapRounds: n };
  try { return await fn(); } finally { config.limits = savedLimits; }
}
const gapRoundsTest = (name, n, fn) => test(name, () => withGapRounds(n, fn));

const chatOf = (task) => task.chats[0].messages.filter((m) => m.role === 'assistant').map((m) => m.text ?? m.content ?? '');

// ---------------------------------------------------------------------------

test('fixGapsWanted: auto follows the board, on and off decide', () => {
  // A task is born with the value copied (on/off); `auto` is what older tasks carry.
  const task = taskOf({ fixGaps: 'auto' });
  settings.update({ fixGaps: false });
  assert.equal(fixGapsWanted(task), false);
  settings.update({ fixGaps: true });
  assert.equal(fixGapsWanted(task), true);
  task.fixGaps = 'off';
  assert.equal(fixGapsWanted(task), false);
  settings.update({ fixGaps: false });
  task.fixGaps = 'on';
  assert.equal(fixGapsWanted(task), true);
});

test('setFixGaps stores the mode on the task, refuses anything else, and logs it', () => {
  const task = taskOf();
  assert.equal(setFixGaps(keyOf(task), 'on'), 'on');
  assert.equal(task.fixGaps, 'on');
  assert.equal(setFixGaps(keyOf(task), 'auto'), 'auto');
  assert.throws(() => setFixGaps(keyOf(task), 'maybe'), /auto, on or off/);
  assert.throws(() => setFixGaps(999999, 'on'), /Unknown task/);
  assert.ok(task.log.some((l) => l.phase === 'gaps' && /close gaps before the PR/.test(l.line)));
});

test('maxGapRoundsOf: limits.maxGapRounds, 3 when absent or not a positive integer', () => {
  assert.equal(maxGapRoundsOf({}), 3);
  assert.equal(maxGapRoundsOf({ limits: {} }), 3);
  assert.equal(maxGapRoundsOf({ limits: { maxGapRounds: 5 } }), 5);
  assert.equal(maxGapRoundsOf({ limits: { maxGapRounds: 0 } }), 3);
  assert.equal(maxGapRoundsOf({ limits: { maxGapRounds: 'x' } }), 3);
  assert.equal(maxGapRoundsOf({ limits: { maxGapRounds: 1.5 } }), 3);
});

gapRoundsTest('a clean verdict: one round, the fix session RESUMED (not forked), nothing fixed, summary in the chat', 3, async () => {
  const task = taskOf();
  const calls = script([verdictLine(CLEAN)]);
  const order = phases(task);
  await gapsPhase(task, issueOf(task));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].resume, 'fix-session');
  assert.notEqual(calls[0].forkSession, true);
  assert.ok(calls[0].hooks?.PreToolUse, 'the gh gate rides on it');
  assert.match(calls[0].prompt, new RegExp(`Ronda 1 de ${maxGapRoundsOf(config)}`));
  assert.match(calls[0].prompt, /GAPS_VERDICT:/, 'the contract is in the prompt');
  assert.equal('effort' in calls[0], false, 'auto passes nothing');
  assert.deepEqual(order, [], 'no gap to close: no fix, no suite');
  assert.equal(task.gaps.rounds, 1);
  assert.deepEqual(task.gaps.pending, []);
  assert.equal(task.gaps.lastVerdict.evidence, 'yes');
  assert.ok(task.phaseModels.gaps, 'the card chip knows this session');
  const said = chatOf(task);
  assert.equal(said.length, 1);
  assert.match(said[0], /Cerrar huecos, ronda 1/);
  assert.match(said[0], /Nada pendiente/);
});

gapRoundsTest('a resolvable gap: the closing fix runs (continuing), then the suite, then a second round', 3, async () => {
  const task = taskOf();
  const calls = script([
    verdictLine({ evidence: 'partial', evidenceNotes: 'falta un test', gaps: [gap('g1')] }),
    verdictLine(CLEAN),
  ]);
  const order = phases(task);
  await gapsPhase(task, issueOf(task));

  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, new RegExp(`Ronda 2 de ${maxGapRoundsOf(config)}`));
  assert.deepEqual(order.map((o) => o.step), ['fix', 'test']);
  assert.equal(order[0].state, 'fixing');
  assert.equal(order[1].state, 'testing');
  assert.equal(order[0].opts.continuing, true, 'a continuation: it reviews the branch, it does not start over');
  assert.match(order[0].brief, /\(g1\) hueco g1/);
  assert.match(order[0].brief, /Ronda 1 de cierre de huecos/);
  assert.equal(task.state, 'fix_gaps', 'back in its own state after the round');
  assert.equal(task.e2ePassedAt, 'abc123');
  assert.equal(task.gaps.rounds, 2);
  assert.deepEqual(task.gaps.pending, []);
  const said = chatOf(task);
  assert.equal(said.length, 2, 'one summary per round');
  assert.match(said[0], /Lo que se arregló/);
});

test('a gap that needs a person is never fixed by the board, and is listed as pending', async () => {
  const task = taskOf();
  script([verdictLine({ evidence: 'yes', evidenceNotes: '', gaps: [gap('h1', { needsHuman: true })] })]);
  const order = phases(task);
  await gapsPhase(task, issueOf(task));
  assert.deepEqual(order, []);
  assert.deepEqual(task.gaps.pending.map((g) => g.id), ['h1']);
  assert.match(chatOf(task)[0], /Lo que necesita a una persona:\n- \(h1\)/);
});

gapRoundsTest('the same gap two rounds running stops the loop (the fix is not moving it)', 3, async () => {
  const task = taskOf();
  const calls = script([
    verdictLine({ evidence: 'no', evidenceNotes: '', gaps: [gap('g1')] }),
    verdictLine({ evidence: 'no', evidenceNotes: '', gaps: [gap('g1')] }),
    verdictLine(CLEAN),
  ]);
  const order = phases(task);
  await gapsPhase(task, issueOf(task));
  assert.equal(calls.length, 2, 'no third round');
  assert.equal(order.filter((o) => o.step === 'fix').length, 1);
  assert.deepEqual(task.gaps.pending.map((g) => g.id), ['g1'], 'what is still open goes to a person');
});

gapRoundsTest('limits.maxGapRounds caps the rounds', 1, async () => {
  const task = taskOf();
  const calls = script([verdictLine({ evidence: 'partial', evidenceNotes: '', gaps: [gap('g1')] })]);
  const order = phases(task);
  await gapsPhase(task, issueOf(task));
  assert.equal(calls.length, 1);
  assert.deepEqual(order, [], 'the only round is spent: nothing to close it with');
  assert.deepEqual(task.gaps.pending.map((g) => g.id), ['g1']);
  assert.match(calls[0].prompt, /Ronda 1 de 1/);
});

gapRoundsTest('limits.maxGapRounds at 5: five rounds run, the last one is spent, and the prompt says so', 5, async () => {
  const task = taskOf();
  // A different gap every round, so the "same gap twice" guard never stops the loop before the cap.
  const calls = script([
    ...['g1', 'g2', 'g3', 'g4', 'g5'].map((id) => verdictLine({ evidence: 'partial', evidenceNotes: '', gaps: [gap(id)] })),
    verdictLine(CLEAN),
  ]);
  const order = phases(task);
  await gapsPhase(task, issueOf(task));
  assert.equal(calls.length, 5, 'the sixth reply is never asked for');
  assert.match(calls[0].prompt, /Ronda 1 de 5/);
  assert.match(calls[4].prompt, /Ronda 5 de 5/);
  assert.deepEqual(order.map((o) => o.step), ['fix', 'test', 'fix', 'test', 'fix', 'test', 'fix', 'test'], 'rounds 1-4 close their gap; round 5 has no round left to follow it');
  assert.equal(task.gaps.rounds, 5);
  assert.deepEqual(task.gaps.pending.map((g) => g.id), ['g5'], 'what is still open goes to a person');
  assert.equal(chatOf(task).length, 5);
  assert.ok(task.log.some((l) => l.phase === 'gaps' && /round 5 of 5/.test(l.line)));
});

test('an unreadable verdict is asked for ONCE more, and the answer is used', async () => {
  const task = taskOf();
  const calls = script(['no sé qué decir', verdictLine(CLEAN)]);
  phases(task);
  await gapsPhase(task, issueOf(task));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].resume, 'fix-session', 'the re-ask is the same session');
  assert.equal(calls[1].maxTurns, 3);
  assert.ok(calls[1].hooks?.PreToolUse, 'and the re-ask is gated too');
  assert.equal(task.gaps.lastVerdict.evidence, 'yes');
});

test('a verdict that stays unreadable never blocks the PR: logged, said in the chat, and the phase returns', async () => {
  const task = taskOf();
  const calls = script(['nada', 'tampoco', verdictLine(CLEAN)]);
  const order = phases(task);
  const out = await gapsPhase(task, issueOf(task));      // does not throw
  assert.equal(calls.length, 2, 'one re-ask, not the retry budget');
  assert.deepEqual(order, []);
  assert.equal(out.unreadable, true);
  assert.ok(task.log.some((l) => l.phase === 'gaps' && /gaps verdict could not be read/.test(l.line) && /moving on to the PR/.test(l.line)));
  assert.ok(chatOf(task).some((t) => /No pude leer el veredicto/.test(t)));
});

test('the account\'s quota stops the phase instead of passing for a verdict', async () => {
  const task = taskOf();
  script([{ resultText: '', ok: false, quota: true }]);
  phases(task);
  await assert.rejects(() => gapsPhase(task, issueOf(task)), (e) => e instanceof QuotaExhausted && e.resumeFrom === 'fix_gaps');
});

test('a task turned manual stops the next round (PausedForMode), as the rest of the pipeline does', async () => {
  const task = taskOf({ mode: 'manual' });
  const calls = script([verdictLine(CLEAN)]);
  phases(task);
  await assert.rejects(() => gapsPhase(task, issueOf(task)), /pasó a manual/);
  assert.equal(calls.length, 0);
});

test('no fix session to resume: the phase says so and moves on', async () => {
  const task = taskOf();
  task.chats[0].sessionId = null;
  const calls = script([verdictLine(CLEAN)]);
  await gapsPhase(task, issueOf(task));
  assert.equal(calls.length, 0);
  assert.ok(task.log.some((l) => /no fix session to resume/.test(l.line)));
});

// ---------------------------------------------------------------------------
// Where runPipeline calls it

const HEAD = '5835cde9aa11bb22cc33';
function stubs(task, over = {}) {
  const calls = [];
  const step = (name, fn) => async (...args) => { calls.push(name); return fn?.(...args); };
  return {
    calls,
    getIssue: async () => issueOf(task),
    classifyIssue: step('classifyIssue', async () => ({ state: 'assigned', branches: [], prs: [], reasons: [] })),
    isProjectWorktree: async () => true,
    ensureWorktree: step('ensureWorktree'),
    bringMain: step('bringMain', async () => ({ merged: false, behind: 0, conflicts: [], blocked: null })),
    headCommit: async () => HEAD,
    hasCommits: async () => true,
    continuationContext: async () => '',
    triagePhase: step('triagePhase'),
    prepareDependencies: step('prepareDependencies', async () => ({ ok: true })),
    fixPhase: step('fixPhase'),
    testPhase: step('testPhase'),
    browserQaPhase: step('browserQaPhase'),
    gapsPhase: step('gapsPhase', async (t) => { t.gapsSeenState = t.state; t.gapsSeenPhase = t.phase; }),
    composePrBody: step('composePrBody'),
    draftPrPhase: step('draftPrPhase', async (t) => { t.prNumber = 77; t.prUrl = 'https://github.com/x/pull/77'; }),
    generateDemoSteps: step('generateDemoSteps'),
    ...over,
  };
}
const piped = (fields = {}) => taskOf({ complexity: 'simple', fixedAt: HEAD, e2ePassedAt: HEAD, ...fields });

test('runPipeline: with the switch on, gaps run after the QA block and before the PR, in their own state and phase', async () => {
  const task = piped({ fixGaps: 'on' });
  const steps = stubs(task);
  await pipeline.runPipeline(task, 'assigned', steps);
  const at = (name) => steps.calls.indexOf(name);
  assert.ok(at('gapsPhase') > at('fixPhase') && at('gapsPhase') < at('composePrBody'), steps.calls.join(' > '));
  assert.equal(task.gapsSeenState, 'fix_gaps');
  assert.equal(task.gapsSeenPhase, 'fix_gaps');
});

test('runPipeline: with the switch off (the default) gaps do not run', async () => {
  settings.update({ fixGaps: false });
  const task = piped();
  const steps = stubs(task);
  await pipeline.runPipeline(task, 'assigned', steps);
  assert.equal(steps.calls.includes('gapsPhase'), false);
});

test('runPipeline: a run resumed at the PR does not pay for the gaps round again', async () => {
  const task = piped({ fixGaps: 'on', prBody: 'Closes #1' });
  const steps = stubs(task);
  await pipeline.runPipeline(task, 'pr', steps);
  assert.equal(steps.calls.includes('gapsPhase'), false);
});

test('runPipeline: a run resumed AT fix_gaps goes straight to it', async () => {
  const task = piped({ fixGaps: 'on' });
  const steps = stubs(task);
  await pipeline.runPipeline(task, 'fix_gaps', steps);
  assert.deepEqual(steps.calls.filter((c) => ['fixPhase', 'testPhase', 'browserQaPhase', 'gapsPhase'].includes(c)), ['gapsPhase']);
});

test('runPipeline: the quota in the gaps phase parks the task on fix_gaps, never in error', async () => {
  const task = piped({ fixGaps: 'on' });
  const steps = stubs(task, { gapsPhase: async () => { throw new QuotaExhausted('fix_gaps'); } });
  await assert.rejects(() => pipeline.runPipeline(task, 'assigned', steps), (e) => e instanceof QuotaExhausted && e.resumeFrom === 'fix_gaps');
});
