// #31 §6: the validators read the adopted text, and the sealed one when a
// later turn replaced a good answer with an acknowledgement.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerOf, substantialAnswerOf } from '../src/sealedanswer.js';

const longEnough = (t) => t.length > 20;

test('the adopted text wins when it validates, whatever the sealed one says', () => {
  assert.equal(answerOf({ resultText: 'x'.repeat(30), sealedText: 'y'.repeat(40) }, longEnough), 'x'.repeat(30));
});

test('a sealed text that validates replaces an adopted one that does not', () => {
  assert.equal(answerOf({ resultText: 'ack', sealedText: 'y'.repeat(40) }, longEnough), 'y'.repeat(40));
});

test('with neither validating, the adopted text stays (the retry complains about it)', () => {
  assert.equal(answerOf({ resultText: 'ack', sealedText: 'also short' }, longEnough), 'ack');
});

test('a result with no sealedText is read as it is, and a missing one is an empty string', () => {
  assert.equal(answerOf({ resultText: 'ack' }, longEnough), 'ack');
  assert.equal(answerOf({}, longEnough), '');
  assert.equal(answerOf(null, longEnough), '');
});

test('fallback texts are tried after the sealed one, in order, and the origin is reported', () => {
  const seen = [];
  const long = (c) => c.repeat(30);
  const r = { resultText: 'one sentence', sealedText: 'short', fallbackTexts: ['also short', long('a'), long('b')] };
  assert.equal(answerOf(r, longEnough, (o) => seen.push(o)), long('a'));
  assert.deepEqual(seen, ['fallback']);
  assert.equal(answerOf({ resultText: 'ack', sealedText: long('s'), fallbackTexts: [long('f')] }, longEnough, (o) => seen.push(o)), long('s'));
  assert.deepEqual(seen, ['fallback', 'sealed']);
});

test('with nothing validating among the fallbacks the adopted text stays, and nothing is reported', () => {
  const seen = [];
  assert.equal(answerOf({ resultText: 'one sentence', fallbackTexts: ['short'] }, longEnough, (o) => seen.push(o)), 'one sentence');
  assert.deepEqual(seen, []);
});

test('a replaced text is tried before the sealed one, and noted as sealed', () => {
  const seen = [];
  const r = { resultText: 'ok', replacedTexts: ['G'.repeat(30)], sealedText: 'S'.repeat(40) };
  assert.equal(answerOf(r, longEnough, (o) => seen.push(o)), 'G'.repeat(30));
  assert.deepEqual(seen, ['sealed']);
  assert.equal(answerOf({ ...r, replacedTexts: ['short'] }, longEnough), 'S'.repeat(40), 'an invalid replaced text is skipped');
});

test('substantialAnswerOf: an acknowledgement yields to a longer sealed text; the 200-char line is the threshold', () => {
  const ack = 'Background agent completed: PONG received.';
  const plan = 'P'.repeat(200);
  const seen = [];
  assert.equal(substantialAnswerOf({ resultText: ack, sealedText: plan }, (o) => seen.push(o)), plan);
  assert.deepEqual(seen, ['sealed']);
  assert.equal(substantialAnswerOf({ resultText: 'x'.repeat(199), sealedText: plan }), plan, '199 chars on one line is still an acknowledgement');
  assert.equal(substantialAnswerOf({ resultText: 'x'.repeat(200), sealedText: 'y'.repeat(300) }), 'x'.repeat(200), '200 chars is an answer');
  assert.equal(substantialAnswerOf({ resultText: 'uno\ndos', sealedText: plan }), 'uno\ndos', 'several lines is an answer');
  assert.equal(substantialAnswerOf({ resultText: ack }), ack, 'with nothing else the adopted text stays');
  assert.equal(substantialAnswerOf({ resultText: ack, sealedText: 'listo' }), ack, 'a sealed acknowledgement does not replace it');
});
