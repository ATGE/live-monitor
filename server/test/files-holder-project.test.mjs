// A project chat of a project that is not the default one: its relative
// mentions are looked for inside THAT project's holder worktree and checkout,
// never inside hfs, which lives on the same disk. A runner holds no second
// project, so on it such a mention has nowhere to be looked for.
//
// `files.test.mjs` cannot host this: a second registered project changes what
// its `allowedRoots` test expects. Here the registry has two projects and the
// machines are fakes under one temp dir, so nothing reaches the real runners.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hfsmon-holderproj-data-'));
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'hfsmon-holderproj-')));
const HFS = { repo: path.join(ROOT, 'hfs-repo'), wtRoot: path.join(ROOT, 'hfs-wt') };
const BETA = { repo: path.join(ROOT, 'beta-repo'), wtRoot: path.join(ROOT, 'beta-wt') };
const write = (dir, name, data) => {
  const file = path.join(dir, ...name.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
};

// `projects.js` caches on first read: the registry goes to disk before any import.
writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([
  { id: 'hfs', name: 'hfs', repoPath: HFS.repo, worktreeRoot: HFS.wtRoot, repo: 'HeliosSoftware/hfs', assignee: 'eterceros', reviewer: 'reviewer-user', overrides: {} },
  { id: 'app-b', name: 'External App B', repoPath: BETA.repo, worktreeRoot: BETA.wtRoot, repo: 'eterceros/app-b', assignee: 'eterceros', reviewer: 'reviewer-user', overrides: {} },
], null, 2), 'utf8');

let files;
let config;
let savedMachines;
let savedProject;

before(async () => {
  ({ config } = await import('../src/config.js'));
  files = await import('../src/files.js');
  mkdirSync(HFS.repo, { recursive: true });
  mkdirSync(BETA.repo, { recursive: true });
  savedMachines = config.machines;
  savedProject = config.project;
  config.project = { ...config.project, repoPath: HFS.repo, worktreeRoot: HFS.wtRoot };
  config.machines = { local: { kind: 'local', repoPath: HFS.repo, worktreeRoot: HFS.wtRoot } };
  files.filesHooks.homeOf = async () => path.join(ROOT, 'home');
  files.filesHooks.uidOf = async () => null;
  files.filesHooks.tmpRoots = () => [path.join(ROOT, 'tmp', 'claude')];
  files.filesHooks.probeMs = 5000;

  // The same relative name in all four places that could be searched.
  write(HFS.repo, 'out2/cmp.md', 'hfs checkout\n');
  write(HFS.wtRoot, '_proyecto/out2/cmp.md', 'hfs holder\n');
  write(BETA.repo, 'out2/cmp.md', 'beta checkout\n');
  write(BETA.wtRoot, '_proyecto/out2/cmp.md', 'beta holder\n');
  write(BETA.wtRoot, '_proyecto/out2/solo-beta.md', 'only beta holder\n');
});

after(() => {
  config.machines = savedMachines;
  if (savedMachines === undefined) delete config.machines;
  config.project = savedProject;
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

const holder = (project, machine = 'local') => ({ kind: 'project', project, issue: null, machine });
const inside = (dir) => (p) => path.resolve(p).startsWith(path.resolve(dir) + path.sep);

test('the holder of a non-default project resolves in its own _proyecto, before its checkout', async () => {
  const r = await files.resolveRef({ task: holder('app-b'), ref: 'out2/cmp.md' });
  assert.deepEqual(r.candidates.map((x) => [x.machine, x.base]), [['local', 'worktree']], 'the holder wins, the checkout copy is the same relative');
  assert.ok(inside(path.join(BETA.wtRoot, '_proyecto'))(r.candidates[0].path));
});

test('a mention only in the checkout of the non-default project still opens from its holder chat', async () => {
  write(BETA.repo, 'sub/solo-checkout.md', 'only in the beta checkout\n');
  const r = await files.resolveRef({ task: holder('app-b'), ref: 'sub/solo-checkout.md' });
  assert.deepEqual(r.candidates.map((x) => x.base), ['repo']);
  assert.ok(inside(BETA.repo)(r.candidates[0].path));
});

test('nothing of hfs is a candidate or in tried for a app-b holder', async () => {
  for (const ref of ['out2/cmp.md', 'out2/nada.md']) {
    const r = await files.resolveRef({ task: holder('app-b'), ref });
    const places = [...r.candidates.map((x) => x.path), ...r.tried.map((t) => t.where)];
    assert.ok(places.length > 0);
    for (const p of places) {
      assert.ok(!inside(HFS.repo)(p) && !inside(HFS.wtRoot)(p), `${p} is inside hfs`);
    }
  }
});

test('the default project holder still resolves inside hfs', async () => {
  const r = await files.resolveRef({ task: holder('hfs'), ref: 'out2/cmp.md' });
  assert.deepEqual(r.candidates.map((x) => x.base), ['worktree']);
  assert.ok(inside(path.join(HFS.wtRoot, '_proyecto'))(r.candidates[0].path));
});

test('a project this machine does not hold gives no bases: its mention is not looked for in hfs', async () => {
  // `ghost` is not in the registry: machineFor throws, and the answer is nowhere, not hfs.
  const r = await files.resolveRef({ task: holder('ghost'), ref: 'out2/cmp.md' });
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.tried, []);
});
