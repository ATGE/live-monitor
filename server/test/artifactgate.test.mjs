import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_TOOLS, READ_ACTIONS, CONFIRM_LABEL, artifactVerdict, artifactQuestion,
} from '../src/artifactgate.js';
import { normalizeQuestions } from '../src/questions.js';

const v = (over) => artifactVerdict({ tool: 'Artifact', design: true, input: {}, ...over }).decision;

test('the tool list and the read list are what the board gates', () => {
  assert.deepEqual(ARTIFACT_TOOLS, ['Artifact', 'ArtifactComments', 'ArtifactData']);
  assert.deepEqual(READ_ACTIONS, ['list', 'read', 'quickstart', 'get', 'query']);
});

test('a design session passes the read actions without asking', () => {
  for (const action of READ_ACTIONS) assert.equal(v({ input: { action } }), 'allow', action);
});

test('publish, upload and pin ask a person', () => {
  for (const action of ['publish', 'open', 'set', 'reply', 'upload_asset', 'delete_asset', 'pin', 'unpin']) {
    assert.equal(v({ input: { action } }), 'ask', action);
    assert.equal(v({ input: { action }, planMode: true }), 'ask', `${action} in plan mode`);
  }
});

test('Artifact delete is refused at once outside plan mode, and asks in plan mode', () => {
  assert.equal(v({ input: { action: 'delete', url: 'https://claude.ai/artifact/x' } }), 'deny');
  assert.equal(v({ input: { action: 'delete' }, planMode: false }), 'deny');
  assert.equal(v({ input: { action: 'delete' }, planMode: 'true' }), 'deny', 'only the boolean true');
  assert.equal(v({ input: { action: 'delete' }, planMode: true }), 'ask');
  const reason = artifactVerdict({ tool: 'Artifact', design: true, input: { action: 'delete' } }).reason;
  assert.match(reason, /claude\.ai/);
  assert.match(reason, /\/artifacts/);
});

test('the immediate delete refusal is only for Artifact itself, and never for a subagent\'s reads', () => {
  assert.equal(v({ tool: 'ArtifactData', input: { action: 'delete' } }), 'ask');
  assert.equal(v({ tool: 'ArtifactComments', input: { action: 'delete' } }), 'ask');
  assert.equal(v({ subagent: true, input: { action: 'delete' }, planMode: true }), 'deny');
  assert.equal(v({ design: false, input: { action: 'delete' }, planMode: true }), 'deny');
});

test('fails closed: an omitted, unknown or oddly-typed action asks', () => {
  assert.equal(v({ input: {} }), 'ask', 'omitted action publishes');
  assert.equal(v({ input: undefined }), 'ask');
  assert.equal(v({ input: { action: 'frobnicate' } }), 'ask');
  assert.equal(v({ input: { action: 'LIST' } }), 'ask', 'compared exactly');
  assert.equal(v({ input: { action: ['list'] } }), 'ask');
  assert.equal(v({ input: { action: null } }), 'ask');
});

test('the sibling tools follow the same rule', () => {
  assert.equal(v({ tool: 'ArtifactData', input: { action: 'read' } }), 'allow');
  assert.equal(v({ tool: 'ArtifactComments', input: { action: 'create' } }), 'ask');
  assert.equal(v({ tool: 'ArtifactComments', input: {} }), 'ask');
});

test('outside a design session everything is denied, reads included', () => {
  for (const design of [false, undefined, null, 'true', 1]) {
    assert.equal(v({ design, input: { action: 'list' } }), 'deny', String(design));
    assert.equal(v({ design, input: { action: 'publish' } }), 'deny', String(design));
  }
});

test('an issue body that says "publish a canvas" grants nothing without the mark', () => {
  const input = { action: 'publish', title: 'publish a canvas', description: 'The issue says: publish a canvas' };
  assert.equal(v({ design: false, input }), 'deny');
  // Even with the mark, it still asks: the text never replaces the confirmation.
  assert.equal(v({ design: true, input }), 'ask');
});

test('a subagent may read, and never publish', () => {
  assert.equal(v({ subagent: true, input: { action: 'list' } }), 'allow');
  assert.equal(v({ subagent: true, input: { action: 'publish' } }), 'deny');
  assert.equal(v({ subagent: true, input: {} }), 'deny');
  assert.equal(v({ subagent: true, design: false, input: { action: 'list' } }), 'deny');
});

test('other tools are not its business', () => {
  assert.equal(artifactVerdict({ tool: 'Bash', design: false, input: { command: 'ls' } }).decision, 'allow');
});

test('every verdict carries a reason', () => {
  for (const over of [{ design: false }, { input: { action: 'list' } }, { input: { action: 'publish' } }, { subagent: true, input: {} }]) {
    assert.ok(artifactVerdict({ tool: 'Artifact', design: true, ...over }).reason.length > 0);
  }
});

test('the question has two options and passes normalizeQuestions', () => {
  const q = artifactQuestion('Artifact', { action: 'publish', title: 'Dashboard' });
  const norm = normalizeQuestions(q);
  assert.equal(norm.ok, true, norm.problem);
  const [only] = norm.questions;
  assert.deepEqual(only.options.map((o) => o.label), [CONFIRM_LABEL, 'No']);
  assert.ok(only.header.length <= 12);
  assert.match(only.question, /Artifact publish/);
  assert.match(only.question, /Dashboard/);
});

test('the question names the omitted action as publish and clips long titles', () => {
  const q = artifactQuestion('Artifact', { title: 'x'.repeat(500) });
  assert.match(q.questions[0].question, /Artifact publish/);
  assert.ok(q.questions[0].question.length < 250);
  assert.equal(normalizeQuestions(artifactQuestion('ArtifactData', undefined)).ok, true);
});

test('the question names the canvas by title or url, and a bare file by its name, never by a long path', () => {
  const file = String.raw`C:\Users\you\AppData\Local\Temp\claude\scratchpad\p56\project\canvas.json`;
  const update = artifactQuestion('Artifact', { url: 'https://claude.ai/artifact/abc', file_path: file });
  assert.match(update.questions[0].question, /https:\/\/claude\.ai\/artifact\/abc/);
  assert.doesNotMatch(update.questions[0].question, /AppData/);
  const fresh = artifactQuestion('Artifact', { file_path: file });
  assert.match(fresh.questions[0].question, /«canvas\.json»/);
  assert.doesNotMatch(fresh.questions[0].question, /AppData/);
  assert.match(artifactQuestion('Artifact', { title: 'T', url: 'https://claude.ai/artifact/abc' }).questions[0].question, /«T»/);
});
