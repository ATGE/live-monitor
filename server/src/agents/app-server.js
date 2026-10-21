// Codex App Server (JSON-RPC over stdio).
// A separate transport from the batch SDK: supports persistent threads,
// mid-turn steer, interrupts and server-initiated approval requests.
// Never send an implicit 'accept': unhandled permissions fail closed.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const appServerHooks = { spawn: (cmd, args, opts) => spawn(cmd, args, opts) };
export const CODEX_APP_SERVER_TIMEOUT_MS = 15_000;
export const CODEX_APPROVAL_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
export const isCodexApprovalMethod = (method) => CODEX_APPROVAL_METHODS.includes(method);

const decision = (method) => method === 'item/permissions/requestApproval'
  ? { permissions: {} } : method === 'item/tool/requestUserInput'
  ? { answers: {} } : method === 'mcpServer/elicitation/request'
    ? { action: 'decline', content: null } : { decision: 'decline' };

export class CodexAppServer extends EventEmitter {
  #child = null;
  #reader = null;
  #nextId = 0;
  #pending = new Map();
  #approvalControllers = new Set();
  #closed = false;
  #opening = null;

  constructor({ command = 'codex', requestHandler = null, timeoutMs = CODEX_APP_SERVER_TIMEOUT_MS } = {}) {
    super();
    this.command = command;
    this.requestHandler = requestHandler;
    this.timeoutMs = timeoutMs;
  }

  get alive() { return Boolean(this.#child && !this.#closed); }

  async open() {
    if (this.#opening) return this.#opening;
    if (this.#closed) throw new Error('Codex App Server connection was closed');
    this.#opening = this.#connect();
    return this.#opening;
  }

  async #connect() {
    const child = appServerHooks.spawn(this.command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.#child = child;
    child.once('error', (e) => this.#fail(e));
    child.once('exit', (code, signal) => this.#fail(new Error(`codex app-server exited (${code ?? signal ?? 'unknown'})`)));
    // Do not log raw stderr: it can include command parameters or private paths.
    child.stderr?.on('data', () => {});
    // Broken pipes must not crash the whole board with an unhandled stream error.
    child.stdin?.on('error', (e) => this.#fail(e));
    child.stdout?.on('error', (e) => this.#fail(e));
    this.#reader = createInterface({ input: child.stdout });
    this.#reader.on('line', (line) => this.#receive(line));
    await this.request('initialize', {
      clientInfo: { name: 'live_monitor', title: 'Live Monitor', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    this.notify('initialized', {});
    return this;
  }

  #send(message) {
    if (this.#closed || !this.#child?.stdin?.writable) throw new Error('Codex App Server is disconnected');
    this.#child.stdin.write(JSON.stringify(message) + '\n');
  }

  // Codex App Server JSON-RPC intentionally OMITS the jsonrpc version member
  // on the wire. Adding {jsonrpc:'2.0'} makes older CLI builds reject requests.
  notify(method, params = {}) { this.#send({ method, params }); }

  request(method, params = {}, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (this.#closed) return Promise.reject(new Error('Codex App Server is disconnected'));
    if (signal?.aborted) return Promise.reject(new Error('Codex request cancelled'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const finish = (err, value) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        signal?.removeEventListener('abort', pending.abort);
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`Codex RPC ${method} timed out`)), timeoutMs);
      timer.unref?.();
      const abort = () => finish(new Error(`Codex RPC ${method} cancelled`));
      this.#pending.set(id, { timer, abort, finish });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.#send({ id, method, params }); }
      catch (e) { finish(e); }
    });
  }

  #receive(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.emit('protocol_error', new Error('Invalid JSON from Codex App Server')); return; }
    if (!msg || typeof msg !== 'object') return;
    if (Object.hasOwn(msg, 'id') && !msg.method) {
      const pending = this.#pending.get(msg.id);
      if (pending) pending.finish(msg.error ? new Error(`Codex RPC error ${msg.error.code ?? 'unknown'}: ${msg.error.message ?? 'Unknown error'}`) : null, msg.result);
      return;
    }
    if (msg.method && Object.hasOwn(msg, 'id')) {
      void this.#serveRequest(msg);
      return;
    }
    if (msg.method) this.emit('notification', msg);
  }

  async #serveRequest(msg) {
    // For any unknown method the safest outcome is refusing to grant access.
    let answer = decision(msg.method);
    try {
      if (typeof this.requestHandler === 'function') {
        const ctl = new AbortController();
        this.#approvalControllers.add(ctl);
        let approvalTimer;
        try {
          const supplied = await Promise.race([
            Promise.resolve().then(() => this.requestHandler(msg, { signal: ctl.signal })),
            new Promise((resolve) => {
              approvalTimer = setTimeout(() => { ctl.abort(); resolve(null); }, 60_000);
              approvalTimer.unref?.();
            }),
          ]);
          if (!ctl.signal.aborted && supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
            // Only explicitly validated approval decisions on allowed methods may reach Codex.
            // Unknown methods are rejected even if the callback returned accept.
            if (typeof supplied.decision === 'string' && ['accept', 'decline', 'cancel'].includes(supplied.decision)
                && CODEX_APPROVAL_METHODS.includes(msg.method)) {
              answer = { decision: supplied.decision };
            } else if (msg.method === 'item/tool/requestUserInput' && supplied.answers && typeof supplied.answers === 'object') {
              answer = { answers: supplied.answers };
            }
          }
        } finally {
          clearTimeout(approvalTimer);
          this.#approvalControllers.delete(ctl);
        }
      }
    } catch (e) { this.emit('request_error', new Error(`Codex approval handler failed: ${e.message}`)); }
    try { this.#send({ id: msg.id, result: answer }); }
    catch { /* server ended meanwhile */ }
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of [...this.#pending.values()]) p.finish(error);
    for (const ctl of [...this.#approvalControllers]) {
      try { ctl.abort(error); } catch {}
    }
    this.#approvalControllers.clear();
    this.#reader?.close();
    this.emit('disconnected', error);
  }

  close() {
    if (this.#closed) return;
    this.#fail(new Error('Codex App Server closed'));
    try { this.#child?.kill('SIGTERM'); } catch { /* already exited */ }
  }
}
