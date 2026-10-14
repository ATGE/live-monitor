// Every `gh` call the board makes says `-R <owner/name>`, and which repository
// that is comes from the project. `github.js` takes it in every function — but
// ALWAYS with a default, `DEFAULT_PROJECT_ID`, so a call that forgets it
// compiles, runs, and quietly talks to hfs.
//
// The bug this file exists for: Edson imported `eterceros/app-b`; its
// issue #1 is «Mode custom List of words». The card came back titled
// «feat/LEI-20: integrate the HL7.FHIRPath.Validator» — the title of issue #1
// of `HeliosSoftware/hfs` — and the branch was derived from it. `github.js`
// had already grown `projectId` on all of its doors; `pipeline.js` passed it
// on exactly two of them. Nobody saw the hole because every signature has a
// default: there is no arity error, no crash, no log line. It is green in
// every test, because every test uses the default project.
//
// Reading the title off the wrong repository is embarrassing. The same missing
// argument on the writing doors is not: `createDraftPr` would open a pull
// request in `HeliosSoftware/hfs`, and `commentOnPr` / `replyToReviewThread` /
// `requestReviewForChangeRequest` would write in another team's repository,
// in public, over a task that has nothing to do with it.
//
// So the source is read instead of trusted, like `task-identity.test.mjs` (the
// identity of a task) and `ghgate-wiring.test.mjs` (the shape of a call).
//
// No `./isolate.mjs`: nothing here imports `../src/` at runtime — every file
// it looks at is read as text — so nothing can reach the live store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const srcFile = (name) => path.join(TEST_DIR, '..', 'src', name);
const GITHUB = srcFile('github.js');

/**
 * Every module that may talk to `github.js` — not just the one that got this
 * wrong. The hole this file closes was born of exactly that assumption («ese
 * archivo es de otro paquete»), so the sweep is of the whole seam, not of the
 * file where it happened to show.
 *
 * `pipeline.js` is where the 20 leaks were. `poller.js` and `index.js` call
 * `listAssignedIssues` / `listClosedAssignedIssues` / `getIssue` and already
 * pass the project — they are here so they keep doing it. `move.js` calls
 * nothing of `github.js` today; it is here so that the first call somebody
 * adds there arrives with a project.
 *
 * A file that stops importing `github.js` is not a problem for this list, and
 * one that starts importing it must be added: the last test below fails when
 * `server/src/` grows an importer this list does not name.
 */
const SWEPT = ['pipeline.js', 'move.js', 'poller.js', 'index.js', 'issuedraft.js'];

/**
 * Every door of `github.js` that runs `gh` against one repository, and WHERE
 * that repository's project goes in the call. Two shapes, because `github.js`
 * has two:
 *
 * - `{ last: n }` — the project is the **last positional argument**, and a
 *   complete call therefore has exactly `n` arguments: `getIssue(number,
 *   project)` is `{ last: 2 }`.
 * - `{ options: i }` — the project is a **field of the options object** at
 *   argument index `i`: `prsForBranch(branch, { cache, project })` is
 *   `{ options: 1 }`.
 *
 * `write: true` marks the doors that change something in GitHub that other
 * people see — a pull request, a review comment, a review request. Those are
 * why this file is not a style check.
 *
 * An explicit, hand-kept list on purpose: derived from `github.js`'s exports,
 * and checked against them below, so it cannot silently drift into testing
 * nothing. Functions of `github.js` that take no project at all
 * (`summarizeChecks`, `closeIssueArgs`, `normalizePrList`, `prBranchCacheKey`,
 * `closingCommentMarker`, `findPriorClosingComment`) are deliberately absent.
 *
 * Doors nothing in `server/src/` calls yet are listed all the same — today
 * that is `issueComments`, `currentLogin`, `repoLabels`, `issueOrPrRef`,
 * `publishIssueComment`, `addIssueLabels`, `closeIssue` and `markPrReady`.
 * Three of them write (they comment on, label and close issues), and the whole
 * point of this file is that the silent default is waiting for whoever wires
 * them up. A guard that only covers what is already wired arrives late.
 */
const GH_DOORS = {
  // reads
  getIssue: { last: 2 },
  issueStates: { last: 2 },
  issueStatesQueries: { last: 2 },
  linkedPullRequests: { last: 2 },
  findPrForBranch: { last: 2 },
  prView: { last: 2 },
  issueReopenInfo: { last: 2 },
  getChangeRequests: { last: 2 },
  listAssignedIssues: { last: 1 },
  listClosedAssignedIssues: { last: 2 },
  issueComments: { last: 2 },
  currentLogin: { last: 1 },
  repoLabels: { last: 1 },
  issueOrPrRef: { last: 2 },
  prsForBranch: { options: 1 },
  searchRepoUsers: { options: 1, bare: true },
  checksForOpenPrs: { options: 0 },
  // writes — these land in somebody else's repository
  readyPr: { last: 2, write: true },
  // `arity`: the declaration has more parameters than the project's position
  // (an optional login after it). No door has a default project: a call without
  // it fails loudly in github.js (`falta el proyecto`) instead of reaching hfs.
  addReviewer: { last: 2, arity: 3, bare: true, write: true },
  markPrReady: { last: 2, arity: 3, write: true },
  replyToReviewThread: { last: 3, write: true },
  commentOnPr: { last: 3, write: true },
  requestReviewForChangeRequest: { last: 3, write: true },
  addIssueLabels: { last: 3, write: true },
  createDraftPr: { options: 0, bare: true, write: true },
  closeIssue: { options: 1, write: true },
  publishIssueComment: { options: 2, write: true },
};

const NAMES = Object.keys(GH_DOORS);

/**
 * The source with every comment, string and template body replaced by spaces,
 * character for character, so offsets and line numbers still line up.
 *
 * Why: a `//` that spells out the bad call must not be a finding, a `(` inside
 * a string must not unbalance the argument scanner, and the word «project»
 * inside a log line must not pass for an argument.
 */
export function blank(src) {
  const out = src.split('');
  const hide = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      hide(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      hide(i, end < 0 ? src.length : end + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') { depth += 1; j += 2; continue; }
        if (c === '`' && depth > 0 && src[j] === '}') { depth -= 1; j += 1; continue; }
        if (src[j] === c && depth === 0) break;
        if (c !== '`' && src[j] === '\n') break;   // an unterminated quote: give up on this line
        j += 1;
      }
      hide(i + 1, j);
      i = j + 1;
    } else i += 1;
  }
  return out.join('');
}

/** The arguments of the call whose `(` is at `open`, split at top level. */
function argsAt(src, open) {
  let depth = 0;
  const parts = [];
  let start = open + 1;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      depth -= 1;
      if (depth === 0) {
        const tail = src.slice(start, i);
        if (parts.length || tail.trim()) parts.push(tail);
        return parts;
      }
    } else if (c === ',' && depth === 1) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return null;   // unbalanced: not a call this file can judge
}

/** Does this argument name a project? `task.project`, `project`, `projectId`. */
const namesProject = (arg) => /\bproject(Id)?\b/.test(arg ?? '');

/** Does this options object carry a `project` field (`project: x` or shorthand)? */
const carriesProject = (arg) => /(?:^|[{,\s])project\s*(?::|,|\}|$)/.test(arg ?? '');

/**
 * Every call in `src` to a door of `GH_DOORS` that does not say which project
 * it is for — and would therefore reach `HeliosSoftware/hfs`.
 *
 * Only a literal call is caught: `prView(n)`, `steps.prView(n)`. A door reached
 * through a variable (`const f = prView; f(n)`) gets past this, a known and
 * accepted limit — the point is the shape that was actually written eighteen
 * times, not to prove a theorem.
 *
 * @param {string} src the source of `pipeline.js`.
 * @returns {{line: number, receiver: string, fn: string, why: string, text: string}[]}
 */
export function projectLeaks(src) {
  const clean = blank(src);
  const lines = src.split('\n');
  const re = new RegExp(String.raw`(?:^|[^\w$.])(?:(\w[\w$]*)\.)?(${NAMES.join('|')})\s*\(`, 'g');
  const leaks = [];
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const fn = m[2];
    const door = GH_DOORS[fn];
    const open = m.index + m[0].length - 1;
    // `function prView(…)` / `async function prView(…)`: a definition, not a call.
    if (/\bfunction\s+$/.test(clean.slice(Math.max(0, m.index), open - fn.length))) continue;
    const args = argsAt(clean, open);
    if (args === null) continue;

    let why = null;
    if (door.last !== undefined) {
      if (args.length < door.last) why = `takes the project as argument ${door.last} of ${door.last} and got ${args.length}`;
      else if (!namesProject(args[door.last - 1])) why = `argument ${door.last} is the project, and \`${args[door.last - 1].trim()}\` is not one`;
    } else if (!carriesProject(args[door.options])) {
      why = args.length <= door.options
        ? 'takes the project inside its options object, and was called without one'
        : 'takes the project inside its options object, and that object has no `project`';
    }
    if (!why) continue;

    const line = clean.slice(0, open).split('\n').length;
    leaks.push({ line, receiver: m[1] ? `${m[1]}.${fn}` : fn, fn, why, text: (lines[line - 1] ?? '').trim() });
  }
  return leaks;
}

/** The failure message, actionable without opening this file. */
function complain(leaks, file = 'pipeline.js') {
  const writes = leaks.filter((l) => GH_DOORS[l.fn].write);
  const head = writes.length
    ? `\n${writes.length} de estas llamadas ESCRIBEN en GitHub (${[...new Set(writes.map((l) => l.fn))].join(', ')}): `
      + 'sin proyecto abren pull requests y comentan reviews en el repositorio de OTRA gente '
      + '(HeliosSoftware/hfs), en público. Las demás solo leen el issue equivocado.\n'
    : '\nSin proyecto, estas llamadas leen del repositorio por defecto (HeliosSoftware/hfs) '
      + 'en vez del de la tarea: así el issue #1 de app-b se tituló con el #1 de hfs.\n';
  return head + leaks.map((l) => {
    const door = GH_DOORS[l.fn];
    const cure = door.last !== undefined
      ? `\`${l.receiver}(…, task.project)\``
      : `\`${l.receiver}({ …, project: task.project })\``;
    return `${file}:${l.line} — ${l.receiver}: ${l.why}.`
      + `${door.write ? ' ⚠️ ESCRIBE en GitHub.' : ''} Pásale el proyecto: ${cure}.`
      + `\n      ${l.text}`;
  }).join('\n');
}

for (const file of SWEPT) {
  test(`no GitHub call in ${file} leaves out the project`, () => {
    const leaks = projectLeaks(readFileSync(srcFile(file), 'utf8'));
    assert.equal(leaks.length, 0, `\n${complain(leaks, file)}\n`);
  });
}

test('no module of server/src imports github.js without being swept', () => {
  // The hole this file closes was a file nobody was sweeping. A new importer
  // must join `SWEPT` — otherwise the next one is invisible in exactly the
  // same way.
  const missing = readdirSync(srcFile('.'))
    .filter((f) => f.endsWith('.js') && f !== 'github.js' && !SWEPT.includes(f))
    .filter((f) => /from '\.\/github\.js'/.test(readFileSync(srcFile(f), 'utf8')));
  assert.deepEqual(missing, [], 'estos módulos llaman a github.js y nadie los mira: añádelos a SWEPT');
});

test('every door in the list still exists in github.js, with the project where the list says', () => {
  // The way a source analyzer rots: `prView` is renamed, the regex stops
  // matching anything, and this file passes by checking nothing at all. Worse
  // here than usual, because the defaults mean nothing else would notice.
  const src = blank(readFileSync(GITHUB, 'utf8'));
  for (const [name, door] of Object.entries(GH_DOORS)) {
    const decl = new RegExp(String.raw`export\s+(?:async\s+)?(?:function\s+${name}\s*|const\s+${name}\s*=\s*(?:async\s*)?)\(`).exec(src);
    assert.ok(decl, `github.js ya no exporta \`${name}\`: actualiza GH_DOORS (o el renombrado se llevó una guarda por delante)`);
    const params = argsAt(src, decl.index + decl[0].length - 1);
    assert.ok(params, `no se pudo leer la firma de \`${name}\``);
    if (door.last !== undefined) {
      assert.equal(params.length, door.arity ?? door.last, `\`${name}\` ya no toma ${door.arity ?? door.last} argumento(s): GH_DOORS miente sobre dónde va el proyecto`);
      const p = params[door.last - 1];
      // No door has a default project any more: the project is the bare parameter.
      assert.match(p.trim(), /^project(Id)?$/, `el argumento ${door.last} de \`${name}\` ya no es el proyecto, o vuelve a tener un valor por defecto`);
    } else {
      assert.ok(params.length > door.options, `\`${name}\` no tiene argumento ${door.options}`);
      const p = params[door.options];
      assert.match(p, /\bproject\b/, `el objeto de opciones de \`${name}\` ya no lleva \`project\``);
      assert.doesNotMatch(p, /\bproject\s*=/, `\`${name}\` vuelve a tener un proyecto por defecto`);
    }
  }
});

test('the analyzer catches the bug it was written for, in every shape it was written in', () => {
  // A parser only ever seen to pass proves nothing, so it is shown the real
  // lines — the ones that titled app-b's #1 with hfs's #1, and the ones
  // that would have opened its PR in hfs.
  const bad = [
    'async function run(task, steps) {',
    '  const issue = await getIssue(task.issue);',                    // the reported bug
    '  const live = await steps.prView(task.prNumber);',              // through a seam
    '  await readyPr(number);',                                       // a write, positional
    '  await commentOnPr(task.prNumber, cr.draftSummary);',           // a write, 3 args
    '  const byNumber = await checksForOpenPrs();',                   // options, no argument
    '  const prs = await steps.prsForBranch(head, { cache: true });', // options, no project
    '  pr = await createDraftPr({ branch, title, body });',           // the PR write
    '  await addReviewer(number, task.issue);',                       // an argument that is not a project
    '}',
  ].join('\n');

  const leaks = projectLeaks(bad);
  assert.deepEqual(
    leaks.map((l) => [l.line, l.receiver]),
    [[2, 'getIssue'], [3, 'steps.prView'], [4, 'readyPr'], [5, 'commentOnPr'],
      [6, 'checksForOpenPrs'], [7, 'steps.prsForBranch'], [8, 'createDraftPr'], [9, 'addReviewer']],
  );

  // And the message names the line, the function, the cure, and why it matters.
  const said = complain(leaks);
  assert.match(said, /pipeline\.js:2 — getIssue/);
  assert.match(said, /pipeline\.js:8 — createDraftPr/);
  assert.match(said, /task\.project/);
  assert.match(said, /ESCRIBEN en GitHub/);
  assert.match(said, /createDraftPr/);
  assert.match(said, /otra gente/i);
});

test('the analyzer leaves alone every call that does say which project it is for', () => {
  const fine = [
    '/** `getIssue(task.issue)` is how this used to be written — a comment, not a call. */',
    'const LOG = "createDraftPr() sin proyecto abría el PR en hfs";',
    'async function run(task, steps) {',
    '  const issue = await getIssue(task.issue, task.project);',
    '  const live = await steps.prView(task.prNumber, task.project);',
    '  await steps.readyPr(number, task.project);',
    '  await commentOnPr(task.prNumber, cr.draftSummary, task.project);',
    '  const byNumber = await checksForOpenPrs({ project });',
    '  const forced = await checksForOpenPrs({ force: true, project: task.project });',
    '  const prs = await steps.prsForBranch(head, { cache, project });',
    '  pr = await createDraftPr({ project: task.project, branch, title, body: `closes #${issue.number}` });',
    '  const list = await listAssignedIssues(projectId);',
    '  const old = await listClosedAssignedIssues(12, projectId);',
    '}',
  ].join('\n');

  assert.deepEqual(projectLeaks(fine), []);
});
