import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { machines } from './machine.js';
import { loginHooks, parseProbe, checkLogin, setLoginJob, clearAuthFailure } from './login.js';

/**
 * «Renovar login»: runs `claude auth login` on ONE machine and hands the URL it
 * prints to the client that asked for it.
 *
 * What may leave this module, and where:
 *  - the URL and a pasted code live only in this process's memory (`job.url`,
 *    `job.buffer`) and in the response to the caller that holds the job's ticket;
 *  - the state published to everybody (`setLoginJob`) is `{ state }` and nothing else;
 *  - no error message is built from the command's output: every failure is a fixed
 *    string, so an uncaught error cannot carry the URL into the board's err log;
 *  - the runner's stderr is NOT copied to `process.stderr` (that is what
 *    `RemoteProcess` does, so the `/claude` socket is driven here directly);
 *  - nothing is written to the store, the task log or the upgrade job log.
 */

const ACTIVE = ['starting', 'url', 'code', 'verifying'];
const TERMINAL = ['done', 'failed', 'cancelled'];
const BUFFER_MAX = 16 * 1024;
const CODE_MAX = 512;

const URL_RE = /https?:\/\/[^\s"'<>]+/;
const CODE_PROMPT_RE = /(paste|enter)[^\n]{0,40}code|authorization code|code[^\n]{0,20}(here|if prompted)/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

const posix = process.platform !== 'win32';

class LoginJobError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Seams for tests and for index.js, which wires the pieces that live in other modules. */
export const loginJobHooks = {
  /** True while a board restart is waiting or in progress (restart.js `restartPending`). */
  restartPending: () => false,
  /** True while an upgrade job is waiting or running (upgrade.js `upgradeHoldsNewWork`). */
  upgradeHolds: () => false,
  /** The busy chats/processes ON THAT MACHINE: `[{ id, title, kind }]`. */
  busy: (_machineName) => [],
  /** The bundled CLI the sessions use on the laptop (upgrade.js `bundledCliPath`), or null. */
  cliPath: () => null,
  machineOf: (name) => Object.values(machines()).find((m) => m.name === name) ?? null,
  localCommand: () => ({ file: loginJobHooks.cliPath() ?? 'claude', args: ['auth', 'login'] }),
  spawnLocal: (file, args, opts) => spawn(file, args, opts),
  /** Ends a local child and its tree; only a child that is still running. */
  killTree(child) {
    return new Promise((resolve) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 10_000);
      timer.unref?.();
      const done = () => { clearTimeout(timer); resolve(); };
      try {
        if (posix) {
          child.once('exit', done);
          process.kill(-child.pid, 'SIGTERM');
        } else {
          const tk = loginJobHooks.spawnLocal('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          tk.on('exit', done);
          tk.on('error', () => { try { child.kill(); } catch { /* already gone */ } done(); });
        }
      } catch { done(); }
    });
  },
  /** `{ expiresAt }` as read now from the machine's credentials (numbers only). */
  async readLogin(machine) {
    const nums = parseProbe(await loginHooks.probe(machine));
    if (!nums) throw new Error('invalid read');
    return { expiresAt: nums.expiresAt };
  },
  /** True when `claude auth status` says logged in. Nothing else of its output is kept. */
  async authStatus(machine) {
    const file = machine.kind === 'local' ? (loginJobHooks.cliPath() ?? 'claude') : 'claude';
    const r = await machine.exec(file, ['auth', 'status', '--json'], { timeoutMs: 30_000 });
    if (!r?.ok) return false;
    try { return JSON.parse(r.stdout)?.loggedIn === true; } catch { return false; }
  },
  timing: {
    /** The whole login, from the spawn: the user has to authorize in a browser. */
    timeoutMs: 10 * 60_000,
    /** How often a job that waits for the machine to go idle looks again. */
    waitPollMs: 5_000,
  },
};

/** machine name -> job (the last one: a finished job stays until the next starts). */
const jobs = new Map();

const strip = (text) => text.replace(ANSI_RE, '');
const isTerminal = (job) => TERMINAL.includes(job.state);

function setState(job, state, error = null) {
  job.state = state;
  job.error = error;
  if (TERMINAL.includes(state)) {
    clearTimeout(job.timeout);
    clearInterval(job.waitTimer);
    job.buffer = '';
    job.url = null;
    job.needsCode = false;
    setLoginJob(job.machine, null);
  } else {
    setLoginJob(job.machine, { state });
  }
}

/** True while a login command is running: restart and upgrade must not start. */
export function loginJobRunning() {
  for (const j of jobs.values()) if (ACTIVE.includes(j.state)) return true;
  return false;
}

/** The job as the ticket holder sees it. */
function ownerView(job) {
  return {
    state: job.state,
    machine: job.machine,
    url: job.url,
    needsCode: job.needsCode,
    busy: job.state === 'waiting' ? job.busy : [],
    error: job.error,
  };
}

/** The job as anybody sees it: no URL, no code, no ticket. */
const publicView = (job) => ({ state: job?.state ?? null, machine: job?.machine ?? null });

function onData(job, text) {
  if (isTerminal(job) || job.state === 'verifying') return;
  job.buffer = (job.buffer + strip(text)).slice(-BUFFER_MAX);
  if (!job.url) {
    const m = URL_RE.exec(job.buffer);
    if (m) {
      job.url = m[0];
      setState(job, 'url');
    }
  }
  if (job.url && !job.needsCode && CODE_PROMPT_RE.test(job.buffer)) {
    job.needsCode = true;
    setState(job, 'code');
  }
}

async function verify(job, machine) {
  setState(job, 'verifying');
  try {
    const after = await loginJobHooks.readLogin(machine);
    if (!(after.expiresAt > 0) || !(after.expiresAt > job.before)) {
      return setState(job, 'failed', 'El login terminó pero no quedó guardado (¿disco lleno?)');
    }
    if (!(await loginJobHooks.authStatus(machine))) {
      return setState(job, 'failed', 'El login terminó pero Claude sigue sin sesión en esa máquina');
    }
  } catch {
    return setState(job, 'failed', 'No se pudo comprobar el login después de renovarlo');
  }
  setState(job, 'done');
  clearAuthFailure(job.machine);
  checkLogin(job.machine, { force: true }).catch(() => null);
}

function onExit(job, machine, code) {
  if (isTerminal(job)) return;
  if (code === 0) { verify(job, machine); return; }
  setState(job, 'failed', 'El comando de login terminó con error');
}

function onFailure(job) {
  if (isTerminal(job)) return;
  setState(job, 'failed', 'Se perdió la conexión con el comando de login');
}

function launchLocal(job) {
  const { file, args } = loginJobHooks.localCommand();
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const child = loginJobHooks.spawnLocal(file, args, {
    env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: posix,
  });
  child.stdout?.on('data', (b) => onData(job, b.toString('utf8')));
  child.stderr?.on('data', (b) => onData(job, b.toString('utf8')));
  child.stdin?.on('error', () => {});
  return {
    child,
    listen(machine) {
      child.on('close', (code) => onExit(job, machine, code));
      child.on('error', () => onFailure(job));
    },
    write: (text) => child.stdin.write(text),
    kill: () => loginJobHooks.killTree(child),
  };
}

function launchRemote(job, machine) {
  const ws = machine.ws('/claude', { start: { args: ['auth', 'login'] } });
  let exited = false;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (typeof m.stdout === 'string') onData(job, m.stdout);
    if (typeof m.stderr === 'string') onData(job, m.stderr);
    if (m.exit) { exited = true; onExit(job, machine, m.exit.code); }
    if (m.error) { onFailure(job); try { ws.close(); } catch { /* closed */ } }
  });
  ws.on('error', () => onFailure(job));
  ws.on('close', () => { if (!exited) onFailure(job); });
  const send = (frame) => { try { ws.send(JSON.stringify(frame)); } catch { /* socket gone */ } };
  return {
    listen() {},
    write: (text) => send({ stdin: text }),
    async kill() {
      send({ kill: true });
      try { ws.close(); } catch { /* closed */ }
    },
  };
}

async function begin(job, machine) {
  setState(job, 'starting');
  try {
    job.before = (await loginJobHooks.readLogin(machine)).expiresAt || 0;
  } catch {
    job.before = 0;
  }
  if (isTerminal(job)) return;
  let handle;
  try {
    handle = machine.kind === 'local' ? launchLocal(job) : launchRemote(job, machine);
  } catch {
    return setState(job, 'failed', 'No se pudo lanzar el comando de login');
  }
  job.handle = handle;
  handle.listen(machine);
  job.timeout = setTimeout(() => {
    if (isTerminal(job)) return;
    setState(job, 'failed', 'Se agotó el tiempo para completar el login');
    handle.kill();
  }, loginJobHooks.timing.timeoutMs);
  job.timeout.unref?.();
}

/** Why a new job cannot start right now, or null. */
function refusal(name) {
  const current = jobs.get(name);
  if (current && !isTerminal(current)) return 'Ya hay una renovación de login en curso en esa máquina';
  if (loginJobHooks.upgradeHolds()) return 'The board is updating or has an update scheduled';
  if (loginJobHooks.restartPending()) return 'El tablero tiene un reinicio programado o en curso';
  return null;
}

function evaluate(job, machine) {
  if (job.state !== 'waiting') return;
  if (loginJobHooks.upgradeHolds() || loginJobHooks.restartPending()) {
    setState(job, 'failed', 'Una actualización o un reinicio del tablero tomó el relevo');
    return;
  }
  job.busy = loginJobHooks.busy(job.machine);
  if (job.busy.length) return;
  clearInterval(job.waitTimer);
  begin(job, machine);
}

/**
 * Starts a job for `name`. Without `force` it waits until the machine has nothing
 * busy; with it, it starts now. Returns `{ ticket, job }`.
 */
export function startLoginJob(name, { force = false } = {}) {
  const machine = loginJobHooks.machineOf(name);
  if (!machine) throw new LoginJobError(404, 'Esa máquina no existe');
  const why = refusal(name);
  if (why) throw new LoginJobError(409, why, { busy: loginJobHooks.busy(name) });
  const job = {
    machine: name, ticket: randomBytes(16).toString('hex'), state: 'waiting', force: Boolean(force),
    buffer: '', url: null, needsCode: false, error: null, busy: [], before: 0,
    handle: null, timeout: null, waitTimer: null,
  };
  jobs.set(name, job);
  setLoginJob(name, { state: 'waiting' });
  job.busy = force ? [] : loginJobHooks.busy(name);
  if (!job.busy.length) {
    begin(job, machine);
  } else {
    job.waitTimer = setInterval(() => evaluate(job, machine), loginJobHooks.timing.waitPollMs);
    job.waitTimer.unref?.();
  }
  return { ticket: job.ticket, job: ownerView(job) };
}

function ticketJob(name, ticket) {
  const job = jobs.get(name);
  const a = Buffer.from(String(ticket ?? ''));
  const b = Buffer.from(job?.ticket ?? '');
  if (!job || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new LoginJobError(403, 'Esa renovación no es tuya o ya no existe');
  }
  return job;
}

/** The job's view: full for the ticket holder, state-only otherwise. */
export function loginJobView(name, ticket) {
  const job = jobs.get(name);
  if (!ticket) return publicView(job);
  return ownerView(ticketJob(name, ticket));
}

export function submitLoginCode(name, ticket, code) {
  const job = ticketJob(name, ticket);
  if (job.state !== 'code' || !job.handle) throw new LoginJobError(409, 'El comando no está pidiendo ningún código');
  if (typeof code !== 'string' || !code.trim() || code.length > CODE_MAX || /[\r\n]/.test(code)) {
    throw new LoginJobError(400, 'El código no es válido');
  }
  job.handle.write(`${code.trim()}\n`);
  job.needsCode = false;
  setState(job, 'url');
  return ownerView(job);
}

export async function cancelLoginJob(name, ticket) {
  const job = ticketJob(name, ticket);
  if (isTerminal(job)) return ownerView(job);
  const handle = job.handle;
  setState(job, 'cancelled');
  if (handle) await handle.kill();
  return ownerView(job);
}

export function loginJobRouter() {
  const router = express.Router();
  const reply = (res, fn) => Promise.resolve()
    .then(fn)
    .then((body) => res.status(body?.__status ?? 200).json(body?.__status ? body.body : body))
    .catch((e) => {
      if (e instanceof LoginJobError) return res.status(e.status).json({ error: e.message, ...e.extra });
      return res.status(500).json({ error: 'Could not handle the login renewal' });
    });
  const ticketOf = (req) => req.get('x-login-ticket');

  router.post('/api/machines/:name/login', (req, res) => reply(res, () => {
    const { ticket, job } = startLoginJob(req.params.name, { force: req.body?.force === true });
    return { __status: 202, body: { ticket, ...job } };
  }));
  router.get('/api/machines/:name/login/job', (req, res) => reply(res, () => loginJobView(req.params.name, ticketOf(req))));
  router.post('/api/machines/:name/login/code', (req, res) => reply(res, () => submitLoginCode(req.params.name, ticketOf(req), req.body?.code)));
  router.post('/api/machines/:name/login/cancel', (req, res) => reply(res, () => cancelLoginJob(req.params.name, ticketOf(req))));
  return router;
}

/** For tests: forget every job (killing nothing: tests own their processes). */
export function resetLoginJobsForTests() {
  for (const j of jobs.values()) { clearTimeout(j.timeout); clearInterval(j.waitTimer); }
  jobs.clear();
}
