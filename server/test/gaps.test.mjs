import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  gapsContract, readGaps, gapsToFixBrief, chatSummary, shouldIterate,
} from '../src/gaps.js';
import { renderPrompt, ALLOWED } from '../src/prompts.js';

const line = (o) => `texto previo\nGAPS_VERDICT: ${JSON.stringify(o)}`;
const good = {
  evidence: 'partial',
  evidenceNotes: 'faltan tests',
  gaps: [
    { id: 'g1', summary: 'caso vacío sin tratar', needsHuman: false, fix: 'añadir el caso' },
    { id: 'g2', summary: 'decidir el nombre', needsHuman: true },
  ],
};

test('readGaps: un veredicto válido se lee', () => {
  const r = readGaps(line(good));
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdict, good);
});

test('readGaps: sin línea, o con el contrato roto, dice por qué', () => {
  assert.equal(readGaps('nada').ok, false);
  assert.equal(readGaps(null).ok, false);
  const bad = (patch) => readGaps(line({ ...good, ...patch }));
  assert.match(bad({ evidence: 'maybe' }).problem, /evidence/);
  assert.match(bad({ evidenceNotes: 3 }).problem, /evidenceNotes/);
  assert.match(bad({ gaps: 'x' }).problem, /gaps/);
  assert.match(bad({ gaps: [{ id: '', summary: 's', needsHuman: false }] }).problem, /id/);
  assert.match(bad({ gaps: [{ id: 'a', summary: 's', needsHuman: 'no' }] }).problem, /needsHuman/);
  assert.match(bad({ gaps: [{ id: 'a', summary: '', needsHuman: false }] }).problem, /summary/);
  assert.match(bad({ gaps: [{ id: 'a', summary: 's', needsHuman: false, fix: 1 }] }).problem, /fix/);
  assert.match(bad({ gaps: [
    { id: 'a', summary: 's', needsHuman: false }, { id: 'a', summary: 't', needsHuman: true },
  ] }).problem, /repetido/);
});

test('readGaps: sin huecos es válido', () => {
  const r = readGaps(line({ evidence: 'yes', evidenceNotes: '', gaps: [] }));
  assert.equal(r.ok, true);
});

test('gapsToFixBrief: solo los huecos que no necesitan a una persona', () => {
  const brief = gapsToFixBrief(good, 2);
  assert.match(brief, /Ronda 2/);
  assert.match(brief, /g1/);
  assert.match(brief, /añadir el caso/);
  assert.doesNotMatch(brief, /g2/);
  assert.equal(gapsToFixBrief({ evidence: 'yes', evidenceNotes: '', gaps: [good.gaps[1]] }, 1), '');
});

test('chatSummary: hallazgos, lo arreglado y lo que necesita a una persona', () => {
  const md = chatSummary({ round: 1, verdict: good, fixed: ['g1'], pending: ['g2'] });
  assert.match(md, /ronda 1/);
  assert.match(md, /Huecos encontrados: 2/);
  assert.match(md, /Lo que se arregló:\n- \(g1\) caso vacío/);
  assert.ok(md.indexOf('Lo que necesita a una persona') > md.indexOf('Lo que se arregló'));
  assert.match(md, /- \(g2\) decidir el nombre/);
  const none = chatSummary({ round: 1, verdict: { evidence: 'yes', evidenceNotes: '', gaps: [] } });
  assert.match(none, /Nada pendiente/);
});

test('shouldIterate: huecos resolubles, rondas y guarda de bucle', () => {
  assert.equal(shouldIterate(good, 1, 3), true);
  assert.equal(shouldIterate(good, 3, 3), false, 'rondas agotadas');
  assert.equal(shouldIterate({ ...good, gaps: [good.gaps[1]] }, 1, 3), false, 'solo huecos humanos');
  assert.equal(shouldIterate({ ...good, gaps: [] }, 1, 3), false);
  assert.equal(shouldIterate(good, 2, 5, good), false, 'los mismos ids dos rondas seguidas');
  const other = { ...good, gaps: [{ id: 'g9', summary: 'x', needsHuman: false }] };
  assert.equal(shouldIterate(other, 2, 5, good), true);
});

test('shouldIterate: sin un round entero nunca itera', () => {
  assert.equal(shouldIterate(good, undefined, 3), false);
  assert.equal(shouldIterate(good, null, 3), false);
  assert.equal(shouldIterate(good, '1', 3), false);
  assert.equal(shouldIterate(good, 1.5, 3), false);
  assert.equal(shouldIterate(good, 1, 3), true);
});

test('shouldIterate: sin un maxRounds entero nunca itera', () => {
  assert.equal(shouldIterate(good, 1, undefined), false);
  assert.equal(shouldIterate(good, 1, null), false);
  assert.equal(shouldIterate(good, 1, '3'), false);
});

test('gapsContract exige la línea en una sola línea', () => {
  const c = gapsContract();
  assert.match(c, /GAPS_VERDICT:/);
  assert.match(c, /una sola línea/);
});

test('fix-gaps.md: variables exactas, paralelismo y sin vocabulario de stack', () => {
  const file = readFileSync(path.join(process.cwd(), 'server', 'prompts', 'fix-gaps.md'), 'utf8');
  const vars = [...new Set([...file.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(vars, [
    'baseBranch', 'gapsContract', 'issueBody', 'issueNumber', 'issueTitle', 'maxRounds', 'parallel', 'processRule', 'round', 'shellRule',
  ]);
  assert.doesNotMatch(file, /cargo|Cargo|R6|FHIR|HFS_|HeliosSoftware|npm|playwright/i);
  if (ALLOWED['fix-gaps']) {
    const out = renderPrompt('fix-gaps', {
      issueNumber: 7, issueTitle: 't', issueBody: 'b', baseBranch: 'main', round: 1, maxRounds: 2,
      gapsContract: gapsContract(),
    });
    assert.match(out, /GAPS_VERDICT:/);
    assert.doesNotMatch(out, /\{\{/);
  }
});
