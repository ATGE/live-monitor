import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The web has no test runner: the full-height rules of the layout are read
// as text. Every one declares `vh` first (the fallback) and `dvh` after it.

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');
const css = readFileSync(path.join(WEB, 'src', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
// The column's rule moved to the board's own stylesheet; `.app` stayed behind.
const boardCss = readFileSync(path.join(WEB, 'src', 'styles', 'board.css'), 'utf8').replace(/\r\n/g, '\n');

/** The declaration block of the first rule whose selector line is exactly `selector`. */
function ruleOf(selector, source = css) {
  const at = source.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no rule for ${selector}`);
  return source.slice(at, source.indexOf('}', at));
}

test('the app declares 100vh first and 100dvh after it; the column fills its parent', () => {
  const rule = ruleOf('.app');
  const vh = rule.search(/100vh/);
  const dvh = rule.search(/100dvh/);
  assert.ok(vh >= 0 && dvh > vh, '.app: vh fallback, then dvh');
  // The column is bounded by its parents (KPI strip above, Completadas below),
  // not by a viewport calc that ignores them.
  const column = ruleOf('.bd-col', boardCss);
  assert.match(column, /max-height:\s*100%/, '.bd-col: max-height 100%');
  assert.doesNotMatch(column, /100d?vh/, '.bd-col: no viewport calc');
});
