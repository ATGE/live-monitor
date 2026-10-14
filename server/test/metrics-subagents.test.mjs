// aggregate().subagents: the share of tool calls that were subagents, per phase
// and stage, from session spans; and the CLI that reads it from a data directory.
import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../src/metrics.js';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const sp = (kind, name, start, len, meta = {}, extra = {}) => ({
  kind, name, startedAt: at(start), endedAt: len == null ? null : at(start + len), ms: len, attempt: 1, outcome: 'ok',
  meta: { cycle: 1, ...meta }, ...extra,
});
const task = (timings) => ({ createdAt: at(0), timings });

test('subagents: share per phase from meta.within, and a null within is the none bucket', () => {
  const t = task([
    sp('phase', 'triage', 0, 1000),
    sp('session', 'triage', 100, 500, { stage: 'triage', within: 'triage', toolCalls: 20, subagents: 2 }),
    sp('session', 'triage', 200, 100, { stage: 'triage', within: 'triage', toolCalls: 10, subagents: 0 }),
    sp('session', 'cr', 5000, 100, { stage: 'cr', within: null, toolCalls: 4, subagents: 0 }),
  ]);
  const { subagents } = aggregate([t]);
  assert.deepEqual(subagents.phases.triage, { sessions: 2, calls: 30, subagents: 2, share: 2 / 30, nudges: 0, nudgeMs: 0 });
  assert.equal(subagents.phases.none.sessions, 1);
  assert.equal(subagents.phases.none.share, 0);
  assert.equal(subagents.total.calls, 34);
  assert.equal(subagents.total.subagents, 2);
  assert.equal(subagents.total.share, 2 / 34);
});

test('subagents: an old span without within is placed by time containment in its own cycle', () => {
  const t = task([
    sp('phase', 'fixing', 0, 1000, {}),
    sp('phase', 'testing', 2000, 1000, { cycle: 2 }),
    sp('session', 'fix', 100, 500, { stage: 'fix', toolCounts: { Read: 3, Agent: 1 }, subagents: 1 }),
    // Starts inside the time of cycle 1's `fixing`, but belongs to cycle 2.
    sp('session', 'fix', 500, 100, { stage: 'fix', cycle: 2, toolCounts: { Bash: 2 }, subagents: 0 }),
    sp('session', 'x', 9000, 100, { stage: 'x', toolCounts: { Bash: 1 }, subagents: 0 }),
  ]);
  const { subagents } = aggregate([t]);
  assert.deepEqual(subagents.phases.fixing, { sessions: 1, calls: 4, subagents: 1, share: 0.25, nudges: 0, nudgeMs: 0 });
  assert.equal(subagents.phases.none.sessions, 2);
  assert.equal(subagents.phases.none.calls, 3);
});

test('subagents: a nudge span adds its calls and time but is not a session', () => {
  const t = task([
    sp('phase', 'triage', 0, 1000),
    sp('session', 'triage', 100, 300, { stage: 'triage', within: 'triage', toolCalls: 12, subagents: 0 }),
    sp('session', 'triage', 400, 250, { stage: 'triage', within: 'triage', nudge: true, toolCalls: 6, subagents: 3 }),
  ]);
  const { subagents } = aggregate([t]);
  assert.deepEqual(subagents.phases.triage, { sessions: 1, calls: 18, subagents: 3, share: 3 / 18, nudges: 1, nudgeMs: 250 });
  assert.equal(subagents.stages.triage.nudges, 1);
  assert.equal(subagents.total.nudgeMs, 250);
});

test('subagents: stages fold per-task suffixes of fix and plan', () => {
  const t = task([
    sp('session', 'fix:t1', 0, 10, { stage: 'fix:t1', within: 'fixing', toolCalls: 5, subagents: 0 }),
    sp('session', 'fix:t2', 0, 10, { stage: 'fix:t2', within: 'fixing', toolCalls: 5, subagents: 1 }),
    sp('session', 'plan:a', 0, 10, { stage: 'plan:a', within: 'triage', toolCalls: 1, subagents: 0 }),
    sp('session', 'qa', 0, 10, { stage: 'qa', within: 'testing', toolCalls: 1, subagents: 0 }),
  ]);
  const { subagents } = aggregate([t]);
  assert.deepEqual(Object.keys(subagents.stages).sort(), ['fix:*', 'plan:*', 'qa']);
  assert.equal(subagents.stages['fix:*'].sessions, 2);
  assert.equal(subagents.stages['fix:*'].share, 0.1);
});

test('subagents: chat turns count only when they recorded toolCalls', () => {
  const t = task([
    sp('chat', 'turn', 0, 10, { chatId: 'a', toolCalls: 50, subagents: 5 }),
    sp('chat', 'turn', 20, 10, { chatId: 'a' }),
  ]);
  const { subagents } = aggregate([t]);
  assert.deepEqual(subagents.chat, { sessions: 1, calls: 50, subagents: 5, share: 0.1, nudges: 0, nudgeMs: 0 });
  assert.equal(subagents.total.sessions, 0);
});

test('subagents: nothing to count gives zeros and a null share', () => {
  const empty = aggregate([]).subagents;
  assert.deepEqual(empty.total, { sessions: 0, calls: 0, subagents: 0, share: null, nudges: 0, nudgeMs: 0 });
  assert.deepEqual(empty.phases, {});
  assert.deepEqual(empty.stages, {});
  assert.equal(empty.chat.share, null);
  assert.equal(aggregate([{}]).subagents.total.calls, 0);
});

test('tools/metrics/subagents.mjs prints the share from a data directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'subagents-cli-'));
  try {
    const t = task([
      sp('phase', 'triage', 0, 1000),
      sp('session', 'triage', 100, 500, { stage: 'triage', within: 'triage', toolCalls: 20, subagents: 2 }),
    ]);
    writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([t]), 'utf8');
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'metrics', 'subagents.mjs');
    const text = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /triage/);
    assert.match(text.stdout, /10 %/);
    const json = spawnSync(process.execPath, [script, dir, '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(json.stdout).phases.triage.subagents, 2);
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
