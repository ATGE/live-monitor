// #36 parts H1 and E: one behavioural test per `answerOf` call site of
// `pipeline.js`, and one per retry path. Every test drives a session whose CLI
// reaction turn answered with an acknowledgement over a good sealed answer, and
// the result is the one the real `runClaude` builds from the SDK stream, not a
// hand-made object. Reverting a site to read `resultText` directly turns its
// test red (`tools/subagent-probe/mutants.mjs` does exactly that).
//
// `sealed-guard.test.mjs` pins the readers over synthetic results; this file
// pins the call sites over real sessions.
import './isolate.mjs';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

const { store } = await import('../src/store.js');
const { claudeHooks, runClaude } = await import('../src/claude.js');
const { machineOf } = await import('../src/machine.js');
const { ADVISOR_PLAN_HEADING } = await import('../src/advisorplan.js');
const pipeline = await import('../src/pipeline.js');

const original = claudeHooks.query;
afterEach(() => { claudeHooks.query = original; });

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const ACK = 'Background agent completed: PONG received.';
const SEALED_NOTE = /using the sealed text/;

let n = 9900;
const freshTask = () => {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = `/wt/${n}`;
  task.branch = `fix/${n}-thing`;
  return task;
};
const logOf = (task) => (task.log ?? []).map((l) => l.line).join('\n');
const notesOf = (task) => logOf(task).split('\n').filter((l) => SEALED_NOTE.test(l));
const issueOf = (task) => ({ number: task.issue, title: 'Titulo', labels: [], body: 'cuerpo' });

/**
 * The SDK seam. `queue[i]` scripts the i-th session: `{ sealed: GOOD }` is a
 * background subagent that reports, a turn whose result is GOOD, and then a
 * reaction turn that answers ACK; `{ text }` is a plain one-turn session.
 */
function fakeSdk(queue) {
  const seen = [];
  const pending = [...queue];
  let seq = 0;
  claudeHooks.query = ({ prompt, options }) => {
    const sent = [];
    let closed = false;
    (async () => { for await (const m of prompt) sent.push(m); closed = true; })();
    seen.push({ options, sent });
    seq += 1;
    return (async function* stream() {
      await tick();
      const { sealed, text, sid = `s-${seq}` } = pending.shift() ?? { text: '' };
      const uuid = sent[0]?.uuid;
      const result = (t, turns, extra = {}) => ({ type: 'result', subtype: 'success', result: t, num_turns: turns, total_cost_usd: 0, session_id: sid, ...extra });
      yield { type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5' };
      if (sealed !== undefined) {
        yield { type: 'assistant', session_id: sid, user_message_uuid: uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'general-purpose', run_in_background: true } }] } };
        yield { type: 'system', subtype: 'task_started', task_id: 't1', description: 'probe', task_type: 'local_agent', subagent_type: 'general-purpose', tool_use_id: 'a1', is_backgrounded: true };
        yield { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'listo' };
        yield result(sealed, 2, { user_message_uuid: uuid, user_message_uuids: [uuid] });
        yield { type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5' };
        yield result(ACK, 1);
      } else {
        yield { type: 'assistant', session_id: sid, user_message_uuid: uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } };
        yield result(text, 1, { user_message_uuid: uuid, user_message_uuids: [uuid] });
      }
      for (let i = 0; i < 500 && !closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  return seen;
}

/** A finished session as the phases receive it: the adopted text is ACK, the good one rides as `sealedText`. */
async function sealedResult(good, sid = 'sealed-1') {
  fakeSdk([{ sealed: good, sid }]);
  const result = await runClaude({ cwd: '/wt/x', model: 'haiku', prompt: 'haz algo', trackQuota: false });
  assert.equal(result.resultText, ACK, 'the reaction turn is what the CLI adopted');
  assert.equal(result.sealedText, good, 'and the good answer is kept apart');
  return result;
}

/** A session that went wrong: it left no usable text, but it can be resumed. */
const flat = (text, sessionId = 'flat-1') => ({ ok: true, resultText: text, sessionId, toolCounts: {} });
/** The reply to a complaint: a reaction turn over a good sealed answer. */
const reacted = (good, sessionId = 'flat-1') => ({ ok: true, resultText: ACK, sealedText: good, sessionId, toolCounts: {} });
const noAsk = () => { assert.fail('a second ask was bought over an answer that was already there'); };

const PLAN_LINE = 'WORK_PLAN: {"tasks":[{"id":"a","what":"hacer a"}]}';
const TAGGED = 'QA_TAG: ok';
const readTagged = (t) => (t.includes(TAGGED) ? { ok: true, value: { fine: true } } : { ok: false, problem: 'sin etiqueta' });
const VERDICT = `TRIAGE_RESULT: ${JSON.stringify({ complexity: 'simple', reason: 'r', summary: 'Una línea.' })}`;
const ADVISOR_PLAN = `${ADVISOR_PLAN_HEADING}\n\n${'Enfoque, archivos y orden, partes en paralelo y riesgos a vigilar. '.repeat(10)}`.trim();
const WAITING = 'Los subagentes siguen explorando; continúo con el plan cuando informen.';
const BODY = '## At a glance: before vs. after\n\nBefore: the net lost the plan. After: it keeps it.\n';
const STEPS = `## Preparación\n\nHaz esto.\n\n## Pasos\n\n1. Abre la URL.\n${PLAN_LINE}`;
const REPLIES = 'Done.\nREVIEW_REPLIES: {"replies":[{"threadId":"T1","body":"Fixed in the latest commit."}],"summary":"All threads are addressed."}';

/** Makes the task's machine see `task.worktreePath` as a worktree of the project, with an empty diff. Returns the undo. */
function pretendWorktree(task) {
  const m = machineOf(task);
  const real = { exec: m.exec, exists: m.fs.exists };
  m.fs.exists = async () => true;
  m.exec = async (cmd, args) => (args.includes('--git-common-dir')
    ? { ok: true, stdout: m.path.join(m.repoPath, '.git'), stderr: '' }
    : { ok: true, stdout: '', stderr: '' });
  return () => { m.exec = real.exec; m.fs.exists = real.exists; };
}

// ---------------------------------------------------------------------------
// One test per call site, first read.

test('site 1, work plan: readWorkPlanFrom takes the plan of the sealed answer', async () => {
  const task = freshTask();
  const result = await sealedResult(`Plan.\n${PLAN_LINE}`);
  const { plan, problem } = await pipeline.readWorkPlanFrom(task, 'fix', result, { machine: null, cwd: '/wt', model: 'sonnet', tuning: {}, onEvent: () => {}, run: noAsk });
  assert.equal(problem, null);
  assert.equal(plan?.tasks?.[0]?.id ?? plan?.[0]?.id, 'a');
  assert.equal(notesOf(task).length, 1);
});

test('site 2, tagged lines: taggedFrom takes the tagged line of the sealed answer', async () => {
  const task = freshTask();
  const got = await pipeline.taggedFrom(task, 'qa', await sealedResult(TAGGED), { read: readTagged, tag: 'QA_TAG', onEvent: () => {}, run: noAsk });
  assert.deepEqual(got, { fine: true });
  assert.equal(notesOf(task).length, 1);
});

test('site 3, triage verdict: triageVerdictFor takes the verdict of the sealed answer, with no re-ask', async () => {
  const task = freshTask();
  const { verdict, path } = await pipeline.triageVerdictFor(task, await sealedResult(VERDICT), { run: noAsk, onEvent: () => {} });
  assert.equal(verdict.complexity, 'simple');
  assert.equal(path, 'first');
  assert.equal(notesOf(task).length, 1);
});

test('site 4, advisor plan: advisorPlanFor stores the plan of the sealed answer, with no re-ask', async () => {
  const seen = fakeSdk([{ sealed: ADVISOR_PLAN, sid: 'adv-1' }]);
  const task = freshTask();
  const plan = await pipeline.advisorPlanFor(task, { advise: { model: 'opus' }, prompt: 'asesora' });
  assert.equal(seen.length, 1, 'the plan was there: no complaint');
  assert.ok(plan?.includes('Enfoque, archivos y orden'), 'the sealed plan, not the acknowledgement');
  assert.equal(task.advisorPlan, plan);
  assert.equal(notesOf(task).length, 1);
});

test('site 5, PR body: composePrBody takes the sealed body, with no second attempt', async () => {
  const seen = fakeSdk([{ sealed: BODY }]);
  const task = freshTask();
  const body = await pipeline.composePrBody(task, issueOf(task));
  assert.equal(seen.length, 1);
  assert.ok(body?.includes('At a glance'), String(body));
  assert.equal(notesOf(task).length, 1);
});

test('site 6, review replies: draftReviewReplies drafts from the sealed answer', async () => {
  const task = freshTask();
  task.changeRequests = [{ reviewId: 41, author: 'rev', status: 'fixed', comments: [{ threadId: 'T1', path: 'a.rs', line: 3 }], draftReplies: [] }];
  const seen = fakeSdk([{ sealed: REPLIES }]);
  const undo = pretendWorktree(task);
  let cr;
  try {
    cr = await pipeline.draftReviewReplies(task.issue, 41);
  } finally { undo(); }
  assert.equal(seen.length, 1, 'no second attempt over replies that were already there');
  assert.deepEqual(cr.draftReplies.map((r) => r.threadId), ['T1']);
  assert.equal(cr.draftSummary, 'All threads are addressed.');
  assert.equal(notesOf(task).length, 1);
});

test('site 7, demo steps: generateDemoSteps stores the steps of the sealed answer', async () => {
  const task = freshTask();
  fakeSdk([{ sealed: STEPS }]);
  const undo = pretendWorktree(task);
  try {
    await pipeline.generateDemoSteps(task, issueOf(task));
  } finally { undo(); }
  assert.match(task.demoSteps, /^## Preparación/);
  assert.doesNotMatch(task.demoSteps, /WORK_PLAN/, 'the plan line is for the board');
  assert.equal(notesOf(task).length, 1, 'one note for the steps and the plan read of the same result');
});

// ---------------------------------------------------------------------------
// One test per retry path: the complaint is answered by a reaction turn.

test('retry, work plan: the plan is read from the sealed text of the answer to the complaint', async () => {
  const task = freshTask();
  const asks = [];
  const run = async (o) => { asks.push(o); return reacted(`Plan.\n${PLAN_LINE}`); };
  const { plan, problem } = await pipeline.readWorkPlanFrom(task, 'fix', flat('Sigo pensando.'), { machine: null, cwd: '/wt', model: 'sonnet', tuning: {}, onEvent: () => {}, run });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].resume, 'flat-1');
  assert.equal(problem, null);
  assert.equal(plan?.tasks?.[0]?.id ?? plan?.[0]?.id, 'a');
  assert.equal(notesOf(task).length, 1);
});

test('retry, tagged lines: the tagged line is read from the sealed text of the answer to the complaint', async () => {
  const task = freshTask();
  let asks = 0;
  const run = async () => { asks += 1; return reacted(TAGGED); };
  const got = await pipeline.taggedFrom(task, 'qa', flat('Nada.'), { read: readTagged, tag: 'QA_TAG', onEvent: () => {}, run });
  assert.deepEqual(got, { fine: true });
  assert.equal(asks, 1);
  assert.equal(notesOf(task).length, 1);
});

test('retry, triage: the verdict is read from the sealed text of the re-ask, and the path says so', async () => {
  const task = freshTask();
  let asks = 0;
  const run = async () => { asks += 1; return reacted(VERDICT); };
  const { verdict, path } = await pipeline.triageVerdictFor(task, flat('Sin veredicto.'), { run, onEvent: () => {} });
  assert.equal(asks, 1);
  assert.equal(path, 'reasked');
  assert.equal(verdict.complexity, 'simple');
  assert.equal(notesOf(task).length, 1);
});

test('retry, advisor plan: the plan is read from the sealed text of the answer to the complaint', async () => {
  const seen = fakeSdk([{ text: WAITING, sid: 'adv-1' }, { sealed: ADVISOR_PLAN, sid: 'adv-1' }]);
  const task = freshTask();
  const plan = await pipeline.advisorPlanFor(task, { advise: { model: 'opus' }, prompt: 'asesora' });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].options.resume, 'adv-1', 'the complaint resumes the session');
  assert.ok(plan?.includes('Enfoque, archivos y orden'), 'the sealed plan, not the acknowledgement');
  assert.equal(notesOf(task).length, 1);
});

test('retry, PR body: the second attempt takes the sealed body', async () => {
  const seen = fakeSdk([{ text: 'Todavía estoy esperando a los subagentes.' }, { sealed: BODY }]);
  const task = freshTask();
  const body = await pipeline.composePrBody(task, issueOf(task));
  assert.equal(seen.length, 2, 'the first answer was no body, the second session was');
  assert.ok(body?.includes('At a glance'), String(body));
  assert.equal(notesOf(task).length, 1);
});

// ---------------------------------------------------------------------------
// Part E: the note is a count to be read with `grep`, so one event is one line.

test('one session read by the verdict, the work plan and the QA plan leaves one note, not three', async () => {
  const task = freshTask();
  const result = await sealedResult([VERDICT, PLAN_LINE, TAGGED].join('\n'));
  await pipeline.triageVerdictFor(task, result, { run: noAsk, onEvent: () => {} });
  await pipeline.readWorkPlanFrom(task, 'triage', result, { machine: null, cwd: '/wt', model: 'sonnet', tuning: {}, onEvent: () => {}, run: noAsk });
  await pipeline.taggedFrom(task, 'triage', result, { read: readTagged, tag: 'QA_TAG', onEvent: () => {}, run: noAsk });
  assert.equal(notesOf(task).length, 1, notesOf(task).join('\n'));
});

test('a different result of the same stage notes on its own', async () => {
  const task = freshTask();
  await pipeline.triageVerdictFor(task, await sealedResult(VERDICT, 'first'), { run: noAsk, onEvent: () => {} });
  await pipeline.triageVerdictFor(task, await sealedResult(VERDICT, 'second'), { run: noAsk, onEvent: () => {} });
  assert.equal(notesOf(task).length, 2, 'two results, two events');
});

test('the work plan reading logs once per result even when the plan is read twice', async () => {
  const task = freshTask();
  const result = await sealedResult(`Plan.\n${PLAN_LINE}`);
  const opts = { machine: null, cwd: '/wt', model: 'sonnet', tuning: {}, onEvent: () => {}, run: noAsk };
  await pipeline.readWorkPlanFrom(task, 'fix', result, opts);
  await pipeline.readWorkPlanFrom(task, 'fix', result, opts);
  assert.equal(notesOf(task).length, 1);
});
