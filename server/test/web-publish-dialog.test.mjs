import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';
const E = (p) => { const v = p.split('.').reduce((o, k) => o?.[k], es); assert.equal(typeof v, 'string', `missing es key ${p}`); return v; };

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const question = read('web', 'src', 'components', 'QuestionDialog.jsx');
const confirm = read('web', 'src', 'components', 'PublishConfirm.jsx');

test('QuestionDialog routes the gate question to PublishConfirm', () => {
  assert.match(question, /isPublishQuestion\(props\.questions\)/);
  assert.match(question, /<PublishConfirm \{\.\.\.props\} \/>/);
  assert.match(question, /<ChoiceDialog \{\.\.\.props\} \/>/);
});

test('the choice dialog keeps its Otro and skip, on the btn system', () => {
  assert.match(question, /t\.chat\.question\.skip\}/);
  assert.match(question, /t\.chat\.question\.otherLabel/);
  assert.equal(E('chat.question.skip'), 'Que decida Claude');
  assert.equal(E('chat.question.otherLabel'), 'Otro');
  assert.doesNotMatch(question, /Que decida Claude|>Otro</);
  assert.doesNotMatch(question, /className="(ghost|primary) /);
});

test('PublishConfirm is a risk alertdialog answering with the server labels', () => {
  assert.match(confirm, /PUBLISH_YES/);
  assert.match(confirm, /PUBLISH_NO/);
  assert.match(confirm, /role="alertdialog"/);
  assert.match(confirm, /tone="danger"/);
  assert.match(confirm, /PUBLISH_COPY\.destination/);
  assert.match(confirm, /dismissLabel=\{t\.chat\.publish\.dismiss\}/);
  assert.equal(E('chat.publish.dismiss'), 'Cerrar (Esc): la pregunta sigue pendiente');
  // The answer value is the wire label; the visible text is the catalog's.
  assert.match(confirm, /answer\(PUBLISH_NO\)/);
  assert.match(confirm, /answer\(PUBLISH_YES\)/);
  assert.match(confirm, /\{t\.chat\.publish\.yes\}/);
  assert.match(confirm, /\{t\.common\.no\}/);
  assert.equal(E('chat.publish.yes'), 'Sí, publicar');
  assert.equal(E('common.no'), 'No');
  assert.doesNotMatch(confirm, />\s*(?:Sí, publicar|No)\s*</);
});

test('«No» has the initial focus and there is no way out but the two answers', () => {
  assert.match(confirm, /className="pub-answer pub-no" autoFocus/);
  assert.doesNotMatch(confirm, /autoFocus[^>]*pub-yes|pub-yes[^>]*autoFocus/);
  assert.doesNotMatch(confirm, /Otro|Que decida Claude|onSkip/);
  assert.match(confirm, /btn-danger-solid/);
});

test('both answers are disabled while submitting', () => {
  assert.equal((confirm.match(/disabled=\{submitting\}/g) || []).length, 2);
});

test('the close button is the Dialog one alone: no second one, no nested header', () => {
  assert.doesNotMatch(confirm, /pub-close/);
  assert.doesNotMatch(confirm, /<header/);
  assert.match(confirm, /<div className="pub-head">/);
  assert.doesNotMatch(read('web', 'src', 'styles', 'publish.css'), /pub-close/);
});
