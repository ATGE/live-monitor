// Persistent Codex chat backed by App Server, not Claude's streaming SDK.
// Exposes ChatSession's surface: send/interrupt/close/retune/plan mode.
// Writes are still controlled by Codex sandbox and explicit UI approvals.
import { CodexAppServer, CODEX_APPROVAL_METHODS } from './app-server.js';
import { CODEX_SESSION_PREFIX, codexThreadId, codexEvent } from './codex.js';

export { CODEX_APPROVAL_METHODS };
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
  #pendingApprovals = new Map();

  constructor({
    machine, cwd, model = null, effort = null, resume = null, forkSession = false,
    onEvent = null, onApproval = null, idleMs = 15 * 60_000,
    permissionMode = 'plan', command = 'codex', mcpPolicy = null,
    sessionId = null, projectId = null, taskId = null, planningId = null,
    codexHome = null, forkFromHome = null,
  } = {}) {
    this.machine = machine;
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.sessionId = resume ?? sessionId;
    this.projectId = projectId;
    this.taskId = taskId;
    this.planningId = planningId;
    this.initialSessionId = sessionId;
    this.customCodexHome = codexHome;
    this.isolatedHome = codexHome ?? null;
    this.forkFromHome = forkFromHome;
    this.onEvent = onEvent;
    this.onApproval = onApproval;
    this.idleMs = idleMs;
    this.permissionMode = permissionMode;
    this.command = command;
    this.mcpPolicy = mcpPolicy;
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
    // Like the existing Claude ChatSession, a closed idle process may reopen
    // later using its persisted thread id.
    this.#closed = false;
    const client = codexChatHooks.create({
      command: this.command,
      cwd: this.cwd,
      mcpPolicy: this.mcpPolicy,
      codexHome: this.isolatedHome ?? this.customCodexHome,
      sessionId: this.initialSessionId ?? this.sessionId,
      projectId: this.projectId,
      taskId: this.taskId,
      planningId: this.planningId,
      forkFromHome: this.forkFromHome,
      requestHandler: (msg, options) => this.#approval(msg, options?.signal),
    });
    this.#client = client;
    client.on('notification', (msg) => this.#onNotification(msg));
    client.on('disconnected', (e) => {
      if (this.#client === client) {
        this.#client = null;
        this.#opening = null;
      }
      if (this.#pending) this.#settle(false, e.message);
      this.onEvent?.({ kind: 'session_closed' });
    });
    this.#opening = (async () => {
      await client.open();
      if (!this.isolatedHome && client.isolatedHome) {
        this.isolatedHome = client.isolatedHome;
      }
      const cfg = {
        cwd: this.cwd,
        // Thread-level enum in the Codex 0.162.1 protocol uses CLI-style kebab-case;
        // the separate turn-level sandboxPolicy.type uses camelCase.
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
      // Preserve the originating RPC/protocol error. Closing first fires the
      // disconnect handler, which otherwise masks it with "App Server closed".
      this.#settle(false, `Codex App Server startup failed: ${e.message}`);
      client.close();
      throw e;
    });
    return this.#opening;
  }

  #invalidateApprovals(reason) {
    for (const entry of this.#pendingApprovals.values()) {
      try { entry.abort(new Error(`Codex approval cancelled: ${reason}`)); } catch {}
    }
    this.#pendingApprovals.clear();
  }

  async #approval(msg, signal) {
    // The RPC transport declines when nothing explicitly authorizes a request.
    // In plan mode, without an active turn, or without a thread id, fail closed immediately.
    if (this.permissionMode === 'plan' || !this.#pending || !this.#threadId) {
      return { decision: 'decline' };
    }
    // Only explicitly allowed approval methods may ever be approved.
    if (!CODEX_APPROVAL_METHODS.includes(msg.method)) {
      return { decision: 'decline' };
    }

    // Extract identifiers from params (supporting both camelCase and snake_case variants used by Codex protocol).
    const requestThreadId = msg.params?.threadId ?? msg.params?.thread_id
      ?? msg.params?.conversationId ?? msg.params?.conversation_id;
    const requestTurnId = msg.params?.turnId ?? msg.params?.turn_id;

    // Fail closed if thread or turn cannot be verified to belong to the active thread and turn.
    // Requests with missing, empty, or mismatched identifiers MUST be rejected.
    if (!requestThreadId || requestThreadId !== this.#threadId) {
      return { decision: 'decline' };
    }
    if (!this.#pending.turnId || !requestTurnId || requestTurnId !== this.#pending.turnId) {
      return { decision: 'decline' };
    }

    const requestId = String(msg.id);
    const boundTurn = this.#pending;
    const boundTurnId = this.#pending.turnId;
    const boundThreadId = this.#threadId;

    const approvalCtl = new AbortController();
    const onAbort = () => approvalCtl.abort(signal?.reason ?? new Error('Approval aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

    this.#pendingApprovals.set(requestId, {
      abort: (err) => approvalCtl.abort(err ?? new Error('Approval invalidated')),
      boundTurn,
      boundTurnId,
      boundThreadId,
    });

    let answer;
    try {
      answer = await this.onApproval?.({
        id: requestId,
        method: msg.method,
        params: msg.params ?? {},
        threadId: boundThreadId,
        turnId: boundTurnId,
        signal: approvalCtl.signal,
      });
    } catch {
      return { decision: 'decline' };
    } finally {
      this.#pendingApprovals.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
    }

    // A stale, aborted, or cross-turn/session answer must NEVER be accepted.
    if (
      approvalCtl.signal.aborted ||
      this.permissionMode === 'plan' ||
      !this.#pending ||
      this.#pending !== boundTurn ||
      this.#pending.turnId !== boundTurnId ||
      this.#threadId !== boundThreadId
    ) {
      return { decision: 'decline' };
    }

    return answer?.decision === 'accept' ? { decision: 'accept' } : { decision: 'decline' };
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
    this.#invalidateApprovals('turn ended');
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
        sandboxPolicy: this.permissionMode === 'plan'
          ? { type: 'readOnly' }
          : { type: 'workspaceWrite', writableRoots: [this.cwd], networkAccess: false },
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
    this.#invalidateApprovals('turn interrupted');
    await this.#client.request('turn/interrupt', { threadId: this.#threadId, turnId: this.#pending.turnId });
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
    if (this.busy && mode !== this.permissionMode) {
      this.#invalidateApprovals('permissions changed');
      throw new Error('Cannot change Codex permissions during an active turn');
    }
    this.permissionMode = mode;
    this.#invalidateApprovals('permissions changed');
  }

  close() {
    this.#stopIdle();
    if (this.#closed) return;
    this.#closed = true;
    this.#invalidateApprovals('session closed');
    if (this.#pending) this.#settle(false, 'Codex chat session closed');
    this.#stopIdle();
    const client = this.#client;
    this.#client = null;
    this.#opening = null;
    client?.close();
  }
}
