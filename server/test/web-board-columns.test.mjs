import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';
const E = (path) => path.split('.').reduce((o, k) => o[k], es);

// The web has no test runner: the board's columns, rails and phone lanes are
// read as text.

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web');
const src = (...p) => readFileSync(path.join(WEB, 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const board = src('components', 'Board.jsx');
const css = src('styles', 'board.css');
const card = src('components', 'ProjectChatCard.jsx');

test('Board.jsx keeps the shared busy and hide-when-empty rules', () => {
  assert.match(board, /BUSY_STATES\.includes\(task\.state\)/);
  assert.match(board, /HIDE_WHEN_EMPTY\.includes\(key\)/);
  assert.doesNotMatch(board, /const BUSY\s*=/);
});

test('an empty column folds into a rail that opens on click', () => {
  assert.match(board, /is-rail/);
  assert.match(board, /aria-label=\{`\$\{info\.label\}: \$\{plural\(0, t\.common\.task\)\}`\}/);
  assert.equal(E('common.task.other'), '{n} tareas');
  assert.match(board, /onClick=\{\(\) => open\(key\)\}/);
  assert.match(css, /\.bd-col\.is-rail\s*\{[^}]*width:\s*40px/);
  assert.doesNotMatch(board, /<button[^>]*>(?:(?!<\/button>)[\s\S])*<h2/, 'no heading inside a button');
  assert.match(css, /writing-mode:\s*vertical-rl/);
});

test('"N columnas más" counts the columns out of view and scrolls to the next', () => {
  assert.match(board, /ResizeObserver/);
  assert.match(board, /addEventListener\('scroll'/);
  assert.match(board, /plural\(more\.count, t\.board\.moreColumns\)/);
  assert.equal(E('board.moreColumns.other'), '{n} columnas más');
  assert.equal(E('board.moreColumns.one'), '{n} columna más');
  assert.match(board, /scrollBy\(/);
  assert.match(board, /prefers-reduced-motion/);
  assert.match(css, /\.bd-fade\s*\{[^}]*width:\s*40px/);
});

test('the phone shows one lane at a time, picked from chips with aria-current', () => {
  assert.match(board, /aria-label=\{t\.board\.columnsNav\}/);
  assert.equal(E('board.columnsNav'), 'Columnas');
  assert.match(board, /scrollend/);
  assert.doesNotMatch(board, /onScroll=\{onLaneScroll\}/, 'no write per scroll event');
  assert.match(board, /aria-current=\{key === activeKey \? 'true' : undefined\}/);
  assert.match(board, /hfsmon-mobile-column/);
  assert.match(board, /usePhone|PHONE/);
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.match(css, /scroll-snap-type:\s*x mandatory/);
});

test('first load paints ghost columns, only while loading', () => {
  assert.match(board, /\{loading && <BoardSkeleton \/>\}/);
  assert.match(board, /const empty = !loading/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.bd-ghost\s*\{\s*animation:\s*none/);
});

test('an empty board says so and offers "Buscar ahora"', () => {
  assert.match(board, /t\.board\.noOpenTasks/);
  assert.equal(E('board.noOpenTasks'), 'No hay tareas abiertas en este proyecto.');
  assert.match(board, /t\.board\.pollNow/);
  assert.equal(E('board.pollNow'), 'Buscar ahora');
  assert.match(board, /onPollNow\?\.\(\)/);
  assert.match(board, /disabled=\{polling\}/);
  assert.match(board, /name="refresh"/);
});

test('the project chat card keeps its id, role and keyboard', () => {
  assert.match(card, /id=\{`card-\$\{holder\.key\}`\}/);
  assert.match(card, /role="button"/);
  assert.match(card, /tabIndex=\{0\}/);
  assert.match(card, /e\.key === 'Enter' \|\| e\.key === ' '/);
  assert.match(card, /bd-project/);
  assert.doesNotMatch(card, /className="[^"]*\b(card|chip|spinner)\b/);
});

test('board.css uses tokens only and no !important', () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b/);
  assert.doesNotMatch(css, /!important/);
});
