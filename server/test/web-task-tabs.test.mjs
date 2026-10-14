import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The web has no test runner: the task tab strip is read as text.

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');
const css = readFileSync(path.join(WEB, 'src', 'styles', 'task-tabs.css'), 'utf8').replace(/\r\n/g, '\n');

/** The declaration block of the first rule whose selector line is exactly `selector`. */
function ruleOf(selector, source = css) {
  const at = source.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no rule for ${selector}`);
  return source.slice(at, source.indexOf('}', at));
}

test('the active task tab is unmistakable and does not shift the strip', () => {
  const weight = (rule) => Number(rule.match(/font-weight:\s*(\d+)/)?.[1] ?? 0);
  const bg = (rule) => rule.match(/background:\s*([^;]+);/)?.[1];
  const on = ruleOf('.task-tabs-bar .task-tab.is-active');
  const off = ruleOf('.task-tabs-bar .task-tab');
  // Bold lives on the text spans only: on the container it would reach
  // `.run-count` (no ghost) and the tab would change width when selected.
  assert.doesNotMatch(on, /font-weight/, '.task-tab.is-active: no font-weight on the container');
  assert.doesNotMatch(on, /#[0-9a-f]{3,8}/i, 'tokens only, no hex');
  assert.ok(bg(on) && bg(on) !== bg(off), '.task-tab.is-active: its own background');
  assert.match(on, /inset 0 2px 0 var\(--text-2\)/, '.task-tab.is-active: a 2px top mark');
  const taskSpans = ruleOf('.task-tab.is-active .task-tab-num,\n.task-tab.is-active .task-tab-title');
  assert.ok(weight(taskSpans) >= 600, 'task tab number and title: bold');
  // Bold is reserved in advance by a hidden bold ghost, so no tab changes width.
  const ghost = ruleOf('.task-tab-num::after,\n.task-tab-title::after');
  assert.match(ghost, /content: attr\(data-label\)/);
  assert.match(ghost, /font-weight: 700/);
  assert.match(ghost, /white-space: nowrap/);
  assert.match(ghost, /height: 0/);
  assert.match(ghost, /visibility: hidden/);
  const tabs = readFileSync(path.join(WEB, 'src', 'components', 'TaskTabs.jsx'), 'utf8');
  assert.match(tabs, /className="task-tab-num" data-label=/);
  assert.match(tabs, /className="task-tab-title" data-label=/);
  // Truncation survives: the title keeps its ellipsis.
  assert.match(ruleOf('\n.task-tab-title'), /text-overflow: ellipsis/);
  // The 120px floor must be lifted, at the same specificity, where the title hides.
  for (const q of ['@container (max-width: 460px) {', '@media (max-width: 780px) {']) {
    const at = css.indexOf(q);
    assert.ok(at >= 0, `no ${q}`);
    assert.match(css.slice(at, at + 120), /\.task-tabs-bar \.task-tab \{ min-width: 0; \}/, `${q} lifts min-width`);
  }
});
