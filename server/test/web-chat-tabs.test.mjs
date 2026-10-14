import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

// The web has no test runner: the chat tab strip is read as text. Its rules
// live in `styles/chat.css` (owner of the chat panel), which loads after
// `styles.css`, so an equal selector there wins by order.

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');
const css = readFileSync(path.join(WEB, 'src', 'styles', 'chat.css'), 'utf8').replace(/\r\n/g, '\n');
const read = (f) => readFileSync(path.join(WEB, 'src', 'components', f), 'utf8');

/** The declaration block of the first rule whose selector line is exactly `selector`. */
function ruleOf(selector, source = css) {
  const at = source.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `no rule for ${selector}`);
  return source.slice(at, source.indexOf('}', at));
}

test('the active chat tab is unmistakable and does not shift the strip', () => {
  const weight = (rule) => Number(rule.match(/font-weight:\s*(\d+)/)?.[1] ?? 0);
  const bg = (rule) => rule.match(/background:\s*([^;]+);/)?.[1].trim();
  const on = ruleOf('.chat-tab.is-active');
  const off = ruleOf('.chat-tab');
  // Bold lives on the text spans only: on the container it would reach
  // `.run-count` (no ghost) and the tab would change width when selected.
  assert.doesNotMatch(on, /font-weight/, '.chat-tab.is-active: no font-weight on the container');
  assert.doesNotMatch(off, /font-weight/, '.chat-tab: no font-weight on the container');
  assert.ok(bg(on) && bg(on) !== 'none' && bg(on) !== bg(off), '.chat-tab.is-active: its own background');
  assert.match(on, /box-shadow:[^;]*inset 0 -2px 0 var\(--text-2\)/, '.chat-tab.is-active: a mark under it');
  assert.ok(weight(ruleOf('.chat-tab.is-active .chat-tab-name')) >= 600, 'chat tab name: bold');
  // Bold is reserved in advance by a hidden bold ghost, so no tab changes width.
  const ghost = ruleOf('.chat-tab-name::after');
  assert.match(ghost, /content: attr\(data-label\)/);
  assert.match(ghost, /font-weight: 700/);
  assert.match(ghost, /white-space: nowrap/);
  assert.match(ghost, /height: 0/);
  assert.match(ghost, /visibility: hidden/);
  assert.match(read('ChatPanel.jsx'), /className="chat-tab-name" data-label=\{c\.title\}/);
  // Truncation survives: the name keeps its ellipsis.
  assert.match(ruleOf('.chat-tab-name'), /text-overflow: ellipsis/);
});

test('chat tabs: the plan mode is a pressed button, not a switch, and no old alias is left', () => {
  const src = read('ChatPanel.jsx');
  assert.match(src, /aria-pressed=\{chat\.planMode === true\}/);
  assert.match(src, /api\.setPlanMode\(task, chat\.id, !chat\.planMode\)/);
  assert.doesNotMatch(src, /role="switch"/);
  assert.doesNotMatch(src, /plan-switch/);
  assert.doesNotMatch(src, /type="checkbox"/);
  // The tab keeps its hooks (renaming, run count, waiting mark) and the add buttons say what they do.
  for (const hook of ['chat-tab-label', 'chat-tab-close', 'chat-add', 'run-count', 'ask-dot', 'chat-tab-rename']) {
    assert.ok(src.includes(hook), `ChatPanel keeps ${hook}`);
  }
  assert.match(src, /aria-label=\{t\.chat\.panel\.newChat\}/);
  assert.equal(E('chat.panel.newChat'), 'Abrir otra conversación en blanco');
  assert.doesNotMatch(src, /className="(?:primary|warn|danger|ghost|close)\b/);
});

test('chat panel: model and closed chats are popovers; the composer says why Enviar is off', () => {
  const src = read('ChatPanel.jsx');
  assert.match(src, /usePopover\(\)/);
  assert.match(src, /<Popover pop=\{histPop\}/);
  assert.match(src, /<Popover pop=\{modelPop\}/);
  assert.match(src, /t\.chat\.panel\.sendEmpty/);
  assert.equal(E('chat.panel.sendEmpty'), 'Escribe algo para enviar');
  assert.match(src, /aria-label=\{t\.chat\.panel\.closePanel\}/);
  assert.equal(E('chat.panel.closePanel'), 'Cerrar el panel');
  // No mask on the thread: it would wash out the sticky day band at its top.
  // The band itself fades into the thread instead.
  assert.doesNotMatch(ruleOf('.cp-messages'), /mask-image/);
  assert.match(ruleOf('.cp-messages > .day-divider'), /background: linear-gradient\(var\(--col\) 75%, transparent\)/);
  // The old padding of styles.css (0,2,0) must not beat the square tab buttons.
  assert.match(ruleOf('.chat-tab.chat-add'), /padding: 0;/);
  assert.match(ruleOf('.chat-tab .chat-tab-close'), /padding: 0;/);
  // The phone keeps its two-line composer and the 16px text that stops the iOS zoom.
  assert.match(css, /@media \(max-width: 780px\)[\s\S]*--composer-lines: 2/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
