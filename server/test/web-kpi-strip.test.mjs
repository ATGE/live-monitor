import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

// The web code is not run here (no browser): like web-card-layout, these tests
// read the source and pin the contract of the redesigned KPI strip.
const web = path.resolve(import.meta.dirname, '../../web/src');
const read = (rel) => readFileSync(path.join(web, rel), 'utf8');
const strip = read('components/kpi/KpiStrip.jsx');
const css = read('styles/kpi.css');

test('KpiStrip draws its own root and no longer leans on the old topbar look', () => {
  assert.match(strip, /<section className="kpi" aria-label=\{t\.stripLabel\}>/);
  assert.equal(E('kpi.stripLabel'), 'Indicadores del tablero');
  assert.doesNotMatch(strip, /className="(?:[^"]* )?(?:topbar|kpi-seam|slots|awaiting)(?: [^"]*)?"/);
});

test('figures come from kpiView: open by state, agents, recent durations', () => {
  assert.match(strip, /from '\.\.\/\.\.\/kpiView\.js'/);
  for (const fn of ['openByState', 'agentsSummary', 'recentDurations']) {
    assert.match(strip, new RegExp(`\\b${fn}\\(`), `${fn} is called`);
  }
});

test('both quota panels and the median panel sit inside hover Popovers', () => {
  assert.match(strip, /usePopover\(\{ hover: true \}\)/);
  assert.match(strip, /<Popover [^>]*>\s*<QuotaPanel kind=\{kind\} meter=\{meter\} usage=\{usage\} now=\{now\} onRefresh=\{onRefresh\} \/>\s*<\/Popover>/);
  assert.match(strip, /<Popover [^>]*>\s*<MedianPanel stats=\{stats\} \/>\s*<\/Popover>/);
  assert.match(strip, /kind="session"/);
  assert.match(strip, /kind=\{mainKind\}/);
  assert.match(strip, /t\.quotaNoData/);
  assert.equal(E('kpi.quotaNoData'), 'Cuota: sin datos');
  assert.match(strip, /t\.median\.none/);
  assert.equal(E('kpi.median.none'), 'Mediana: sin tareas terminadas');
});

test('the «esperan» button jumps to the first waiting task; calm cell when none', () => {
  assert.match(strip, /<button type="button" className="kpi-await"[^>]*onClick=\{onJumpAwaiting\}/);
  assert.match(strip, /t\.awaitingNone/);
  assert.equal(E('kpi.awaitingNone'), 'Nada espera tu decisión');
});

test('the limit steppers stay between 1 and the ceiling', () => {
  assert.match(strip, /onSetMax\(Math\.max\(1, maxActive - 1\)\)/);
  assert.match(strip, /onSetMax\(Math\.min\(ceiling, maxActive \+ 1\)\)/);
  assert.match(strip, /aria-label=\{t\.limitLower\}/);
  assert.match(strip, /aria-label=\{t\.limitRaise\}/);
  assert.equal(E('kpi.limitLower'), 'Bajar el límite');
  assert.equal(E('kpi.limitRaise'), 'Subir el límite');
});

test('an empty bucket draws nothing but is still read aloud', () => {
  assert.match(strip, /open\.zero\.map\(\(k\) => <span key=\{k\} className="kpi-sr">/);
  assert.match(css, /\.kpi-sr \{[^}]*clip: rect\(0 0 0 0\)/);
  assert.match(strip, /t\.openNone/);
  assert.equal(E('kpi.openNone'), 'Sin tareas abiertas');
});

test('kpi.css: phone breakpoint, scroll-snap, no hex colours', () => {
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.match(css, /scroll-snap-type: x/);
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(noComments, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(noComments, /!important/);
});
