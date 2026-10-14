import { EventEmitter } from 'node:events';
import express from 'express';
import { machines } from './machine.js';
import { runnerEvents } from './runner-client.js';
import { settings, REQUIRED_PLUGIN_RE } from './settings.js';

/**
 * The required USER-level plugins (`settings.requiredPlugins`), checked on every
 * machine the board can reach, and installed only when a person asks.
 *
 * The check costs no tokens: `claude plugin list --json` on the machine (the
 * bundled CLI on the laptop, the `claude` on the PATH of a runner), with a
 * `node -e` read of `installed_plugins.json` and of `enabledPlugins` alone as the
 * fallback. Nothing else of a user's settings is read or kept.
 *
 * Nothing in here installs by itself: `startPluginChecks` only reads. An install
 * is `POST /api/machines/:name/plugins/install`, with an id that must be in the
 * required list and match `REQUIRED_PLUGIN_RE`, and is run as an argv array, never
 * through a shell.
 */

const DAY_MS = 24 * 60 * 60_000;
export const OK_CACHE_MS = DAY_MS;
export const FAILURE_CACHE_MS = 10 * 60_000;
const ERROR_MAX = 500;

/** Runs under `node -e` on the machine: prints `[{id, enabled}]` for the user-scope installs. */
const PROBE_SCRIPT = [
  'const fs=require("fs"),os=require("os"),p=require("path");',
  'const rd=(f)=>{try{return JSON.parse(fs.readFileSync(p.join(os.homedir(),".claude",...f),"utf8"));}catch(e){return null;}};',
  'const inst=((rd(["plugins","installed_plugins.json"])||{}).plugins)||{};',
  'const en=(rd(["settings.json"])||{}).enabledPlugins||{};',
  'const out=[];',
  'for(const id of Object.keys(inst)){',
  'const recs=Array.isArray(inst[id])?inst[id]:[];',
  'if(recs.some((r)=>r&&r.scope==="user"))out.push({id,enabled:en[id]===true});}',
  'console.log(JSON.stringify(out));',
].join('');

/** Seams for tests, and for index.js, which wires what lives in other modules. */
export const userPluginHooks = {
  now: () => Date.now(),
  timeoutMs: 30_000,
  /** The install runs a network fetch: it gets longer than a read. */
  installTimeoutMs: 5 * 60_000,
  /** True while a board restart is waiting or in progress (restart.js `restartPending`). */
  restartPending: () => false,
  /** True while an upgrade job is waiting or running (upgrade.js `upgradeHoldsNewWork`). */
  upgradeHolds: () => false,
  /** The bundled CLI the sessions use on the laptop (upgrade.js `bundledCliPath`), or null. */
  cliPath: () => null,
  /** The `claude` to run on that machine. */
  claudeFor: (machine) => (machine.kind === 'local' ? (userPluginHooks.cliPath() ?? 'claude') : 'claude'),
  /** `[{id, enabled}]` of the user-scope plugins on the machine; rejects when it cannot be asked. */
  async list(machine) {
    const file = userPluginHooks.claudeFor(machine);
    try {
      const r = await machine.exec(file, ['plugin', 'list', '--json'], { timeoutMs: userPluginHooks.timeoutMs });
      if (r?.ok) {
        const parsed = parseList(r.stdout);
        if (parsed) return parsed;
      }
    } catch { /* fall through to the file read */ }
    const node = machine.kind === 'local' ? process.execPath : 'node';
    const r = await machine.exec(node, ['-e', PROBE_SCRIPT], { timeoutMs: userPluginHooks.timeoutMs });
    if (!r?.ok) throw new Error(`${machine.name}: could not read the plugins`);
    const parsed = parseFallback(r.stdout);
    if (!parsed) throw new Error(`${machine.name}: invalid plugin read`);
    return parsed;
  },
  /** Runs `claude plugin <args>` on the machine. Resolves `{ ok, stderr }`; never rejects. */
  async cli(machine, args) {
    try {
      const r = await machine.exec(userPluginHooks.claudeFor(machine), ['plugin', ...args], { timeoutMs: userPluginHooks.installTimeoutMs });
      return { ok: Boolean(r?.ok), message: String(r?.stderr || r?.stdout || '') };
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  },
};

/** `[{id, enabled}]` from `claude plugin list --json` (user scope only), or null if it is not that. */
export function parseList(stdout) {
  let data;
  try { data = JSON.parse(String(stdout ?? '')); } catch { return null; }
  if (!Array.isArray(data)) return null;
  return data
    .filter((e) => e && typeof e.id === 'string' && (e.scope === undefined || e.scope === 'user'))
    .map((e) => ({ id: e.id, enabled: e.enabled === true }));
}

/** The fallback script's output: same shape, or null. */
export function parseFallback(stdout) {
  let data;
  try { data = JSON.parse(String(stdout ?? '').trim()); } catch { return null; }
  if (!Array.isArray(data)) return null;
  return data.filter((e) => e && typeof e.id === 'string').map((e) => ({ id: e.id, enabled: e.enabled === true }));
}

/** Pure: which of `required` is missing or disabled given the machine's listing. */
export function diffRequired(required, listing) {
  const byId = new Map(listing.map((e) => [e.id, e.enabled]));
  const missing = [];
  const disabled = [];
  for (const id of required) {
    if (!byId.has(id)) missing.push(id);
    else if (!byId.get(id)) disabled.push(id);
  }
  return { missing, disabled };
}

export const pluginEvents = new EventEmitter();

/** name -> { listing, readOk, checkedAt, at, job, loaded } (nothing here leaves the process but the public view). */
const entries = new Map();
let published = '';

const iso = () => new Date(userPluginHooks.now()).toISOString();
const findMachine = (name) => Object.values(machines()).find((m) => m.name === name) ?? null;

/** The id's plugin name: what a session's `init` reports in `plugins[].name`. */
const nameOf = (id) => id.slice(0, id.indexOf('@'));

function viewOf(e, required) {
  const { missing, disabled } = e.readOk ? diffRequired(required, e.listing) : { missing: [], disabled: [] };
  // Installed and enabled, yet a live session on this machine did not load it.
  const notLoaded = e.readOk && e.loaded
    ? required.filter((id) => !missing.includes(id) && !disabled.includes(id) && !e.loaded.has(nameOf(id)))
    : [];
  return { online: e.readOk, missing, disabled, notLoaded, checkedAt: e.checkedAt, job: e.job };
}

/** The public shape: the required list and, per machine, what is missing. */
export function pluginsState() {
  const required = settings.requiredPlugins;
  const out = {};
  for (const [name, e] of entries) out[name] = viewOf(e, required);
  return { required, machines: out };
}

function publish() {
  const next = pluginsState();
  const key = JSON.stringify(next);
  if (key === published) return;
  published = key;
  pluginEvents.emit('state', next);
}

function put(name, patch) {
  const prev = entries.get(name) ?? { listing: [], readOk: false, checkedAt: null, at: 0, job: null, loaded: null };
  entries.set(name, { ...prev, ...patch });
  publish();
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const inFlight = new Map();

/**
 * Reads one machine's plugins. Cached 24 h after a good read and 10 min after a
 * failed one; `force` skips the cache. An unreachable machine reports `online:false`
 * and nothing missing: we do not know.
 */
export function checkPlugins(name, { force = false } = {}) {
  const e = entries.get(name);
  if (!force && e && userPluginHooks.now() - e.at < (e.readOk ? OK_CACHE_MS : FAILURE_CACHE_MS)) {
    return Promise.resolve(pluginsState().machines[name]);
  }
  if (inFlight.has(name)) return inFlight.get(name);
  const job = (async () => {
    const machine = findMachine(name);
    let listing = [];
    let readOk = false;
    if (machine) {
      try {
        listing = await withTimeout(Promise.resolve(userPluginHooks.list(machine)), userPluginHooks.timeoutMs + 5_000);
        readOk = Array.isArray(listing);
        if (!readOk) listing = [];
      } catch {
        listing = []; // fixed outcome: nothing of the failure is kept
      }
    }
    put(name, { listing, readOk, checkedAt: iso(), at: userPluginHooks.now() });
    return pluginsState().machines[name];
  })().finally(() => inFlight.delete(name));
  inFlight.set(name, job);
  return job;
}

export const checkAllPlugins = (opts) => Promise.all(Object.values(machines()).map((m) => checkPlugins(m.name, opts)));

/**
 * A session's `init` frame, as the passive corroboration of the check: which
 * plugin names that machine's session actually loaded. A frame without a
 * `plugins` list (older CLIs, test doubles) says nothing.
 */
export function noteInit({ machine, plugins } = {}) {
  if (!Array.isArray(plugins)) return;
  const name = machine || 'local';
  if (!entries.has(name)) return; // not checked yet: the check will decide first
  const loaded = new Set(plugins.map((p) => p?.name).filter((n) => typeof n === 'string'));
  put(name, { loaded });
}

let timer = null;
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  runnerEvents.on('offline', ({ machine }) => {
    put(machine, { listing: [], readOk: false, checkedAt: iso(), at: userPluginHooks.now() });
  });
  runnerEvents.on('online', ({ machine }) => { checkPlugins(machine, { force: true }).catch(() => null); });
  // Editing the required list changes what is missing without asking the machines again.
  settings.on('change', () => publish());
}

/** Once on boot and once a day, every machine in parallel. It only reads. */
export function startPluginChecks() {
  wire();
  checkAllPlugins({ force: true }).catch(() => null);
  if (timer) return;
  timer = setInterval(() => checkAllPlugins({ force: true }).catch(() => null), DAY_MS);
  timer.unref?.();
}

// ── install jobs ────────────────────────────────────────────────────────────

class PluginJobError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ACTIVE = ['installing', 'enabling', 'verifying'];
/** machine name -> { state, error, id, done } (the last one: a finished job stays until the next starts). */
const jobs = new Map();

const isActive = (job) => ACTIVE.includes(job.state);

/** True while an install runs: restart and upgrade must not start under it. */
export function pluginJobRunning() {
  for (const j of jobs.values()) if (isActive(j)) return true;
  return false;
}

function setJobState(job, state, error = null) {
  job.state = state;
  job.error = error;
  put(job.machine, { job: isActive(job) ? { state, id: job.id } : (state === 'failed' ? { state, id: job.id } : null) });
}

/** The command's own message, trimmed and capped: the person needs to see why it failed. */
const messageOf = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, ERROR_MAX);

/** Why a new install cannot start right now, or null. */
function refusal(name) {
  const current = jobs.get(name);
  if (current && isActive(current)) return 'Ya hay una instalación de plugins en curso en esa máquina';
  if (userPluginHooks.upgradeHolds()) return 'El tablero se está actualizando o tiene una actualización programada';
  if (userPluginHooks.restartPending()) return 'El tablero tiene un reinicio programado o en curso';
  return null;
}

async function runInstall(job, machine) {
  const id = job.id;
  const stillBad = async () => {
    await checkPlugins(job.machine, { force: true });
    const view = pluginsState().machines[job.machine];
    return { view, bad: !view?.online || view.missing.includes(id) || view.disabled.includes(id) };
  };
  try {
    const current = pluginsState().machines[job.machine];
    if (!current?.disabled.includes(id)) {
      setJobState(job, 'installing');
      const r = await userPluginHooks.cli(machine, ['install', id, '--scope', 'user', '--json']);
      if (!r.ok) return setJobState(job, 'failed', messageOf(r.message) || 'La instalación falló');
    }
    setJobState(job, 'verifying');
    let { view, bad } = await stillBad();
    if (bad && view?.disabled.includes(id)) {
      setJobState(job, 'enabling');
      const r = await userPluginHooks.cli(machine, ['enable', id, '--scope', 'user', '--json']);
      if (!r.ok) return setJobState(job, 'failed', messageOf(r.message) || 'No se pudo activar el plugin');
      setJobState(job, 'verifying');
      ({ bad } = await stillBad());
    }
    return bad ? setJobState(job, 'failed', 'El comando terminó pero el plugin sigue sin estar activo en la máquina') : setJobState(job, 'done');
  } catch {
    return setJobState(job, 'failed', 'La instalación falló');
  }
}

/**
 * Installs ONE required plugin on ONE machine, on explicit request. Returns the
 * job's view at once; the work goes on in the background.
 */
export function startPluginInstall(name, id) {
  const machine = findMachine(name);
  if (!machine) throw new PluginJobError(404, 'Esa máquina no existe');
  if (typeof id !== 'string' || !REQUIRED_PLUGIN_RE.test(id)) throw new PluginJobError(400, 'El id del plugin no es válido');
  if (!settings.requiredPlugins.includes(id)) throw new PluginJobError(400, 'Ese plugin no está en la lista de requeridos');
  const why = refusal(name);
  if (why) throw new PluginJobError(409, why);
  const job = { machine: name, id, state: 'installing', error: null, done: null };
  jobs.set(name, job);
  setJobState(job, 'installing');
  job.done = runInstall(job, machine);
  return { state: job.state, id, machine: name, error: null };
}

/** For tests: resolves when the machine's last install job has ended. */
export const pluginJobSettled = (name) => jobs.get(name)?.done ?? Promise.resolve();

/** The last install job of a machine as `{ state, id, error }`, or null. */
export function pluginJobView(name) {
  const j = jobs.get(name);
  return j ? { state: j.state, id: j.id, machine: name, error: j.error } : null;
}

export function userPluginsRouter() {
  const router = express.Router();
  router.get('/api/plugins', (req, res) => res.json(pluginsState()));
  router.post('/api/machines/:name/plugins/install', (req, res) => {
    try {
      return res.status(202).json(startPluginInstall(req.params.name, req.body?.id));
    } catch (e) {
      if (e instanceof PluginJobError) return res.status(e.status).json({ error: e.message, ...e.extra });
      return res.status(500).json({ error: 'Could not handle the plugin install' });
    }
  });
  router.get('/api/machines/:name/plugins/job', (req, res) => res.json(pluginJobView(req.params.name)));
  return router;
}

/** For tests: forget every entry and job (killing nothing: tests own their processes). */
export function resetUserPluginsForTests() {
  entries.clear();
  inFlight.clear();
  jobs.clear();
  published = '';
  if (timer) { clearInterval(timer); timer = null; }
}
