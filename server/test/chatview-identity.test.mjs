// `chatView` is an identity, not an issue number: `<project, issue>` plus the
// chat on screen. `App.jsx` resolves it by matching BOTH halves —
// `visible.find((t) => t.issue === chatView.issue && t.project === chatView.project)`
// — so a view written without `project` matches nothing, `chatTask` is null,
// `sideOpen` goes false and the whole side panel disappears.
//
// The bug this file exists for: the «+» / «⑂» buttons and every chat tab set
// `setChatView({ issue: chatTask.issue, chatId: id })`. Opening a new chat
// closed the panel; reopening it and clicking that chat closed it again.
// Reported by Edson. It is the client-side twin of `task-identity.test.mjs`:
// the composite key reduced back to the bare issue, invisible in review
// because the line reads perfectly.
//
// The cure in place is `showChat`, which PATCHES the view (`{ ...v, chatId }`)
// instead of rebuilding it, so no half can be dropped. This test guards the
// other shape: a view built from scratch must name its project.
//
// `./isolate.mjs` first, as every test file does (`data-dir.test.mjs` insists):
// this file reads `web/src` only, but it must never reach `data/` unisolated.
import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(TEST_DIR, '..', '..', 'web', 'src', 'App.jsx');

/** The object literal starting at `from` (which must be its `{`), braces balanced. */
function literalAt(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

/**
 * Every `setChatView({ … })` whose literal never names `project`.
 *
 * Only literals are examined. `setChatView(null)` closes the panel and
 * `setChatView((v) => …)` patches it — neither can lose a half, so neither is
 * a leak.
 *
 * @param {string} src the source of `App.jsx`.
 * @returns {{line: number, text: string}[]}
 */
export function viewsWithoutProject(src) {
  const call = /setChatView\(\s*\{/g;
  const leaks = [];
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const open = src.indexOf('{', m.index);
    const literal = literalAt(src, open);
    if (/\bproject\b/.test(literal)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    leaks.push({ line, text: literal.replace(/\s+/g, ' ') });
  }
  return leaks;
}

/** The failure message a person has to be able to act on without reading this file. */
const complain = (leaks) => leaks.map((l) =>
  `App.jsx:${l.line} — \`setChatView(${l.text})\` has no \`project\`: \`chatTask\` matches on both `
  + 'halves of the key, so this view resolves to nothing, `sideOpen` goes false and the side panel '
  + 'disappears on click. Name the project, or patch the view instead of rebuilding it '
  + '(`showChat(id)` / `setChatView((v) => ({ ...v, … }))`).'
  + `\n      ${l.text}`).join('\n');

test('no chat view is built without its project', () => {
  const src = readFileSync(APP, 'utf8');
  const leaks = viewsWithoutProject(src);
  assert.equal(leaks.length, 0, `\n${complain(leaks)}\n`);
});

test('the analyzer is still looking at the real thing', () => {
  // A rename of `setChatView`, or a move of App.jsx, would leave this file
  // passing by testing nothing at all — the classic way a source analyzer rots.
  const src = readFileSync(APP, 'utf8');
  const literals = [...src.matchAll(/setChatView\(\s*\{/g)];
  assert.ok(literals.length > 0, 'no `setChatView({ … })` left in App.jsx: this guard now tests nothing');
  assert.match(src, /chatView\.project/, 'the view is no longer resolved by project: revisit this guard');
});

test('the analyzer catches the bug it was written for, and leaves the cures alone', () => {
  const sample = [
    'setChatView({ issue: chatTask.issue, chatId: c.id });',        // the reported bug
    'setChatView({ project, issue, chatId });',                     // openChat: fine
    'setChatView(null);',                                           // closing: fine
    'setChatView((v) => (v ? { ...v, chatId } : v));',              // showChat: fine
    'setChatView({\n  issue,\n  chatId: id,\n});',                  // multi-line, still a leak
  ].join('\n');

  assert.deepEqual(viewsWithoutProject(sample).map((l) => l.line), [1, 5]);
  assert.match(complain(viewsWithoutProject(sample)), /App\.jsx:1/);
  assert.match(complain(viewsWithoutProject(sample)), /showChat/);
});

test('every chat view names its owner kind, and a holder view names its machine', () => {
  const src = readFileSync(APP, 'utf8');
  const call = /setChatView\(\s*\{/g;
  let seen = 0;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const literal = literalAt(src, src.indexOf('{', m.index));
    seen += 1;
    assert.match(literal, /owner/, `a chat view without \`owner\`: ${literal.replace(/\s+/g, ' ')}`);
    if (/owner: 'project'/.test(literal)) assert.match(literal, /machine/, 'a holder view needs its machine');
  }
  assert.ok(seen >= 2, 'both the task and the project view are built from scratch');
});

test('taskKey and sameTask: two holders of one project never cross-talk, and a holder is never a task', async () => {
  const k = await import(pathToFileURL(path.join(TEST_DIR, '..', '..', 'web', 'src', 'taskKey.js')).href);
  const a = { kind: 'project', key: 'hfs@local', project: 'hfs', machine: 'local', issue: null };
  const b = { kind: 'project', key: 'hfs@runner-1', project: 'hfs', machine: 'runner-1', issue: null };
  const task = { project: 'hfs', issue: 12 };
  assert.equal(k.taskKey(a), 'hfs@local');
  assert.equal(k.taskKey(task), 'hfs#12');
  assert.equal(k.holderTabEntry('hfs', 'local'), 'p:hfs@local');
  assert.deepEqual(k.parseHolderTab('p:hfs@runner-1'), { project: 'hfs', machine: 'runner-1' });
  assert.equal(k.parseHolderTab(12), null);
  const toA = { owner: 'project', project: 'hfs', machine: 'local', issue: null };
  assert.equal(k.sameTask(toA, a), true);
  assert.equal(k.sameTask(toA, b), false, 'other machine');
  assert.equal(k.sameTask(toA, task), false, 'a holder message is not a task message');
  assert.equal(k.sameTask({ project: 'hfs', issue: 12 }, a), false, 'a task message is not a holder message');
  assert.equal(k.sameTask({ project: 'hfs', issue: 12 }, task), true);
  assert.equal(k.sameTask({ issue: 12 }, task), true, 'no project stamped: still the task');
});
