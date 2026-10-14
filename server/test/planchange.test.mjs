import './isolate.mjs';   // primero: planchange.js llega a opencode.js → claude.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validatePlanChange, applyPlanChange, describePlanChange, planChangeQuestion,
  readPlanChangeDecision, planChangeTool, planChangeMcpServers,
} from '../src/planchange.js';
import { newPlanRecord } from '../src/planexec.js';
import { validateWorkPlan } from '../src/workplan.js';

// t1 (done) → t6 (failing, check 'mal'); t8 has no ordering against t6.
const plan = () => {
  const r = validateWorkPlan({ tasks: [
    { id: 't1', what: 'uno', files: ['a.rs'], dependsOn: [] },
    { id: 't6', what: 'seis', files: ['c.rs'], dependsOn: ['t1'], check: 'mal' },
    { id: 't8', what: 'ocho', files: ['d.rs'], dependsOn: [] },
  ] });
  assert.ok(r.ok, r.problem);
  const p = newPlanRecord({ id: 'p1', ...r.plan });
  p.tasks[0].status = 'done';
  p.tasks[1].status = 'asking';
  p.tasks[1].attempts = 2;
  p.tasks[1].lastFailure = { kind: 'check' };
  return p;
};
const t7 = (over = {}) => ({ id: 't7', what: 'siete', files: ['e.rs'], dependsOn: ['t6'], check: 'ok', ...over });

test('cambiar solo el check', () => {
  const r = validatePlanChange(plan(), 't6', { reason: 'el check estaba mal', check: '  cargo check  ' });
  assert.ok(r.ok, r.problem);
  assert.deepEqual(r.change, { taskId: 't6', reason: 'el check estaba mal', check: 'cargo check', newTasks: [] });
});

test('null quita el check', () => {
  const r = validatePlanChange(plan(), 't6', { reason: 'r', check: null });
  assert.ok(r.ok, r.problem);
  assert.equal(r.change.check, null);
  const p = plan();
  applyPlanChange(p, r.change);
  assert.equal(p.tasks[1].check, null);
});

test('añadir t7 que depende de t6', () => {
  const r = validatePlanChange(plan(), 't6', { reason: 'falta', newTasks: [t7()] });
  assert.ok(r.ok, r.problem);
  assert.equal(r.change.check, undefined);
  assert.equal(r.change.newTasks[0].id, 't7');
});

test('rechazos', () => {
  const p = plan();
  const bad = (id, prop, re) => {
    const r = validatePlanChange(p, id, prop);
    assert.equal(r.ok, false, JSON.stringify(prop));
    assert.match(r.problem, re);
  };
  bad('t99', { reason: 'r', check: 'x' }, /no existe/);
  bad('t1', { reason: 'r', check: 'x' }, /hecha/);
  bad('t6', { reason: '  ', check: 'x' }, /reason/);
  bad('t6', { reason: 'r', newTasks: [t7({ id: 't8' })] }, /ya existe/);
  bad('t6', { reason: 'r', newTasks: [t7({ dependsOn: ['t1'] })] }, /tiene que depender de `t6`/);
  bad('t6', { reason: 'r', newTasks: [t7({ dependsOn: ['t6'], files: ['d.rs'] }), ] }, /pueden ir a la vez/);
  bad('t6', { reason: 'r' }, /no cambia nada/);
  bad('t6', { reason: 'r', check: 'mal' }, /no cambia nada/);
  bad('t6', { reason: 'r', check: '   ' }, /no vacío/);
  const six = Array.from({ length: 6 }, (_, i) => t7({ id: `n${i}`, files: [`n${i}.rs`] }));
  bad('t6', { reason: 'r', newTasks: six }, /hasta 5/);
});

test('una tarea nueva puede colgar de t6 a través de otra nueva', () => {
  const r = validatePlanChange(plan(), 't6', { reason: 'r', newTasks: [t7(), t7({ id: 't9', files: ['f.rs'], dependsOn: ['t7'] })] });
  assert.ok(r.ok, r.problem);
});

test('depender de una tarea saltada se rechaza', () => {
  const p = plan();
  p.tasks[2].status = 'skipped';
  const r = validatePlanChange(p, 't6', { reason: 'r', newTasks: [t7({ dependsOn: ['t6', 't8'] })] });
  assert.equal(r.ok, false);
  assert.match(r.problem, /`t7` depende de `t8`, que no se va a ejecutar/);
});

test('una tarea nueva puede depender de la tarea fallida aunque esté en failed', () => {
  const p = plan();
  p.tasks[1].status = 'failed';
  const r = validatePlanChange(p, 't6', { reason: 'r', newTasks: [t7()] });
  assert.ok(r.ok, r.problem);
});

test('compartir archivo con una tarea DONE sin orden se acepta', () => {
  const r = validatePlanChange(plan(), 't6', { reason: 'r', newTasks: [t7({ files: ['a.rs'] })] });
  assert.ok(r.ok, r.problem);
});

test('aplicar: selected, waves y changes; el resto intacto', () => {
  const p = plan();
  const { change } = validatePlanChange(p, 't6', { reason: 'porque sí', check: 'bien', newTasks: [t7()] });
  const line = applyPlanChange(p, change);
  assert.equal(line, 't6: plan changed — check `mal` → `bien`; added t7');
  assert.equal(p.tasks[1].check, 'bien');
  assert.equal(p.tasks[1].attempts, 2);
  assert.deepEqual(p.tasks[1].lastFailure, { kind: 'check' });
  assert.equal(p.tasks[1].status, 'asking');
  assert.equal(p.tasks[0].status, 'done');
  const n = p.tasks.find((t) => t.id === 't7');
  assert.equal(n.status, 'pending');
  assert.ok(p.selected.includes('t7'));
  assert.ok(p.waves.flat().includes('t7'));
  assert.ok(p.waves.findIndex((w) => w.includes('t7')) > p.waves.findIndex((w) => w.includes('t6')));
  assert.equal(p.changes.length, 1);
  assert.deepEqual(
    { ...p.changes[0], at: undefined },
    { at: undefined, taskId: 't6', reason: 'porque sí', before: { check: 'mal' }, after: { check: 'bien' }, added: ['t7'] },
  );
});

test('describir y preguntar', () => {
  const p = plan();
  const { change } = validatePlanChange(p, 't6', { reason: 'motivo', check: null, newTasks: [t7()] });
  const md = describePlanChange(p, change);
  assert.match(md, /motivo/);
  assert.match(md, /Before: `mal`/);
  assert.match(md, /After: «no check»/);
  assert.match(md, /t7/);
  const { questions: [qq] } = planChangeQuestion(p, change);
  assert.equal(qq.header, 'Plan change');
  assert.deepEqual(qq.options.map((o) => o.label), ['Apply the change', 'Do not apply']);
  assert.equal(qq.preview, md);
});

test('readPlanChangeDecision', () => {
  assert.deepEqual(readPlanChangeDecision('Aplicar el cambio'), { approve: true, note: null });
  assert.deepEqual(readPlanChangeDecision('No aplicar'), { approve: false, note: null });
  assert.deepEqual(readPlanChangeDecision('  aplicar pero sin t7 '), { approve: false, note: 'aplicar pero sin t7' });
});

test('la tool devuelve isError con ok:false y ante una excepción', async () => {
  const mk = (onPropose) => planChangeTool({ onPropose }).handler({ reason: 'r' }, {});
  const yes = await mk(async () => ({ ok: true, text: 'aplicado' }));
  assert.notEqual(yes.isError, true);
  assert.equal(yes.content[0].text, 'aplicado');
  const no = await mk(async () => ({ ok: false, text: 'la persona dijo no' }));
  assert.equal(no.isError, true);
  assert.equal(no.content[0].text, 'la persona dijo no');
  const boom = await mk(async () => { throw new Error('se cayó'); });
  assert.equal(boom.isError, true);
  assert.match(boom.content[0].text, /se cayó/);
});

test('el servidor MCP se llama plan', () => {
  const s = planChangeMcpServers({ onPropose: async () => ({ ok: true, text: '' }) });
  assert.deepEqual(Object.keys(s), ['plan']);
});

test('readPlanChangeDecision still reads the Spanish labels stored before the board spoke English', () => {
  assert.deepEqual(readPlanChangeDecision('Aplicar el cambio'), { approve: true, note: null });
  assert.deepEqual(readPlanChangeDecision('No aplicar'), { approve: false, note: null });
});
