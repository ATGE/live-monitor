import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

/**
 * The KPI detail panels (quota weekly/session and median). No browser runner,
 * so the source is read as text: what is pinned is the decision that pace is
 * only shown when the usage figures can be trusted, the one button, the exact
 * copy, and the symbols the documentation cites in QuotaMeter.jsx.
 */
const SRC = path.resolve(import.meta.dirname, '..', '..', 'web', 'src', 'components');
const read = (...p) => readFileSync(path.join(SRC, ...p), 'utf8');
const quotaPanel = read('kpi', 'QuotaPanel.jsx');
const medianPanel = read('kpi', 'MedianPanel.jsx');
const quotaMeter = read('QuotaMeter.jsx');

test('QuotaPanel derives pace and the reopening stamp from the pure helpers', () => {
  assert.match(quotaPanel, /\bquotaPace\b/);
  assert.match(quotaPanel, /\bpaceTrusted\b/);
  assert.match(quotaPanel, /\bweekdayStamp\b/);
});

test('the «se agota hacia» warning needs trusted usage and an exhaustion time', () => {
  assert.match(quotaPanel, /const exhaust = trusted && [^\n]*\?\.exhaustAt != null/);
  assert.match(quotaPanel, /\{exhaust && \(/);
  assert.match(quotaPanel, /t\.exhaust\b/);
  assert.match(E('kpi.panel.exhaust'), /^A este ritmo se agota hacia las \{time\}/);
});

test('«Consumo por hora» is drawn only when the pace is trusted', () => {
  assert.match(quotaPanel, /if \(trusted && pace\) \{/);
  assert.match(quotaPanel, /\{paceValue && \(/);
  assert.match(quotaPanel, /t\.paceLabel/);
  assert.equal(E('kpi.panel.paceLabel'), 'Consumo por hora');
  assert.match(quotaPanel, /\{!trusted && <p className="kp-muted">\{t\.untrusted\}<\/p>\}/);
  assert.equal(E('kpi.panel.untrusted'), 'Sin ritmo fiable: datos de uso desactualizados');
});

test('the single button asks for a fresh sample and is named', () => {
  assert.match(quotaPanel, /aria-label=\{t\.refresh\}/);
  assert.equal(E('kpi.panel.refresh'), 'Actualizar la cuota');
  assert.match(quotaPanel, /onClick=\{refresh\}/);
  assert.equal(quotaPanel.match(/<button\b/g)?.length, 1);
});

test('a hold says nothing is left to press', () => {
  assert.match(quotaPanel, /t\.nothingToPress/);
  assert.equal(E('kpi.panel.nothingToPress'), 'No hay nada que pulsar: el tablero se reanuda solo.');
  assert.match(quotaPanel, /meter\?\.hold/);
});

test('MedianPanel carries the reopened-task note', () => {
  assert.match(medianPanel, /t\.reopened/);
  assert.equal(E('kpi.median.reopened'), 'Una tarea reabierta cuenta solo su último ciclo.');
  assert.match(medianPanel, /n < Math\.min\(considered, RECENT\)/);
  assert.match(medianPanel, /const RECENT = 20;/);
});

test('QuotaMeter.jsx keeps the symbols the documentation cites', () => {
  assert.match(quotaMeter, /export function quotaMeter\(/);
  assert.match(quotaMeter, /function rowTone\(/);
  assert.match(quotaMeter, /const HOVER_GRACE_MS\b/);
});
