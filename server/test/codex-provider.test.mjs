import './isolate.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexHooks, runCodex, codexThreadId, codexEvent } from '../src/agents/codex.js';
import { providerFor } from '../src/agents/index.js';

const worktree = mkdtempSync(path.join(tmpdir(), 'hfsmon-codex-provider-'));
const orig = codexHooks.create;
after(() => {
  codexHooks.create = orig;
  rmSync(worktree, { force: true, recursive: true });
});

const usage = { input_tokens: 120, output_tokens: 30, cached_input_tokens: 0, reasoning_output_tokens: 5 };
const fakeStream = (events) => async function* () { for (const e of events) yield e; };
const machine = { kind: 'local' };

test('Claude remains the default and Codex is selectable only in triage', () => {
  assert.equal(providerFor('triage', null, {}), 'claude');
  assert.equal(providerFor('triage', null, { agents: { phases: { triage: 'codex' } } }), 'codex');
  assert.throws(() => providerFor('fix', null, { agents: { phases: { fix: 'codex' } } }), /not yet supported/);
  assert.throws(() => providerFor('triage', 'claude-abc', { agents: { phases: { triage: 'codex' } } }), /Claude thread/);
  assert.throws(() => providerFor('triage', 'codex:abc123456', { agents: { phases: { triage: 'claude' } } }), /Codex thread/);
  assert.throws(() => providerFor('triage', null, { agents: { phases: { triage: 'other' } } }), /Unknown/);
});

test('Codex session ids are namespaced and strictly validated', () => {
  assert.equal(codexThreadId(null), null);
  assert.equal(codexThreadId('codex:session-12345'), 'session-12345');
  assert.throws(() => codexThreadId('claude:12345'), /Cannot resume/);
  assert.throws(() => codexThreadId('codex:../../credentials'), /Invalid/);
});

test('read-only streaming triage yields Claude-compatible result and activity events', async () => {
  let options;
  const seen = [];
  codexHooks.create = async () => ({
    startThread(o) {
      options = o;
      return {
        id: 'session-12345',
        runStreamed: async (_prompt, turnOptions) => {
          assert.equal(_prompt, 'Triaging issue');
          assert.ok(turnOptions.signal instanceof AbortSignal);
          return { events: fakeStream([
            { type: 'thread.started', thread_id: 'session-12345' },
            { type: 'item.started', item: { id: 'tool-1', type: 'command_execution', command: 'git status', status: 'in_progress', aggregated_output: '' } },
            { type: 'item.completed', item: { id: 'tool-1', type: 'command_execution', command: 'git status', status: 'completed', exit_code: 0, aggregated_output: 'clean' } },
            { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'TRIAGE_RESULT: {"complexity":"simple"}' } },
            { type: 'turn.completed', usage },
          ])() };
        },
      };
    },
  });
  const r = await runCodex({ machine, cwd: worktree, prompt: 'Triaging issue', model: 'gpt-6', onEvent: (ev) => seen.push(ev) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.quota, false);
  assert.equal(r.sessionId, 'codex:session-12345');
  assert.match(r.resultText, /TRIAGE_RESULT/);
  assert.equal(r.toolCounts.Bash, 1);
  assert.equal(r.stats.tokens, 150);
  assert.deepEqual(options, {
    workingDirectory: worktree, sandboxMode: 'read-only', approvalPolicy: 'never',
    networkAccessEnabled: false, model: 'gpt-6',
  });
  assert.deepEqual(seen.map((e) => e.kind), ['init', 'tool', 'tool_end', 'text', 'result']);
  assert.equal(seen[0].provider, 'codex');
});

test('resumeThread reuses a namespaced Codex thread and the same sandbox', async () => {
  let resumeId;
  let resumeOptions;
  codexHooks.create = async () => ({
    startThread() { throw new Error('must resume'); },
    resumeThread(id, opts) {
      resumeId = id;
      resumeOptions = opts;
      return {
        id,
        runStreamed: async () => ({ events: fakeStream([
          { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'repaired answer' } },
          { type: 'turn.completed', usage },
        ])() }),
      };
    },
  });
  const r = await runCodex({ machine, cwd: worktree, prompt: 'try again', resume: 'codex:session-54321' });
  assert.equal(r.ok, true, r.error);
  assert.equal(resumeId, 'session-54321');
  assert.equal(r.sessionId, 'codex:session-54321');
  assert.equal(resumeOptions.sandboxMode, 'read-only');
});

test('stream errors and failed turns must never report success', async () => {
  for (const events of [
    [{ type: 'error', message: 'account unavailable' }],
    [{ type: 'turn.failed', error: { message: 'limit reached' } }],
    [{ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'partial' } }],
    [{ type: 'turn.completed', usage }],
  ]) {
    codexHooks.create = async () => ({
      startThread: () => ({ runStreamed: async () => ({ events: fakeStream(events)() }) }),
    });
    const r = await runCodex({ machine, cwd: worktree, prompt: 'triage' });
    assert.equal(r.ok, false);
    assert.match(r.error, /account unavailable|limit reached|completed turn/i);
  }
});

test('pilot refuses remote runners and missing directories before launching SDK', async () => {
  codexHooks.create = () => { throw new Error('SDK should not be loaded'); };
  const remote = await runCodex({ machine: { kind: 'runner' }, cwd: worktree, prompt: 'hi' });
  assert.equal(remote.ok, false);
  assert.match(remote.error, /only supports local worktrees/);
  const bad = await runCodex({ machine, cwd: '/does/not/exist/live-monitor', prompt: 'hi' });
  assert.equal(bad.ok, false);
});

test('sensitive reasoning is not emitted; command results preserve their status', () => {
  const seen = [];
  const counts = Object.create(null);
  codexEvent({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'private' } }, (e) => seen.push(e), counts);
  codexEvent({ type: 'item.started', item: { id: 'x', type: 'file_change', changes: [{ path: 'src/a', kind: 'update' }], status: 'completed' } }, (e) => seen.push(e), counts);
  codexEvent({ type: 'item.completed', item: { id: 'x', type: 'file_change', changes: [{ path: 'src/a', kind: 'update' }], status: 'completed' } }, (e) => seen.push(e), counts);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].name, 'Edit');
  assert.equal(seen[1].ok, true);
  assert.equal(counts.Edit, 1);
});
