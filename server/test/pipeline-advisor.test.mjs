// The advisor's answer is a plan or it is not stored.
//
// The advisor fans out to subagents like every phase, and a turn that ends on
// «the subagents are still running, I continue when their reports arrive» used
// to be stored as `task.advisorPlan` and handed to the fix as its plan. Both
// advisor sites go through `advisorPlanFor`; these drive it through the SDK
// seam (`claudeHooks.query`), the way the CLI would be.
import './isolate.mjs';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { claudeHooks } = await import('../src/claude.js');
const pipeline = await import('../src/pipeline.js');
const { ADVISOR_PLAN_HEADING } = await import('../src/advisorplan.js');
const { COLLECT_RULE } = await import('../src/parallel.js');

const WAITING = 'the three exploration subagents are still running; I continue with the plan when their reports arrive';
const PLAN = `${ADVISOR_PLAN_HEADING}\n\n${'Enfoque, archivos y orden, partes en paralelo y riesgos a vigilar. '.repeat(10)}`.trim();

const original = claudeHooks.query;
afterEach(() => { claudeHooks.query = original; });

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

/** One fake session per ask: `answers[n]` is what the n-th session says. */
function fakeSdk(answers) {
  const seen = [];
  const queue = [...answers];
  claudeHooks.query = ({ prompt, options }) => {
    const sent = [];
    let closed = false;
    (async () => { for await (const m of prompt) sent.push(m); closed = true; })();
    seen.push({ options, sent });
    return (async function* stream() {
      await tick();
      const text = queue.shift() ?? '';
      const uuid = sent[0]?.uuid;
      yield { type: 'system', subtype: 'init', session_id: 'adv-1', model: 'claude-opus-5' };
      yield { type: 'assistant', user_message_uuid: uuid, session_id: 'adv-1', message: { role: 'assistant', content: [{ type: 'text', text }] } };
      yield {
        type: 'result', subtype: 'success', result: text, num_turns: 1, total_cost_usd: 0, session_id: 'adv-1',
        user_message_uuid: uuid, user_message_uuids: [uuid],
      };
      for (let i = 0; i < 500 && !closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  return seen;
}

let n = 9700;
const freshTask = (advisorPlan = null) => {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = `/wt/${n}`;
  task.advisorPlan = advisorPlan;
  return task;
};
const adviseOf = () => ({ model: 'opus' });
const textOfSent = (s) => String(s.sent[0]?.message?.content ?? '');
const logOf = (task) => (task.log ?? []).map((l) => l.line).join('\n');

test('a plan on the first answer is stored, with no second ask', async () => {
  const seen = fakeSdk([PLAN]);
  const task = freshTask();
  const plan = await pipeline.advisorPlanFor(task, { advise: adviseOf(), prompt: 'planea', onEvent: () => {} });
  assert.equal(plan, PLAN);
  assert.equal(task.advisorPlan, PLAN);
  assert.equal(seen.length, 1);
});

test('a waiting sentence is asked again in the same session, and the plan that follows is stored', async () => {
  const seen = fakeSdk([WAITING, PLAN]);
  const task = freshTask();
  await pipeline.advisorPlanFor(task, { advise: adviseOf(), prompt: 'planea', onEvent: () => {} });
  assert.equal(task.advisorPlan, PLAN, 'never the waiting sentence');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].options.resume, 'adv-1', 'the ask resumes the advisor session');
  assert.equal(seen[1].options.maxTurns, 3);
  assert.match(textOfSent(seen[1]), new RegExp(ADVISOR_PLAN_HEADING), 'the complaint names the heading');
  assert.match(logOf(task), /asking again \(1 of/);
});

test('an advisor that never writes a plan leaves advisorPlan null, even over a stale one', async () => {
  const max = config.retry?.max ?? 3;
  const seen = fakeSdk(Array.from({ length: max + 1 }, () => WAITING));
  const task = freshTask('PLAN VIEJO de otro ciclo');
  await pipeline.advisorPlanFor(task, { advise: adviseOf(), prompt: 'planea', onEvent: () => {} });
  assert.equal(task.advisorPlan, null);
  assert.equal(seen.length, 1 + max, 'first ask plus one per retry, no more');
  assert.match(logOf(task), /the advisor returned no usable plan/);
});

test('the session of the advisor carries the foreground-subagent hook', async () => {
  const seen = fakeSdk([PLAN]);
  await pipeline.advisorPlanFor(freshTask(), { advise: adviseOf(), prompt: 'planea', onEvent: () => {} });
  const matchers = seen[0].options.hooks.PreToolUse.map((m) => m.matcher);
  assert.deepEqual(matchers, ['Bash', 'Artifact|ArtifactComments|ArtifactData', 'Agent|Task']);
});

test('the resumed advisor session carries the same hooks as the first one', async () => {
  const seen = fakeSdk([WAITING, PLAN]);
  await pipeline.advisorPlanFor(freshTask(), { advise: adviseOf(), prompt: 'planea', onEvent: () => {} });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].options.resume, 'the second session is the resumed one');
  for (const [i, s] of seen.entries()) {
    const matchers = s.options.hooks?.PreToolUse?.map((m) => m.matcher);
    assert.deepEqual(matchers, ['Bash', 'Artifact|ArtifactComments|ArtifactData', 'Agent|Task'], `session ${i} carries the gate and the subagent hook`);
  }
});

test('the change-request advisor asks for the heading and carries the collect rule', () => {
  const prompt = pipeline.changeRequestAdvisorPrompt({ number: 12 }, 'BRIEF DEL REVISOR');
  assert.ok(prompt.includes('#12'));
  assert.ok(prompt.includes('BRIEF DEL REVISOR'));
  assert.ok(prompt.includes(ADVISOR_PLAN_HEADING));
  assert.ok(prompt.includes(COLLECT_RULE));
});

test('a plan with a waiting sentence before its heading is stored from the heading on', async () => {
  fakeSdk([`${WAITING}\n\n${PLAN}`]);
  const task = freshTask();
  await pipeline.advisorPlanFor(task, { advise: adviseOf(), prompt: 'planea', onEvent: () => {} });
  assert.equal(task.advisorPlan, PLAN.trim());
  assert.ok(!task.advisorPlan.includes('still running'));
});

/**
 * A session per ask whose text depends on the prompt: the advisor prompts carry
 * the plan heading, everything else (triage, its re-asks) gets the verdict line.
 */
function routedSdk(verdict) {
  const seen = [];
  claudeHooks.query = ({ prompt, options }) => {
    const sent = [];
    let closed = false;
    (async () => { for await (const m of prompt) sent.push(m); closed = true; })();
    seen.push({ options, sent });
    return (async function* stream() {
      await tick();
      const asked = String(sent[0]?.message?.content ?? '');
      const text = asked.includes(ADVISOR_PLAN_HEADING) ? `${WAITING}\n\n${PLAN}` : `TRIAGE_RESULT: ${JSON.stringify(verdict)}`;
      const uuid = sent[0]?.uuid;
      yield { type: 'system', subtype: 'init', session_id: 'tri-1', model: 'claude-opus-5' };
      yield { type: 'assistant', user_message_uuid: uuid, session_id: 'tri-1', message: { role: 'assistant', content: [{ type: 'text', text }] } };
      yield {
        type: 'result', subtype: 'success', result: text, num_turns: 1, total_cost_usd: 0, session_id: 'tri-1',
        user_message_uuid: uuid, user_message_uuids: [uuid],
      };
      for (let i = 0; i < 500 && !closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  return seen;
}
const SIMPLE = { complexity: 'simple', reason: 'una línea', summary: 'A one line fix.' };
const COMPLEX = { complexity: 'complex', reason: 'toca varios módulos', summary: 'Varios módulos.' };
const issueOf = (task) => ({ number: task.issue, title: 'Titulo', labels: [], body: 'cuerpo' });

test('triagePhase: a simple verdict clears the plan of the previous cycle', async () => {
  routedSdk(SIMPLE);
  const task = freshTask('PLAN VIEJO de otro ciclo');
  await pipeline.PIPELINE_STEPS.triagePhase(task, issueOf(task));
  assert.equal(task.complexity, 'simple');
  assert.equal(task.advisorPlan, null);
});

test('triagePhase: a complex verdict stores the new plan from its heading, not the old one', async () => {
  routedSdk(COMPLEX);
  const task = freshTask('PLAN VIEJO de otro ciclo');
  await pipeline.PIPELINE_STEPS.triagePhase(task, issueOf(task));
  assert.equal(task.complexity, 'complex');
  assert.equal(task.advisorPlan, PLAN.trim());
});

test('changeRequestTriage: a simple review clears the plan of the previous cycle', async () => {
  routedSdk(SIMPLE);
  const task = freshTask('PLAN VIEJO de otro ciclo');
  const cr = {};
  const verdict = await pipeline.changeRequestTriage(task, cr, issueOf(task), { brief: 'BRIEF DEL REVISOR' });
  assert.equal(verdict.complexity, 'simple');
  assert.equal(cr.triageSummary, 'A one line fix.');
  assert.equal(task.advisorPlan, null);
});

test('changeRequestTriage: a complex review stores the new plan from its heading', async () => {
  const seen = routedSdk(COMPLEX);
  const task = freshTask('PLAN VIEJO de otro ciclo');
  await pipeline.changeRequestTriage(task, {}, issueOf(task), { brief: 'BRIEF DEL REVISOR' });
  assert.equal(task.advisorPlan, PLAN.trim());
  assert.ok(textOfSent(seen[0]).includes('BRIEF DEL REVISOR'), 'the triage sees the review');
});

test('#31 §6: a plan sealed in the turn where a subagent reported survives the CLI\'s acknowledgement turn', async () => {
  const sent = [];
  let closed = false;
  let sessions = 0;
  claudeHooks.query = ({ prompt }) => {
    sessions += 1;
    (async () => { for await (const m of prompt) sent.push(m); closed = true; })();
    return (async function* stream() {
      await tick();
      const uuid = sent[0]?.uuid;
      yield { type: 'system', subtype: 'init', session_id: 'adv-1', model: 'claude-opus-5' };
      yield { type: 'assistant', session_id: 'adv-1', user_message_uuid: uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'general-purpose', run_in_background: true } }] } };
      yield { type: 'system', subtype: 'task_started', task_id: 't1', description: 'probe', task_type: 'local_agent', subagent_type: 'general-purpose', tool_use_id: 'a1', is_backgrounded: true };
      yield { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'listo' };
      yield { type: 'result', subtype: 'success', result: PLAN, num_turns: 2, total_cost_usd: 0, session_id: 'adv-1', user_message_uuid: uuid, user_message_uuids: [uuid] };
      // The CLI's own turn for the report, which the net adopts.
      yield { type: 'system', subtype: 'init', session_id: 'adv-1', model: 'claude-opus-5' };
      yield { type: 'result', subtype: 'success', result: 'Background agent completed: PONG received.', num_turns: 1, total_cost_usd: 0, session_id: 'adv-1' };
      for (let i = 0; i < 500 && !closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  const task = freshTask();
  await pipeline.advisorPlanFor(task, { advise: adviseOf(), prompt: 'planea', onEvent: () => {} });
  assert.equal(task.advisorPlan, PLAN, 'the sealed plan, not the acknowledgement');
  assert.equal(sessions, 1, 'no retry bought over a plan that was already there');
  assert.match(logOf(task), /using the sealed text/, 'the guard leaves a line in the log, which is how it is counted');
});

// #31 g4: the source-reading test is gone, so the sessions that have a seam are
// checked by behaviour instead: the options the SDK receives carry the gate.
test('the PR body session carries the gh gate and the foreground-subagent hook', async () => {
  const seen = fakeSdk(['x']);
  await pipeline.composePrBody(freshTask(), { number: 1, title: 't', body: 'b' }).catch(() => {});
  assert.ok(seen.length >= 1, 'the body session opened');
  const matchers = (seen[0].options.hooks?.PreToolUse ?? []).map((m) => m.matcher);
  assert.deepEqual(matchers, ['Bash', 'Artifact|ArtifactComments|ArtifactData', 'Agent|Task']);
});
