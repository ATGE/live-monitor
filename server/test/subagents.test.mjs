import './isolate.mjs';   // primero: aisla el directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { projectSlug, transcriptCandidates, parseAgentTranscript } from '../src/subagents.js';
import { newActivity, applyEvent, treeFor, mergeAgentCalls, MAX_AGENT_CHILDREN } from '../src/activity.js';

// Lines shaped like the real transcript of #937's agent (2026-09-13), trimmed.
const line = (o) => JSON.stringify({ isSidechain: true, agentId: 'a597', sessionId: 's1', ...o });
const TRANSCRIPT = [
  line({ type: 'user', timestamp: '2026-09-13T19:19:24Z', message: { role: 'user', content: 'implement (vi)' } }),
  line({ type: 'assistant', timestamp: '2026-09-13T19:19:28Z', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'git status', description: 'Check worktree status' } }] } }),
  line({ type: 'user', timestamp: '2026-09-13T19:19:29Z', toolUseResult: { stdout: 'clean\n', stderr: '' }, message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'clean' }] } }),
  line({ type: 'assistant', timestamp: '2026-09-13T19:30:27Z', message: { content: [{ type: 'tool_use', id: 'c2', name: 'Edit', input: { file_path: 'src/fetcher.rs', old_string: 'a', new_string: 'b' } }] } }),
  line({ type: 'user', timestamp: '2026-09-13T19:30:28Z', message: { content: [{ type: 'tool_result', tool_use_id: 'c2', is_error: true, content: [{ type: 'text', text: 'String not found' }] }] } }),
  line({ type: 'assistant', timestamp: '2026-09-13T19:49:07Z', message: { content: [{ type: 'tool_use', id: 'c3', name: 'Bash', input: { command: 'cargo check', run_in_background: true } }] } }),
  '{ roto',
].join('\n');

test('el transcript de un subagente se lee como llamadas del árbol', () => {
  const calls = parseAgentTranscript(TRANSCRIPT, { agentRunning: true });
  assert.deepEqual(calls.map((c) => [c.id, c.kind, c.status]), [['c1', 'bash', 'done'], ['c2', 'tool', 'error'], ['c3', 'bash', 'running']]);
  assert.equal(calls[0].command, 'git status');
  assert.equal(calls[0].summary, 'Check worktree status');
  assert.equal(calls[0].output, 'clean\n');
  assert.equal(calls[0].endedAt, '2026-09-13T19:19:29Z');
  assert.equal(calls[1].summary, 'src/fetcher.rs');
  assert.equal(calls[1].output, 'String not found');
  assert.equal(calls[2].background, true);
  assert.equal(parseAgentTranscript(TRANSCRIPT, { agentRunning: false })[2].status, 'stopped', 'sin resultado y el agente parado: detenida, no girando');
});

test('las rutas candidatas siguen el nombre de proyecto del CLI, con la letra de unidad en los dos casos', () => {
  assert.equal(projectSlug('C:\\Users\\you\\src\\heliossoftware\\hfs-wt\\feat-937-manual-test-pass-sqlite'), 'C--Users-you-src-heliossoftware-hfs-wt-feat-937-manual-test-pass-sqlite');
  assert.equal(projectSlug('/home/user/src/hfs-wt/fix-1078'), '-home-user-src-hfs-wt-fix-1078');
  const win = transcriptCandidates({ home: 'C:\\Users\\you', cwd: 'C:\\wt\\937', sessionIds: ['s1'], agentId: 'a597', join: path.win32.join });
  assert.deepEqual(win, [
    'C:\\Users\\you\\.claude\\projects\\C--wt-937\\s1\\subagents\\agent-a597.jsonl',
    'C:\\Users\\you\\.claude\\projects\\c--wt-937\\s1\\subagents\\agent-a597.jsonl',
  ]);
  const box = transcriptCandidates({ home: '/home/user', cwd: '/home/user/src/hfs-wt/fix-1078', sessionIds: ['s9', null], agentId: 'b1', join: path.posix.join });
  assert.deepEqual(box, ['/home/user/.claude/projects/-home-user-src-hfs-wt-fix-1078/s9/subagents/agent-b1.jsonl']);
});

test('una llamada de un subagente va al árbol que tiene a su agente, aunque ese turno ya terminara', () => {
  const launch = newActivity('t1');
  applyEvent(launch, { kind: 'tool', id: 'ag', name: 'Agent', parentId: null, input: 'general-purpose: implement', args: { subagent_type: 'general-purpose' } });
  const later = newActivity('t2');
  applyEvent(later, { kind: 'tool', id: 'main1', name: 'Bash', parentId: null, input: 'check', args: { command: 'ls' } });

  const child = { kind: 'tool', id: 'c9', name: 'Read', parentId: 'ag', input: 'x.rs', args: {} };
  // No turn open: before, this went nowhere.
  assert.equal(treeFor(null, [launch, later], child), launch);
  // Another turn open: before, it landed there as the main thread's call.
  assert.equal(treeFor(later, [launch, later], child), launch);
  applyEvent(launch, child);
  assert.equal(launch.items[0].children[0].id, 'c9', 'colgada de su agente');
  assert.equal(later.items.length, 1, 'el turno de después no la recibe');

  // Its end finds it by its own id; a main-thread call of the open turn stays there.
  assert.equal(treeFor(later, [launch, later], { kind: 'tool_end', id: 'c9' }), launch);
  assert.equal(treeFor(later, [launch, later], { kind: 'tool', id: 'main2', name: 'Bash', parentId: null }), later);
  // The agent's narration too.
  assert.equal(treeFor(null, [launch, later], { kind: 'text', text: 'leyendo', parentId: 'ag' }), launch);
});

test('cada agente guarda sus últimas llamadas y cuenta las que salen, sin tocar el tope del turno', () => {
  const a = newActivity('t');
  applyEvent(a, { kind: 'tool', id: 'ag', name: 'Agent', parentId: null, input: 'x', args: {} });
  let last = null;
  for (let n = 1; n <= MAX_AGENT_CHILDREN + 42; n += 1) {
    last = applyEvent(a, { kind: 'tool', id: `c${n}`, name: 'Bash', parentId: 'ag', input: `paso ${n}`, args: { command: 'x' } });
  }
  const agent = a.items[0];
  assert.equal(agent.children.length, MAX_AGENT_CHILDREN);
  assert.equal(agent.hiddenChildren, 42);
  assert.equal(agent.children[0].id, 'c43', 'se van las más viejas');
  assert.equal(last.item, agent, 'al recortar viaja el agente entero, para que el panel también recorte');
  assert.equal(a.dropped, 0, 'nada se descarta en silencio');
});

test('rellenar desde el transcript añade lo que faltó, cierra lo que terminó, y respeta el tope', () => {
  const a = newActivity('t');
  applyEvent(a, { kind: 'tool', id: 'ag', name: 'Agent', parentId: null, input: 'x', args: {} });
  applyEvent(a, { kind: 'tool', id: 'c1', name: 'Bash', parentId: 'ag', input: 'Check worktree status', args: { command: 'git status' } });
  const agent = a.items[0];
  const calls = parseAgentTranscript(TRANSCRIPT, { agentRunning: true });
  const r = mergeAgentCalls(agent, calls);
  assert.deepEqual(r, { added: 2, total: 3, hidden: 0 });
  assert.deepEqual(agent.children.map((c) => c.id), ['c1', 'c2', 'c3']);
  assert.equal(agent.children[0].status, 'done', 'la que seguía corriendo en el árbol queda cerrada por el transcript');
  assert.deepEqual(mergeAgentCalls(agent, calls), { added: 0, total: 3, hidden: 0 }, 'idempotente');
  const tight = mergeAgentCalls(agent, calls, { keep: 2 });
  assert.equal(tight.hidden, 1);
  assert.deepEqual(agent.children.map((c) => c.id), ['c2', 'c3']);
  // With calls scrolled out, reopening must not report them as recovered again
  // (measured on #937: the second backfill said «42 recuperadas»).
  assert.deepEqual(mergeAgentCalls(agent, calls, { keep: 2 }), { added: 0, total: 3, hidden: 1 });
});
