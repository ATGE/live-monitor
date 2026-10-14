// Turn caps for the sessions that used to run with none: browser QA, the fix
// session and its plan tasks, and the chat's plan tasks. Generous, configurable
// under `limits.maxTurns.<role>`, and loud in the log when one is hit.
import './isolate.mjs';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDir } from './teardown.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HFSMON_NO_AUTOSTART = '1';

const { store } = await import('../src/store.js');
const { settings } = await import('../src/settings.js');
const pipeline = await import('../src/pipeline.js');
const { maxTurnsFor, MAX_TURNS_DEFAULT } = pipeline;

before(() => settings.update({ autoStart: false }));

test('the default is generous and the configuration overrides it per role', () => {
  for (const role of ['fix', 'qa', 'chatPlan']) {
    assert.ok(MAX_TURNS_DEFAULT[role] >= 200, `${role} default is a runaway cap, not a limit on normal work`);
    assert.equal(maxTurnsFor(role, {}), MAX_TURNS_DEFAULT[role]);
    assert.equal(maxTurnsFor(role, { limits: {} }), MAX_TURNS_DEFAULT[role]);
  }
  assert.equal(maxTurnsFor('qa', { limits: { maxTurns: { qa: 40 } } }), 40);
  assert.equal(maxTurnsFor('fix', { limits: { maxTurns: { qa: 40 } } }), MAX_TURNS_DEFAULT.fix, 'one role does not move another');
});

test('a configured value that is not a positive integer is ignored', () => {
  for (const bad of [0, -3, 2.5, '40', null, NaN]) {
    assert.equal(maxTurnsFor('fix', { limits: { maxTurns: { fix: bad } } }), MAX_TURNS_DEFAULT.fix, String(bad));
  }
});

test('every runClaude call of pipeline.js passes maxTurns', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pipeline.js'), 'utf8');
  // `nudgedSession(task, '<template>', {` is a runClaude call in a wrapper: it must stay watched.
  const calls = [...src.matchAll(/\b(?:fixHooks\.)?runClaude\(\{|\brun\(\{|\bnudgedSession\(task,\s*'[^']+',\s*\{/g)];
  assert.ok(calls.length >= 15, `found ${calls.length} calls`);
  const missing = [];
  for (const m of calls) {
    // The object literal of the call, by brace matching.
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end += 1) {
      if (src[end] === '{') depth += 1;
      else if (src[end] === '}' && --depth === 0) break;
    }
    const literal = src.slice(m.index, end);
    if (!/maxTurns|\.\.\.common/.test(literal)) missing.push(src.slice(0, m.index).split('\n').length);
  }
  assert.deepEqual(missing, [], `runClaude calls without a maxTurns, at lines ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The fix session: the cap travels, and hitting it is said.

let n = 13000;
function taskOf() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  return Object.assign(task, {
    machine: 'local', branch: `fix/${n}-x`, worktreePath: tempDir(`hfsmon-caps-${n}-`),
    complexity: 'simple', approvePlan: 'off',
  });
}

test('fixPhase passes the cap and logs a line when the session stops on it', async () => {
  const task = taskOf();
  const seen = [];
  const saved = pipeline.fixHooks.runClaude;
  pipeline.fixHooks.runClaude = async (options) => {
    seen.push(options);
    return { ok: false, quota: false, sessionId: 's1', resultText: '', toolCounts: {}, stats: { subtype: 'error_max_turns', turns: options.maxTurns } };
  };
  try {
    // What the phase does after the session is not the point here.
    await pipeline.fixPhaseOf(task, { number: task.issue, title: task.title, body: 'x' }).catch(() => {});
  } finally {
    pipeline.fixHooks.runClaude = saved;
  }
  const fix = seen.find((o) => o.maxTurns === MAX_TURNS_DEFAULT.fix);
  assert.ok(fix, `no fix session carried the cap: ${JSON.stringify(seen.map((o) => o.maxTurns))}`);
  const line = task.log.find((l) => l.phase === 'fix' && /reached the cap of \d+ turns/.test(l.line));
  assert.ok(line, JSON.stringify(task.log.map((l) => l.line)));
});

test('a session that ends normally logs nothing about the cap', async () => {
  const task = taskOf();
  const saved = pipeline.fixHooks.runClaude;
  pipeline.fixHooks.runClaude = async () => ({ ok: true, quota: false, sessionId: 's1', resultText: 'ok', toolCounts: {}, stats: { subtype: 'success' } });
  try {
    await pipeline.fixPhaseOf(task, { number: task.issue, title: task.title, body: 'x' }).catch(() => {});
  } finally {
    pipeline.fixHooks.runClaude = saved;
  }
  assert.equal(task.log.some((l) => /reached the cap of \d+ turns/.test(l.line)), false);
});
