import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_BRIEF_HEADING, MIN_BRIEF_CHARS, planBriefContract, readBrief, briefProblems,
  planText, briefComplaint,
} from '../src/planbrief.js';
import { WORK_PLAN_TAG, validateWorkPlan } from '../src/workplan.js';

/**
 * The brief is the only part of a plan a human reads before approving it. What
 * these tests pin down is the frame: that it is there, that it is a paragraph,
 * and that the plan still goes out when it is not.
 */

const BODY = 'Hoy el servidor acepta una búsqueda con `:in` aunque el ValueSet no exista, '
  + 'y responde 200 con un bundle vacío, que se lee como «no hay pacientes» en vez de como un error. '
  + 'Después del cambio devuelve un OperationOutcome 400 diciendo qué ValueSet no encontró. '
  + 'Se toca la capa REST de búsqueda y el cliente de terminología; la UI no cambia.';

const good = (extra = '') => `${PLAN_BRIEF_HEADING}\n\n${BODY}${extra}`;

const plan = validateWorkPlan({
  tasks: [{ id: 't1', what: 'devuelve 400', files: ['crates/rest/src/search.rs'] }],
}).plan;

// ---------------------------------------------------------------------------
// Lo que pasa

test('un resumen con cabecera y tres frases pasa', () => {
  assert.deepEqual(briefProblems(good()), []);
});

test('el resumen se lee de lo que hay antes de la línea del plan', () => {
  const turn = `${good()}\n\n${WORK_PLAN_TAG}: {"tasks":[{"id":"t1","what":"x"}]}\n`;
  const brief = readBrief(turn);
  assert.ok(brief.startsWith(PLAN_BRIEF_HEADING));
  assert.doesNotMatch(brief, new RegExp(WORK_PLAN_TAG), 'la línea etiquetada no es parte del resumen');
  assert.deepEqual(briefProblems(turn), [], 'el turno entero se valida igual que el resumen suelto');
});

test('lo que venga después de otra cabecera no cuenta como resumen', () => {
  // El cuerpo propio ya da la talla; la sección siguiente no lo infla ni lo rompe.
  assert.deepEqual(briefProblems(good('\n\n## Riesgos\n\nNinguno.')), []);
});

// ---------------------------------------------------------------------------
// Lo que falla, y que lo diga con palabras que sirvan para corregirlo

test('sin la cabecera no hay resumen, por larga que sea la prosa', () => {
  const problems = briefProblems(`## Resumen\n\n${BODY}`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /De un vistazo/);
});

test('sin la cabecera se dice con qué empieza el texto', () => {
  const problems = briefProblems('Los dos subagentes siguen trabajando; el plan llega con sus informes.');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /empieza por «Los dos subagentes siguen trabajando/);
  assert.doesNotMatch(problems[0], /por donde tiene que empezar/);
});

test('un titular no es un resumen: por debajo de 200 caracteres se rechaza', () => {
  const short = `${PLAN_BRIEF_HEADING}\n\nArregla el 400 de la búsqueda.`;
  const problems = briefProblems(short);
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(String(MIN_BRIEF_CHARS)));
  assert.match(problems[0], /caracteres/);
});

test('un turno que sólo trae la línea del plan no deja resumen', () => {
  const turn = `${WORK_PLAN_TAG}: {"tasks":[{"id":"t1","what":"x"}]}`;
  assert.equal(readBrief(turn), null);
  const problems = briefProblems(turn);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /De un vistazo/);
});

test('el texto vacío no revienta', () => {
  assert.equal(readBrief(''), null);
  assert.equal(readBrief(null), null);
  assert.equal(briefProblems(undefined).length, 1);
});

// ---------------------------------------------------------------------------
// Lo que sale

test('planText pone la prosa delante del plan', () => {
  const text = planText(good(), plan);
  assert.ok(text.indexOf(PLAN_BRIEF_HEADING) < text.indexOf('El plan de trabajo'), 'el resumen va primero');
  assert.match(text, /crates\/rest\/src\/search\.rs/, 'el plan sigue entero');
});

test('sin resumen utilizable sale sólo el plan, no una cabecera vacía', () => {
  for (const brief of [null, '', '   \n ']) {
    const text = planText(brief, plan);
    assert.match(text, /El plan de trabajo/);
    assert.doesNotMatch(text, /De un vistazo/);
  }
});

// ---------------------------------------------------------------------------
// (25–29) El resumen es la sección, no todo lo que hay antes de la etiqueta

test('un intento fallido de plan no se lleva el resumen por delante', () => {
  // `parseTaggedJson` se queda con la ÚLTIMA línea válida, así que el plan que
  // corre es el segundo; el resumen tiene que sobrevivir al primero.
  const turn = `${WORK_PLAN_TAG}: {"tasks":[]}\n\n${good()}\n\n${WORK_PLAN_TAG}: {"tasks":[{"id":"t1","what":"x"}]}`;
  assert.deepEqual(briefProblems(turn), []);
  assert.ok(readBrief(turn).startsWith(PLAN_BRIEF_HEADING));
  assert.doesNotMatch(readBrief(turn), new RegExp(WORK_PLAN_TAG));
});

test('una etiqueta a media línea tampoco acaba dentro del resumen', () => {
  const turn = `${good()}\n\nAhí va: ${WORK_PLAN_TAG}: {"tasks":[{"id":"t1","what":"x"}]}`;
  const brief = readBrief(turn);
  assert.doesNotMatch(brief, /\{"tasks"/, 'el JSON no se le enseña a nadie');
  assert.doesNotMatch(brief, new RegExp(WORK_PLAN_TAG));
  assert.deepEqual(briefProblems(turn), []);
});

test('con la cabecera repetida manda la que trae cuerpo', () => {
  const turn = `${PLAN_BRIEF_HEADING}\n\n${PLAN_BRIEF_HEADING}\n\n${BODY}`;
  assert.deepEqual(briefProblems(turn), [], 'la vacía no es el resumen');
  assert.match(readBrief(turn), new RegExp(BODY.slice(0, 40).replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')));
});

test('un `#` dentro de un bloque de código no corta el resumen', () => {
  const head = 'Hoy el import en lote se queda en «Aborting» hasta que alguien recarga la página, '
    + 'y después del cambio pasa a «Stopped» en el siguiente sondeo.';
  const tail = 'Se toca el handler de estado de la UI y su prueba de extremo a extremo; el servidor no cambia.';
  const turn = `${PLAN_BRIEF_HEADING}\n\n${head}\n\n\`\`\`bash\n# así se reproduce\ncargo test -p helios-ui\n\`\`\`\n\n${tail}`;
  assert.ok(head.length < MIN_BRIEF_CHARS, 'sin lo de después de la valla no llegaría');
  assert.deepEqual(briefProblems(turn), [], 'el comentario de shell no es una cabecera');
});

test('lo que el agente escribió ANTES de la cabecera no llega a la ventana de revisión', () => {
  const analysis = 'Primero miré el handler, luego los tests, luego el cliente de terminología. '.repeat(20);
  const turn = `${analysis}\n\n${good()}\n\n${WORK_PLAN_TAG}: {"tasks":[{"id":"t1","what":"x"}]}`;
  const brief = readBrief(turn);
  assert.ok(brief.startsWith(PLAN_BRIEF_HEADING), 'el resumen empieza en su cabecera');
  assert.doesNotMatch(brief, /Primero miré el handler/, 'el análisis se queda fuera');
  assert.doesNotMatch(planText(brief, plan), /Primero miré el handler/);
});

test('el contrato pide la cabecera exacta y prohíbe la lista de rutas', () => {
  const contract = planBriefContract();
  assert.match(contract, new RegExp(PLAN_BRIEF_HEADING));
  assert.match(contract, /sin abrir el código/);
  assert.match(contract, /No vale/);
  assert.match(contract, new RegExp(`${WORK_PLAN_TAG}:`), 'dice dónde va la tabla');
});

test('la queja pide el resumen sin rehacer el trabajo', () => {
  const message = briefComplaint(['falta la cabecera']);
  assert.match(message, /falta la cabecera/);
  assert.match(message, /sin rehacer el trabajo/);
  assert.equal(briefComplaint('un problema suelto').includes('un problema suelto'), true);
});
