import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  WORK_PLAN_TAG, validateWorkPlan, readWorkPlan, planStats, subagentsUsed, planIgnored,
  parallelismLine, renderWorkPlan, workPlanContract, workPlanComplaint, MAX_TASKS,
} from '../src/workplan.js';
import { parseTaggedJson, stripTaggedLine } from '../src/tagged.js';
import { renderPrompt, ALLOWED } from '../src/prompts.js';

const DIR = path.join(process.cwd(), 'server', 'prompts');

const plan = (tasks) => validateWorkPlan({ tasks });
const t = (id, files = [], dependsOn = []) => ({ id, what: `hace ${id}`, files, dependsOn });

// ---------------------------------------------------------------------------
// Lo que el tablero acepta

test('un plan bien formado pasa y sale ordenado por rondas', () => {
  const r = plan([t('a', ['x.rs']), t('b', ['y.rs']), t('c', ['z.rs'], ['a', 'b'])]);
  assert.ok(r.ok, r.problem);
  assert.deepEqual(r.plan.waves, [['a', 'b'], ['c']]);
  assert.deepEqual(planStats(r.plan), { total: 3, independent: 2, widest: 2, rounds: 2 });
});

test('un plan de una sola tarea es válido y no es un incumplimiento', () => {
  const r = plan([t('solo', ['un.rs'])]);
  assert.ok(r.ok);
  assert.equal(planIgnored(r.plan, {}), false, 'una tarea no se reparte y no se penaliza');
});

test('files y dependsOn son opcionales: una fase de solo lectura no toca archivos', () => {
  const r = validateWorkPlan({ tasks: [{ id: 'q1', what: 'busca X' }, { id: 'q2', what: 'busca Y' }] });
  assert.ok(r.ok, r.problem);
  assert.deepEqual(r.plan.tasks[0].files, []);
  assert.deepEqual(r.plan.tasks[0].dependsOn, []);
});

test('dos tareas que tocan el mismo archivo pueden ir a la vez si están encadenadas', () => {
  const r = plan([t('a', ['same.rs']), t('b', ['same.rs'], ['a'])]);
  assert.ok(r.ok, r.problem);
});

test('el orden transitivo también cuenta como orden', () => {
  // a -> b -> c: a y c nunca coinciden aunque c no dependa de a directamente.
  const r = plan([t('a', ['same.rs']), t('b', [], ['a']), t('c', ['same.rs'], ['b'])]);
  assert.ok(r.ok, r.problem);
});

// ---------------------------------------------------------------------------
// Lo que rechaza, y que diga por qué con palabras que sirvan para corregirlo

test('sin tasks, o vacío, se rechaza', () => {
  assert.equal(validateWorkPlan({}).ok, false);
  assert.equal(validateWorkPlan({ tasks: [] }).ok, false);
  assert.equal(validateWorkPlan(null).ok, false);
  assert.equal(validateWorkPlan([]).ok, false);
});

test('ids repetidos', () => {
  const r = plan([t('a'), t('a')]);
  assert.equal(r.ok, false);
  assert.match(r.problem, /`a` está repetido/);
});

test('una tarea sin id o sin what', () => {
  assert.match(validateWorkPlan({ tasks: [{ what: 'x' }] }).problem, /no tiene `id`/);
  assert.match(validateWorkPlan({ tasks: [{ id: 'a' }] }).problem, /no dice en `what`/);
});

test('dependencia que no existe, o de sí misma', () => {
  assert.match(plan([t('a', [], ['zz'])]).problem, /`zz`, que no existe/);
  assert.match(plan([t('a', [], ['a'])]).problem, /depende de sí misma/);
});

test('un ciclo se detecta aunque sea largo', () => {
  const r = plan([t('a', [], ['c']), t('b', [], ['a']), t('c', [], ['b'])]);
  assert.equal(r.ok, false);
  assert.match(r.problem, /ciclo/);
});

test('dos tareas paralelas que tocan el mismo archivo: rechazado, y nombra las dos y el archivo', () => {
  const r = plan([t('a', ['crates/rest/src/lib.rs']), t('b', ['crates/rest/src/lib.rs'])]);
  assert.equal(r.ok, false);
  assert.match(r.problem, /`a` y `b`/);
  assert.match(r.problem, /crates\/rest\/src\/lib\.rs/);
  assert.match(r.problem, /dependsOn/, 'tiene que decir cómo arreglarlo');
});

test('el mismo archivo escrito de dos maneras sigue siendo el mismo archivo', () => {
  // Windows: separadores, ./ y mayúsculas no distinguen archivos.
  assert.equal(plan([t('a', ['crates\\rest\\src\\lib.rs']), t('b', ['./crates/rest/src/lib.rs'])]).ok, false);
  assert.equal(plan([t('a', ['Crates/Rest/Lib.rs']), t('b', ['crates/rest/lib.rs'])]).ok, false);
});

test('files o dependsOn con tipos raros se rechazan en vez de reventar', () => {
  assert.equal(validateWorkPlan({ tasks: [{ id: 'a', what: 'x', files: 'lib.rs' }] }).ok, false);
  assert.equal(validateWorkPlan({ tasks: [{ id: 'a', what: 'x', dependsOn: [1] }] }).ok, false);
  assert.equal(validateWorkPlan({ tasks: ['a'] }).ok, false);
});

test('hay un tope de tareas', () => {
  const many = Array.from({ length: MAX_TASKS + 1 }, (_, i) => t(`t${i}`, [`f${i}.rs`]));
  assert.match(plan(many).problem, /máximo/);
});

// ---------------------------------------------------------------------------
// Leerlo del texto de un turno

test('readWorkPlan saca la última línea válida aunque el modelo se corrigiera', () => {
  const text = [
    'Voy a repartirlo así.',
    `${WORK_PLAN_TAG}: {"tasks":[{"id":"a","what":"x","files":["f.rs"]},{"id":"a","what":"y"}]}`,
    'Perdón, el id estaba repetido:',
    `${WORK_PLAN_TAG}: {"tasks":[{"id":"a","what":"x","files":["f.rs"]},{"id":"b","what":"y","files":["g.rs"]}]}`,
  ].join('\n');
  const r = readWorkPlan(text);
  assert.ok(r.ok, r.problem);
  assert.equal(r.plan.tasks.length, 2);
});

test('sin la línea, o con JSON roto, el problema lo dice', () => {
  assert.match(readWorkPlan('no hay plan').problem, /WORK_PLAN/);
  assert.match(readWorkPlan(`${WORK_PLAN_TAG}: {"tasks": [`).problem, /WORK_PLAN/);
});

test('parseTaggedJson recorre hacia atrás hasta un JSON que parsee', () => {
  const text = 'X: {"a":1}\nX: {rota\n';
  assert.deepEqual(parseTaggedJson(text, 'X'), { a: 1 });
  assert.equal(parseTaggedJson('nada', 'X'), null);
});

test('stripTaggedLine quita la línea del plan y nada más', () => {
  const steps = `## Qué cambió\nalgo\n\n## Pasos\n1. x\n${WORK_PLAN_TAG}: {"tasks":[]}\n`;
  const out = stripTaggedLine(steps, WORK_PLAN_TAG);
  assert.ok(!out.includes(WORK_PLAN_TAG));
  assert.ok(out.startsWith('## Qué cambió'));
  assert.ok(out.endsWith('1. x'));
});

// ---------------------------------------------------------------------------
// Compararlo con lo que pasó de verdad

test('los subagentes se cuentan con el nombre real (Agent) y con el viejo (Task)', () => {
  assert.equal(subagentsUsed({ Agent: 3, Read: 10 }), 3);
  assert.equal(subagentsUsed({ Task: 2, Agent: 1 }), 3);
  assert.equal(subagentsUsed({ Read: 4 }), 0);
  assert.equal(subagentsUsed(undefined), 0);
});

test('declarar reparto y no repartir es incumplimiento; dos es el umbral', () => {
  const r = plan([t('a', ['x']), t('b', ['y']), t('c', ['z'])]);
  assert.equal(planIgnored(r.plan, { Read: 40, Edit: 5 }), true, 'tres independientes y cero subagentes');
  assert.equal(planIgnored(r.plan, { Agent: 1 }), true, 'un subagente no es paralelismo');
  assert.equal(planIgnored(r.plan, { Agent: 2 }), false);
  const serial = plan([t('a', ['x']), t('b', ['y'], ['a'])]);
  assert.equal(planIgnored(serial.plan, {}), false, 'un plan en serie no prometió nada');
});

test('la línea del log dice plan, ejecución y tiempo', () => {
  const r = plan([t('a', ['x']), t('b', ['y']), t('c', ['z'], ['a'])]);
  assert.equal(parallelismLine(r.plan, { Agent: 2, Read: 3 }, 12 * 60000),
    'plan: 3 tasks, 2 independent · execution: 2 subagents · 12 min');
  assert.equal(parallelismLine(plan([t('a')]).plan, null),
    'plan: 1 task, 1 independent');
});

// ---------------------------------------------------------------------------
// Lo que llega al prompt

test('renderWorkPlan agrupa por rondas y pide un subagente por tarea en el MISMO mensaje', () => {
  const r = plan([t('a', ['x.rs']), t('b', ['y.rs']), t('c', ['z.rs'], ['a', 'b'])]);
  const text = renderWorkPlan(r.plan);
  assert.match(text, /Ronda 1 — estas 2 van A LA VEZ/);
  assert.match(text, /MISMO mensaje/);
  assert.match(text, /- Ronda 2:\n {2}- `c`/);
  assert.match(text, /`x\.rs`/);
});

test('el contrato dice lo que se comprueba: archivos disjuntos y no inflar el plan', () => {
  const c = workPlanContract('lo que sea');
  assert.match(c, new RegExp(`${WORK_PLAN_TAG}:`));
  assert.match(c, /no pueden compartir un\s+archivo/);
  assert.match(c, /declara una sola tarea/);
  assert.match(c, /lo que sea/);
  assert.match(workPlanComplaint('falta X'), /falta X/);
});

test('el contrato llega solo a triage, fix-plan y demo; el fix recibe el plan ya hecho', () => {
  for (const name of ['triage', 'fix-plan', 'demo']) {
    const text = readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    assert.ok(text.includes('{{workPlan}}'), `${name}.md no pide el WORK_PLAN`);
    assert.ok(ALLOWED[name].includes('workPlan'), `${name} no declara workPlan`);
  }
  assert.ok(readFileSync(path.join(DIR, 'fix.md'), 'utf8').includes('{{workPlanSection}}'));
  assert.ok(ALLOWED.fix.includes('workPlanSection'));
});

test('fix-plan se renderiza sin que el llamante pase el contrato, y es de solo lectura', () => {
  const text = renderPrompt('fix-plan', {
    issueNumber: 1, issueTitle: 'x', branch: 'b', issueBody: '', planSection: '', extraContext: '',
  });
  assert.match(text, /WORK_PLAN:/);
  assert.match(text, /No toques nada/);
  assert.match(text, /Explora en abanico/, 'lleva también el bloque de paralelismo');
});

test('triage puede terminar con las dos líneas y las dos se leen', () => {
  const out = 'Análisis…\nTRIAGE_RESULT: {"complexity":"simple","reason":"r","summary":"s"}\n'
    + `${WORK_PLAN_TAG}: {"tasks":[{"id":"a","what":"x","files":["f.rs"]}]}`;
  assert.equal(parseTaggedJson(out, 'TRIAGE_RESULT').complexity, 'simple');
  assert.ok(readWorkPlan(out).ok);
});

// ---------------------------------------------------------------------------
// check: how the board tells a task is done

test('check es opcional, se conserva, y se rechaza si no es un comando', () => {
  const r = plan([{ ...t('a', ['x.rs']), check: ' cargo check -p x ' }, t('b', ['y.rs'])]);
  assert.ok(r.ok, r.problem);
  assert.equal(r.plan.tasks[0].check, 'cargo check -p x');
  assert.equal(r.plan.tasks[1].check, null);
  assert.match(plan([{ ...t('a'), check: 42 }]).problem, /check.*comando/);
  assert.match(renderWorkPlan(r.plan), /comprobación: `cargo check -p x`/);
  assert.match(workPlanContract(), /`check`/);
});
