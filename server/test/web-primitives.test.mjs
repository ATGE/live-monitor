import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

/** Shared primitives: no browser runner, so their contract is checked as text. */
const WEB = path.resolve(import.meta.dirname, '..', '..', 'web', 'src');
const read = (...p) => readFileSync(path.join(WEB, ...p), 'utf8');
const ui = (f) => read('components', 'ui', f);

test('SegmentedControl is a group of toggle buttons, not radios', () => {
  const src = ui('SegmentedControl.jsx');
  assert.match(src, /role="group"/);
  assert.match(src, /aria-pressed/);
  assert.doesNotMatch(src, /role="radio"/);
});

test('ExpandButton says what it does and what it controls', () => {
  const src = ui('ExpandButton.jsx');
  assert.match(src, /t\.topbar\.ui\.expandCard\b/);
  assert.match(src, /t\.topbar\.ui\.shrinkCard\b/);
  assert.equal(E('topbar.ui.expandCard'), 'Ampliar tarjeta');
  assert.equal(E('topbar.ui.shrinkCard'), 'Reducir tarjeta');
  assert.match(src, /aria-expanded/);
});

test('StateButton offers the one action', () => {
  const src = ui('StateButton.jsx');
  assert.match(src, /t\.topbar\.ui\.activate\b/);
  assert.match(src, /t\.topbar\.ui\.deactivate\b/);
  assert.equal(E('topbar.ui.activate'), 'Activar');
  assert.equal(E('topbar.ui.deactivate'), 'Desactivar');
});

test('Popover portals to the body and closes on Escape', () => {
  const src = ui('Popover.jsx');
  assert.match(src, /createPortal/);
  assert.match(src, /Escape/);
  assert.match(src, /export function usePopover/);
});

test('every primitive file exists with a default export', () => {
  for (const f of ['SegmentedControl', 'StateButton', 'SettingRow', 'ExpandButton', 'Pill', 'Chip', 'LiveDot', 'Popover', 'Kbd']) {
    assert.match(ui(`${f}.jsx`), /export default /, f);
  }
});

test('primitives.css respects reduced motion and coarse pointers, and has no hex colours', () => {
  const css = read('styles', 'primitives.css');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /pointer: coarse/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /!important/);
});

test('Popover measures the natural height, ignores its own scroll, and hover mode does not toggle on click', () => {
  const src = ui('Popover.jsx');
  // offsetHeight is the clamped height once maxHeight is set: it would flicker.
  assert.match(src, /panel\.scrollHeight/);
  assert.doesNotMatch(src, /offsetHeight/);
  // A scroll inside the panel must not reposition it.
  assert.match(src, /panelRef\.current\?\.contains\(e\.target\)/);
  // Hover opens on enter/focus; the click that follows must not close it again.
  assert.match(src, /onClick: hover \? now : toggle/);
});

test('the live dot pulse uses the duration token', () => {
  const css = read('styles', 'primitives.css');
  assert.match(css, /ui-live-pulse var\(--dur-pulse\)/);
  assert.doesNotMatch(css, /\d(\.\d+)?s ease-in-out/);
});
