// The `chat`/`turn` span of a live chat turn: its length, its outcome, and the
// model, cost and turns of the turn when the session reports them.
//
// The session is faked at `ChatSession.prototype.send` (the `chat-owner.test.mjs`
// pattern), so what is checked is what `runTurn` records around a real call.
import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tempDir } from './teardown.mjs';

process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let projectchats;
let chats;
let ChatSession;
const real = {};
let reply = null;   // what the next fake `send` answers, or a function that throws

/** A real one-commit git repo: the holder's worktree stand-in (the `chat-owner.test.mjs` pattern). */
function gitRepo() {
  const dir = tempDir('hfsmon-mc-git-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  return dir;
}
let repo;

before(async () => {
  repo = gitRepo();
  pipeline = await import('../src/pipeline.js');
  projectchats = await import('../src/projectchats.js');
  chats = await import('../src/chats.js');
  ({ ChatSession } = await import('../src/session.js'));
  real.send = ChatSession.prototype.send;
  real.retune = ChatSession.prototype.retune;
  real.ensure = pipeline.chatOwnerHooks.ensure;
  real.refresh = pipeline.chatOwnerHooks.refresh;
  ChatSession.prototype.retune = async function retune() { return { reopened: false }; };
  ChatSession.prototype.send = async function send() {
    if (typeof reply === 'function') return reply();
    return reply;
  };
  pipeline.chatOwnerHooks.ensure = async (h) => { h.worktreePath = repo; return repo; };
  pipeline.chatOwnerHooks.refresh = async () => ({ moved: false, note: null, head: null });
});

after(() => {
  ChatSession.prototype.send = real.send;
  ChatSession.prototype.retune = real.retune;
  pipeline.chatOwnerHooks.ensure = real.ensure;
  pipeline.chatOwnerHooks.refresh = real.refresh;
});

const holder = () => projectchats.getHolder('hfs', 'local');
const holderKeyStr = () => projectchats.holderKey('hfs', 'local');
const turnsOf = (h, chat) => (h.timings ?? []).filter((s) => s.kind === 'chat' && s.name === 'turn' && s.meta.chatId === chat.id);

async function until(ok, ms = 3000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for the turn span');
    await new Promise((r) => { setTimeout(r, 5); });
  }
}

test('a chat turn leaves a closed «chat/turn» span with the model, cost and turns of the turn', async () => {
  const h = holder();
  const chat = chats.addChatTo(h, {});
  reply = {
    ok: true, sessionId: 's-1', toolCounts: {}, resultText: '',
    stats: { ms: 5, turns: 3, subtype: 'success', costUsdTotal: 0.5, costUsd: 0.25, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 }, graceMs: 0, resumed: false },
  };
  pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
  await until(() => turnsOf(h, chat).length === 1 && turnsOf(h, chat)[0].endedAt);

  const [s] = turnsOf(h, chat);
  assert.equal(s.outcome, 'ok');
  assert.equal(s.meta.chatId, chat.id);
  assert.equal(s.meta.turns, 3);
  assert.equal(s.meta.costUsd, 0.25);
  assert.deepEqual(s.meta.tokens, { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 });
  assert.ok(s.meta.model, 'the effective model is named');
  assert.equal(s.meta.cycle, 1, 'stamped by the recorder with the metrics cycle');
});

test('a chat turn keeps the total of its tool calls and how many were subagents', async () => {
  const h = holder();
  const chat = chats.addChatTo(h, {});
  reply = {
    ok: true, sessionId: 's-2', toolCounts: { Read: 5, Bash: 2, Agent: 1, Task: 1 }, resultText: '',
    stats: { ms: 5, turns: 1, subtype: 'success', costUsdTotal: 0, costUsd: 0, tokens: null, graceMs: 0, resumed: false },
  };
  pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
  await until(() => turnsOf(h, chat).length === 1 && turnsOf(h, chat)[0].endedAt);

  const [s] = turnsOf(h, chat);
  assert.equal(s.meta.toolCalls, 9);
  assert.equal(s.meta.subagents, 2);
});

test('a turn whose session throws closes the span as «error» and keeps no stats', async () => {
  const h = holder();
  const chat = chats.addChatTo(h, {});
  reply = () => { throw new Error('boom'); };
  pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
  await until(() => turnsOf(h, chat).length === 1 && turnsOf(h, chat)[0].endedAt);

  const [s] = turnsOf(h, chat);
  assert.equal(s.outcome, 'error');
  assert.equal(s.meta.turns, undefined);
});
