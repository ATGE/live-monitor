import './isolate.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './teardown.mjs';
import { codexBatchHooks, runCodexReadOnlyPlan } from '../src/agents/planning.js';
import { forkSessionForProvider, providerFor, runTaskAgent } from '../src/agents/index.js';

const original = codexBatchHooks.create;
const cwd = tempDir('hfsmon-codex-plan-');
after(() => { codexBatchHooks.create = original; });
const machine = { kind: 'local' };
const cfg = { agents: { phases: { plan: 'codex' }, codex: { reasoningEffort: 'high', timeoutMinutes: 2 } } };

test('planning stays Claude by default; only plan/triage/chat can opt in', () => {
  assert.equal(providerFor('plan', null, {}), 'claude');
  assert.equal(providerFor('plan', null, cfg), 'codex');
  assert.throws(() => providerFor('fix', null, { agents: { phases: { fix: 'codex' } } }), /not yet supported/);
  assert.throws(() => providerFor('qa', null, { agents: { phases: { qa: 'codex' } } }), /not yet supported/);
  assert.throws(() => providerFor('plan', 'claude-1234', cfg), /Claude thread/);
  assert.throws(() => providerFor('plan', 'codex:12345678', {}), /Codex thread/);
  assert.equal(providerFor('plan', 'codex:12345678', cfg), 'codex');
});

test('Codex planning plan record cannot be forked into Claude executor session', () => {
  assert.equal(forkSessionForProvider('codex:thread-12345678', 'claude'), null);
  assert.equal(forkSessionForProvider('claude-thread-12345678', 'claude'), 'claude-thread-12345678');
  assert.equal(forkSessionForProvider('codex:thread-12345678', 'codex'), 'codex:thread-12345678');
  assert.equal(forkSessionForProvider('claude-thread-12345678', 'codex'), null);
  assert.equal(forkSessionForProvider(null, 'claude'), null);
  assert.throws(() => forkSessionForProvider('codex:thread-12345678', 'unsupported'), /Unknown/);
});

test('pipeline guards every direct Claude resume from Codex chat session ids', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /resume: principalChat\(task\)\??\.sessionId/);
  assert.doesNotMatch(source, /forkFrom: chat\.sessionId/);
  assert.match(source, /forkFrom: forkSessionForProvider\(chat\.sessionId, 'claude'\)/);
});

test('a read-only planning turn ignores all Claude hooks and model aliases', async () => {
  let sessionOptions;
  let prompt;
  let closed = false;
  codexBatchHooks.create = (options) => {
    sessionOptions = options;
    return {
      async send(value) {
        prompt = value;
        return { ok: true, quota: false, sessionId: 'codex:thread-test',
          resultText: 'WORK_PLAN: {"tasks":[]}', toolCounts: { Bash: 1 } };
      },
      close() { closed = true; },
    };
  };
  const out = await runTaskAgent({
    machine, cwd, prompt: 'Plan without editing', model: 'opus', effort: 'high',
    canUseTool: () => { throw Error('Claude hook must never be called'); },
    hooks: { PreToolUse: [{ matcher: '*' }] },
  }, { stage: 'plan', cfg });
  assert.equal(out.ok, true);
  assert.equal(prompt, 'Plan without editing');
  assert.equal(out.sessionId, 'codex:thread-test');
  assert.equal(closed, true);
  assert.equal(sessionOptions.permissionMode, 'plan');
  assert.equal(sessionOptions.model, null);
  assert.equal(sessionOptions.effort, 'high');
  assert.equal(sessionOptions.idleMs, 0);
  assert.equal(sessionOptions.cwd, cwd);
  assert.equal(sessionOptions.machine, machine);
  assert.deepEqual(await sessionOptions.onApproval(), { decision: 'decline' });
  assert.equal('canUseTool' in sessionOptions, false);
  assert.equal('hooks' in sessionOptions, false);
});

test('Codex planning resumes the same thread and never forks Claude ids', async () => {
  let options;
  codexBatchHooks.create = (input) => {
    options = input;
    return { send: async () => ({ ok: true, sessionId: input.resume, resultText: 'updated', toolCounts: {} }), close() {} };
  };
  const r = await runTaskAgent({ machine, cwd, prompt: 'revise', resume: 'codex:thread-12345678' }, { stage: 'plan', cfg });
  assert.equal(r.ok, true);
  assert.equal(options.resume, 'codex:thread-12345678');
  assert.equal(options.forkSession, false);
});

test('remote runner and invalid worktree fail BEFORE creating an App Server', async () => {
  codexBatchHooks.create = () => { throw Error('unexpected process spawn'); };
  const remote = await runCodexReadOnlyPlan({ machine: { kind: 'runner' }, cwd, prompt: 'hi' });
  assert.equal(remote.ok, false);
  assert.match(remote.error, /local Incus worktree/);
  const relative = await runCodexReadOnlyPlan({ machine, cwd: '.', prompt: 'hi' });
  assert.equal(relative.ok, false);
  assert.match(relative.error, /absolute/);
  const missing = await runCodexReadOnlyPlan({ machine, cwd: '/nonexistent/repo', prompt: 'hi' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /does not exist/);
});

test('aborted signal before execution cannot spawn a provider', async () => {
  const ctl = new AbortController();
  ctl.abort();
  codexBatchHooks.create = () => { throw Error('unexpected process spawn'); };
  const r = await runCodexReadOnlyPlan({ machine, cwd, prompt: 'hi', signal: ctl.signal });
  assert.equal(r.ok, false);
  assert.match(r.error, /aborted before/);
});

test('an unresponsive planning session is forcibly closed on timeout', async () => {
  let closed = false;
  codexBatchHooks.create = () => {
    let resolve;
    return {
      send: () => new Promise((r) => { resolve = r; }),
      close() {
        closed = true;
        resolve?.({ ok: false, sessionId: null, resultText: '', toolCounts: {}, error: 'closed' });
      },
    };
  };
  const r = await runCodexReadOnlyPlan({ machine, cwd, prompt: 'hi', timeoutMs: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Codex planning timed out');
  assert.equal(closed, true);
});

test('failed App Server turn is returned as failure, never treated as a valid plan', async () => {
  let closed = false;
  codexBatchHooks.create = () => ({
    send: async () => ({ ok: false, quota: false, resultText: '', error: 'Codex turn failed', toolCounts: {} }),
    close: () => { closed = true; },
  });
  const r = await runCodexReadOnlyPlan({ machine, cwd, prompt: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Codex turn failed/);
  assert.equal(closed, true);
});
