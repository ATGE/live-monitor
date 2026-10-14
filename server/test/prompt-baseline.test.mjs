// La línea base de los prompts.
//
// Un segundo proyecto vigilado traerá `{{projectContext}}` a las plantillas de
// `server/prompts/`. Este archivo congela lo que producen HOY para que después
// se pueda demostrar que el prompt de hfs sale idéntico salvo por el bloque
// añadido. No comprueba que el texto sea bueno: comprueba que no se movió.
//
// El fixture es autocontenido a propósito. `server/data/tasks.json` está en
// `.gitignore`, pesa 44 MB, crece con cada sondeo y en el runner es otro
// archivo con otras tareas: una prueba que lo leyera se pondría roja sola. Las
// tareas congeladas viven en `baseline.json` y de ahí se re-renderiza.
//
// Como `parallel.test.mjs` y `workplan.test.mjs`, importa `prompts.js`
// directamente y sin `isolate.mjs`: ni él ni los módulos de contratos
// despiertan a ningún escritor del directorio de datos.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED } from '../src/prompts.js';
import {
  CONTRACTS,
  contractPath,
  firstDifference,
  fixtureEntries,
  hashText,
  readBaseline,
  readFrozenText,
  renderFor,
  samplePath,
  sortedEntries,
} from '../../tools/prompt-baseline/lib.mjs';

const FREEZE = 'node tools/prompt-baseline/baseline.mjs freeze';
const DUMP = 'node tools/prompt-baseline/baseline.mjs dump --out <dir fuera del repo>';

const baseline = readBaseline();
const entries = sortedEntries(Object.values(baseline.tasks));

/** Lo que hay que hacer con un fallo, repetido en cada mensaje porque es lo único accionable. */
const howTo = (extra = '') => `${extra}\n`
  + `  Ver el diff completo: ${DUMP} antes y después, y \`diff -r\` entre los dos directorios.\n`
  + `  Si el cambio es el esperado, rehaz el fixture: ${FREEZE}`;

test('el fixture congela exactamente las plantillas que existen', () => {
  assert.deepEqual(baseline.templates, Object.keys(ALLOWED),
    howTo('la lista de plantillas del fixture no es la de `ALLOWED` en `server/src/prompts.js`.\n'
      + '  Una plantilla nueva (o retirada) obliga a congelar de nuevo, a propósito.'));
});

test('las variables permitidas por plantilla no se movieron', () => {
  for (const name of baseline.templates) {
    assert.deepEqual(baseline.allowed[name], ALLOWED[name],
      howTo(`\`ALLOWED.${name}\` cambió respecto al fixture.`));
  }
});

test('cada par (plantilla, tarea) sigue produciendo el mismo texto', () => {
  let pairs = 0;
  for (const template of baseline.templates) {
    const frozen = baseline.hashes[template];
    assert.ok(frozen, howTo(`el fixture no tiene hashes para \`${template}\`.`));
    for (const entry of entries) {
      const key = String(entry.issue);
      const expected = frozen[key];
      assert.ok(expected, howTo(`el fixture no tiene hash para (\`${template}\`, issue ${key}).`));
      const actual = hashText(renderFor(entry, template));
      assert.equal(actual, expected,
        howTo(`el prompt \`${template}\` para el issue ${key} ya no es el congelado.`));
      pairs += 1;
    }
    assert.equal(Object.keys(frozen).length, entries.length,
      howTo(`el fixture tiene ${Object.keys(frozen).length} tareas para \`${template}\` y la lista de tareas trae ${entries.length}.`));
  }
  assert.ok(pairs > 0, 'el fixture no congela ningún par');
});

test('el texto completo de las muestras es el congelado', () => {
  const samples = baseline.sampleIssues;
  assert.ok(samples.length, howTo('el fixture no declara ninguna tarea de muestra.'));

  for (const template of baseline.templates) {
    for (const issue of samples) {
      const entry = baseline.tasks[String(issue)];
      assert.ok(entry, howTo(`la muestra declara el issue ${issue}, que no está entre las tareas congeladas.`));

      const file = samplePath(template, issue);
      let expected;
      try {
        expected = readFrozenText(file);
      } catch (e) {
        assert.fail(howTo(`falta la muestra de (\`${template}\`, issue ${issue}) en ${file}: ${e.message}`));
      }

      const actual = renderFor(entry, template);
      const diff = firstDifference(expected, actual);
      assert.equal(diff, null, diff && howTo(
        `el prompt \`${template}\` para el issue ${issue} difiere de ${file}.\n${diff.report}`,
      ));
    }
  }
});

test('los contratos que el pipeline inyecta por llamada siguen iguales', () => {
  const frozen = new Map(baseline.contracts.map((c) => [c.name, c]));
  assert.deepEqual(CONTRACTS.map((c) => c.name), baseline.contracts.map((c) => c.name),
    howTo('la lista de contratos del fixture no es la de `tools/prompt-baseline/lib.mjs`.'));

  for (const contract of CONTRACTS) {
    const entry = frozen.get(contract.name);
    assert.equal(entry.call, contract.call,
      howTo(`el contrato \`${contract.name}\` ya no se obtiene con \`${entry.call}\` sino con \`${contract.call}\`.`));
    assert.equal(hashText(contract.text), entry.hash,
      howTo(`el contrato \`${contract.name}\` (\`${contract.call}\`) cambió de texto.`));

    const file = contractPath(contract.name);
    const expected = readFrozenText(file);
    const diff = firstDifference(expected, contract.text);
    assert.equal(diff, null, diff && howTo(
      `el contrato \`${contract.name}\` difiere de ${file}.\n${diff.report}`,
    ));
  }
});

test('freeze --from-fixture rechaza un fixture sin tareas con número de issue', () => {
  assert.throws(() => fixtureEntries({}), /ninguna tarea/);
  assert.throws(() => fixtureEntries({ a: { title: 'sin número' } }), /ninguna tarea/);
  const kept = fixtureEntries({ b: { issue: 9, title: 'b' }, a: { issue: 2, title: 'a' }, x: { title: 'x' } });
  assert.deepEqual(kept.map((t) => t.issue), [2, 9], 'descarta lo que no tiene issue y ordena');
});
