import { EventEmitter } from 'node:events';
import { machines } from './machine.js';
import { runnerEvents } from './runner-client.js';
import { usageEvents } from './usage.js';

/**
 * Per-machine state of the Claude OAuth login: `ok | expiring | expired | unknown`.
 *
 * The expiry is read through the machine's own `exec` route with a command that
 * prints three numbers and nothing else — never through `RemoteFs.readFile`,
 * which would copy the whole token file across the tailnet. Nothing here keeps,
 * logs or emits a token, an account e-mail or the raw output of the command.
 *
 * Why not `machineStatus()` / `info()`: every open tab polls those every 60 s.
 * The read happens once on boot, once a day, and when something says the login
 * may have changed (a runner coming back, the usage probe failing, a session
 * that failed with `authentication_failed`).
 */

export const WARN_DAYS = 5;
const DAY_MS = 24 * 60 * 60_000;
export const OK_CACHE_MS = DAY_MS;
export const FAILURE_CACHE_MS = 10 * 60_000;
const USAGE_RECHECK_MIN_MS = 60_000;

/** Runs under `node -e` on the machine: prints `R=<ms|none> E=<ms> T=<0|1>` or `NOFILE`. */
const PROBE_SCRIPT = [
  'const fs=require("fs"),os=require("os"),p=require("path");',
  'let j;',
  'try{j=JSON.parse(fs.readFileSync(p.join(os.homedir(),".claude",".credentials.json"),"utf8"));}',
  'catch(e){console.log("NOFILE");process.exit(0);}',
  'const o=(j&&j.claudeAiOauth)||{};',
  'const n=(v)=>{v=Number(v);return Number.isFinite(v)&&v>0?Math.floor(v):0;};',
  'const r=n(o.refreshTokenExpiresAt);',
  'console.log("R="+(r?r:"none")+" E="+n(o.expiresAt)+" T="+(o.accessToken&&o.refreshToken?1:0));',
].join('');

const PROBE_RE = /^R=(\d+|none) E=(\d+) T=([01])$/;

/** Seams for tests: the clock, the command, the timeout. */
export const loginHooks = {
  now: () => Date.now(),
  timeoutMs: 20_000,
  /** Resolves the command's stdout; rejects when the machine cannot be asked. */
  async probe(machine) {
    const node = machine.kind === 'local' ? process.execPath : 'node';
    const r = await machine.exec(node, ['-e', PROBE_SCRIPT], { timeoutMs: loginHooks.timeoutMs });
    if (!r?.ok) throw new Error(`${machine.name}: could not read the login`);
    return r.stdout;
  },
};

/**
 * `{ refreshAt, expiresAt, hasTokens }` from the probe's stdout, or `null` when
 * the output is not exactly the expected shape (or the file is absent).
 */
export function parseProbe(stdout) {
  const m = PROBE_RE.exec(String(stdout ?? '').trim());
  if (!m) return null;
  return {
    refreshAt: m[1] === 'none' ? null : Number(m[1]),
    expiresAt: Number(m[2]),
    hasTokens: m[3] === '1',
  };
}

/** Pure: `{ state, expiresAt }`. The threshold is decided by the refresh token's expiry. */
export function loginStateFrom(nums, now) {
  if (!nums) return { state: 'unknown', expiresAt: null };
  const { refreshAt = null, expiresAt = 0, hasTokens = false } = nums;
  // The CLI blanks the file after a failed refresh: tokens gone, expiresAt 0.
  if (!hasTokens && !expiresAt) return { state: 'expired', expiresAt: refreshAt };
  if (!refreshAt) return { state: 'unknown', expiresAt: null };
  if (refreshAt <= now) return { state: 'expired', expiresAt: refreshAt };
  if (refreshAt - now <= WARN_DAYS * DAY_MS) return { state: 'expiring', expiresAt: refreshAt };
  return { state: 'ok', expiresAt: refreshAt };
}

export const loginEvents = new EventEmitter();

/** name -> { state, expiresAt, checkedAt, job, readOk, at, failedAt } (`failedAt` never leaves the process) */
const entries = new Map();
let published = '';
let lastUsageRecheck = 0;

const iso = () => new Date(loginHooks.now()).toISOString();

/** The public shape: states and timestamps only. */
export function loginState() {
  const out = {};
  for (const [name, e] of entries) {
    out[name] = { state: e.state, expiresAt: e.expiresAt, checkedAt: e.checkedAt, job: e.job };
  }
  return out;
}

function publish() {
  const next = loginState();
  const key = JSON.stringify(next);
  if (key === published) return;
  published = key;
  loginEvents.emit('state', next);
}

function put(name, patch) {
  const prev = entries.get(name) ?? { state: 'unknown', expiresAt: null, checkedAt: null, job: null, readOk: false, at: 0 };
  entries.set(name, { ...prev, ...patch });
  publish();
}

const findMachine = (name) => Object.values(machines()).find((m) => m.name === name) ?? null;

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const inFlight = new Map();

/**
 * Reads one machine's login. Cached 24 h after a good read and 10 min after a
 * failed one; `force` skips the cache. An unreachable machine is `unknown`,
 * never `expired`.
 */
export function checkLogin(name, { force = false } = {}) {
  const e = entries.get(name);
  if (!force && e && loginHooks.now() - e.at < (e.readOk ? OK_CACHE_MS : FAILURE_CACHE_MS)) {
    return Promise.resolve(loginState()[name]);
  }
  if (inFlight.has(name)) return inFlight.get(name);
  const job = (async () => {
    const machine = findMachine(name);
    let nums = null;
    let readOk = false;
    if (machine) {
      try {
        const out = await withTimeout(Promise.resolve(loginHooks.probe(machine)), loginHooks.timeoutMs);
        nums = parseProbe(out);
        readOk = nums !== null;
      } catch {
        nums = null; // fixed outcome: nothing of the failure is kept
      }
    }
    let { state, expiresAt } = loginStateFrom(nums, loginHooks.now());
    // A session saw `authentication_failed`: a file that still looks healthy
    // (revoked server-side) must not flip the chip back to ok. The mark clears
    // when the refresh expiry moves past the one recorded at the failure.
    const mark = entries.get(name)?.failedAt;
    if (mark && readOk) {
      const renewed = nums?.refreshAt && nums.refreshAt > mark.refreshAt;
      if (renewed) put(name, { failedAt: null });
      else if (state === 'ok' || state === 'expiring' || state === 'unknown') state = 'expired';
    }
    put(name, { state, expiresAt, checkedAt: iso(), readOk, at: loginHooks.now() });
    return loginState()[name];
  })().finally(() => inFlight.delete(name));
  inFlight.set(name, job);
  return job;
}

/** A session on this machine failed with `authentication_failed`: it is expired now. */
export function noteAuthFailure(name) {
  if (!name) return;
  const prev = entries.get(name);
  // Remember the refresh expiry that was in force: only a later one clears the mark.
  const failedAt = prev?.failedAt ?? { refreshAt: prev?.expiresAt ?? 0 };
  put(name, { state: 'expired', checkedAt: iso(), failedAt });
}

/** A renewal finished and was verified: forget the failure mark of this machine. */
export function clearAuthFailure(name) {
  if (entries.has(name)) put(name, { failedAt: null });
}

/** The renew job of a machine, as `{ state }` only (never a URL, code or ticket); `null` clears it. */
export function setLoginJob(name, job) {
  put(name, { job: job ? { state: String(job.state) } : null });
}

export const checkAllLogins = (opts) => Promise.all(Object.values(machines()).map((m) => checkLogin(m.name, opts)));

let timer = null;
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  runnerEvents.on('offline', ({ machine }) => {
    put(machine, { state: 'unknown', expiresAt: null, checkedAt: iso(), readOk: false, at: loginHooks.now() });
  });
  runnerEvents.on('online', ({ machine }) => { checkLogin(machine, { force: true }).catch(() => null); });
  // The laptop's usage probe uses the login every few minutes: a failure there
  // is a free «maybe broken» signal. Only a re-read of the file decides.
  usageEvents.on('state', (usage) => {
    if (!usage?.error) return;
    const now = loginHooks.now();
    if (now - lastUsageRecheck < USAGE_RECHECK_MIN_MS) return;
    lastUsageRecheck = now;
    checkLogin('local', { force: true }).catch(() => null);
  });
}

/** Once on boot and once a day, every machine in parallel. */
export function startLoginChecks() {
  wire();
  checkAllLogins({ force: true }).catch(() => null);
  if (timer) return;
  timer = setInterval(() => checkAllLogins({ force: true }).catch(() => null), DAY_MS);
  timer.unref?.();
}

/** For tests. */
export function resetLoginForTests() {
  entries.clear();
  inFlight.clear();
  published = '';
  lastUsageRecheck = 0;
  if (timer) { clearInterval(timer); timer = null; }
}
