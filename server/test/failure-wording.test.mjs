// El texto que recibe el agente de fix cuando falla el comando de verificación.
//
// El tablero es multiproyecto y `e2e.testCommand` es un comando arbitrario: un
// proyecto de documentación corre un gate de Python, no Playwright. Decirle al
// agente «LOS TESTS E2E DE PLAYWRIGHT FALLARON» lo manda a buscar specs que no
// existen. La clave opcional `e2e.label` nombra la verificación y elige el
// texto neutro; sin ella el texto es el de siempre, byte por byte.
//
// `isolate.mjs` va primero y a propósito: `pipeline.js` importa `store.js`.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HFSMON_NO_AUTOSTART = '1';

const { fixFailureBrief } = await import('../src/pipeline.js');

const TAIL = 'FAILED docs gate: 2 new findings\nsee report';
const attempt = (round, tail) => ({ round, tail, at: '2026-10-05T00:00:00.000Z' });

test('sin `e2e.label` el texto es exactamente el de siempre (hfs y todo proyecto existente)', () => {
  const cfg = { e2e: { testCommand: 'npx playwright test' } };
  const expected = `\nLOS TESTS E2E DE PLAYWRIGHT FALLARON. Analiza esta salida, repara la causa (puede ser tu cambio o un test que deba actualizarse legítimamente — nunca debilites un test solo para ponerlo en verde) y commitea la corrección:\n\`\`\`\n${TAIL}\n\`\`\`\n`;
  assert.equal(fixFailureBrief(cfg, TAIL, [attempt(1, TAIL)]), expected);
});

test('sin `e2e.label` las rondas anteriores salen con el formato de siempre', () => {
  const cfg = { e2e: { testCommand: 'npx playwright test' } };
  const expected = '\nLOS TESTS E2E DE PLAYWRIGHT FALLARON. Analiza esta salida, repara la causa (puede ser tu cambio o un test que deba actualizarse legítimamente — nunca debilites un test solo para ponerlo en verde) y commitea la corrección:\n```\nnow\n```\n'
    + '\nRondas anteriores que NO bastaron (analiza por qué, y si la estrategia no sirve cámbiala en vez de repetirla):\n- ronda 1:\n```\nfirst\n```\n- ronda 2:\n```\nsecond\n```\n';
  assert.equal(fixFailureBrief(cfg, 'now', [attempt(1, 'first'), attempt(2, 'second'), attempt(3, 'now')]), expected);
});

test('con `e2e.label` el texto es neutro, nombra la verificación y lleva la salida', () => {
  const cfg = { e2e: { testCommand: 'python tools/docs_gate.py', label: 'docs gate' } };
  const out = fixFailureBrief(cfg, TAIL, [attempt(1, TAIL)]);
  assert.match(out, /^\nLA VERIFICACIÓN DEL PROYECTO \(docs gate\) FALLÓ\. Analiza esta salida, repara la causa/);
  assert.match(out, /nunca debilites la verificación solo para ponerla en verde/);
  assert.ok(out.includes(`\`\`\`\n${TAIL}\n\`\`\``), 'la cola de la salida viaja tal cual');
  assert.doesNotMatch(out, /PLAYWRIGHT|E2E/);
});

test('con `e2e.label` las rondas anteriores también se incluyen', () => {
  const cfg = { e2e: { testCommand: 'python tools/docs_gate.py', label: 'docs gate' } };
  const out = fixFailureBrief(cfg, 'now', [attempt(1, 'first'), attempt(2, 'now')]);
  assert.match(out, /Rondas anteriores que NO bastaron/);
  assert.match(out, /- ronda 1:\n```\nfirst\n```/);
});

test('un `label` vacío o que no es texto cuenta como ausente', () => {
  for (const label of ['', '   ', 7, null]) {
    const out = fixFailureBrief({ e2e: { testCommand: 'x', label } }, TAIL, [attempt(1, TAIL)]);
    assert.match(out, /^\nLOS TESTS E2E DE PLAYWRIGHT FALLARON\./);
  }
});
