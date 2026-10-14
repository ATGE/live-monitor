import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVISOR_PLAN_HEADING, MIN_ADVISOR_PLAN_CHARS, advisorPlanProblems, advisorPlanText, advisorPlanComplaint,
} from '../src/advisorplan.js';
import { firstLineOf } from '../src/firstline.js';

const BODY = 'Enfoque: dejar los subagentes en primer plano y tomar el último result cuando el sellado '
  + 'se dio con subagentes fuera. Archivos: claude.js primero, luego los validadores y el cableado de pipeline.js. '
  + 'En paralelo: el módulo del hook, el validador y el bloque de prompts, que no comparten archivos. '
  + 'Riesgos: que el CLI no aplique updatedInput, y que un result posterior pise una respuesta buena. '
  + 'Tests: el de la sesión simulada, el de cableado y el de la línea de aviso en el log.';

test('un plan con cabecera y cuerpo suficiente pasa', () => {
  assert.ok(BODY.length >= MIN_ADVISOR_PLAN_CHARS);
  assert.deepEqual(advisorPlanProblems(`${ADVISOR_PLAN_HEADING}\n\n${BODY}`), []);
});

test('lo que haya antes de la cabecera o en subsecciones no rompe el plan', () => {
  const text = `Pensando en voz alta.\n\n${ADVISOR_PLAN_HEADING}\n\n## 1. Enfoque\n\n${BODY}`;
  assert.deepEqual(advisorPlanProblems(text), []);
});

test('la frase de espera de #17 no es un plan', () => {
  const waiting = 'The three exploration subagents are still running; I continue with the plan when their reports arrive.';
  const problems = advisorPlanProblems(waiting);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Plan de implementación/);
  assert.match(problems[0], /empieza por «The three exploration subagents/);
});

test('la frase de espera bajo la cabecera tampoco: por debajo del mínimo se rechaza', () => {
  const problems = advisorPlanProblems(`${ADVISOR_PLAN_HEADING}\n\nLos subagentes siguen trabajando.`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(String(MIN_ADVISOR_PLAN_CHARS)));
});

test('vacío, nulo y aviso de límite de uso no son un plan (sin cabecera)', () => {
  assert.equal(advisorPlanProblems('').length, 1);
  assert.equal(advisorPlanProblems(undefined).length, 1);
  assert.equal(advisorPlanProblems('   \n').length, 1);
  const limit = advisorPlanProblems("You've hit your limit · resets 3pm");
  assert.equal(limit.length, 1);
  assert.match(limit[0], /empieza por «You've hit your limit/);
});

test('advisorPlanText: guarda desde la cabecera y descarta la frase de espera previa', () => {
  const plan = `${ADVISOR_PLAN_HEADING}\n\n${BODY}`;
  assert.equal(advisorPlanText(plan), plan);
  assert.equal(advisorPlanText(`Los subagentes siguen trabajando.\n\n${plan}\n`), plan);
  assert.equal(advisorPlanText('sin cabecera'), '');
  assert.equal(advisorPlanText(undefined), '');
});

test('advisorPlanText: una cabecera dentro de un bloque de código no cuenta', () => {
  const text = `Previo.\n\n\`\`\`md\n${ADVISOR_PLAN_HEADING}\n\`\`\`\n\n${ADVISOR_PLAN_HEADING}\n\n${BODY}`;
  assert.equal(advisorPlanText(text), `${ADVISOR_PLAN_HEADING}\n\n${BODY}`);
});

test('la queja dice qué arreglar y no pide implementar', () => {
  const text = advisorPlanComplaint(['falta la cabecera']);
  assert.match(text, /falta la cabecera/);
  assert.match(text, /Plan de implementación/);
  assert.match(text, /no implementes nada/);
});

test('firstLineOf: primera línea no vacía, recortada', () => {
  assert.equal(firstLineOf('\n\n  hola  \nsegunda'), 'hola');
  assert.equal(firstLineOf(null), '');
  const cut = firstLineOf('x'.repeat(200), 80);
  assert.equal([...cut].length, 80);
  assert.ok(cut.endsWith('…'));
  assert.equal(firstLineOf('😀'.repeat(100), 10), `${'😀'.repeat(9)}…`);
});
