import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PR_TITLE_MAX, prTypeFor, clipTitle, choosePrTitle } from '../src/prtitle.js';
import { WIP_COMMIT_MESSAGE } from '../src/worktree.js';
import { publishProblems } from '../src/language.js';

/**
 * El título con el que sale una PR draft. El caso real (#1125) es el primero:
 * `fix: ` + el título del issue medía 265 caracteres, GitHub acepta 256, y la
 * tarea murió en el último paso de una ejecución que ya había pagado el fix,
 * la suite e2e y 25 minutos de Browser QA.
 */

// El título real de la #1125.
const ISSUE_1125 = 'ui: the Bulk Import Submission Log never refreshes while the server is still '
  + 'recording entries, so the operator has to reload the page by hand to find out whether the last '
  + 'submitted bundle was accepted, rejected, or is still waiting in the ingestion queue';
const FULL_1125 = `fix: ${ISSUE_1125}`;

test('el caso real: el título que no cabía cabe, sin partir palabras', () => {
  assert.ok(FULL_1125.length > PR_TITLE_MAX, `el caso de partida mide ${FULL_1125.length}`);
  const r = choosePrTitle({ branch: 'fix/1125-bulk-import-log', issueTitle: ISSUE_1125, commitSubject: null });
  assert.equal(r.source, 'issue');
  assert.ok(r.title.length <= PR_TITLE_MAX, `mide ${r.title.length}`);
  assert.ok(r.title.endsWith('…'));
  assert.ok(FULL_1125.startsWith(r.title.slice(0, -1)), 'no inventa texto: es un prefijo del original');
  assert.deepEqual(publishProblems(r.title, { maxChars: PR_TITLE_MAX }), [], 'y pasa el control de publicación');
});

test('clipTitle nunca se pasa del tope ni corta a mitad de palabra, con cualquier tope', () => {
  for (let max = 240; max <= 300; max += 1) {
    const clipped = clipTitle(FULL_1125, max);
    assert.ok(clipped.length <= max, `con tope ${max} devolvió ${clipped.length}`);
    if (FULL_1125.length <= max) {
      assert.equal(clipped, FULL_1125, `con tope ${max} no hacía falta recortar`);
      continue;
    }
    assert.ok(clipped.endsWith('…'), `con tope ${max} no acabó en puntos suspensivos`);
    const body = clipped.slice(0, -1);
    assert.ok(FULL_1125.startsWith(body), `con tope ${max} el texto no es un prefijo`);
    const next = FULL_1125[body.length];
    assert.ok(/[\s,;:.·–—-]/.test(next), `con tope ${max} cortó dentro de la palabra: «…${body.slice(-12)}|${next}»`);
  }
});

test('un texto que ya cabe se devuelve tal cual, con los espacios normalizados', () => {
  assert.equal(clipTitle('fix: algo corto'), 'fix: algo corto');
  assert.equal(clipTitle('  fix:   dos   espacios  '), 'fix: dos espacios');
  assert.equal(clipTitle('x'.repeat(PR_TITLE_MAX)).length, PR_TITLE_MAX);
  assert.equal(clipTitle('x'.repeat(PR_TITLE_MAX + 1)).length, PR_TITLE_MAX, 'una sola palabra gigante se corta igual');
});

test('nunca parte un par suplente: un emoji entero o ninguno', () => {
  const s = `${'x'.repeat(9)}😀😀`;
  const out = clipTitle(s, 11);
  assert.ok(out.length <= 11);
  assert.ok(!/[\uD800-\uDBFF]/.test(out), `quedó medio emoji: ${JSON.stringify(out)}`);
  assert.equal(JSON.stringify(out).includes('\\ud'), false);
});

test('prTypeFor sigue la convención de ramas del repo', () => {
  assert.equal(prTypeFor('fix/1125-x'), 'fix');
  assert.equal(prTypeFor('feat/900-y'), 'feat');
  assert.equal(prTypeFor(null), 'feat');
});

test('se prefiere el asunto del commit cuando es conventional e inglés', () => {
  const r = choosePrTitle({
    branch: 'fix/1125-bulk-import-log',
    issueTitle: ISSUE_1125,
    commitSubject: 'fix(ui): refresh the bulk import submission log while the server records entries',
  });
  assert.equal(r.source, 'commit');
  assert.equal(r.title, 'fix(ui): refresh the bulk import submission log while the server records entries');
  assert.deepEqual(r.rejected, []);
});

test('los asuntos que no valen caen al título del issue, y el log dice por qué', () => {
  const cases = [
    [WIP_COMMIT_MESSAGE, /conventional/],
    ['Merge branch \'main\' into fix/1125-bulk-import-log', /merge/],
    ['arregla el refresco del log de importación', /conventional|español|acentuadas/],
    [`fix: ${'a'.repeat(300)}`, /supera 256/],
    ['refresh the log without the prefix', /conventional/],
  ];
  for (const [commitSubject, why] of cases) {
    const r = choosePrTitle({ branch: 'fix/1125-x', issueTitle: 'Bulk import log never refreshes', commitSubject });
    assert.equal(r.source, 'issue', `debería caer al issue: ${commitSubject.slice(0, 40)}`);
    assert.equal(r.title, 'fix: Bulk import log never refreshes');
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].source, 'commit');
    assert.ok(r.rejected[0].problems.some((p) => why.test(p)), r.rejected[0].problems.join(' | '));
  }
});

test('si no vale ninguno: sin título y con los motivos de los dos', () => {
  const r = choosePrTitle({
    branch: 'feat/1-x',
    issueTitle: 'añade el botón de publicación',   // el issue tampoco pasa el control
    commitSubject: 'wip: lo que había sin commitear',
  });
  assert.equal(r.title, null);
  assert.equal(r.source, null);
  assert.deepEqual(r.rejected.map((x) => x.source), ['commit', 'issue']);
  for (const x of r.rejected) assert.ok(x.problems.length, `${x.source} sin motivos`);
});

test('el asunto que se propone es el primer commit de la rama, no el último', async () => {
  const { commitSubject } = await import('../src/worktree.js');
  const seen = [];
  const machine = {
    exec: async (cmd, args) => {
      seen.push([cmd, args]);
      // Lo que devuelve `git log --reverse`: el trabajo primero, los arreglos
      // de la ronda de reparación después.
      return { ok: true, stdout: 'fix(ui): refresh the bulk import submission log\nfix: address review feedback\n' };
    },
  };
  assert.equal(await commitSubject(machine, '/wt'), 'fix(ui): refresh the bulk import submission log');
  assert.ok(seen[0][1].includes('--reverse'), 'sin --reverse el título sería «address review feedback»');
  assert.ok(seen[0][1].includes('--no-merges'), 'tras traer main, HEAD suele ser un merge');
  assert.ok(!seen[0][1].includes('-1'), 'git aplica el límite antes de invertir: «-1 --reverse» es el más nuevo');
  assert.ok(seen[0][1].includes('origin/main..HEAD'));

  assert.equal(await commitSubject({ exec: async () => ({ ok: false, stdout: '' }) }, '/wt'), null);
  assert.equal(await commitSubject({ exec: async () => ({ ok: true, stdout: '\n' }) }, '/wt'), null, 'una rama sin commits propios');
});

test('sin asunto de commit no se inventa un candidato descartado', () => {
  const r = choosePrTitle({ branch: 'feat/2-x', issueTitle: 'Add the publish button', commitSubject: null });
  assert.equal(r.title, 'feat: Add the publish button');
  assert.deepEqual(r.rejected, []);
});
