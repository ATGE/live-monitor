import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';

// There is no web test runner: the «Trabajar» group of the card (Chat, Plan,
// Demo, Browser QA, Log, Tiempos) is pinned by reading the sources as text.
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const work = read('components/card/WorkGroup.jsx');
const demoPanel = read('components/DemoPanel.jsx');
// The text lives in the Spanish catalog: pin the value there and the key's use in the source.
const pin = (p, value) => assert.equal(p.split('.').reduce((o, k) => o?.[k], es), value, p);

test('el botón Browser QA lleva su cuenta de evidencia', () => {
  assert.match(work, /<Icon name="compass" \/> Browser QA\{task\.qaEvidenceCount/);
});

test('Demo abre su panel con la tarea', () => {
  assert.match(work, /onClick=\{\(\) => onDemo\(task\.issue\)\}/);
});

test('ChatButton y PlanButton se exportan para el pie de la cerrada', () => {
  assert.match(work, /export function ChatButton\(/);
  assert.match(work, /export function PlanButton\(/);
  assert.match(work, /onClick=\{\(\) => onChat\(task\.issue\)\}/);
  assert.match(work, /onClick=\{\(\) => onReviewPlan\(task\.issue\)\}/);
});

test('Plan muestra hechas / no omitidas y solo mientras corre o se detuvo', () => {
  assert.match(work, /\['running', 'asking', 'stopped', 'failed'\]\.includes\(plan\.status\)/);
  assert.match(work, /task\.state === 'plan_ready'/);
  assert.match(work, /Plan\{total > 0 \? ` \$\{done\}\/\$\{total\}`/);
});

test('Log y Tiempos son ghost de 24h en la cabecera de la sección', () => {
  pin('card.work.title', 'Trabajar');
  assert.match(work, /<CardSection title=\{t\.card\.work\.title\} aside=/);
  assert.match(work, /className="btn btn-ghost btn-xs tcw-aside-btn" onClick=\{\(\) => onLog/);
  assert.match(work, /className="btn btn-ghost btn-xs tcw-aside-btn" onClick=\{\(\) => onTimeline/);
});

test('sin alias ni rejilla vieja', () => {
  assert.doesNotMatch(work, /\bc1\b|\bc2\b|span-2|btn-secondary/);
});

test('QA incompleto es una nota bajo la fila', () => {
  pin('card.work.qaIncomplete', 'QA incompleto');
  pin('card.work.qaIncompleteCounts', 'QA incompleto · {checked} de {total} comprobados');
  assert.match(work, /\{qaTotal > 0 \? fill\(t\.card\.work\.qaIncompleteCounts, \{ checked: qaChecked, total: qaTotal \}\) : t\.card\.work\.qaIncomplete\}/);
});

test('Demo: el panel sabe cuándo el servidor la resolvió apagada', () => {
  assert.match(demoPanel, /task\.demoWanted === false/);
});
