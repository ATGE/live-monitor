// The topbar «···» menu is pinned from its source text (there is no browser runner here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../web/src/${rel}`, import.meta.url)), 'utf8');
const menu = read('components/topbar/MoreMenu.jsx');
const restart = read('components/RestartControl.jsx');

test('MoreMenu is a popover with the three actions', () => {
  assert.match(menu, /<Popover\b/);
  assert.match(menu, /placement="bottom-end"/);
  assert.match(menu, /t\.topbar\.more\.importProject/);
  assert.match(menu, /t\.topbar\.more\.checkUpdates/);
  assert.equal(E('topbar.more.importProject'), 'Importar proyecto');
  assert.equal(E('topbar.more.checkUpdates'), 'Buscar actualizaciones');
  assert.match(menu, /<ImportProjectDialog\b/);
  assert.match(menu, /<RestartControl variant="menu"/);
});

test('the trigger is labelled', () => {
  assert.match(menu, /aria-label=\{restartPending \? t\.topbar\.more\.pending : t\.topbar\.more\.label\}/);
  assert.equal(E('topbar.more.label'), 'Más acciones');
});

test('RestartControl keeps its name and has both variants', () => {
  assert.match(restart, /export default function RestartControl\(/);
  assert.match(restart, /variant = 'chip'/);
  assert.match(restart, /variant === 'menu'/);
});

test('review fixes: import closes itself, a11y names, own keyframes', () => {
  assert.match(menu, /onImported=\{\(p\) => \{ setImporting\(false\); onImported\?\.\(p\); \}\}/);
  assert.match(menu, /aria-haspopup="dialog"/);
  assert.match(menu, /t\.topbar\.more\.pending/);
  assert.equal(E('topbar.more.pending'), 'Más acciones (reinicio pendiente)');
  assert.doesNotMatch(restart, /aria-label="Reiniciar el tablero"/);
  const css = read('styles/more-menu.css');
  assert.match(css, /@keyframes mm-spin/);
  assert.match(css, /animation: mm-spin/);
});
