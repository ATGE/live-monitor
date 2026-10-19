import './isolate.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { appServerHooks, CodexAppServer } from '../src/agents/app-server.js';
import { codexChatHooks, CodexChatSession } from '../src/agents/chat-session.js';

const previousSpawn = appServerHooks.spawn;
const previousCreate = codexChatHooks.create;
after(() => { appServerHooks.spawn = previousSpawn; codexChatHooks.create = previousCreate; });

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit('exit', 0, null); return true; };
  child.fromClient = [];
  const input = createInterface({ input: child.stdin });
  input.on('line', (line) => {
    const request = JSON.parse(line);
    child.fromClient.push(request);
    // The Codex JSON-RPC dialect has no "jsonrpc" protocol version property.
    // Reject it like a strict Codex server would so this does not regress.
    if (Object.hasOwn(request, 'jsonrpc')) {
      child.write({ id: request.id, error: { code: -32600, message: 'Unknown field jsonrpc' } });
      return;
    }
    if (request.method === 'initialize') child.write({ id: request.id, result: { userAgent: 'codex-test' } });
    if (request.method === 'thread/start') child.write({ id: request.id, result: { thread: { id: 'thread-test-123' } } });
  });
  child.write = (msg) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  return child;
}

test('App Server performs initialize handshake, streams notifications and handles RPC replies', async () => {
  const process = fakeProcess();
  appServerHooks.spawn = (bin, args, opts) => {
    assert.equal(bin, 'codex');
    assert.deepEqual(args, ['app-server']);
    assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    return process;
  };
  const server = new CodexAppServer({ timeoutMs: 500 });
  const notices = [];
  server.on('notification', (msg) => notices.push(msg.method));
  await server.open();
  assert.equal(process.fromClient[0].method, 'initialize');
  assert.equal(Object.hasOwn(process.fromClient[0], 'jsonrpc'), false);
  assert.equal(process.fromClient[1].method, 'initialized');
  assert.equal((await server.request('thread/start', { cwd: '/tmp/project' })).thread.id, 'thread-test-123');
  process.write({ method: 'turn/started', params: { turn: { id: 'turn-test' } } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(notices, ['turn/started']);
  server.close();
  assert.equal(server.alive, false);
});

test('App Server RPC errors preserve their method and machine-readable error code', async () => {
  const process = fakeProcess();
  appServerHooks.spawn = () => process;
  const server = new CodexAppServer({ timeoutMs: 500 });
  await server.open();
  const failing = server.request('bad/request', { id: 'nope' });
  await new Promise((resolve) => setImmediate(resolve));
  const request = process.fromClient.find((m) => m.method === 'bad/request');
  assert.ok(request, 'request reaches mock process');
  process.write({ id: request.id, error: { code: -32602, message: 'Invalid params: sandbox' } });
  await assert.rejects(failing, /-32602: Invalid params: sandbox/);
  server.close();
});

test('Unknown and high-risk permission requests default to denial, even without handler', async () => {
  const process = fakeProcess();
  appServerHooks.spawn = () => process;
  const server = new CodexAppServer({ timeoutMs: 500 });
  await server.open();
  process.write({ method: 'item/commandExecution/requestApproval', id: 40, params: { command: 'rm -rf /' } });
  process.write({ method: 'item/fileChange/requestApproval', id: 41, params: {} });
  process.write({ method: 'item/permissions/requestApproval', id: 42, params: {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(process.fromClient.find((m) => m.id === 40)?.result, { decision: 'decline' });
  assert.deepEqual(process.fromClient.find((m) => m.id === 41)?.result, { decision: 'decline' });
  assert.deepEqual(process.fromClient.find((m) => m.id === 42)?.result, { permissions: {} });
  assert.ok(process.fromClient.filter((m) => m.result).every((m) => !Object.hasOwn(m, 'jsonrpc')));
  server.close();
});

test('Approval handler is allowlisted, never accepts per-session auto approval', async () => {
  const process = fakeProcess();
  appServerHooks.spawn = () => process;
  const server = new CodexAppServer({
    requestHandler: async (msg) => msg.id === 50
      ? { decision: 'accept' } : { decision: 'acceptForSession' },
    timeoutMs: 500,
  });
  await server.open();
  process.write({ method: 'item/commandExecution/requestApproval', id: 50, params: {} });
  process.write({ method: 'item/fileChange/requestApproval', id: 51, params: {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(process.fromClient.find((m) => m.id === 50)?.result, { decision: 'accept' });
  assert.deepEqual(process.fromClient.find((m) => m.id === 51)?.result, { decision: 'decline' });
  server.close();
});

test('Connection close rejects in-flight RPCs, no hung messages', async () => {
  const process = fakeProcess();
  appServerHooks.spawn = () => process;
  const server = new CodexAppServer({ timeoutMs: 500 });
  await server.open();
  const pending = server.request('never/returns');
  server.close();
  await assert.rejects(pending, /closed/);
});

class FakeAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.alive = false;
    this.calls = [];
    this.turn = 0;
  }
  async open() { this.alive = true; return this; }
  close() { this.alive = false; this.emit('disconnected', new Error('test close')); }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-chat-1' } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'thread/fork') return { thread: { id: 'thread-fork-2' } };
    if (method === 'turn/start') {
      const turnId = 'turn-' + (++this.turn);
      setImmediate(() => {
        this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } });
        this.emit('notification', { method: 'item/started', params: {
          threadId: params.threadId, turnId, item: { type: 'commandExecution', id: 'tool-1', command: 'ls', status: 'inProgress' },
        } });
        this.emit('notification', { method: 'item/completed', params: {
          threadId: params.threadId, turnId, item: { type: 'commandExecution', id: 'tool-1', command: 'ls', status: 'completed', exit_code: 0, aggregated_output: 'ok' },
        } });
        this.emit('notification', { method: 'item/completed', params: {
          threadId: params.threadId, turnId, item: { type: 'agentMessage', id: 'reply-1', text: 'Codex says hello' },
        } });
        this.emit('notification', { method: 'turn/completed', params: {
          threadId: params.threadId, turn: { id: turnId, status: 'completed' },
        } });
      });
      return { turn: { id: turnId, status: 'inProgress' } };
    }
    return {};
  }
}

test('Chat uses App Server, read-only default, persistent thread id, messages and activity', async () => {
  const fake = new FakeAppServer();
  codexChatHooks.create = () => fake;
  const events = [];
  const session = new CodexChatSession({ machine: { kind: 'local' }, cwd: '/repo', onEvent: (e) => events.push(e) });
  const result = await session.send('hello');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sessionId, 'codex:thread-chat-1');
  assert.equal(result.resultText, 'Codex says hello');
  assert.equal(result.toolCounts.Bash, 1);
  assert.ok(events.some((e) => e.kind === 'tool'));
  assert.ok(events.some((e) => e.kind === 'text'));
  assert.deepEqual(fake.calls.filter((c) => c.method === 'thread/start')[0].params, {
    cwd: '/repo', sandbox: 'read-only', approvalPolicy: 'on-request',
  });
  const sent = fake.calls.find((c) => c.method === 'turn/start');
  assert.equal(sent.params.sandboxPolicy.type, 'readOnly');
  const another = await session.send('hello again');
  assert.equal(another.ok, true);
  assert.equal(fake.calls.filter((c) => c.method === 'thread/start').length, 1);
  session.close();
});

test('Writable chat stays under worktree sandbox without network, explicit approvals only', async () => {
  const fake = new FakeAppServer();
  codexChatHooks.create = () => fake;
  const session = new CodexChatSession({ machine: { kind: 'local' }, cwd: '/repo', permissionMode: 'bypassPermissions' });
  const r = await session.send('fix');
  assert.equal(r.ok, true);
  const opts = fake.calls.find((c) => c.method === 'turn/start').params;
  assert.deepEqual(opts.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['/repo'], networkAccess: false });
  assert.equal(opts.approvalPolicy, 'on-request');
  const thread = fake.calls.find((call) => call.method === 'thread/start');
  assert.equal(thread.params.sandbox, 'workspace-write');
  assert.equal(thread.params.approvalPolicy, 'on-request');
  session.close();
});

test('thread and turn sandbox types deliberately use different enum formats', async () => {
  const fake = new FakeAppServer();
  codexChatHooks.create = () => fake;
  const session = new CodexChatSession({ machine: { kind: 'local' }, cwd: '/repo' });
  await session.send('read');
  const start = fake.calls.find((call) => call.method === 'thread/start').params;
  const turn = fake.calls.find((call) => call.method === 'turn/start').params;
  // Verified against openai/codex tag rust-v0.162.1:
  // schema/json/v2/ThreadStartParams.json and TurnStartParams.json.
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'on-request');
  assert.equal(turn.sandboxPolicy.type, 'readOnly');
  assert.equal(turn.approvalPolicy, 'on-request');
  session.close();
});

test('Codex sessions resume and fork existing history without corrupting source thread', async () => {
  const fake = new FakeAppServer();
  codexChatHooks.create = () => fake;
  const session = new CodexChatSession({ machine: { kind: 'local' }, cwd: '/repo', resume: 'codex:parent-thread', forkSession: true });
  const result = await session.send('forked chat');
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'codex:thread-fork-2');
  assert.ok(fake.calls.some((c) => c.method === 'thread/fork' && c.params.threadId === 'parent-thread'));
  session.close();

  const again = new FakeAppServer();
  codexChatHooks.create = () => again;
  const existing = new CodexChatSession({ machine: { kind: 'local' }, cwd: '/repo', resume: 'codex:thread-chat-1' });
  await existing.send('continue');
  assert.ok(again.calls.some((c) => c.method === 'thread/resume' && c.params.threadId === 'thread-chat-1'));
  existing.close();
});

test('A failed initialize reports the real RPC rejection instead of masking it as App Server closed', async () => {
  class FailingAppServer extends EventEmitter {
    alive = false;
    async open() { throw new Error('RPC -32600: unsupported jsonrpc header'); }
    close() { this.emit('disconnected', new Error('Codex App Server closed')); }
  }
  codexChatHooks.create = () => new FailingAppServer();
  const session = new CodexChatSession({ machine: { kind: 'local' }, cwd: '/repo' });
  const result = await session.send('hello');
  assert.equal(result.ok, false);
  assert.match(result.error, /-32600: unsupported jsonrpc header/);
  assert.doesNotMatch(result.error, /App Server closed/);
  session.close();
});

test('Never start Codex chats on remote runners, and reject mixed Claude thread ids', async () => {
  const session = new CodexChatSession({ machine: { kind: 'runner' }, cwd: '/repo' });
  const res = await session.send('hello');
  assert.equal(res.ok, false);
  assert.match(res.error, /local worktree/);
  session.close();
  assert.throws(() => new CodexChatSession({ machine: { kind: 'local' }, cwd: '/repo', resume: 'claude-session' }), /Cannot resume/);
});

test('Interactive turn approval is denied when plan mode is on, and otherwise requires the owner', async () => {
  const fake = new FakeAppServer();
  codexChatHooks.create = (options) => { fake.options = options; return fake; };
  const session = new CodexChatSession({
    machine: { kind: 'local' }, cwd: '/repo', permissionMode: 'bypassPermissions',
    onApproval: async () => ({ decision: 'accept' }),
  });
  await session.send('review');
  // The turn has already completed: stale approvals always fail closed.
  const stale = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval', id: 17, params: {},
  });
  assert.deepEqual(stale, { decision: 'decline' });
  await session.setPermissionMode('plan');
  assert.equal((await fake.options.requestHandler({
    method: 'item/fileChange/requestApproval', id: 18, params: {},
  })).decision, 'decline');
  session.close();
});
