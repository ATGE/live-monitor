import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';

// The web has no test runner: the Browser QA preview's touch behaviour is read
// as text. The lens's rules live in the side panels' own stylesheet (the old
// copies in styles.css are dead and go in the consolidation wave).

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');
const css = readFileSync(path.join(WEB, 'src', 'styles', 'side-panels.css'), 'utf8').replace(/\r\n/g, '\n');

/** The declaration block of the first rule whose selector line is exactly `selector`. */
function ruleOf(selector, source = css) {
  const at = source.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no rule for ${selector}`);
  return source.slice(at, source.indexOf('}', at));
}

test('on touch screens the QA hot zone is click-through; wide ones get a zoom button outside the video', () => {
  const rd = (...p) => readFileSync(path.join(WEB, 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
  const panel = rd('components', 'BrowserQaPanel.jsx');
  const hook = rd('components', 'useHoverPreview.js');
  const preview = rd('components', 'EvidencePreview.jsx');
  const coarse = css.slice(css.indexOf('@media (hover: none) and (pointer: coarse) {'));
  assert.match(ruleOf('  .qa-hot', coarse), /pointer-events: none/, 'taps reach the <video> at any width');
  const wide = css.slice(css.indexOf('@media (hover: none) and (pointer: coarse) and (min-width: 781px) {'));
  assert.match(ruleOf('  .qa-zoom', wide), /display: inline-flex/);
  assert.match(ruleOf('  .qa-zoom', wide), /min-width: 40px; min-height: 40px/);
  assert.match(ruleOf('.qa-zoom'), /display: none/, 'hidden everywhere else');
  assert.doesNotMatch(css, /\.qa-zoom[^}]*position: absolute/, 'no longer over the video');
  const bar = panel.slice(panel.indexOf('className="qa-video-bar"'), panel.indexOf('<SpeedBar'));
  assert.equal(es.card.qa.zoomAria, 'Ampliar el vídeo');
  assert.equal(es.card.qa.zoom, 'Ampliar');
  assert.match(bar, /className="qa-zoom" aria-label=\{t\.card\.qa\.zoomAria\}/, 'inside the bar, outside the video');
  assert.match(bar, /data-qa-anchor/);
  assert.match(bar, /<Icon name="maximize"\/> \{t\.card\.qa\.zoom\}/);
  assert.match(panel, /preview\.openAt\(e, [^)]*, ev\.currentTarget\)/, 'focus goes back to the button');
  assert.match(bar, /aria-describedby=/);
  assert.match(panel, /qa-hot" \{\.\.\.preview\.bind\(e\)\}/, 'desktop hot zone kept');
  assert.match(panel, /<QaVideo [^>]*\bplaysInline\b/, 'iPhone plays in place');
  assert.match(preview, /<QaVideo[^>]*?\bplaysInline\b/s, 'also in the zoomed view');
  assert.match(hook, /const show = useCallback\(\(item, el, focusEl = el\)/);
  assert.match(hook, /anchorEl\.current = focusEl/);
  assert.match(hook, /const bind = useCallback/);
  assert.match(hook, /return \{ open, anchor: state\?\.anchor \?\? null, bind, openAt,/);
});
