// The required-plugins chips and dialog (redesign «C refinada», package 1-plugins).
// There is no browser runner: like web-card-layout.test.mjs this reads the source as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

const web = (p) => readFileSync(fileURLToPath(new URL(`../../web/src/${p}`, import.meta.url)), 'utf8');

test('PluginChips: no emoji, no always-visible editor button, a failed chip is an alert', () => {
  const src = web('components/PluginChips.jsx');
  assert.doesNotMatch(src, /🧩/);
  assert.doesNotMatch(src, /plugin-edit/);
  assert.doesNotMatch(src, /RequiredPluginsDialog/, 'the dialog opens from Settings, not from the bar');
  assert.match(src, /role=\{failed \? 'alert' : 'status'\}/);
  assert.match(src, /name="puzzle"|'puzzle'/);
  assert.match(src, /'x-circle'/);
  assert.match(src, /'loader'/);
  assert.match(src, /return null/, 'paints nothing while nothing is missing');
});

test('RequiredPluginsDialog: puzzle icon, field wiring and the exact texts', () => {
  const src = web('components/RequiredPluginsDialog.jsx');
  assert.match(src, /icon="puzzle"/);
  assert.match(src, /placeholder=\{t\.topbar\.pluginsDialog\.inputPlaceholder\}/);
  assert.match(src, /aria-invalid/);
  assert.match(src, /aria-describedby/);
  assert.equal(E('topbar.pluginsDialog.inputPlaceholder'), 'nombre@marketplace');
  for (const [key, text] of [
    ['topbar.pluginsDialog.caption', 'Plugins de usuario que el tablero espera en cada máquina. Si falta uno, la barra lo avisa y ofrece instalarlo; nunca se instala solo.'],
    ['topbar.pluginsDialog.empty', 'No hay plugins requeridos.'],
    ['common.loading', 'Cargando…'],
    ['topbar.pluginsDialog.saving', 'Guardando…'],
    ['topbar.pluginsDialog.saveFailed', 'No se pudo guardar: {error}'],
    ['topbar.pluginsDialog.invalidFormat', 'El id debe ser nombre@marketplace, por ejemplo frontend-design@claude-plugins-official'],
  ]) {
    assert.equal(E(key), text, `catalog text: ${key}`);
    assert.ok(src.includes(`t.${key}`), `source does not use ${key}`);
  }
  assert.doesNotMatch(src, /Plugins de usuario|No hay plugins|Cargando…|Guardando…|No se pudo guardar/, 'no Spanish literal left in the component');
  assert.doesNotMatch(src, /className="(ghost|primary)"/);
  assert.match(src, /btn btn-primary btn-md/);
  assert.equal(E('topbar.pluginsDialog.escCloses'), 'cierra');
  assert.ok(src.includes('<Kbd>Esc</Kbd>'));
  assert.match(src, /hint=\{<><Kbd>Esc<\/Kbd> .*\{t\.topbar\.pluginsDialog\.escCloses\}<\/>\}/);
  assert.doesNotMatch(src, /pl-foot/);
});

test('usePlugins returns state, chips, error and install', () => {
  const src = web('usePlugins.js');
  assert.match(src, /export function usePlugins\(/);
  assert.match(src, /return \{ state, chips: pluginChips\(state\), error, install \}/);
});

test('plugins.css: own prefix, no !important, no raw hex, reduced motion and phone rules', () => {
  const css = web('styles/plugins.css');
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /rgba?\(/, 'colours come from tokens');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /max-width: 780px/);
  assert.match(css, /\.pl-chip-failed/);
});
