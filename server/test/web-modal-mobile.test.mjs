import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The web has no test runner: the dialog's heights and footer on a phone are
// read as text. `vh` is written first as the fallback, `dvh` after it.

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');
const css = readFileSync(path.join(WEB, 'src', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');

/** The declaration block of the first rule whose selector line is exactly `selector`. */
function ruleOf(selector, source = css) {
  const at = source.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no rule for ${selector}`);
  return source.slice(at, source.indexOf('}', at));
}

test('the modal backdrop and the modal declare 100vh first and 100dvh after it', () => {
  const rule = ruleOf('.modal-backdrop');
  const vh = rule.search(/100vh/);
  const dvh = rule.search(/100dvh/);
  assert.ok(vh >= 0 && dvh > vh, '.modal-backdrop: vh fallback, then dvh');
  const modal = ruleOf('.modal');
  assert.match(modal, /max-height: min\(88vh, 900px\);\s*max-height: min\(88dvh, 900px\)/);
});

test('on a phone the modal is the visible height, not the layout height', () => {
  const phone = css.slice(css.indexOf('.modal, .modal-wide {'));
  const block = phone.slice(0, phone.indexOf('}'));
  assert.ok(block.indexOf('height: 100vh') < block.indexOf('height: 100dvh'));
  assert.doesNotMatch(css, /\.modal, \.modal-wide \{ width: 100%; max-height: 100vh; height: 100vh;/, 'the vh-only rule is gone');
});

test('the dialog footer never shrinks away, clears the home indicator and stacks below 480px', () => {
  const foot = ruleOf('.modal-foot');
  assert.match(foot, /flex: none/);
  assert.match(foot, /padding-bottom: calc\(10px \+ env\(safe-area-inset-bottom\)\)/);
  const narrow = css.slice(css.indexOf('@media (max-width: 480px) {\n  .modal-foot'));
  assert.match(narrow.slice(0, narrow.indexOf('\n}\n')), /\.modal-foot button \{ width: 100%; \}/);
});

test('the dialog base styles its footer with the btn system and exposes the C props', () => {
  const dlg = readFileSync(path.join(WEB, 'src', 'styles', 'dialogs.css'), 'utf8').replace(/\r\n/g, '\n');
  // 0,2,0 so a `btn-*` wins over the old `.modal-foot button` (0,1,1).
  assert.match(dlg, /^\.modal-foot \.btn \{/m);
  const foot = dlg.slice(dlg.indexOf('.modal-foot .btn {'));
  const block = foot.slice(0, foot.indexOf('}'));
  // Colours are read from the variant's own variables, never set to a fixed one.
  for (const d of ['background: var(--btn-bg)', 'color: var(--btn-fg)', 'box-shadow: 0 0 0 1px var(--btn-ring)', 'border: 0', 'height: var(--btn-h)']) {
    assert.ok(block.includes(d), `.modal-foot .btn declares ${d}`);
  }
  assert.match(dlg, /\.modal-foot \.btn:hover:not\(:disabled\) \{ background: var\(--btn-bg-hover\)/);
  assert.match(dlg, /\.dlg-head-custom \.dlg-close \{ margin-top: 18px/);
  assert.match(dlg.slice(dlg.indexOf('max-width: 480px')), /\.modal-foot \{ align-items: stretch; \}/);
  const jsx = readFileSync(path.join(WEB, 'src', 'components', 'Dialog.jsx'), 'utf8');
  for (const prop of ['tone', 'role', 'header', 'hint', 'dismissLabel']) {
    assert.ok(jsx.includes(`${prop} = `), `Dialog takes ${prop}`);
  }
  assert.match(jsx, /aria-labelledby=/);
  const ask = readFileSync(path.join(WEB, 'src', 'useDialog.jsx'), 'utf8');
  assert.match(ask, /'danger-solid'/);
  assert.doesNotMatch(ask, /className="(primary|ghost|warn|danger) /, 'no old button aliases');
});
