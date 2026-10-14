// The install gate at the real call sites.
//
// `installgate-wiring.test.mjs` calls `ghGateHooks(task, phase)` itself, so it
// cannot notice a call site that passes the wrong stage. These drive the real
// sessions (triage, its verdict re-ask, the change-request triage, both advisor
// sessions, the fix) through the SDK seam and fire the Bash hook each one was
// handed with an install: denied in the first five, allowed in the fix.
import './isolate.mjs';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './teardown.mjs';

process.env.HFSMON_NO_AUTOSTART = '1';

const { store } = await import('../src/store.js');
const { claudeHooks } = await import('../src/claude.js');
const pipeline = await import('../src/pipeline.js');
const { ADVISOR_PLAN_HEADING } = await import('../src/advisorplan.js');

const original = claudeHooks.query;
afterEach(() => { claudeHooks.query = original; });

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const PLAN = `${ADVISOR_PLAN_HEADING}\n\n${'Enfoque, archivos y orden, partes en paralelo y riesgos a vigilar. '.repeat(10)}`.trim();
const SIMPLE = { complexity: 'simple', reason: 'una línea', summary: 'A one line fix.' };
const COMPLEX = { complexity: 'complex', reason: 'toca varios módulos', summary: 'Varios módulos.' };

/** One fake session per ask; `textFor(asked, n)` says what the n-th one answers. */
function sdk(textFor) {
  const seen = [];
  claudeHooks.query = ({ prompt, options }) => {
    const sent = [];
    let closed = false;
    (async () => { for await (const m of prompt) sent.push(m); closed = true; })();
    const n = seen.length;
    seen.push({ options, sent });
    return (async function* stream() {
      await tick();
      const asked = String(sent[0]?.message?.content ?? '');
      const text = textFor(asked, n);
      const uuid = sent[0]?.uuid;
      yield { type: 'system', subtype: 'init', session_id: `cs-${n}`, model: 'claude-opus-5' };
      yield { type: 'assistant', user_message_uuid: uuid, session_id: `cs-${n}`, message: { role: 'assistant', content: [{ type: 'text', text }] } };
      yield {
        type: 'result', subtype: 'success', result: text, num_turns: 1, total_cost_usd: 0, session_id: `cs-${n}`,
        user_message_uuid: uuid, user_message_uuids: [uuid],
      };
      for (let i = 0; i < 500 && !closed; i += 1) await new Promise((r) => { setTimeout(r, 1); });
    })();
  };
  return seen;
}
const routed = (verdict) => (asked) => (asked.includes(ADVISOR_PLAN_HEADING) ? PLAN : `TRIAGE_RESULT: ${JSON.stringify(verdict)}`);

let n = 9900;
function freshTask() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = `/wt/${n}`;
  return task;
}
const issueOf = (task) => ({ number: task.issue, title: 'Titulo', labels: [], body: 'cuerpo' });

/** What the Bash hook of a session says to an install. */
async function decisionFor(options, command = 'npm ci') {
  const matcher = options?.hooks?.PreToolUse?.[0];
  assert.equal(matcher?.matcher, 'Bash', 'the session carries the Bash gate first');
  const out = await matcher.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  return out?.hookSpecificOutput?.permissionDecision ?? 'allow';
}
const gateFailed = (task) => task.log.some((l) => /gate failed on this command/.test(l.line));

async function assertAllDenied(seen, task, what) {
  assert.ok(seen.length >= 1, `${what}: no session opened`);
  for (const [i, s] of seen.entries()) {
    assert.equal(await decisionFor(s.options), 'deny', `${what}: session ${i} lets an install through`);
  }
  assert.equal(gateFailed(task), false, `${what}: the gate failed instead of denying`);
}

test('the triage session denies an install', async () => {
  const seen = sdk(routed(SIMPLE));
  const task = freshTask();
  await pipeline.PIPELINE_STEPS.triagePhase(task, issueOf(task));
  await assertAllDenied(seen, task, 'triagePhase');
});

test('the verdict re-ask of the triage denies an install', async () => {
  const seen = sdk(routed(SIMPLE));
  const task = freshTask();
  const out = await pipeline.triageVerdictFor(task, { ok: true, sessionId: 'first-0', resultText: 'sin veredicto' });
  assert.equal(out.path, 'reasked', 'the second ask is the one that ran');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.resume, 'first-0');
  assert.equal(seen[0].options.maxTurns, 3);
  await assertAllDenied(seen, task, 'triageVerdictFor');
});

test('the change-request triage denies an install', async () => {
  const seen = sdk(routed(SIMPLE));
  const task = freshTask();
  await pipeline.changeRequestTriage(task, {}, issueOf(task), { brief: 'BRIEF DEL REVISOR' });
  await assertAllDenied(seen, task, 'changeRequestTriage');
});

test('both advisor sessions deny an install', async () => {
  const seen = sdk((asked, i) => (i === 0 ? 'the subagents are still running; I continue when their reports arrive' : PLAN));
  const task = freshTask();
  await pipeline.advisorPlanFor(task, { advise: { model: 'opus' }, prompt: 'planea', onEvent: () => {} });
  assert.equal(seen.length, 2, 'the first ask and its resumed ask');
  assert.ok(seen[1].options.resume, 'the second session is the resumed one');
  await assertAllDenied(seen, task, 'advisorPlanFor');
});

test('a complex triage reaches the advisor, and that session denies too', async () => {
  const seen = sdk(routed(COMPLEX));
  const task = freshTask();
  await pipeline.PIPELINE_STEPS.triagePhase(task, issueOf(task));
  assert.ok(seen.length >= 2, 'triage plus advisor');
  await assertAllDenied(seen, task, 'triagePhase + advisor');
});

test('the fix session allows the same install', async () => {
  const task = freshTask();
  task.machine = 'local';
  task.branch = `fix/${task.issue}-x`;
  task.worktreePath = tempDir(`hfsmon-gate-${task.issue}-`);
  task.complexity = 'simple';
  task.approvePlan = 'off';
  const seen = [];
  const saved = pipeline.fixHooks.runClaude;
  pipeline.fixHooks.runClaude = async (options) => {
    seen.push(options);
    return { ok: false, quota: false, sessionId: 's1', resultText: '', toolCounts: {}, stats: { subtype: 'error_max_turns' } };
  };
  try {
    // What the phase does after the session is not the point here.
    await pipeline.fixPhaseOf(task, { number: task.issue, title: task.title, body: 'x' }).catch(() => {});
  } finally {
    pipeline.fixHooks.runClaude = saved;
  }
  const fix = seen.find((o) => o.maxTurns === pipeline.MAX_TURNS_DEFAULT.fix);
  assert.ok(fix, `no fix session: ${JSON.stringify(seen.map((o) => o.maxTurns))}`);
  assert.equal(await decisionFor(fix), 'allow');
  assert.equal(await decisionFor(fix, 'bash -c "npm ci"'), 'allow');
  // An allow from a gate that threw would look the same: it must not have.
  assert.equal(gateFailed(task), false);
  // And the same hook machinery does deny where it is told to.
  assert.equal(await decisionFor({ hooks: pipeline.ghGateHooks(task, 'triage') }), 'deny');
});
