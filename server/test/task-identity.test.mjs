// `task.issue` is a number; a task's identity is `keyOf(task)`.
//
// The bug this file exists for: `pipeline.js` called its own doors with the
// bare issue number — `steps.ensureWorktree(task.issue)` — and those doors
// resolve what they are given with `store.get()` / `keyIn()`, which go through
// `coerceKey`. `coerceKey` NEVER throws: given `1` it fills the missing half
// with the default project and answers `'hfs#1'`. So issue #1 of
// `eterceros/app-b` was looked up as `hfs#1`, which does not exist, and
// the card went `worktree → error (Tarea #1 desconocida)`. Reported by the maintainer,
// reproduced on the laptop and on `runner-1`.
//
// It is invisible in review — the call reads perfectly — and it is green in
// every test that uses the default project, which is all of them. So the
// source is read instead of trusted, in the style of `data-dir.test.mjs` (the
// import graph) and `ghgate-wiring.test.mjs` (the shape of a call).
//
// No `./isolate.mjs`: this file imports nothing from `../src/`, it only reads
// `pipeline.js` as text, so nothing here can reach the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(TEST_DIR, '..', 'src', 'pipeline.js');

/**
 * The doors of `pipeline.js` that resolve their first argument against the
 * store: each one does `store.get(issue)` or `keyIn(issue)` (which is
 * `coerceKey`) on it. Passing a bare number to any of them is the bug above.
 *
 * Derived by hand from every `store.get(` / `keyIn(` in `pipeline.js` — an
 * explicit list, on purpose: a heuristic ("any function whose first parameter
 * is called `issue`") would drift into both false positives and silent misses,
 * and this list is short enough to keep honest. `ALSO_RESOLVES` below keeps it
 * honest: every name here must still exist in the file.
 *
 * NOT here, deliberately, because they take the issue as a NUMBER (or, for
 * `putAttachment`, a number or `_proyecto`) and never touch the store:
 * `getIssue`, `issueReopenInfo`, `classifyIssue`, `detectExistingWork`,
 * `linkedPullRequests`, `findBranchesForIssue`, `putAttachment`, `qaDirOf`,
 * `opencodeConfigDirOf`.
 */
const RESOLVERS = [
  // run/ownership bookkeeping, keyed by task key
  'isUserRun', 'isRunning', 'isPipelineRunning', 'markRunning',
  // task lifecycle
  'setMode', 'startTask', 'setTaskMachine', 'ensureWorktree', 'acceptFix', 'publishPr', 'retry', 'bootstrapRepo',
  'bringMainNow', 'askMergeHelp', 'pushNow', 'markReady', 'deleteWorktree',
  'runBrowserQa', 'setBrowserQa', 'setDemo',
  // pending questions and plans
  'answerChatPending', 'answerTaskPending', 'setApprovePlan', 'setFixGaps', 'setDesign', 'decideTaskPlan',
  'continueChatPlan', 'stopChatPlan',
  // chats and their live sessions
  'sendChat', 'createChat', 'closeChat', 'reopenChat', 'deleteChat', 'interruptChat',
  'setChatModel', 'setChatPlanMode', 'closeLiveSession',
  'backfillAgent', 'agentCalls', 'stopBackground',
  // change requests
  'setActiveChangeRequest', 'startChangeRequest', 'draftReviewReplies',
  'discardReviewReplies', 'resolveChangeRequest',
];

/**
 * A call whose first argument is `<something>.issue`, optionally reached
 * through a seam (`steps.ensureWorktree`, `pipelineHooks.run`).
 *
 * Only the literal form is caught: `sendChat(task.issue, …)`. Laundering the
 * number through a variable first (`const n = task.issue; sendChat(n, …)`)
 * gets past this, and that is a known, accepted limit — the point is to catch
 * the shape that was actually written eleven times, not to prove a theorem.
 */
const CALL = new RegExp(String.raw`(?:^|[^\w$.])(?:(\w[\w$]*)\.)?(${RESOLVERS.join('|')})\s*\(\s*(\w[\w$]*)\.issue\b`, 'g');

/** Where the comments are, so a comment that spells out the bad call is not one. */
function commentRanges(src) {
  const ranges = [];
  let i = 0;
  while (i < src.length) {
    const block = src.indexOf('/*', i);
    // A `//` that is not the tail of a `://` URL inside a string.
    let line = -1;
    for (let j = i; j < src.length - 1; j += 1) {
      if (src[j] === '/' && src[j + 1] === '/' && src[j - 1] !== ':') { line = j; break; }
    }
    const next = [block, line].filter((n) => n >= 0).sort((a, b) => a - b)[0];
    if (next === undefined) break;
    if (next === block) {
      const end = src.indexOf('*/', block + 2);
      ranges.push([block, end < 0 ? src.length : end + 2]);
      i = end < 0 ? src.length : end + 2;
    } else {
      const end = src.indexOf('\n', line);
      ranges.push([line, end < 0 ? src.length : end]);
      i = end < 0 ? src.length : end;
    }
  }
  return ranges;
}

/**
 * Every place a bare issue number is handed to a door that resolves it against
 * the store.
 *
 * @param {string} src the source of `pipeline.js`.
 * @returns {{line: number, receiver: string, holder: string, text: string}[]}
 */
export function identityLeaks(src) {
  const comments = commentRanges(src);
  const inComment = (at) => comments.some(([from, to]) => at >= from && at < to);
  const leaks = [];
  for (let m = CALL.exec(src); m; m = CALL.exec(src)) {
    const at = m.index + m[0].length - `${m[3]}.issue`.length;
    if (inComment(at)) continue;
    const line = src.slice(0, at).split('\n').length;
    leaks.push({
      line,
      receiver: m[1] ? `${m[1]}.${m[2]}` : m[2],
      holder: m[3],
      text: src.split('\n')[line - 1].trim(),
    });
  }
  return leaks;
}

/** The failure message a person has to be able to act on without reading this file. */
const complain = (leaks) => leaks.map((l) =>
  `pipeline.js:${l.line} — \`${l.receiver}(${l.holder}.issue, …)\`: ${l.receiver} resolves its first argument `
  + `against the store (store.get / keyIn → coerceKey), so a bare number is read as the DEFAULT project: `
  + `issue #1 of another project becomes \`hfs#1\` and the task is «desconocida». `
  + `Pass the identity, not the number: \`${l.receiver}(keyOf(${l.holder}), …)\`. `
  + `\n      ${l.text}`).join('\n');

test('no call inside pipeline.js hands a store-resolving door a bare issue number', () => {
  const src = readFileSync(PIPELINE, 'utf8');
  const leaks = identityLeaks(src);
  assert.equal(leaks.length, 0, `\n${complain(leaks)}\n`);
});

test('the list of store-resolving doors is still the file\'s own vocabulary', () => {
  // A rename would empty the regex of that name and the check would pass by
  // testing nothing at all — the classic way a source analyzer rots.
  const src = readFileSync(PIPELINE, 'utf8');
  // `\s*[(=]`: a door is either `function name(` or `const name = (issue) =>`.
  const gone = RESOLVERS.filter((name) => !new RegExp(String.raw`\b${name}\s*[(=]`).test(src));
  assert.deepEqual(gone, [], 'these no longer exist in pipeline.js: update RESOLVERS (or the rename dropped a guard)');
});

test('the analyzer catches the bug it was written for', () => {
  // A parser that has only ever been seen to pass proves nothing, so it is
  // shown the real shape of the bug — the line that took app-b's #1
  // down — plus every variant that fooled a review.
  const bad = [
    'async function runPipeline(task, steps) {',
    '  await steps.ensureWorktree(task.issue);',           // the reported bug, through the seam
    '  sendChat(task.issue, principalChat(task)?.id, [];',  // direct
    '  closeLiveSession(t.issue, chat.id);',                // any holder, not just `task`
    '  setChatModel( task.issue , chat.id, m);',            // whitespace
    '}',
  ].join('\n');

  const leaks = identityLeaks(bad);
  assert.deepEqual(
    leaks.map((l) => [l.line, l.receiver, l.holder]),
    [[2, 'steps.ensureWorktree', 'task'], [3, 'sendChat', 'task'], [4, 'closeLiveSession', 't'], [5, 'setChatModel', 'task']],
  );

  // And the message names the line, the call and the cure.
  const said = complain(leaks);
  assert.match(said, /pipeline\.js:2/);
  assert.match(said, /steps\.ensureWorktree\(task\.issue/);
  assert.match(said, /keyOf\(task\)/);
});

test('the analyzer leaves alone everything that is genuinely a number', () => {
  const fine = [
    '/** `sendChat(task.issue, …)` is how this used to be written. */',
    'export async function ensureWorktree(issue) {',            // the definition
    '  const task = store.get(issue);',
    '  const meta = await getIssue(task.issue);',                // a number for gh
    '  const info = await steps.issueReopenInfo(task.issue);',   // a number for gh
    '  await detectExistingWork(task.issue, { project: task.project });',
    '  const dir = path.join(root, String(task.issue));',        // a number in a path
    '  const body = `cierra #${task.issue}`;',                   // a number in text
    '  await machine.putAttachment(task.issue, a.path, a.name);',
    '  await steps.ensureWorktree(keyOf(task));',                // the fix
    '  sendChat(keyOf(task), chat.id, text);',
    '  // closeLiveSession(task.issue, chat.id) was the old spelling',
    '}',
  ].join('\n');

  assert.deepEqual(identityLeaks(fine), []);
});
