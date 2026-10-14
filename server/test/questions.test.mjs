import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeQuestions, validateAnswers, isRecommended, bareLabel, sortRecommendedFirst,
  describeAnswers, boardQuestion, readBoardDecision,
} from '../src/questions.js';

const q = (over = {}) => ({
  question: '¿Qué enfoque?', header: 'Enfoque', multiSelect: false,
  options: [{ label: 'A (Recommended)', description: 'a' }, { label: 'B', description: 'b' }],
  ...over,
});

test('normaliza lo que manda el modelo y rechaza lo que no se puede dibujar', () => {
  const ok = normalizeQuestions({ questions: [q(), q({ question: '¿Otra?', header: 'Un header larguísimo', options: [{ label: 'x' }, { label: 'y', preview: '```\nz\n```' }] })] });
  assert.ok(ok.ok, ok.problem);
  assert.equal(ok.questions[1].header, 'Un header la', 'el chip se recorta a 12');
  assert.equal(ok.questions[1].options[1].preview, '```\nz\n```');
  assert.equal(ok.questions[1].options[0].preview, undefined);

  assert.match(normalizeQuestions({}).problem, /faltan/);
  assert.match(normalizeQuestions({ questions: [q(), q(), q(), q(), q()] }).problem, /como mucho 4/);
  assert.match(normalizeQuestions({ questions: [q({ options: [{ label: 'solo' }] })] }).problem, /entre 2 y 4/);
  assert.match(normalizeQuestions({ questions: [q({ question: ' ' })] }).problem, /no tiene texto/);
  assert.match(normalizeQuestions({ questions: [q(), q()] }).problem, /repetida/);
  assert.match(normalizeQuestions({ questions: [q({ options: [{ label: 'A' }, { label: 'A' }] })] }).problem, /repite/);
});

test('respuestas: etiqueta, texto libre («Otro»), lista en multiselección; nada vacío ni desconocido', () => {
  const { questions } = normalizeQuestions({ questions: [q(), q({ question: '¿Cuáles?', header: 'Cuáles', multiSelect: true })] });
  const good = validateAnswers(questions, { '¿Qué enfoque?': 'mi propia idea', '¿Cuáles?': ['A (Recommended)', 'otra cosa'] });
  assert.ok(good.ok, good.problem);
  assert.deepEqual(good.answers, { '¿Qué enfoque?': 'mi propia idea', '¿Cuáles?': ['A (Recommended)', 'otra cosa'] });

  assert.match(validateAnswers(questions, { '¿Qué enfoque?': 'A (Recommended)' }).problem, /Cuáles.*sin responder/);
  assert.match(validateAnswers(questions, { '¿Qué enfoque?': '', '¿Cuáles?': ['A'] }).problem, /Enfoque.*sin responder/);
  assert.match(validateAnswers(questions, { '¿Qué enfoque?': 'A', '¿Cuáles?': [], }).problem, /Cuáles.*sin responder/);
  assert.match(validateAnswers(questions, { '¿Qué enfoque?': 'A', '¿Cuáles?': ['B'], '¿Inventada?': 'x' }).problem, /no es una de las preguntas/);
  assert.match(validateAnswers(questions, null).problem, /no son un objeto/);
  const single = validateAnswers(questions, { '¿Qué enfoque?': ['B'], '¿Cuáles?': 'A' });
  assert.deepEqual(single.answers, { '¿Qué enfoque?': 'B', '¿Cuáles?': ['A'] }, 'una lista en simple toma la primera; un texto en múltiple se envuelve');
});

test('recomendada: en los dos idiomas, primero, y sin el sufijo en la tarjeta', () => {
  assert.equal(isRecommended('X (Recommended)'), true);
  assert.equal(isRecommended('X (Recomendado)'), true);
  assert.equal(isRecommended('X (recomendada) '), true);
  assert.equal(isRecommended('Recommended X'), false);
  assert.equal(bareLabel('Canal por tipo (Recomendado)'), 'Canal por tipo');
  const sorted = sortRecommendedFirst([{ label: 'B' }, { label: 'C (Recommended)' }, { label: 'A' }]);
  assert.deepEqual(sorted.map((o) => o.label), ['C (Recommended)', 'B', 'A'], 'el resto conserva su orden');
});

test('la línea del log resume header → respuesta', () => {
  const { questions } = normalizeQuestions({ questions: [q(), q({ question: '¿Cuáles?', header: 'Cuáles', multiSelect: true })] });
  assert.equal(describeAnswers(questions, { '¿Qué enfoque?': 'B', '¿Cuáles?': ['A', 'C'] }), 'Enfoque → B · Cuáles → A, C');
});

test('la pregunta del tablero tiene la forma de las del modelo, y su respuesta se lee como decisión', () => {
  const bq = boardQuestion({ taskId: 't2', what: 'knob de batch', attempts: 4, failure: { kind: 'check', output: 'l1\nl2\nerror[E0308]' } });
  const norm = normalizeQuestions(bq);
  assert.ok(norm.ok, norm.problem);
  assert.match(norm.questions[0].question, /t2 «knob de batch» failed 4 times/);
  assert.match(bq.questions[0].preview, /error\[E0308\]/);
  assert.deepEqual(readBoardDecision('Reintentar otra vez (Recomendado)'), { action: 'retry', hint: null });
  assert.deepEqual(readBoardDecision('Saltar la tarea'), { action: 'skip' });
  assert.deepEqual(readBoardDecision('Detener el plan'), { action: 'stop' });
  assert.deepEqual(readBoardDecision('prueba con --features R4'), { action: 'retry', hint: 'prueba con --features R4' });
});

test('un fallo irrecuperable lo dice, y «Reintentar» deja de ser la recomendada sin dejar de leerse como tal', () => {
  const bq = boardQuestion({ taskId: 't6', what: 'e2e', attempts: 2, failure: { kind: 'check', output: 'boom', unrecoverable: true } });
  const norm = normalizeQuestions(bq);
  assert.ok(norm.ok, norm.problem);
  const q0 = norm.questions[0];
  assert.match(q0.question, /t6 «e2e» failed 2 times/);
  assert.match(q0.question, /the same error/);
  assert.match(q0.question, /did not change/);
  assert.match(q0.question, /in the plan or the environment, not in the code/);
  const labels = bq.questions[0].options.map((o) => o.label);
  assert.equal(labels.length, 4);
  assert.ok(!labels.some((l) => /recommended/i.test(l)), 'nada se recomienda reintentar');
  assert.match(bq.questions[0].options[0].description, /fail the same way/);
  // The order and the leading words are what the answer is read by.
  assert.deepEqual(labels.map((l) => readBoardDecision(l).action), ['retry', 'done', 'skip', 'stop']);
  assert.equal(readBoardDecision(labels[0]).hint, null, 'el botón no llega como pista');

  const plain = boardQuestion({ taskId: 't6', what: 'e2e', attempts: 4, failure: { kind: 'check', output: 'boom' } });
  assert.equal(plain.questions[0].options[0].label, 'Retry once more (Recommended)', 'sin la marca, la pregunta de siempre');
  assert.doesNotMatch(plain.questions[0].question, /environment/);
});

test('cuatro opciones en orden, y «Dar por hecha» y «check: …» se leen como decisiones', () => {
  for (const failure of [{ kind: 'check', output: 'x' }, { kind: 'check', output: 'x', unrecoverable: true }]) {
    const bq = boardQuestion({ taskId: 't1', what: 'a', attempts: 4, failure });
    assert.ok(normalizeQuestions(bq).ok);
    assert.deepEqual(bq.questions[0].options.map((o) => bareLabel(o.label).split(' ').slice(0, 2).join(' ')),
      ['Retry once', 'Mark as', 'Skip the', 'Stop the'].map((x, i) => (failure.unrecoverable && i === 0 ? 'Retry anyway' : x)));
    assert.match(bq.questions[0].question, /`check: <command>`/);
    assert.match(bq.questions[0].options[1].description, /without passing the check/);
  }
  assert.deepEqual(readBoardDecision('Mark as done'), { action: 'done' });
  assert.deepEqual(readBoardDecision('Dar por hecha'), { action: 'done' }, 'the old Spanish label still reads');
  assert.deepEqual(readBoardDecision('dar por hecha no, mejor prueba otra cosa'), { action: 'retry', hint: 'dar por hecha no, mejor prueba otra cosa' });
  assert.deepEqual(readBoardDecision('check: npm test'), { action: 'set-check', check: 'npm test' });
  assert.deepEqual(readBoardDecision('  Check :  `cargo test -p X` '), { action: 'set-check', check: 'cargo test -p X' });
  assert.deepEqual(readBoardDecision('check:'), { action: 'retry', hint: 'check:' });
  assert.deepEqual(readBoardDecision('check:  `` '), { action: 'retry', hint: 'check:  ``' });
});
