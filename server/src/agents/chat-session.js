// Persistent Codex chat backed by App Server, not Claude's streaming SDK.
// Exposes ChatSession's surface: send/interrupt/close/retune/plan mode.
// Writes are still controlled by Codex sandbox and explicit UI approvals.
import { CodexAppServer } from './app-server.js';
import { CODEX_SESSION_PREFIX, codexThreadId, codexEvent } from './codex.js';

export const codexChatHooks = { create: (opts) => new CodexAppServer(opts) };
const reply = (ok, sessionId, text, counts, started, error, usage) => ({
  ok, quota: false, sessionId, resultText: ok ? text : '', toolCounts: counts,
  stats: {
    ms: Date.now() - started, provider: 'codex',
    tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
  },
  ...(error ? { error } : {}),
});

export class CodexChatSession {
  #client = null;
  #pending = null;
  #opening = null;
  #idle = null;
  #closed = false;
  #threadId = null;
  #forkPending = false;
  #answerBuffer = '';
  #itemMessage = '';
  #usage = null;

  constructor({
    machine, cwd, model = null, effort = null, resume = null, forkSession = false,
    onEvent = null, onApproval = null, idleMs = 15 * 60_000,
    permissionMode = 'plan', command = 'codex',
  } = {}) {
    this.machine = machine;
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.sessionId = resume;
    this.onEvent = onEvent;
    this.onApproval = onApproval;
    this.idleMs = idleMs;
    this.permissionMode = permissionMode;
    this.command = command;
    this.#forkPending = Boolean(resume && forkSession);
    if (resume) this.#threadId = codexThreadId(resume);
  }

  get alive() { return Boolean(this.#client?.alive); }
  get busy() { return Boolean(this.#pending); }
  get working() { return this.busy; }
  get runningEffort() { return this.alive ? this.effort : null; }
  get runningThinking() { return null; }

  #stopIdle() { if (this.#idle) clearTimeout(this.#idle); this.#idle = null; }
  #armIdle() {
    this.#stopIdle();
    if (!this.busy && this.alive && this.idleMs) {
      this.#idle = setTimeout(() => this.close(), this.idleMs);
      this.#idle.unref?.();
    }
  }

  async #open() {
    if (this.#opening) return this.#opening;
    if (this.machine?.kind !== 'local') throw new Error('Codex chat requires a local worktree');
    if (!this.cwd) throw new Error('Codex chat needs a worktree directory');
    if (this.#closed) throw new Error('Codex chat session was closed');
    const client = codexChatHooks.create({
      command: this.command,
      requestHandler: (msg) => this.#approval(msg),
    });
    this.#client = client;
    client.on('notification', (msg) => this.#onNotification(msg));
    client.on('disconnected', (e) => {
      if (this.#pending) this.#settle(false, e.message);
      this.onEvent?.({ kind: 'session_closed' });
    });
    this.#opening = (async () => {
      await client.open();
      const cfg = {
        cwd: this.cwd,
        sandbox: this.permissionMode === 'plan' ? 'read-only' : 'workspace-write',
        approvalPolicy: 'on-request',
        ...(this.model ? { model: this.model } : {}),
      };
      let opened;
      if (this.#threadId && this.#forkPending) {
        opened = await client.request('thread/fork', { threadId: this.#threadId, ...cfg });
      } else if (this.#threadId) {
        opened = await client.request('thread/resume', { threadId: this.#threadId, ...cfg });
      } else {
        opened = await client.request('thread/start', cfg);
      }
      this.#threadId = opened?.thread?.id;
      if (!this.#threadId) throw new Error('Codex thread/start did not return a thread id');
      this.#forkPending = false;
      this.sessionId = CODEX_SESSION_PREFIX + this.#threadId;
      this.onEvent?.({ kind: 'init', provider: 'codex', sessionId: this.sessionId, model: this.model ?? 'default' });
    })().catch((e) => {
      client.close();
      throw e;
    });
    return this.#opening;
  }

  async #approval(msg) {
    // The RPC transport declines when nothing explicitly authorizes a request.
    if (this.permissionMode === 'plan' || !this.#pending) return { decision: 'decline' };
    if (!/requestApproval$/.test(msg.method)) return { decision: 'decline' };
    try {
      const answer = await this.onApproval?.({
        id: String(msg.id), method: msg.method, params: msg.params ?? {},
      });
      return answer?.decision === 'accept' ? { decision: 'accept' } : { decision: 'decline' };
    } catch { return { decision: 'decline' }; }
  }

  #onNotification(msg) {
    const { method, params = {} } = msg;
    if (!this.#pending) return;
    if (params.threadId && params.threadId !== this.#threadId) return;
    const current = this.#pending;
    const actualTurn = params.turn?.id ?? params.turnId ?? null;
    if (actualTurn && current.turnId && actualTurn !== current.turnId) return;
    switch (method) {
      case 'turn/started':
        if (actualTurn) current.turnId = actualTurn;
        this.onEvent?.({ kind: 'turn_start', own: true });
        return;
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') this.#answerBuffer += params.delta;
        return;
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const item = params.item;
        if (!item) return;
        const type = method === 'item/started' ? 'item.started' : method === 'item/updated' ? 'item.updated' : 'item.completed';
        const normalized = { ...item, type: ({
          commandExecution: 'command_execution', fileChange: 'file_change', mcpToolCall: 'mcp_tool_call',
          agentMessage: 'agent_message', webSearch: 'web_search',
        })[item.type] ?? item.type };
        codexEvent({ type, item: normalized }, (ev) => {
          if (ev.kind === 'text') {
            this.#itemMessage = ev.text;
          } else {
            this.onEvent?.(ev);
          }
        }, current.counts);
        return;
      }
      case 'thread/tokenUsage/updated':
        this.#usage = params.tokenUsage?.last ?? params.tokenUsage?.total ?? null;
        return;
      case 'turn/completed': {
        const status = params.turn?.status;
        const ok = status === 'completed';
        this.#settle(ok, ok ? null : `Codex turn ${status ?? 'failed'}`);
        return;
      }
      default: return;
    }
  }

  #settle(ok, error = null) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    const answer = this.#itemMessage || this.#answerBuffer;
    if (answer) this.onEvent?.({ kind: 'text', text: answer });
    this.onEvent?.({ kind: 'result', ok, turns: 1 });
    this.onEvent?.({ kind: 'turn_end', own: true });
    pending.resolve(reply(ok, this.sessionId, answer, pending.counts, pending.started, error, this.#usage));
    this.#armIdle();
  }

  async send(text) {
    if (this.#pending) throw new Error('Codex chat already has a turn in progress');
    this.#stopIdle();
    const counts = Object.create(null);
    // Claim the turn before any asynchronous handshake to prevent racing sends.
    const started = Date.now();
    let resolve;
    const outcome = new Promise((r) => { resolve = r; });
    this.#pending = { resolve, started, counts, turnId: null };
    try {
      await this.#open();
      this.#answerBuffer = '';
      this.#itemMessage = '';
      this.#usage = null;
      const params = {
        threadId: this.#threadId, input: [{ type: 'text', text }],
        sandboxPolicy: { type: this.permissionMode === 'plan' ? 'readOnly' : 'workspaceWrite' },
        approvalPolicy: 'on-request',
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      };
      const response = await this.#client.request('turn/start', params);
      if (this.#pending && response?.turn?.id) this.#pending.turnId = response.turn.id;
    } catch (e) {
      this.#settle(false, e.message);
    }
    return outcome;
  }

  async interrupt() {
    if (!this.#pending || !this.#threadId) throw new Error('There is no Codex turn in progress');
    await this.#client.request('turn/interrupt', { threadId: this.#threadId });
  }

  /** Mid-turn steering, available via the App Server transport. */
  async steer(text) {
    if (!this.#pending?.turnId || !this.#threadId) throw new Error('There is no Codex turn to steer');
    return this.#client.request('turn/steer', {
      threadId: this.#threadId, expectedTurnId: this.#pending.turnId,
      input: [{ type: 'text', text }],
    });
  }

  async setModel(model) { this.model = model; }
  async retune({ model, effort } = {}) {
    if (model !== undefined) this.model = model;
    if (effort !== undefined) this.effort = effort;
    return { reopened: false, effort: this.effort, reason: null };
  }
  async setEffort(effort) { return this.retune({ effort }); }
  async setPermissionMode(mode) {
    if (!['plan', 'bypassPermissions'].includes(mode)) throw new Error('Invalid Codex permission mode');
    if (this.busy && mode !== this.permissionMode) throw new Error('Cannot change Codex permissions during an active turn');
    this.permissionMode = mode;
  }

  close() {
    this.#stopIdle();
    if (this.#closed) return;
    this.#closed = true;
    if (this.#pending) this.#settle(false, 'Codex chat session closed');
    this.#client?.close();
  }
}
