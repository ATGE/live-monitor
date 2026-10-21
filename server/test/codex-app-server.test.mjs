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

test('Unknown methods are rejected even if callback returns accept (App Server and Chat Session)', async () => {
  // App Server level
  const process = fakeProcess();
  appServerHooks.spawn = () => process;
  const server = new CodexAppServer({
    requestHandler: async () => ({ decision: 'accept' }),
    timeoutMs: 500,
  });
  await server.open();
  process.write({ method: 'item/commandExecution/requestApproval', id: 101, params: {} });
  process.write({ method: 'item/unknownAction/requestApproval', id: 102, params: {} });
  process.write({ method: 'item/permissions/requestApproval', id: 103, params: {} });
  process.write({ method: 'dangerous/customMethod', id: 104, params: {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(process.fromClient.find((m) => m.id === 101)?.result, { decision: 'accept' });
  assert.deepEqual(process.fromClient.find((m) => m.id === 102)?.result, { decision: 'decline' });
  assert.deepEqual(process.fromClient.find((m) => m.id === 103)?.result, { permissions: {} });
  assert.deepEqual(process.fromClient.find((m) => m.id === 104)?.result, { decision: 'decline' });
  server.close();

  // Chat Session level
  const fake = new FakeAppServer();
  codexChatHooks.create = (options) => { fake.options = options; return fake; };
  let calledForUnknown = false;
  const session = new CodexChatSession({
    machine: { kind: 'local' }, cwd: '/repo', permissionMode: 'bypassPermissions',
    onApproval: async (req) => {
      if (req.method !== 'item/commandExecution/requestApproval') calledForUnknown = true;
      return { decision: 'accept' };
    },
  });
  session.send('working turn');
  await new Promise((r) => setImmediate(r));

  const resUnknown = await fake.options.requestHandler({
    method: 'item/dangerousCommand/requestApproval', id: 201, params: { threadId: 'thread-chat-1' },
  });
  assert.deepEqual(resUnknown, { decision: 'decline' });
  assert.equal(calledForUnknown, false, 'onApproval should not be invoked for unknown methods');

  const resAllowed = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval', id: 202, params: { threadId: 'thread-chat-1', turnId: 'turn-1' },
  });
  assert.deepEqual(resAllowed, { decision: 'accept' });
  session.close();
});

test('Approvals are strictly associated with thread, turn and request', async () => {
  const fake = new FakeAppServer();
  codexChatHooks.create = (options) => { fake.options = options; return fake; };
  const approvalsReceived = [];
  const session = new CodexChatSession({
    machine: { kind: 'local' }, cwd: '/repo', permissionMode: 'bypassPermissions',
    onApproval: async (req) => {
      approvalsReceived.push(req);
      return { decision: 'accept' };
    },
  });
  session.send('first turn');
  await new Promise((r) => setImmediate(r));

  // Request with matching thread and turn
  const valid = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 301,
    params: { threadId: 'thread-chat-1', turnId: 'turn-1', command: 'ls' },
  });
  assert.deepEqual(valid, { decision: 'accept' });
  assert.equal(approvalsReceived.length, 1);
  assert.equal(approvalsReceived[0].threadId, 'thread-chat-1');
  assert.equal(approvalsReceived[0].turnId, 'turn-1');
  assert.equal(approvalsReceived[0].id, '301');

  // Request with mismatched threadId -> declined immediately
  const wrongThread = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 302,
    params: { threadId: 'wrong-thread-id', turnId: 'turn-1', command: 'ls' },
  });
  assert.deepEqual(wrongThread, { decision: 'decline' });
  assert.equal(approvalsReceived.length, 1, 'Mismatched thread did not call onApproval');

  // Request with mismatched turnId -> declined immediately
  const wrongTurn = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 303,
    params: { threadId: 'thread-chat-1', turnId: 'wrong-turn-999', command: 'ls' },
  });
  assert.deepEqual(wrongTurn, { decision: 'decline' });
  assert.equal(approvalsReceived.length, 1, 'Mismatched turn did not call onApproval');

  // Request with missing threadId -> unverified -> declined immediately
  const missingThread = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 304,
    params: { turnId: 'turn-1', command: 'ls' },
  });
  assert.deepEqual(missingThread, { decision: 'decline' });
  assert.equal(approvalsReceived.length, 1, 'Missing threadId did not call onApproval');

  // Request with missing turnId -> unverified -> declined immediately
  const missingTurn = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 305,
    params: { threadId: 'thread-chat-1', command: 'ls' },
  });
  assert.deepEqual(missingTurn, { decision: 'decline' });
  assert.equal(approvalsReceived.length, 1, 'Missing turnId did not call onApproval');

  // Request with empty params (missing both) -> unverified -> declined immediately
  const missingBoth = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 306,
    params: {},
  });
  assert.deepEqual(missingBoth, { decision: 'decline' });
  assert.equal(approvalsReceived.length, 1, 'Missing both IDs did not call onApproval');

  // Protocol aliases: snake_case thread_id and turn_id are accepted when valid
  const validSnake = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 307,
    params: { thread_id: 'thread-chat-1', turn_id: 'turn-1', command: 'ls' },
  });
  assert.deepEqual(validSnake, { decision: 'accept' });
  assert.equal(approvalsReceived.length, 2);

  // Protocol aliases: conversationId alias is accepted when valid
  const validConv = await fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 308,
    params: { conversationId: 'thread-chat-1', turnId: 'turn-1', command: 'ls' },
  });
  assert.deepEqual(validConv, { decision: 'accept' });
  assert.equal(approvalsReceived.length, 3);

  session.close();
});

test('Late approval from a settled turn is declined and never applies to another turn', async () => {
  const fake = new FakeAppServer();
  codexChatHooks.create = (options) => { fake.options = options; return fake; };

  let completeTurn1;
  fake.request = async (method, params) => {
    fake.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-chat-1' } };
    if (method === 'turn/start') {
      const turnId = 'turn-' + (++fake.turn);
      if (fake.turn === 1) {
        completeTurn1 = () => {
          fake.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } });
          fake.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } });
        };
      } else {
        setImmediate(() => {
          fake.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } });
          fake.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } });
        });
      }
      return { turn: { id: turnId, status: 'inProgress' } };
    }
    return {};
  };

  let resolveLateApproval;
  const lateApprovalPromise = new Promise((resolve) => { resolveLateApproval = resolve; });
  let approvalAborted = false;

  const session = new CodexChatSession({
    machine: { kind: 'local' }, cwd: '/repo', permissionMode: 'bypassPermissions',
    onApproval: async (req) => {
      req.signal?.addEventListener('abort', () => { approvalAborted = true; });
      return lateApprovalPromise;
    },
  });

  const turn1 = session.send('turn 1');
  await new Promise((r) => setImmediate(r));

  const approvalHandlerPromise = fake.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 401,
    params: { threadId: 'thread-chat-1', turnId: 'turn-1' },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(approvalAborted, false);

  completeTurn1();
  await turn1;
  assert.equal(approvalAborted, true, 'Turn settlement must abort pending approval');

  const turn2 = session.send('turn 2');
  await new Promise((r) => setImmediate(r));

  resolveLateApproval({ decision: 'accept' });
  const approvalResult = await approvalHandlerPromise;

  assert.deepEqual(approvalResult, { decision: 'decline' });

  await turn2;
  session.close();
});

test('Pending approvals are invalidated on interrupt, close, and permission change to plan', async () => {
  // Test Interrupt
  {
    const fake = new FakeAppServer();
    codexChatHooks.create = (options) => { fake.options = options; return fake; };
    let abortSignalFired = false;
    let resolveApproval;
    const approvalPromise = new Promise((r) => { resolveApproval = r; });

    const session = new CodexChatSession({
      machine: { kind: 'local' }, cwd: '/repo', permissionMode: 'bypassPermissions',
      onApproval: async (req) => {
        req.signal.addEventListener('abort', () => { abortSignalFired = true; });
        return approvalPromise;
      },
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-chat-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-hold-1', status: 'inProgress' } };
      if (method === 'turn/interrupt') return {};
      return {};
    };

    session.send('do something');
    await new Promise((r) => setImmediate(r));

    const handlerPromise = fake.options.requestHandler({
      method: 'item/commandExecution/requestApproval',
      id: 501,
      params: { threadId: 'thread-chat-1', turnId: 'turn-hold-1' },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(abortSignalFired, false);

    await session.interrupt();
    assert.equal(abortSignalFired, true, 'Interrupt must abort pending approval signal');

    resolveApproval({ decision: 'accept' });
    const res = await handlerPromise;
    assert.deepEqual(res, { decision: 'decline' });
    session.close();
  }

  // Test Close
  {
    const fake = new FakeAppServer();
    codexChatHooks.create = (options) => { fake.options = options; return fake; };
    let abortSignalFired = false;
    let resolveApproval;
    const approvalPromise = new Promise((r) => { resolveApproval = r; });

    const session = new CodexChatSession({
      machine: { kind: 'local' }, cwd: '/repo', permissionMode: 'bypassPermissions',
      onApproval: async (req) => {
        req.signal.addEventListener('abort', () => { abortSignalFired = true; });
        return approvalPromise;
      },
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-chat-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-hold-2', status: 'inProgress' } };
      return {};
    };

    session.send('turn hold');
    await new Promise((r) => setImmediate(r));

    const handlerPromise = fake.options.requestHandler({
      method: 'item/fileChange/requestApproval',
      id: 502,
      params: { threadId: 'thread-chat-1', turnId: 'turn-hold-2' },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(abortSignalFired, false);

    session.close();
    assert.equal(abortSignalFired, true, 'Close must abort pending approval signal');

    resolveApproval({ decision: 'accept' });
    const res = await handlerPromise;
    assert.deepEqual(res, { decision: 'decline' });
  }

  // Test Permission change
  {
    const fake = new FakeAppServer();
    codexChatHooks.create = (options) => { fake.options = options; return fake; };
    let abortSignalFired = false;
    let resolveApproval;
    const approvalPromise = new Promise((r) => { resolveApproval = r; });

    const session = new CodexChatSession({
      machine: { kind: 'local' }, cwd: '/repo', permissionMode: 'bypassPermissions',
      onApproval: async (req) => {
        req.signal.addEventListener('abort', () => { abortSignalFired = true; });
        return approvalPromise;
      },
    });
    fake.request = async (method, params) => {
      fake.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-chat-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-hold-3', status: 'inProgress' } };
      return {};
    };

    session.send('turn hold');
    await new Promise((r) => setImmediate(r));

    const handlerPromise = fake.options.requestHandler({
      method: 'item/commandExecution/requestApproval',
      id: 503,
      params: { threadId: 'thread-chat-1', turnId: 'turn-hold-3' },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(abortSignalFired, false);

    await assert.rejects(
      session.setPermissionMode('plan'),
      /Cannot change Codex permissions during an active turn/
    );
    assert.equal(abortSignalFired, true, 'Changing permission mode mid-turn must abort pending approval');
    assert.equal(session.permissionMode, 'bypassPermissions', 'permissionMode was not mutated mid-turn');

    resolveApproval({ decision: 'accept' });
    const res = await handlerPromise;
    assert.deepEqual(res, { decision: 'decline' });

    session.close();
  }
});

test('Isolation between different sessions: approvals never cross session boundaries', async () => {
  const fake1 = new FakeAppServer();
  const fake2 = new FakeAppServer();
  fake1.request = async (m, p) => m === 'thread/start' ? { thread: { id: 'thread-A' } } : (m === 'turn/start' ? { turn: { id: 'turn-A' } } : {});
  fake2.request = async (m, p) => m === 'thread/start' ? { thread: { id: 'thread-B' } } : (m === 'turn/start' ? { turn: { id: 'turn-B' } } : {});

  let currentFake = fake1;
  codexChatHooks.create = (opts) => { currentFake.options = opts; return currentFake; };

  const sessionA = new CodexChatSession({
    machine: { kind: 'local' }, cwd: '/repoA', permissionMode: 'bypassPermissions',
    onApproval: async () => ({ decision: 'accept' }),
  });
  sessionA.send('hello A');
  await new Promise((r) => setImmediate(r));

  currentFake = fake2;
  const sessionB = new CodexChatSession({
    machine: { kind: 'local' }, cwd: '/repoB', permissionMode: 'bypassPermissions',
    onApproval: async () => ({ decision: 'accept' }),
  });
  sessionB.send('hello B');
  await new Promise((r) => setImmediate(r));

  const crossRes = await fake1.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 601,
    params: { threadId: 'thread-B', turnId: 'turn-B' },
  });
  assert.deepEqual(crossRes, { decision: 'decline' });

  const ownRes = await fake1.options.requestHandler({
    method: 'item/commandExecution/requestApproval',
    id: 602,
    params: { threadId: 'thread-A', turnId: 'turn-A' },
  });
  assert.deepEqual(ownRes, { decision: 'accept' });

  sessionA.close();
  sessionB.close();
});

test('Pipeline codexChatApproval associates thread/turn/request, clears with turn, denies in plan mode', async () => {
  const { codexChatApproval, clearsWithTurn } = await import('../src/pipeline.js');

  assert.equal(clearsWithTurn({ source: 'board', id: 'codex:thread-1:turn-1:req-1:abc' }), true);
  assert.equal(clearsWithTurn({ source: 'board', id: 'artifact:something' }), true);
  assert.equal(clearsWithTurn({ source: 'board', id: 'board:plan-123' }), false);
  assert.equal(clearsWithTurn({ source: 'claude', id: 'tool-use-123' }), true);

  const chatInPlan = { planMode: true, pending: null, messages: [] };
  const resPlan = await codexChatApproval({}, chatInPlan, {}, {
    id: '1', method: 'item/commandExecution/requestApproval', params: {},
  });
  assert.deepEqual(resPlan, { decision: 'decline' });

  const chatNormal = { planMode: false, pending: null, messages: [] };
  const resUnknown = await codexChatApproval({}, chatNormal, {}, {
    id: '2', method: 'unknown/method', params: {},
  });
  assert.deepEqual(resUnknown, { decision: 'decline' });

  const chatBusy = { planMode: false, pending: { id: 'pending-q' }, messages: [] };
  const resBusy = await codexChatApproval({}, chatBusy, {}, {
    id: '3', method: 'item/commandExecution/requestApproval', params: {},
  });
  assert.deepEqual(resBusy, { decision: 'decline' });
});

test('codexChatApproval rejects missing or unverified thread/turn IDs', async () => {
  const { codexChatApproval } = await import('../src/pipeline.js');

  const chat = { planMode: false, pending: null, messages: [] };

  // Missing both threadId and turnId
  const resNoIds = await codexChatApproval({}, chat, {}, {
    id: '1', method: 'item/commandExecution/requestApproval', params: {},
  });
  assert.deepEqual(resNoIds, { decision: 'decline' });

  // Missing turnId
  const resNoTurn = await codexChatApproval({}, chat, {}, {
    id: '2', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' },
  });
  assert.deepEqual(resNoTurn, { decision: 'decline' });

  // Missing threadId
  const resNoThread = await codexChatApproval({}, chat, {}, {
    id: '3', method: 'item/commandExecution/requestApproval', params: { turnId: 'turn-1' },
  });
  assert.deepEqual(resNoThread, { decision: 'decline' });
});

test('pipeline.setChatPlanMode coordinates with active Codex turn: invalidates pending approval and rejects mode change', async () => {
  const { setChatPlanMode, codexChatApproval, liveEntryOf } = await import('../src/pipeline.js');
  const { store } = await import('../src/store.js');

  const task = store.addTask({ number: 88, title: 'Task', labels: [], url: 'https://x/88', closed: false }, 'hfs');
  const chat = task.chats[0];
  chat.planMode = false;

  const fakeSession = new CodexChatSession({
    machine: { kind: 'local' }, cwd: '/repo', permissionMode: 'bypassPermissions',
  });

  // Connect fake session
  const live = liveEntryOf(task, chat);
  live.session = fakeSession;

  // Set up a pending codex approval on chat
  const approvalPromise = codexChatApproval(task, chat, live, {
    id: 'req-88',
    method: 'item/commandExecution/requestApproval',
    threadId: 'thread-88',
    turnId: 'turn-88',
    params: { command: 'git status' },
  });

  assert.ok(chat.pending);
  assert.ok(String(chat.pending.id).startsWith('codex:'));
  assert.equal(chat.pending.threadId, 'thread-88');
  assert.equal(chat.pending.turnId, 'turn-88');

  // Now user tries to toggle planMode to ON while turn is busy
  // (We simulate busy = true on session)
  Object.defineProperty(fakeSession, 'busy', { value: true, configurable: true });

  assert.throws(
    () => setChatPlanMode(88, chat.id, true),
    /Wait for the Codex turn before changing plan mode/
  );

  // Verification:
  // 1. chat.planMode was NOT changed (preserves sandbox synchronization!)
  assert.equal(chat.planMode, false);
  // 2. The pending approval was expired immediately
  assert.equal(chat.pending, null);
  const approvalResult = await approvalPromise;
  assert.deepEqual(approvalResult, { decision: 'decline' });

  // Once turn settles (busy = false), changing plan mode succeeds cleanly
  Object.defineProperty(fakeSession, 'busy', { value: false, configurable: true });
  setChatPlanMode(88, chat.id, true);
  assert.equal(chat.planMode, true);
  assert.equal(fakeSession.permissionMode, 'plan');

  fakeSession.close();
});
