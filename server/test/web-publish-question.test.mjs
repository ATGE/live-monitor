import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';
const E = (p) => { const v = p.split('.').reduce((o, k) => o?.[k], es); assert.equal(typeof v, 'string', `missing es key ${p}`); return v; };

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const P = await import(pathToFileURL(path.join(ROOT, 'web', 'src', 'publishQuestion.js')).href);
const gate = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'artifactgate.js')).href);
const { artifactQuestion } = gate;

const real = artifactQuestion('Artifact', { action: 'publish', title: 'sql-export — nombres de descarga' });

test('the labels are the ones the server reads', () => {
  assert.equal(P.PUBLISH_YES, gate.CONFIRM_LABEL);
  assert.equal(P.PUBLISH_NO, gate.REFUSE_LABEL);
  assert.equal(P.PUBLISH_YES, 'Yes, publish');
});

test('the Spanish catalog keeps the visible labels apart from the wire values', () => {
  assert.equal(E('chat.publish.yes'), 'Sí, publicar');
  assert.equal(E('common.no'), 'No');
  assert.equal(P.PUBLISH_COPY.yesLabel, E('shared.publish.yesLabel'));
});

test('the legacy Spanish confirm label is still accepted', () => {
  const q = real.questions[0];
  const legacy = [{ ...q, options: [{ ...q.options[0], label: 'Sí, publicar' }, q.options[1]] }];
  assert.equal(P.isPublishQuestion(legacy), true);
  assert.equal(gate.isConfirmLabel('Sí, publicar'), true);
});

test('publishTarget accepts both the English and the Spanish question', () => {
  const en = [{ question: 'Allow Claude to run Artifact publish (\u00abt\u00bb)?' }];
  assert.deepEqual(P.publishTarget(en), { tool: 'Artifact', action: 'publish', title: 't' });
  const spanish = [{ question: '\u00bfPermites que Claude ejecute Artifact publish (\u00abt\u00bb)?' }];
  assert.deepEqual(P.publishTarget(spanish), { tool: 'Artifact', action: 'publish', title: 't' });
});

test('isPublishQuestion accepts the shape artifactQuestion produces', () => {
  assert.equal(P.isPublishQuestion(real.questions), true);
});

test('isPublishQuestion rejects anything else', () => {
  const q = real.questions[0];
  assert.equal(P.isPublishQuestion([{ ...q, header: 'Otro' }]), false);
  assert.equal(P.isPublishQuestion([{ ...q, options: [...q.options, { label: 'Quizá' }] }]), false);
  assert.equal(P.isPublishQuestion([{ ...q, options: q.options.slice(0, 1) }]), false);
  assert.equal(P.isPublishQuestion([{ ...q, options: [{ label: 'Sí' }, { label: 'No' }] }]), false);
  assert.equal(P.isPublishQuestion([{ ...q, multiSelect: true }]), false);
  assert.equal(P.isPublishQuestion([q, q]), false);
  assert.equal(P.isPublishQuestion([]), false);
  assert.equal(P.isPublishQuestion(undefined), false);
  assert.equal(P.isPublishQuestion(null), false);
});

test('publishTarget parses tool, action and title', () => {
  assert.deepEqual(P.publishTarget(real.questions), {
    tool: 'Artifact', action: 'publish', title: 'sql-export — nombres de descarga',
  });
});

test('publishTarget without a title', () => {
  const q = artifactQuestion('Artifact', { action: 'publish' });
  assert.deepEqual(P.publishTarget(q.questions), { tool: 'Artifact', action: 'publish', title: null });
});

test('publishTarget with another action', () => {
  const q = artifactQuestion('Artifact', { action: 'delete', url: 'https://claude.ai/artifact/abc' });
  const t = P.publishTarget(q.questions);
  assert.equal(t.tool, 'Artifact');
  assert.equal(t.action, 'delete');
  assert.equal(t.title, 'https://claude.ai/artifact/abc');
});

test('publishTarget returns null for text it does not recognise', () => {
  assert.equal(P.publishTarget([{ question: 'otra cosa' }]), null);
  assert.equal(P.publishTarget([]), null);
  assert.equal(P.publishTarget(undefined), null);
});

test('PUBLISH_COPY has the plan strings', () => {
  assert.equal(P.PUBLISH_COPY.title, '¿Publicar este lienzo en tu cuenta?');
  assert.equal(P.PUBLISH_COPY.otherTitle('Artifact', 'delete'), '¿Permites Artifact delete en tu cuenta?');
  assert.match(P.PUBLISH_COPY.canvasAria('X'), /^X \(lienzo de Claude Design/);
});
