import { test } from 'node:test';
import assert from 'node:assert/strict';

import { continuationBrief } from '../src/fixbrief.js';

test('el reintento con commits pide revisar y terminar, no empezar de cero', () => {
  const b = continuationBrief({
    branch: 'fix/1069-ui-aborting-bulk-import',
    commits: ['f6aa771 fix(ui): keep an aborted bulk import Stopped after the next status poll'],
    files: ['crates/ui/src/bulk_import.rs', 'crates/ui/tests/bulk_import_http.rs'],
    dirty: 0,
    lastError: 'La sesión de fix terminó sin commitear: la rama sigue igual que origin/main.',
  });
  assert.match(b, /ESTE ES UN REINTENTO: NO EMPIECES DE CERO/);
  assert.match(b, /1 commit\(s\) sobre origin\/main/);
  assert.match(b, /- f6aa771 fix\(ui\)/);
  assert.match(b, /- crates\/ui\/src\/bulk_import\.rs/);
  assert.match(b, /> La sesión de fix terminó sin commitear/);
  assert.match(b, /\*\*commitea sólo lo que falte\*\*/);
  assert.match(b, /\*\*no hagas ningún commit\*\*/, 'completo = decirlo, no un commit vacío');
  assert.match(b, /Nunca reescribas la historia/);
  assert.doesNotMatch(b, /SIN commitear en el worktree/, 'sin sucios no se menciona');
});

test('el trabajo sin commitear se señala, y el error anterior es opcional', () => {
  const b = continuationBrief({ branch: 'feat/1', commits: ['abc uno'], files: ['a.rs'], dirty: 3 });
  assert.match(b, /3 archivo\(s\) con cambios SIN commitear/);
  assert.doesNotMatch(b, /intento anterior/);
});

test('listas largas se recortan con un «…y N más»', () => {
  const b = continuationBrief({ branch: 'x', commits: Array.from({ length: 25 }, (_, i) => `c${i} msg`), files: [] });
  assert.match(b, /…y 5 más/);
  assert.match(b, /no cambia ningún archivo/);
});

test('project base branch replaces origin/main; without it, main', () => {
  const dev = continuationBrief({ branch: 'x', commits: ['c1 msg'], files: ['a.js'], base: 'develop' });
  assert.match(dev, /sobre origin\/develop:/);
  assert.match(dev, /git diff origin\/develop\.\.\.HEAD/);
  assert.doesNotMatch(dev, /origin\/main/);
  const none = continuationBrief({ branch: 'x', commits: ['c1 msg'], files: [] });
  assert.match(none, /git diff origin\/main\.\.\.HEAD/);
  assert.match(none, /respecto a origin\/main \(commits vacíos/);
});
