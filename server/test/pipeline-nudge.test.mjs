// The parallelism nudge, as the pipeline wires it: `nudgedSession` around the
// phases that may be asked once to fan out, and nothing around `close-issue`.
//
// The policy itself is `nudge.test.mjs`; here: the wrapper over a fake `run`,
// the real `runClaude` over the SDK seam (the nudge is its own session span), and
// a scan of the source that pins which call sites use the wrapper.
import './isolate.mjs';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { claudeHooks } = await import('../src/claude.js');
const pipeline = await import('../src/pipeline.js');
const { readQaPlan } = await import('../src/qa.js');

const original = claudeHooks.query;
afterEach(() => {
  claudeHooks.query = original;
  delete config.pipeline;
});

let n = 9800;
const freshTask = () => {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = `/wt/${n}`;
  return task;
};
const logOf = (task) => (task.log ?? []).map((l) => l.line).join('\n');

/** A fake `run`: `replies[n]` is what the n-th call answers. */
function fakeRun(replies) {
  const calls = [];
  const queue = [...replies];
  const run = async (options) => {
    calls.push(options);
    const r = queue.shift() ?? {};
    return { ok: true, quota: false, sessionId: 'sess-1', resultText: 'respuesta', toolCounts: {}, ...r };
  };
  return { run, calls };
}

const SERIAL = { toolCounts: { Read: 8, Grep: 4, Bash: 2 } };
const PARALLEL = { toolCounts: { Read: 8, Grep: 4, Agent: 3 } };

test('a serial session is nudged exactly once, in the same session', async () => {
  const task = freshTask();
  const { run, calls } = fakeRun([SERIAL, { resultText: 'repartido', toolCounts: { Agent: 2 } }]);
  const result = await pipeline.nudgedSession(task, 'triage', { prompt: 'a', maxTurns: 15 }, { run });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].resume, 'sess-1');
  assert.equal(calls[1].maxTurns, 15);
  assert.equal(result.resultText, 'repartido');
  assert.equal(result.toolCounts.Agent, 2);
  assert.equal(result.toolCounts.Read, 8, 'the counts of both sessions are added');
  assert.deepEqual(task.nudged, ['sess-1']);
  assert.match(logOf(task), /nudging for fan-out once/);
});

test('a parallel session is not nudged', async () => {
  const task = freshTask();
  const { run, calls } = fakeRun([PARALLEL]);
  await pipeline.nudgedSession(task, 'triage', { prompt: 'a', maxTurns: 15 }, { run });
  assert.equal(calls.length, 1);
  assert.deepEqual(task.nudged ?? [], []);
});

test('a session already nudged is never nudged again', async () => {
  const task = freshTask();
  const first = fakeRun([SERIAL, { resultText: 'x' }]);
  await pipeline.nudgedSession(task, 'triage', { prompt: 'a', maxTurns: 15 }, { run: first.run });
  assert.equal(first.calls.length, 2);
  const second = fakeRun([SERIAL]);
  await pipeline.nudgedSession(task, 'triage', { prompt: 'a', maxTurns: 15 }, { run: second.run });
  assert.equal(second.calls.length, 1, 'same session id: it was asked already');
});

test('close-issue is never nudged, whatever the config says', async () => {
  const task = freshTask();
  config.pipeline = { nudge: { phases: { 'close-issue': true } } };
  const { run, calls } = fakeRun([SERIAL]);
  await pipeline.nudgedSession(task, 'close-issue', { prompt: 'a', maxTurns: 30, tools: ['Read', 'Grep'] }, { run });
  assert.equal(calls.length, 1);
});

test('pipeline.nudge: false turns it off, and a phase can be turned off alone', async () => {
  config.pipeline = { nudge: false };
  const off = fakeRun([SERIAL]);
  await pipeline.nudgedSession(freshTask(), 'triage', { prompt: 'a', maxTurns: 15 }, { run: off.run });
  assert.equal(off.calls.length, 1);

  config.pipeline = { nudge: { phases: { demo: false } } };
  const demo = fakeRun([SERIAL]);
  await pipeline.nudgedSession(freshTask(), 'demo', { prompt: 'a', maxTurns: 40 }, { run: demo.run });
  assert.equal(demo.calls.length, 1);
});

test('the phases that write or resume the principal are off by default, on when asked, and release it first', async () => {
  const idle = fakeRun([SERIAL]);
  await pipeline.nudgedSession(freshTask(), 'fix-gaps', { prompt: 'a', maxTurns: 30 }, { run: idle.run });
  assert.equal(idle.calls.length, 1, 'fix-gaps is off unless configured');

  config.pipeline = { nudge: { phases: { 'review-replies': true } } };
  const order = [];
  const { run } = fakeRun([SERIAL, { resultText: 'ok' }]);
  const traced = async (o) => { order.push(o.resume === 'sess-1' && o.prompt !== 'a' ? 'nudge' : 'first'); return run(o); };
  await pipeline.nudgedSession(freshTask(), 'review-replies', { prompt: 'a', maxTurns: 30 }, { run: traced, before: () => order.push('release') });
  assert.deepEqual(order, ['first', 'release', 'nudge']);
});

test('enabled: false is a plain run (the second attempt of the PR body)', async () => {
  const { run, calls } = fakeRun([SERIAL]);
  await pipeline.nudgedSession(freshTask(), 'pr-body', { prompt: 'a', maxTurns: 20 }, { run, enabled: false });
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// The real runClaude over the SDK seam: the nudge is a session span of its own.

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

function fakeSdk(sessions) {
  const seen = [];
  const queue = [...sessions];
  claudeHooks.query = ({ prompt, options }) => {
    const sent = [];
    let closed = false;
    (async () => { for await (const m of prompt) sent.push(m); closed = true; })();
    seen.push({ options, sent });
    return (async function* stream() {
      await tick();
      const { text, reads = 0, agents = 0 } = queue.shift() ?? { text: '' };
      const uuid = sent[0]?.uuid;
      const tools = [
        ...Array.from({ length: reads }, (_, i) => ({ type: 'tool_use', id: `r${i}`, name: 'Read', input: {} })),
        ...Array.from({ length: agents }, (_, i) => ({ type: 'tool_use', id: `a${i}`, name: 'Agent', input: {} })),
      ];
      yield { type: 'system', subtype: 'init', session_id: 'nd-1', model: 'claude-opus-5' };
      yield { type: 'assistant', user_message_uuid: uuid, session_id: 'nd-1', message: { role: 'assistant', content: [...tools, { type: 'text', text }] } };
      yield {
        type: 'result', subtype: 'success', result: text, num_turns: 1, total_cost_usd: 0, session_id: 'nd-1',
        user_message_uuid: uuid, user_message_uuids: [uuid],
      };
      for (let i = 0; i < 500 && !closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  return seen;
}

test('over the SDK: the nudge resumes the session and leaves its own span, marked', async () => {
  const seen = fakeSdk([{ text: 'primera', reads: 13 }, { text: 'repartido', agents: 2 }]);
  const task = freshTask();
  const result = await pipeline.nudgedSession(task, 'triage', {
    cwd: task.worktreePath, model: 'haiku', prompt: 'triage', maxTurns: 15, trackQuota: false,
    metrics: { task, role: 'triage', stage: 'triage' },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].options.resume, 'nd-1');
  assert.equal(result.nudged, true);
  assert.equal(result.resultText, 'repartido');
  const sessions = task.timings.filter((s) => s.kind === 'session');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].meta.nudge, false);
  assert.equal(sessions[1].meta.nudge, true);
  assert.equal(sessions[1].meta.resumed, true);
});

// ---------------------------------------------------------------------------
// Which call sites use the wrapper.

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pipeline.js'), 'utf8');

test('the seven nudgeable phases go through nudgedSession, each under its template name', () => {
  const names = [...src.matchAll(/\bnudgedSession\(task,\s*'([^']+)',\s*\{/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['change-request', 'demo', 'fix-gaps', 'pr-body', 'qa-plan', 'review-replies', 'triage']);
});

test('close-issue is never an argument of nudgedSession, and its call stays a plain runClaude', () => {
  assert.doesNotMatch(src, /nudgedSession\([^)]*'close-issue'/);
  const at = src.indexOf("renderPrompt('close-issue'");
  assert.ok(at > 0, 'the close-issue prompt is still rendered');
  const head = src.slice(0, at);
  const opener = Math.max(head.lastIndexOf('runClaude({'), head.lastIndexOf('nudgedSession(task'));
  assert.equal(head.slice(opener, opener + 'runClaude({'.length), 'runClaude({', 'the call that renders it is a plain runClaude');
});

// ---------------------------------------------------------------------------
// A nudge reply that is one sentence must not replace a good first answer: the
// phase's own reader keeps the first answer, with no extra paid ask.

const SENTENCE = 'No hay nada independiente que repartir.';
const SIMPLE_VERDICT = `TRIAGE_RESULT: ${JSON.stringify({ complexity: 'simple', reason: 'una línea', summary: 'A one line fix.' })}`;
const issueOf = (task) => ({ number: task.issue, title: 'Titulo', labels: [], body: 'cuerpo' });
const askedTexts = (seen) => seen.map((s) => String(s.sent[0]?.message?.content ?? ''));

test('triage: a one-sentence nudge reply leaves the first verdict in force', async () => {
  const seen = fakeSdk([{ text: SIMPLE_VERDICT, reads: 13 }, { text: SENTENCE }]);
  const task = freshTask();
  await pipeline.PIPELINE_STEPS.triagePhase(task, issueOf(task));
  assert.equal(task.complexity, 'simple', 'the verdict of the first answer, not the complex fallback');
  assert.equal(task.triageSummary, 'A one line fix.');
  assert.match(logOf(task), /verdict read on the first try/);
  assert.match(logOf(task), /using the first answer/, 'the fallback leaves its own line');
  assert.ok(!askedTexts(seen).some((t) => t.includes('TRIAGE_RESULT') && t.length < 600 && /otra vez|no traía/i.test(t)), 'no verdict re-ask');
});

test('change-request: a one-sentence nudge reply leaves the first verdict in force', async () => {
  fakeSdk([{ text: SIMPLE_VERDICT, reads: 13 }, { text: SENTENCE }]);
  const task = freshTask();
  const cr = {};
  const verdict = await pipeline.changeRequestTriage(task, cr, issueOf(task), { brief: 'BRIEF' });
  assert.equal(verdict.complexity, 'simple');
  assert.equal(cr.triageSummary, 'A one line fix.');
  assert.match(logOf(task), /verdict read on the first try/);
});

test('qa-plan: a one-sentence nudge reply leaves the first plan in force, with no re-ask', async () => {
  const task = freshTask();
  const { run, calls } = fakeRun([{ ...SERIAL, resultText: 'QA_PLAN: {"ui":false,"steps":[]}' }, { resultText: SENTENCE }]);
  const planRun = await pipeline.nudgedSession(task, 'qa-plan', { prompt: 'a', maxTurns: 25 }, { run });
  assert.equal(planRun.resultText, SENTENCE, 'the nudge reply is adopted as the result');
  const reasks = fakeRun([]);
  const plan = await pipeline.taggedFrom(task, 'qa', planRun, { read: readQaPlan, tag: 'QA_PLAN', run: reasks.run });
  assert.deepEqual(plan, { ui: false, steps: [] });
  assert.equal(calls.length, 2);
  assert.equal(reasks.calls.length, 0, 'no paid re-ask');
});

const GOOD_BODY = '## At a glance: before vs. after\n\nBefore: it crashed. After: it works.\n';

test('pr-body: a one-sentence nudge reply does not cost the body that had passed', async () => {
  const seen = fakeSdk([{ text: GOOD_BODY, reads: 13 }, { text: SENTENCE }]);
  const task = freshTask();
  task.branch = `fix/${task.issue}-thing`;
  const body = await pipeline.composePrBody(task, issueOf(task));
  assert.ok(body && body.includes('it works'), String(body));
  assert.equal(seen.length, 2, 'the nudge ran once and the second attempt was not needed');
});

async function prBodyAfterNudge(reply) {
  const seen = fakeSdk([{ text: GOOD_BODY, reads: 13 }, { text: reply }]);
  const task = freshTask();
  task.branch = `fix/${task.issue}-thing`;
  const body = await pipeline.composePrBody(task, issueOf(task));
  return { seen, body, task };
}

test('pr-body: a Spanish preamble before the same body in the nudge reply is rejected, the first body stays, no second attempt', async () => {
  const { seen, body, task } = await prBodyAfterNudge(`Lancé los subagentes para revisar esto.\n\n${GOOD_BODY}`);
  assert.ok(body && body.includes('it works'), String(body));
  assert.ok(!body.includes('subagentes'), 'the preamble is not in the body');
  assert.equal(task.prBody, body);
  assert.equal(seen.length, 2, 'first session plus the nudge, and no attempt 2');
});

test('pr-body: an English preamble before the body in the nudge reply is rejected', async () => {
  const { seen, body } = await prBodyAfterNudge(`I launched the subagents and they agree.\n\n${GOOD_BODY}`);
  assert.ok(body && body.includes('it works'), String(body));
  assert.ok(!body.includes('subagents'), 'the preamble is not in the body');
  assert.equal(seen.length, 2);
});

test('pr-body: a better body in the nudge reply is adopted', async () => {
  const better = '## At a glance: before vs. after\n\nBefore: it crashed. After: it is fixed for good.\n';
  const { seen, body } = await prBodyAfterNudge(better);
  assert.ok(body && body.includes('fixed for good'), String(body));
  assert.equal(seen.length, 2);
});

test('pr-body: an empty nudge reply keeps the first body', async () => {
  const { seen, body } = await prBodyAfterNudge('');
  assert.ok(body && body.includes('it works'), String(body));
  assert.equal(seen.length, 2);
});

test('demo: a one-sentence nudge reply does not become the stored steps', async () => {
  const task = freshTask();
  const steps = '## Preparación\n\nHaz esto.\n\n## Pasos\n\n1. Abre la página.\n';
  const { run, calls } = fakeRun([{ ...SERIAL, resultText: steps }, { resultText: SENTENCE }]);
  const result = await pipeline.nudgedSession(task, 'demo', { prompt: 'a', maxTurns: 40 }, { run });
  assert.equal(calls.length, 2);
  assert.equal(pipeline.demoStepsOf(task, result).trim(), steps.trim());
  assert.match(logOf(task), /using the first answer/);
});

test('releasePrincipalForNudge refuses while the principal chat is in a turn or running a plan', async () => {
  const task = freshTask();
  const { principalChat } = await import('../src/chats.js');
  const principal = principalChat(task);
  assert.ok(principal, 'a new task has a principal chat');
  principal.plan = { status: 'running' };
  assert.throws(() => pipeline.releasePrincipalForNudge(task), /turn in progress/);
  principal.plan = null;
  assert.doesNotThrow(() => pipeline.releasePrincipalForNudge(task));
});

test('releasePrincipalForNudge: every arm of the guard refuses, and an idle or absent principal does not', async () => {
  const { principalChat } = await import('../src/chats.js');
  const task = freshTask();
  const principal = principalChat(task);
  // The module-private maps are stood in for through the second argument; their keys
  // are whatever the guard computes, so a stand-in that answers every key is enough.
  const anyKey = (value) => ({ has: () => value, get: () => (value ? { session: { alive: true } } : undefined) });
  const deadLive = { get: () => ({ session: { alive: false } }) };
  const none = { has: () => false };
  const idle = { startingTurns: none, live: { get: () => undefined } };

  assert.throws(() => pipeline.releasePrincipalForNudge(task, { startingTurns: anyKey(true), live: idle.live }), /turn in progress/, 'starting');
  principal.plan = { status: 'asking' };
  assert.throws(() => pipeline.releasePrincipalForNudge(task, idle), /turn in progress/, 'asking');
  principal.plan = null;
  principal.busy = true;
  assert.throws(() => pipeline.releasePrincipalForNudge(task, { startingTurns: none, live: anyKey(true) }), /turn in progress/, 'busy with a live session');
  assert.doesNotThrow(() => pipeline.releasePrincipalForNudge(task, { startingTurns: none, live: deadLive }), 'busy but the process is gone');
  assert.doesNotThrow(() => pipeline.releasePrincipalForNudge(task, { startingTurns: none, live: { get: () => undefined } }), 'busy with no live session');
  principal.busy = false;
  assert.doesNotThrow(() => pipeline.releasePrincipalForNudge(task, { startingTurns: none, live: anyKey(true) }), 'a live session of an idle chat is released, not refused');
  assert.doesNotThrow(() => pipeline.releasePrincipalForNudge({ chats: [] }), 'no principal chat');
});

test('a quota hold stops the nudge at the pipeline level: no paid turn, session unmarked', async () => {
  const quota = await import('../src/quota.js');
  quota.resetQuotaForTests();
  quota.noteQuotaHit({ status: 'rejected', via: 'sdk', resetsAt: Date.now() + 90 * 60_000, rateLimitType: 'five_hour' });
  try {
    assert.equal(quota.quotaHoldsNewWork(), true, 'the hold is real');
    const task = freshTask();
    const { run, calls } = fakeRun([SERIAL, { resultText: 'repartido', toolCounts: { Agent: 2 } }]);
    const result = await pipeline.nudgedSession(task, 'triage', { prompt: 'a', maxTurns: 15 }, { run });
    assert.equal(calls.length, 1, 'the resume never started');
    assert.equal(result.nudged, undefined);
    assert.deepEqual(task.nudged ?? [], []);
    assert.match(logOf(task), /quota pause/);
  } finally { quota.resetQuotaForTests(); }
});

test('a refused release leaves the principal session nudgeable on a later pass', async () => {
  const task = freshTask();
  const refusing = fakeRun([SERIAL]);
  const kept = await pipeline.nudgedSession(task, 'triage', { prompt: 'a', maxTurns: 15 }, {
    run: refusing.run, before: () => { throw new Error('el chat principal tiene un turno en curso'); },
  });
  assert.equal(kept.nudged, 'kept');
  assert.equal(kept.nudgeReason, 'refused');
  assert.deepEqual(task.nudged ?? [], [], 'not marked');
  assert.match(logOf(task), /nudge refused/);
  const later = fakeRun([SERIAL, { resultText: 'repartido', toolCounts: { Agent: 2 } }]);
  const done = await pipeline.nudgedSession(task, 'triage', { prompt: 'a', maxTurns: 15 }, { run: later.run, before: () => {} });
  assert.equal(done.nudged, true);
  assert.deepEqual(task.nudged, ['sess-1']);
});

test('triageVerdictFor: with no verdict the summary is the first answer, not a one-sentence nudge reply', async () => {
  const noVerdict = (over) => ({ ok: true, quota: false, resultText: SENTENCE, ...over });
  const adopted = await pipeline.triageVerdictFor(freshTask(), noVerdict({ fallbackTexts: ['La primera respuesta, sin veredicto.'] }));
  assert.equal(adopted.path, 'fallback');
  assert.equal(adopted.verdict.complexity, 'complex');
  assert.equal(adopted.verdict.summary, 'La primera respuesta, sin veredicto.');
  const plain = await pipeline.triageVerdictFor(freshTask(), noVerdict({}));
  assert.equal(plain.verdict.summary, SENTENCE, 'no nudge: the only answer there is');
  const blank = await pipeline.triageVerdictFor(freshTask(), noVerdict({ fallbackTexts: ['x'] }), { fallbackSummary: '' });
  assert.equal(blank.verdict.summary, '', 'an explicit empty summary wins (change request)');
});

test('triage: one degraded nudge reply logs the fallback note once, however many readers see it', async () => {
  // A first answer all three readers of the triage result accept (verdict, work plan, QA plan).
  const full = [SIMPLE_VERDICT, 'WORK_PLAN: {"tasks":[{"id":"a","what":"do it"}]}', 'QA_PLAN: {"ui":false,"steps":[]}'].join('\n');
  fakeSdk([{ text: full, reads: 13 }, { text: SENTENCE }]);
  const task = freshTask();
  await pipeline.PIPELINE_STEPS.triagePhase(task, issueOf(task));
  const lines = logOf(task).split('\n').filter((l) => /using the first answer/.test(l));
  assert.equal(lines.length, 1, lines.join('\n'));
});

/** Makes the task's machine see `task.worktreePath` as a worktree of the project, with an empty diff. Returns the undo. */
async function pretendWorktree(task) {
  const { machineOf } = await import('../src/machine.js');
  const m = machineOf(task);
  const real = { exec: m.exec, exists: m.fs.exists };
  m.fs.exists = async () => true;
  m.exec = async (cmd, args) => (args.includes('--git-common-dir')
    ? { ok: true, stdout: m.path.join(m.repoPath, '.git'), stderr: '' }
    : { ok: true, stdout: '', stderr: '' });
  return () => { m.exec = real.exec; m.fs.exists = real.exists; };
}

test('demo, end to end: a one-sentence nudge reply leaves the first answer as the stored steps', async () => {
  const steps = '## Preparación\n\nHaz esto.\n\n## Pasos\n\n1. Abre la página.\n';
  fakeSdk([{ text: steps, reads: 13 }, { text: SENTENCE }]);
  const task = freshTask();
  const undo = await pretendWorktree(task);
  try {
    await pipeline.generateDemoSteps(task, issueOf(task));
  } finally { undo(); }
  assert.equal(task.demoSteps.trim(), steps.trim());
  assert.match(logOf(task), /manual validation steps generated/);
  assert.equal(logOf(task).split('\n').filter((l) => /using the first answer/.test(l)).length, 1);
});
