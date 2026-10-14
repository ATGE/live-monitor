// Reviewer rules of github.js: who is asked, what happens with nobody to ask,
// the read-only user search and the base branch of a new PR. No network: `gh`
// is an injected runner.
import './isolate.mjs';

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addReviewer, markPrReady, searchRepoUsers, filterUsers, createDraftPr,
  NeedsReviewerError, forgetRepoCache, _setGhRunner, _forgetUsersCache,
} from '../src/github.js';
import { saveProjects } from '../src/projects.js';
import { config } from '../src/config.js';
import { DEFAULT_PROJECT_ID } from '../src/keys.js';

const entry = (id, over = {}) => ({
  id,
  name: id,
  repoPath: path.join(tmpdir(), `hfsmon-rev-${id}`),
  worktreeRoot: path.join(tmpdir(), `hfsmon-rev-${id}-wt`),
  repo: `eterceros/${id}`,
  assignee: 'eterceros',
  reviewer: null,
  overrides: {},
  ...over,
});

/** A fake `gh` that records its calls and answers from `answer(args)`. */
function fakeGh(answer = () => ({ ok: true, stdout: '', stderr: '' })) {
  const calls = [];
  const opts = [];
  const fn = async (file, args, o) => { calls.push([file, ...args]); opts.push(o); return answer(args); };
  fn.calls = calls;
  fn.opts = opts;
  return fn;
}

// The default project's repository is read live from `config.github.repo`, not from
// its registry entry; this file's expectations are about HeliosSoftware/hfs.
const savedRepo = config.github.repo;
config.github.repo = 'HeliosSoftware/hfs';

beforeEach(() => {
  saveProjects([entry(DEFAULT_PROJECT_ID, { repo: 'HeliosSoftware/hfs', reviewer: 'hfs-rev' }), entry('beta')]);
  forgetRepoCache();
  _forgetUsersCache();
  _setGhRunner();
});
after(() => { _setGhRunner(); config.github.repo = savedRepo; });

test('addReviewer without a reviewer throws NeedsReviewerError and never calls gh', async () => {
  const gh = fakeGh();
  _setGhRunner(gh);
  await assert.rejects(() => addReviewer(7, 'beta'), (e) => {
    assert.ok(e instanceof NeedsReviewerError);
    assert.equal(e.code, 'needs_reviewer');
    assert.match(e.message, /no declara un revisor/);
    return true;
  });
  assert.equal(gh.calls.length, 0);
});

test('addReviewer: an explicit login overrides the registry, and the registry is used otherwise', async () => {
  const gh = fakeGh();
  _setGhRunner(gh);
  await addReviewer(7, DEFAULT_PROJECT_ID);
  await addReviewer(7, DEFAULT_PROJECT_ID, 'picked');
  await addReviewer(8, 'beta', 'only-picked');
  const reviewers = gh.calls.map((c) => c[c.indexOf('--add-reviewer') + 1]);
  assert.deepEqual(reviewers, ['hfs-rev', 'picked', 'only-picked']);
  assert.ok(gh.calls[2].includes('eterceros/beta'), 'the -R is the project\'s own repository');
});

test('addReviewer rejects a malformed login before any gh call', async () => {
  const gh = fakeGh();
  _setGhRunner(gh);
  for (const bad of ['-x', 'a b', 'a;rm', '--add-reviewer', 'a'.repeat(40), 'x/y']) {
    await assert.rejects(() => addReviewer(7, DEFAULT_PROJECT_ID, bad), /reviewer login/, bad);
  }
  assert.equal(gh.calls.length, 0);
  await addReviewer(7, DEFAULT_PROJECT_ID, 'a'.repeat(39));
  assert.equal(gh.calls.length, 1);
});

test('searchRepoUsers does not cache a failed search', async () => {
  let ok = false;
  const gh = fakeGh(() => (ok
    ? { ok: true, stdout: JSON.stringify([{ login: 'zed' }]), stderr: '' }
    : { ok: false, stdout: '', stderr: 'boom' }));
  const opts = { project: 'beta', runner: gh, now: () => 1_000 };
  assert.deepEqual(await searchRepoUsers('', opts), []);
  ok = true;
  assert.deepEqual(await searchRepoUsers('', opts), [{ login: 'zed' }], 'the failure was not remembered');
});

test('addReviewer without a project fails instead of defaulting to hfs', async () => {
  const gh = fakeGh();
  _setGhRunner(gh);
  await assert.rejects(() => addReviewer(7), /project is missing/);
  assert.equal(gh.calls.length, 0);
});

test('markPrReady resolves the reviewer before `gh pr ready`', async () => {
  const gh = fakeGh();
  _setGhRunner(gh);
  await assert.rejects(() => markPrReady(3, 'beta'), NeedsReviewerError);
  assert.equal(gh.calls.length, 0, 'no write happened');
  await markPrReady(3, DEFAULT_PROJECT_ID);
  assert.deepEqual(gh.calls.map((c) => c[2]), ['ready', 'edit']);
});

test('markPrReady: an explicit login overrides the registry, even with no registry reviewer', async () => {
  const gh = fakeGh();
  _setGhRunner(gh);
  await markPrReady(3, 'beta', 'picked');
  assert.deepEqual(gh.calls.map((c) => c[2]), ['ready', 'edit']);
  assert.equal(gh.calls[1][gh.calls[1].indexOf('--add-reviewer') + 1], 'picked');
  gh.calls.length = 0;
  await assert.rejects(() => markPrReady(3, 'beta', 'a b'), /reviewer login/);
  assert.equal(gh.calls.length, 0, 'a malformed login writes nothing');
});

test('searchRepoUsers: an empty answer from every source is not cached', async () => {
  let ok = false;
  const gh = fakeGh((args) => {
    if (!ok) return args[1].includes('/assignees') ? { ok: true, stdout: '[]', stderr: '' } : { ok: false, stdout: '', stderr: 'boom' };
    return args[1].includes('/collaborators') ? { ok: true, stdout: JSON.stringify([{ login: 'zed' }]), stderr: '' } : { ok: true, stdout: '[]', stderr: '' };
  });
  const opts = { project: 'beta', runner: gh, now: () => 1_000 };
  assert.deepEqual(await searchRepoUsers('', opts), []);
  ok = true;
  assert.deepEqual(await searchRepoUsers('', opts), [{ login: 'zed' }], 'the empty answer was not remembered');
});

test('github.js shares the registry LOGIN_RE and prView reports the PR author', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/github.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /GITHUB_LOGIN_RE/, 'no local copy of the login regex');
  assert.match(src, /import \{[^}]*\bLOGIN_RE\b[^}]*\} from '\.\/projects\.js'/);
  assert.match(src, /'--json', 'number,state,isDraft,author'/);
  assert.match(src, /author: raw\.author\?\.login \?\? null/);
});

test('filterUsers: case-insensitive, at most 30, the author is annotated and never removed', () => {
  const users = Array.from({ length: 40 }, (_, i) => ({ login: `User${i}` }));
  assert.equal(filterUsers(users, 'user').length, 30);
  assert.deepEqual(filterUsers([{ login: 'Alice', name: 'Al B' }, { login: 'bob' }], 'AL'), [{ login: 'Alice', name: 'Al B' }]);
  assert.deepEqual(filterUsers([{ login: 'Alice' }, { login: 'bob' }], '', 'ALICE'), [{ login: 'Alice', isAuthor: true }, { login: 'bob' }]);
  assert.deepEqual(filterUsers([{ login: 'Alice' }], 'zzz'), []);
});

const rows = (...logins) => JSON.stringify(logins.map((login) => ({ login })));
const userOwner = { ok: true, stdout: JSON.stringify({ owner: { type: 'User' } }), stderr: '' };

test('searchRepoUsers: the union of assignees, collaborators and contributors, deduplicated and sorted, cached for 5 minutes', async () => {
  let t = 1_000;
  const gh = fakeGh((args) => {
    const p = args[1];
    if (p.includes('/assignees')) return { ok: true, stdout: rows('carol', 'Dave'), stderr: '' };
    if (p.includes('/collaborators')) return { ok: true, stdout: rows('DAVE', 'bob'), stderr: '' };
    if (p.includes('/contributors')) return { ok: true, stdout: rows('erin', 'dependabot[bot]', 'carol'), stderr: '' };
    return userOwner;
  });
  const opts = { project: 'beta', runner: gh, now: () => t };

  assert.deepEqual(await searchRepoUsers('', opts), [{ login: 'bob' }, { login: 'carol' }, { login: 'Dave' }, { login: 'erin' }]);
  const endpoints = gh.calls.map((c) => c[2]);
  for (const kind of ['assignees', 'collaborators', 'contributors']) {
    assert.equal(endpoints.filter((e) => e.includes(`/${kind}?per_page=100&page=1`)).length, 1, `${kind} asked once`);
  }
  assert.ok(endpoints.every((e) => !e.startsWith('orgs/')), 'a user-owned repository has no org members');
  assert.ok(gh.calls.every((c) => c[1] === 'api'), 'reads only');

  const n = gh.calls.length;
  assert.deepEqual(await searchRepoUsers('car', opts), [{ login: 'carol' }]);
  assert.equal(gh.calls.length, n, 'served from the cache');

  t += 5 * 60 * 1000 + 1;
  await searchRepoUsers('x', opts);
  assert.ok(gh.calls.length > n, 'the cache expired');
});

test('searchRepoUsers: a one-person repository still offers that person, annotated as the author', async () => {
  const gh = fakeGh((args) => (args[1].includes('/assignees') || args[1].includes('/collaborators') || args[1].includes('/contributors')
    ? { ok: true, stdout: rows('eterceros'), stderr: '' }
    : userOwner));
  const opts = { project: 'beta', runner: gh };
  assert.deepEqual(await searchRepoUsers('', { ...opts, authorLogin: 'EterCeros' }), [{ login: 'eterceros', isAuthor: true }]);
  assert.deepEqual(await searchRepoUsers('eter', { ...opts, excludeLogin: 'eterceros' }), [{ login: 'eterceros', isAuthor: true }], 'the old option name only annotates');
  assert.deepEqual(await searchRepoUsers('', opts), [{ login: 'eterceros' }]);
});

test('searchRepoUsers: a failing source is skipped, the others still answer', async () => {
  for (const failure of [{ ok: false, stdout: '', stderr: 'HTTP 403' }, { ok: true, stdout: 'not json', stderr: '' }, null]) {
    _forgetUsersCache();
    const gh = fakeGh((args) => {
      if (args[1].includes('/contributors')) {
        if (failure === null) throw new Error('spawn failed');
        return failure;
      }
      if (args[1].includes('/assignees')) return { ok: true, stdout: rows('zed'), stderr: '' };
      if (args[1].includes('/collaborators')) return { ok: true, stdout: rows('amy'), stderr: '' };
      return userOwner;
    });
    assert.deepEqual(await searchRepoUsers('', { project: 'beta', runner: gh }), [{ login: 'amy' }, { login: 'zed' }]);
  }
});

test('searchRepoUsers: an Organization owner adds its members; a failing members call is soft', async () => {
  const make = (membersOk) => fakeGh((args) => {
    const p = args[1];
    if (p.startsWith('orgs/eterceros/members')) return membersOk ? { ok: true, stdout: rows('mia', 'Bob'), stderr: '' } : { ok: false, stdout: '', stderr: 'HTTP 404' };
    if (p.includes('/assignees')) return { ok: true, stdout: rows('bob'), stderr: '' };
    if (p.includes('/collaborators') || p.includes('/contributors')) return { ok: true, stdout: '[]', stderr: '' };
    return { ok: true, stdout: JSON.stringify({ owner: { type: 'Organization' } }), stderr: '' };
  });
  assert.deepEqual(await searchRepoUsers('', { project: 'beta', runner: make(true) }), [{ login: 'bob' }, { login: 'mia' }]);
  _forgetUsersCache();
  assert.deepEqual(await searchRepoUsers('', { project: 'beta', runner: make(false) }), [{ login: 'bob' }]);
});

test('searchRepoUsers: exact endpoints, a timeout on every read, a short page 1 means one call per source', async () => {
  const gh = fakeGh((args) => (args[1].includes('/assignees') ? { ok: true, stdout: rows('a'), stderr: '' } : args[1] === 'repos/eterceros/beta' ? userOwner : { ok: true, stdout: '[]', stderr: '' }));
  await searchRepoUsers('', { project: 'beta', runner: gh });
  const paths = gh.calls.map((c) => c[2]).sort();
  assert.deepEqual(paths, [
    'repos/eterceros/beta',
    'repos/eterceros/beta/assignees?per_page=100&page=1',
    'repos/eterceros/beta/collaborators?per_page=100&page=1',
    'repos/eterceros/beta/contributors?per_page=100&page=1',
  ], 'one call per source, no page 2');
  assert.ok(gh.opts.every((o) => o?.timeoutMs === 20000), 'every read has a 20 s timeout');
});

test('searchRepoUsers: concurrent searches before the cache is warm share one set of gh calls', async () => {
  const gh = fakeGh((args) => (args[1].includes('/assignees') ? { ok: true, stdout: rows('a'), stderr: '' } : args[1] === 'repos/eterceros/beta' ? userOwner : { ok: true, stdout: '[]', stderr: '' }));
  const opts = { project: 'beta', runner: gh };
  const [x, y, z] = await Promise.all([searchRepoUsers('', opts), searchRepoUsers('a', opts), searchRepoUsers('b', opts)]);
  assert.deepEqual(x, [{ login: 'a' }]);
  assert.deepEqual(y, [{ login: 'a' }]);
  assert.deepEqual(z, []);
  assert.equal(gh.calls.length, 4, 'not 12');
});

test('searchRepoUsers: reads up to 3 pages of 100 and stops there', async () => {
  const page = (n) => JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ login: `u${n}x${String(i).padStart(3, '0')}` })));
  const gh = fakeGh((args) => {
    const p = args[1];
    if (p.includes('/assignees')) {
      const n = Number(/page=(\d+)/.exec(p)[1]);
      return { ok: true, stdout: page(n), stderr: '' };
    }
    if (p.includes('/collaborators') || p.includes('/contributors')) return { ok: true, stdout: '[]', stderr: '' };
    return userOwner;
  });
  const users = await searchRepoUsers('u', { project: 'beta', runner: gh });
  assert.equal(users.length, 30, 'limited to 30');
  assert.equal(gh.calls.filter((c) => c[2].includes('/assignees')).length, 3, 'a fourth page is never asked');
});

test('searchRepoUsers is per project and has no default project', async () => {
  const gh = fakeGh((args) => (args[1].includes('/assignees') ? { ok: true, stdout: rows('a'), stderr: '' } : { ok: true, stdout: '[]', stderr: '' }));
  await searchRepoUsers('', { project: 'beta', runner: gh });
  const betaCalls = gh.calls.length;
  await searchRepoUsers('', { project: DEFAULT_PROJECT_ID, runner: gh });
  assert.equal(gh.calls.length, betaCalls * 2, 'two repositories, two sets of fetches');
  assert.ok(gh.calls.some((c) => c[2].includes('HeliosSoftware/hfs')) && gh.calls.some((c) => c[2].includes('eterceros/beta')));
  await assert.rejects(() => searchRepoUsers('a', { runner: gh }), /project is missing/);
});

test('createDraftPr targets the project\'s base branch and needs a project', async () => {
  const gh = fakeGh(() => ({ ok: true, stdout: 'https://github.com/eterceros/beta/pull/5\n', stderr: '' }));
  _setGhRunner(gh);
  saveProjects([entry(DEFAULT_PROJECT_ID, { repo: 'HeliosSoftware/hfs', reviewer: 'hfs-rev' }), entry('beta', { baseBranch: 'develop' })]);
  forgetRepoCache();
  const pr = await createDraftPr({ branch: 'fix/1-x', title: 'Fix the thing', body: 'Closes #1', project: 'beta' });
  assert.equal(pr.number, 5);
  const args = gh.calls[0];
  assert.equal(args[args.indexOf('--base') + 1], 'develop');
  await assert.rejects(() => createDraftPr({ branch: 'b', title: 'Fix', body: 'Closes #1' }), /project is missing/);
});

test('createDraftPr checks the PR text at the project\'s language: Spanish passes for `es`, not for the default', async () => {
  const gh = fakeGh(() => ({ ok: true, stdout: 'https://github.com/eterceros/beta/pull/9\n', stderr: '' }));
  _setGhRunner(gh);
  const title = 'Corrige la paginación de los resultados';
  const body = '## Qué cambia\n\nAntes la página devolvía todos los registros; ahora respeta el límite pedido.\n\nCloses #1';
  saveProjects([entry(DEFAULT_PROJECT_ID, { repo: 'HeliosSoftware/hfs', reviewer: 'hfs-rev' }), entry('beta'), entry('abeja', { language: 'es' })]);
  forgetRepoCache();

  await assert.rejects(() => createDraftPr({ branch: 'fix/1-x', title, body, project: 'beta' }), /No se publica/, 'no language set: English only');
  assert.equal(gh.calls.length, 0, 'refused before gh was reached');

  const pr = await createDraftPr({ branch: 'fix/1-x', title, body, project: 'abeja' });
  assert.equal(pr.number, 9);
  assert.equal(gh.calls.length, 1);
});
