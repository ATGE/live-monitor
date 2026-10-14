import './isolate.mjs';

// «📌 Crear tarea»: the draft and the create, with both seams in place. No SDK
// session starts and `gh` is never run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { draftIssueFromChat, createIssueFromDraft, issueDraftHooks, parseDraft, registerIssueDraftRoutes } from '../src/issuedraft.js';
import { getHolder } from '../src/projectchats.js';
import { store } from '../src/store.js';
import { saveProjects } from '../src/projects.js';
import { forgetRepoCache } from '../src/github.js';

const dirs = [];
const mk = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PROJECT = 'draft-demo';
saveProjects([{
  id: PROJECT,
  name: PROJECT,
  repoPath: mk('hfsmon-draft-repo-'),
  worktreeRoot: mk('hfsmon-draft-wt-'),
  repo: 'acme/draft-demo',
  assignee: 'octocat',
  reviewer: 'octocat',
  overrides: {},
}]);
forgetRepoCache();

function holderWithChat(messages = [['user', 'The search registry ignores the tenant.'], ['assistant', 'Indeed: see crates/persistence/src/search/registry.rs.']]) {
  const holder = getHolder(PROJECT, 'local');
  const chat = holder.chats[0];
  holder.worktreePath = holder.worktreePath ?? mk('hfsmon-draft-cwd-');
  chat.messages = [];
  chat.busy = false;
  for (const [role, text] of messages) store.addChat(holder, chat.id, role, text);
  return { holder, chat };
}

const ENGLISH_BODY = 'The search registry ignores the tenant, so lookups cross tenant boundaries.\n\nSee crates/persistence/src/search/registry.rs.';

test.afterEach(() => { issueDraftHooks.query = null; issueDraftHooks.gh = null; });

// ---------------------------------------------------------------------------
// parseDraft

test('parseDraft reads plain, fenced and chatty JSON, and rejects garbage', () => {
  const ok = { title: 'fix(x): a', body: 'b' };
  assert.deepEqual(parseDraft(JSON.stringify(ok)), ok);
  assert.deepEqual(parseDraft(`\`\`\`json\n${JSON.stringify(ok)}\n\`\`\``), ok);
  assert.deepEqual(parseDraft(`Here you go: ${JSON.stringify(ok)} hope it helps`), ok);
  assert.deepEqual(parseDraft(`ISSUE_DRAFT: ${JSON.stringify(ok)}`), ok);
  assert.equal(parseDraft('no json at all'), null);
  assert.equal(parseDraft('{"title":"only a title"}'), null);
  assert.equal(parseDraft('{"title":"","body":"b"}'), null);
  assert.equal(parseDraft(''), null);
});

// ---------------------------------------------------------------------------
// draft

test('draft: runs a fresh, tool-less session and returns the parsed draft', async () => {
  const { holder, chat } = holderWithChat();
  let seen = null;
  issueDraftHooks.query = async (options) => {
    seen = options;
    return { resultText: JSON.stringify({ title: 'fix(persistence): tenant-scope lookups', body: ENGLISH_BODY }) };
  };
  const draft = await draftIssueFromChat(holder, chat.id);
  assert.deepEqual(draft, { title: 'fix(persistence): tenant-scope lookups', body: ENGLISH_BODY });
  assert.deepEqual(seen.tools, []);
  assert.equal(seen.resume, undefined);
  assert.ok(seen.hooks.PreToolUse.length >= 2, 'both gate hooks are composed');
  assert.match(seen.prompt, /search registry ignores the tenant/);
  assert.match(seen.prompt, /INGLÉS/);
  assert.equal(seen.cwd, holder.worktreePath);
});

test('draft: garbage output is a 502', async () => {
  const { holder, chat } = holderWithChat();
  issueDraftHooks.query = async () => ({ resultText: 'I could not decide.' });
  await assert.rejects(draftIssueFromChat(holder, chat.id), (e) => e.status === 502);
});

test('draft: a failing session is a 502', async () => {
  const { holder, chat } = holderWithChat();
  issueDraftHooks.query = async () => { throw new Error('boom'); };
  await assert.rejects(draftIssueFromChat(holder, chat.id), (e) => e.status === 502 && /boom/.test(e.message));
});

test('draft: busy chat and empty chat are a 409; unknown chat a 404; the session never starts', async () => {
  let calls = 0;
  issueDraftHooks.query = async () => { calls += 1; return { resultText: '{}' }; };
  const { holder, chat } = holderWithChat();
  chat.busy = true;
  await assert.rejects(draftIssueFromChat(holder, chat.id), (e) => e.status === 409);
  chat.busy = false;
  chat.messages = [];
  await assert.rejects(draftIssueFromChat(holder, chat.id), (e) => e.status === 409);
  await assert.rejects(draftIssueFromChat(holder, 'nope'), (e) => e.status === 404);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// create

test('create: runs the exact gh argv with --assignee and --body-file, then notes the chat', async () => {
  const { holder, chat } = holderWithChat();
  let call = null;
  let bodyOnDisk = null;
  issueDraftHooks.gh = async (file, args, opts) => {
    call = { file, args, opts };
    bodyOnDisk = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
    return { ok: true, code: 0, stdout: 'https://github.com/acme/draft-demo/issues/77\n', stderr: '' };
  };
  const title = 'fix(persistence): tenant-scope lookups';
  const out = await createIssueFromDraft(holder, chat.id, { title, body: ENGLISH_BODY });
  assert.deepEqual(out, { number: 77, url: 'https://github.com/acme/draft-demo/issues/77' });

  assert.equal(call.file, 'gh');
  const a = call.args;
  assert.deepEqual(a.slice(0, 8), ['issue', 'create', '-R', 'acme/draft-demo', '--assignee', 'octocat', '--title', title]);
  assert.equal(a[8], '--body-file');
  assert.equal(a.length, 10);
  assert.equal(bodyOnDisk, ENGLISH_BODY);
  assert.equal(existsSync(a[9]), false, 'the temp body file is removed');

  const last = chat.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.text, '📌 Tarea creada: #77 https://github.com/acme/draft-demo/issues/77');
});

test('create: a Spanish body is refused by the language gate before gh runs', async () => {
  const { holder, chat } = holderWithChat();
  let ran = false;
  issueDraftHooks.gh = async () => { ran = true; return { ok: true, stdout: '' }; };
  const before = chat.messages.length;
  await assert.rejects(
    createIssueFromDraft(holder, chat.id, {
      title: 'fix(persistence): tenant-scope lookups',
      body: 'Listo, ya cambié el clamp a 1 y eliminé la constante, porque no aporta nada.',
    }),
    (e) => e.status === 400 && Array.isArray(e.problems) && e.problems.length > 0,
  );
  assert.equal(ran, false);
  assert.equal(chat.messages.length, before, 'no note when nothing was created');
});

test('create: a Spanish title is refused too', async () => {
  const { holder, chat } = holderWithChat();
  let ran = false;
  issueDraftHooks.gh = async () => { ran = true; return { ok: true, stdout: '' }; };
  await assert.rejects(
    createIssueFromDraft(holder, chat.id, { title: 'fix: el filtro ahora usa el tenant, porque la consulta no lo hacia', body: ENGLISH_BODY }),
    (e) => e.status === 400,
  );
  assert.equal(ran, false);
});

test('create: empty title or body is a 400; a gh failure is a 502 with no note', async () => {
  const { holder, chat } = holderWithChat();
  issueDraftHooks.gh = async () => ({ ok: false, code: 1, stdout: '', stderr: 'HTTP 403' });
  await assert.rejects(createIssueFromDraft(holder, chat.id, { title: ' ', body: ENGLISH_BODY }), (e) => e.status === 400);
  await assert.rejects(createIssueFromDraft(holder, chat.id, { title: 'fix: a thing', body: '' }), (e) => e.status === 400);
  const before = chat.messages.length;
  await assert.rejects(
    createIssueFromDraft(holder, chat.id, { title: 'fix: a thing', body: ENGLISH_BODY }),
    (e) => e.status === 502 && /403/.test(e.message),
  );
  assert.equal(chat.messages.length, before);
});

test('create: a title with quotes still reaches gh verbatim', async () => {
  const { holder, chat } = holderWithChat();
  let args = null;
  issueDraftHooks.gh = async (_f, a) => { args = a; return { ok: true, stdout: 'https://github.com/acme/draft-demo/issues/5' }; };
  const title = `fix: don't drop "quoted" names`;
  await createIssueFromDraft(holder, chat.id, { title, body: ENGLISH_BODY });
  assert.equal(args[args.indexOf('--title') + 1], title);
});

// ---------------------------------------------------------------------------
// routes

test('routes: both endpoints are mounted under the holder base path and answer through withHolder', async () => {
  const posts = new Map();
  const app = { post: (p, h) => posts.set(p, h) };
  const { holder, chat } = holderWithChat();
  registerIssueDraftRoutes(app, { withHolder: (handler) => (req, res) => handler(holder, req, res) });
  const base = '/api/projects/:project/project-chats/:machine/chats/:chatId';
  assert.deepEqual([...posts.keys()].sort(), [`${base}/create-issue`, `${base}/draft-issue`]);

  issueDraftHooks.query = async () => ({ resultText: 'nonsense' });
  const reply = {};
  const res = { status(c) { reply.status = c; return this; }, json(b) { reply.body = b; return this; } };
  await posts.get(`${base}/draft-issue`)({ params: { chatId: chat.id }, body: {} }, res);
  assert.equal(reply.status, 502);
  assert.ok(reply.body.error);
});

test('draft: no worktree is a 409 and the session never starts', async () => {
  const { holder, chat } = holderWithChat();
  const saved = holder.worktreePath;
  holder.worktreePath = null;
  let calls = 0;
  issueDraftHooks.query = async () => { calls += 1; return { resultText: '{}' }; };
  try {
    await assert.rejects(draftIssueFromChat(holder, chat.id), (e) => e.status === 409);
  } finally { holder.worktreePath = saved; }
  assert.equal(calls, 0);
});

test('create: a second create for the same chat while one runs is a 409, and the lock is released after', async () => {
  const { holder, chat } = holderWithChat();
  let release;
  const gate = new Promise((r) => { release = r; });
  let ghCalls = 0;
  issueDraftHooks.gh = async () => {
    ghCalls += 1;
    await gate;
    return { ok: true, stdout: 'https://github.com/acme/draft-demo/issues/9' };
  };
  const first = createIssueFromDraft(holder, chat.id, { title: 'fix: a thing', body: ENGLISH_BODY });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(
    createIssueFromDraft(holder, chat.id, { title: 'fix: a thing', body: ENGLISH_BODY }),
    (e) => e.status === 409,
  );
  release();
  assert.equal((await first).number, 9);
  assert.equal(ghCalls, 1);
  issueDraftHooks.gh = async () => ({ ok: true, stdout: 'https://github.com/acme/draft-demo/issues/10' });
  assert.equal((await createIssueFromDraft(holder, chat.id, { title: 'fix: a thing', body: ENGLISH_BODY })).number, 10);
});
