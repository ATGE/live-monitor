// The board's design tokens and button system live in two files: tokens.css is
// the only source of variables (dark theme only), btn.css keeps every rule
// inside :where() so a surface can adjust it without a specificity fight.
// There is no browser runner here, so the sources are read as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const read = (name) => readFileSync(join(SRC, name), 'utf8');
const tokens = read('tokens.css');
const styles = read('styles.css');
const btn = read('btn.css');
const main = read('main.jsx');

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : walk(p);
  return [p];
});
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('styles.css no longer owns a :root block', () => {
  assert.doesNotMatch(strip(styles), /:root\s*\{/);
});

test('tokens.css defines the palette of direction C, dark only', () => {
  const t = strip(tokens);
  for (const decl of [
    '--bg: #0b0f14', '--accent: #56ebf7', '--btn-primary-bg: #007994',
    '--col-w: 320px', '--card-w: 304px', '--live-bg: #0f1a1f', '--on-amber: #0b0f14',
    '--danger-solid: #c92f33',
  ]) assert.ok(t.includes(decl), `tokens.css lacks ${decl}`);
  for (const name of ['--live', '--tint-warn', '--tint-ok', '--surface-4', '--seg-active-bg', '--glow-dot', '--h-touch'])
    assert.match(t, new RegExp(`${name}\\s*:`), `tokens.css lacks ${name}`);
  assert.doesNotMatch(tokens, /data-theme/);
});

test('btn.css keeps every rule inside :where()', () => {
  const css = strip(btn).trim();
  // Split into top-level rules by the closing brace of each block.
  const rules = css.split(/\}\s*/).map((r) => r.trim()).filter(Boolean);
  for (const r of rules) assert.match(r, /^:where\(/, `not wrapped in :where(): ${r.slice(0, 60)}`);
  for (const cls of ['btn-amber', 'btn-danger-solid', 'btn-warn-outline', 'btn-xs', 'btn-block', 'btn-secondary'])
    assert.match(btn, new RegExp(`\\.${cls}\\b`), `btn.css lacks .${cls}`);
});

test('main.jsx imports the per-surface CSS after btn.css, in the fixed order', () => {
  const order = ['./btn.css', './styles/primitives.css', './styles/charts.css', './styles/side-panels.css',
    './styles/dialogs.css', './styles/topbar.css', './styles/board.css', './styles/card.css',
    './styles/chat.css', './styles/task-tabs.css', './styles/activity.css'];
  let at = -1;
  for (const f of order) {
    const i = main.indexOf(`'${f}'`);
    assert.ok(i > at, `${f} is missing or out of order in main.jsx`);
    at = i;
  }
});

test('every var(--x) used in web/src is defined in tokens.css (or local / has a fallback)', () => {
  const defined = new Set([...strip(tokens).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  // btn.css declares the component-local --btn-* variables per element; any
  // surface file may read them.
  const btnLocal = [...strip(btn).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
  const missing = [];
  for (const file of walk(SRC).filter((f) => f.endsWith('.css'))) {
    const css = strip(readFileSync(file, 'utf8'));
    const local = new Set([...btnLocal, ...css.matchAll(/(--[\w-]+)\s*:/g).map((m) => m[1])]);
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      if (m[2] === ',' || defined.has(m[1]) || local.has(m[1])) continue;
      missing.push(`${file.slice(SRC.length + 1)}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
