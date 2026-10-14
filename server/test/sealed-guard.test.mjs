// #31 g2/g3/g4: every validator that reads a finished session's text reads the
// sealed text when the CLI's reaction turn replaced a good answer, and says so
// in the task log. These tests drive the readers (`taggedFrom`, `readWorkPlanFrom`,
// `triageVerdictFor`, `reviewRepliesOf`, `demoStepsOf`) over synthetic results, so
// they pin the readers and the log note, not every call of `answerOf` in
// `pipeline.js`: the call sites and their retry paths, over real sessions, are
// in `sealed-sites.test.mjs`.
import './isolate.mjs';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

const { store } = await import('../src/store.js');
const { claudeHooks } = await import('../src/claude.js');
const pipeline = await import('../src/pipeline.js');

const original = claudeHooks.query;
afterEach(() => { claudeHooks.query = original; });

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const ACK = 'Background agent completed: PONG received.';

let n = 9800;
const freshTask = () => {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = `/wt/${n}`;
  return task;
};
const logOf = (task) => (task.log ?? []).map((l) => l.line).join('\n');
const SEALED_NOTE = /using the sealed text/;

/** The seam of the call sites: a result as `runClaude` returns it after the guard's case. */
const reacted = (good) => ({ ok: true, resultText: ACK, sealedText: good, sessionId: null, toolCounts: {} });

test('the work plan is read from the sealed text when the adopted one is an acknowledgement', async () => {
  const good = 'Plan.\nWORK_PLAN: {"tasks":[{"id":"a","what":"hacer a"}]}';
  const task = freshTask();
  const { plan, problem } = await pipeline.readWorkPlanFrom(task, 'fix', reacted(good), { machine: null, cwd: '/wt', model: 'sonnet', tuning: {}, onEvent: () => {} });
  assert.equal(problem, null);
  assert.equal(plan?.tasks?.[0]?.id ?? plan?.[0]?.id, 'a');
  assert.match(logOf(task), SEALED_NOTE);
});

test('a tagged line (QA plan, gaps verdict) is read from the sealed text too', async () => {
  const read = (t) => (t.includes('QA_TAG: ok') ? { ok: true, value: { fine: true } } : { ok: false, problem: 'sin etiqueta' });
  const task = freshTask();
  const got = await pipeline.taggedFrom(task, 'qa', reacted('QA_TAG: ok'), { read, tag: 'QA_TAG', onEvent: () => {} });
  assert.deepEqual(got, { fine: true });
  assert.match(logOf(task), SEALED_NOTE);
});

test('the triage verdict is read from the sealed text, with no second ask', async () => {
  const good = 'TRIAGE_RESULT: {"complexity":"simple","reason":"r","summary":"s"}';
  const task = freshTask();
  let asked = 0;
  const { verdict, path } = await pipeline.triageVerdictFor(task, reacted(good), { run: async () => { asked += 1; return { ok: false }; }, onEvent: () => {} });
  assert.equal(verdict.complexity, 'simple');
  assert.equal(path, 'first');
  assert.equal(asked, 0);
  assert.match(logOf(task), SEALED_NOTE);
});

test('a text that already validates is left alone, with no note in the log', async () => {
  const read = (t) => (t.includes('QA_TAG: ok') ? { ok: true, value: { fine: true } } : { ok: false, problem: 'sin etiqueta' });
  const task = freshTask();
  const result = { ok: true, resultText: 'QA_TAG: ok', sealedText: 'QA_TAG: ok también', sessionId: null };
  await pipeline.taggedFrom(task, 'qa', result, { read, tag: 'QA_TAG', onEvent: () => {} });
  assert.doesNotMatch(logOf(task), SEALED_NOTE);
});

test('the PR body is the sealed one when the CLI turn that followed the report was an acknowledgement', async () => {
  const BODY = '## At a glance: before vs. after\n\nBefore: the net lost the plan. After: it keeps it.\n\nCloses #1\n';
  const sent = [];
  let closed = false;
  let sessions = 0;
  claudeHooks.query = ({ prompt }) => {
    sessions += 1;
    (async () => { for await (const m of prompt) sent.push(m); closed = true; })();
    return (async function* stream() {
      await tick();
      const uuid = sent[0]?.uuid;
      yield { type: 'system', subtype: 'init', session_id: 'pr-1', model: 'claude-sonnet-5' };
      yield { type: 'assistant', session_id: 'pr-1', user_message_uuid: uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'general-purpose', run_in_background: true } }] } };
      yield { type: 'system', subtype: 'task_started', task_id: 't1', description: 'probe', task_type: 'local_agent', subagent_type: 'general-purpose', tool_use_id: 'a1', is_backgrounded: true };
      yield { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'listo' };
      yield { type: 'result', subtype: 'success', result: BODY, num_turns: 2, total_cost_usd: 0, session_id: 'pr-1', user_message_uuid: uuid, user_message_uuids: [uuid] };
      yield { type: 'system', subtype: 'init', session_id: 'pr-1', model: 'claude-sonnet-5' };
      yield { type: 'result', subtype: 'success', result: ACK, num_turns: 1, total_cost_usd: 0, session_id: 'pr-1' };
      for (let i = 0; i < 500 && !closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  const task = freshTask();
  const body = await pipeline.composePrBody(task, { number: 1, title: 't', body: 'b' });
  assert.equal(sessions, 1, 'no second attempt bought over a body that was already there');
  assert.ok(body?.includes('At a glance'), 'the sealed body, not the acknowledgement');
  assert.match(logOf(task), SEALED_NOTE);
});

test('the review replies are read from the sealed text when the adopted one is an acknowledgement', () => {
  const good = 'listo\nREVIEW_REPLIES: {"replies":[],"summary":"Fixed."}';
  const task = freshTask();
  const parsed = pipeline.reviewRepliesOf(task, reacted(good));
  assert.equal(parsed?.summary, 'Fixed.');
  assert.match(logOf(task), SEALED_NOTE);
  assert.equal(pipeline.reviewRepliesOf(freshTask(), { resultText: ACK }), null, 'with nothing sealed an acknowledgement is still no replies');
});

test('the demo steps are the sealed ones when the adopted text is an acknowledgement', () => {
  const good = '## Preparación\n\nHaz esto.\n\n## Pasos\n\n1. Abre la URL.\nWORK_PLAN: {"tasks":[{"id":"a","what":"x"}]}';
  const task = freshTask();
  const steps = pipeline.demoStepsOf(task, reacted(good));
  assert.match(steps, /^## Preparación/);
  assert.doesNotMatch(steps, /WORK_PLAN/, 'the plan line is for the board');
  assert.match(logOf(task), SEALED_NOTE);
  assert.equal(pipeline.demoStepsOf(freshTask(), { resultText: ACK }), ACK, 'with nothing sealed the text is left as it was');
});
