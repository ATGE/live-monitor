import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

// Text-level checks, as for the other web tests: there is no browser runner.
const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const strip = read('web/src/components/CompletedStrip.jsx');
const rail = read('web/src/components/CompletedRail.jsx');
const css = read('web/src/styles/completed.css');

test('CompletedStrip: 14-day summary, three endings, remembered fold', () => {
  assert.match(strip, /completedByDay\(/);
  assert.match(strip, /<SparkColumns /);
  assert.match(strip, /t\.board\.done\.recent\b/);
  assert.equal(E('board.done.recent'), '{n} en 14 días');
  for (const [key, text] of [['merged', 'PR mergeado'], ['noPr', 'cerrada sin PR'], ['issueClosed', 'issue cerrado en GitHub']]) {
    assert.ok(strip.includes(`t.board.ending.${key}`), key);
    assert.equal(E(`board.ending.${key}`), text);
  }
  // The fold preference is a per-device convenience, always inside try.
  assert.match(strip, /try \{ localStorage\.setItem\(DONE_KEY/);
  assert.match(strip, /try \{ return localStorage\.getItem\(DONE_KEY\)/);
  assert.match(strip, /fill\(t\.board\.done\.noResults, \{ query \}\)/);
  assert.equal(E('board.done.noResults'), 'Sin resultados para «{query}»');
});

test('CompletedStrip and rail: no old classes in the new markup', () => {
  assert.doesNotMatch(strip, /className="(completed|done-|rail)/);
  assert.doesNotMatch(rail, /className="(rail|pill|chip)|`(pill|chip) /);
});

test('CompletedRail: cited symbols stay, ticks carry the ending', () => {
  for (const sym of [/function CompletedRail\(/, /const locate = /, /const measure = /, /const show = /, /function Popup\(/]) {
    assert.match(rail, sym);
  }
  assert.match(rail, /<Pill /);
  assert.match(rail, /<Chip /);
  assert.match(strip, /is-located/);
  for (const cls of ['cs-tick-merged', 'cs-tick-nopr', 'cs-tick-closed']) {
    assert.ok(rail.includes(cls), cls);
    assert.ok(css.includes(`.${cls}`), cls);
  }
});

test('completed.css: tokens only, shape besides colour, phone strip', () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /!important/);
  assert.match(css, /\.cs-tick-nopr \{[^}]*box-shadow: inset/);
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.match(css, /scroll-snap-type: x mandatory/);
  assert.match(css, /\.cs-cards > \.tc-compact \{ flex: none; width: var\(--card-w\)/);
  assert.match(css, /\.cs-cards > \.tc-compact \{ width: min\(82vw, var\(--card-w\)\); scroll-snap-align: center/);
});
