import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { PLANS_DIR, planDirFor, pickPlanFile, reviseMessage, timeoutMessage } from '../src/plans.js';

test('el directorio de planes cuelga del worktree, por chat, en cada plataforma', () => {
  assert.equal(planDirFor({ path: path.win32 }, 'C:\\wt\\937', 'c1'), 'C:\\wt\\937\\tmp\\hfsmon-plans\\c1');
  assert.equal(planDirFor({ path: path.posix }, '/home/e/wt/937', 'c1'), '/home/e/wt/937/tmp/hfsmon-plans/c1');
  assert.equal(PLANS_DIR, 'tmp/hfsmon-plans');
});

test('pickPlanFile: la ruta del Write manda; si no, el .md nuevo; si no, el único; si no, nada', () => {
  assert.equal(pickPlanFile(['a.md', 'b.md'], { hint: 'C:\\wt\\tmp\\hfsmon-plans\\c1\\b.md' }), 'b.md');
  assert.equal(pickPlanFile(['a.md', 'b.md'], { before: ['a.md'] }), 'b.md');
  assert.equal(pickPlanFile(['a.md', 'b.md', 'c.md'], { before: ['a.md'] }), 'c.md', 'varios nuevos: el último por nombre');
  assert.equal(pickPlanFile(['solo.md', 'notas.txt'], {}), 'solo.md');
  assert.equal(pickPlanFile(['a.md', 'b.md'], { before: ['a.md', 'b.md'] }), null);
  assert.equal(pickPlanFile([], {}), null);
});

test('los textos que vuelven al modelo dicen qué hacer', () => {
  assert.match(reviseMessage('quita t4'), /quita t4[\s\S]*ExitPlanMode/);
  assert.match(timeoutMessage(20), /20 minutos/);
});
