/**
 * How much of the account's plan is spent: the numbers behind the quota meter.
 *
 * `quota.js` only learns about the limit when a session trips over it (or is
 * warned); between those moments the board had nothing to show. This module
 * asks the CLI directly, every few minutes, through the SDK's experimental
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` control request —
 * the same numbers `/usage` prints.
 *
 * Why a probe costs nothing: the session is opened with a streaming prompt that
 * never yields a message, so no turn is ever sent to the model. The control
 * request is answered by the CLI itself. Verified 2026-09-21: two probes in a
 * row gave `total_cost_usd: 0`, an empty `model_usage`, and the same
 * percentages before and after (about 4 s of CLI process each).
 *
 * Why `settingSources: []`: the probe needs no settings at all, and loading
 * them would run the user's hooks (SessionStart and friends) and read
 * `CLAUDE.local.md` with its `@` imports — work, and possibly side effects, for
 * a session that exists only to answer one question. `persistSession: false`
 * keeps it from leaving a `.jsonl` transcript behind every five minutes.
 *
 * Why `query()` directly and never `runClaude`/`dispatch`: every message those
 * route goes through `quotaFrom`, and a message that looks alive there calls
 * `noteQuotaAlive()` — which releases a `draining` hold. A probe must never be
 * the thing that tells the board the window reopened.
 *
 * Why not `store.js` / `upgrade.js` / `pipeline.js`: `claude.js` imports this
 * file, and `claude.js` is imported by nearly everything; loading `store.js`
 * from here would rewrite the live `tasks.json` from any command line that
 * touches `claude.js`, and `upgrade.js`/`pipeline.js` would close import
 * circles. The pause during an upgrade arrives through `usageHooks.paused`,
 * which `index.js` points at `upgradeHoldsNewWork`. For the same reason this
 * module has no side effects on import: no timers until `startUsageProbe()`.
 *
 * When the probe fails (or the SDK lost the method), the `rate_limit_event`s
 * that real sessions receive are the fallback: `quotaFrom` hands each one to
 * `noteUsageEvent`, and those rows show — marked `source: 'events'` — only while
 * the probe cannot give a fresh answer. They never overwrite a fresh probe.
 */

import { EventEmitter } from 'node:events';
import express from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ROOT } from './config.js';

/** A healthy probe's cadence. */
export const PROBE_INTERVAL_MS = 5 * 60_000;
/** Failures double the interval up to this. */
export const PROBE_MAX_INTERVAL_MS = 30 * 60_000;
/** One probe never takes longer than this. */
export const PROBE_TIMEOUT_MS = 30_000;
/** On-demand refreshes closer together than this return the current state. */
export const REFRESH_THROTTLE_MS = 60_000;
/** A probe answer older than this is stale (two missed probes and change). */
export const STALE_AFTER_MS = 2 * PROBE_INTERVAL_MS + 60_000;

/**
 * Seams. `paused` is set by `index.js` (upgrade holding new work); `query`,
 * `now` and `timeoutMs` exist so tests never open a real session nor wait.
 */
export const usageHooks = {
  paused: () => false,
  query,
  now: () => Date.now(),
  timeoutMs: PROBE_TIMEOUT_MS,
};

/** Emits `'state'` with the new `usageState()` whenever it changes. */
export const usageEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Normalization (pure)

const WINDOW_LABELS = { session: 'Sesión (5 h)', weekly_all: 'Semanal' };
const labelFor = (kind, name) => (kind === 'weekly_scoped'
  ? `Semanal · ${name ?? 'modelo'}`
  : WINDOW_LABELS[kind] ?? kind);
const groupFor = (kind) => (kind === 'session' ? 'session' : 'weekly');

const toMs = (iso) => {
  if (iso === null || iso === undefined || iso === '') return null;
  if (typeof iso === 'number') return Number.isFinite(iso) ? iso : null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};
const toPercent = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : null);
const SEVERITIES = ['normal', 'warning', 'critical'];
const toSeverity = (s) => (SEVERITIES.includes(s) ? s : null);
// `seven_day_opus` → «Opus».
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** If no row says it is the binding one, the fullest one is. */
function markActive(rows) {
  if (!rows.length || rows.some((r) => r.active)) return rows;
  let top = rows[0];
  for (const r of rows) if ((r.percent ?? -1) > (top.percent ?? -1)) top = r;
  top.active = true;
  return rows;
}

function rowsFromLimits(limits) {
  const rows = [];
  for (const l of limits) {
    if (!l || typeof l !== 'object') continue;
    const percent = toPercent(l.percent);
    if (percent === null) continue;
    const kind = typeof l.kind === 'string' ? l.kind : 'unknown';
    rows.push({
      kind,
      group: typeof l.group === 'string' ? l.group : groupFor(kind),
      label: labelFor(kind, l.scope?.model?.display_name ?? null),
      percent,
      resetsAt: toMs(l.resets_at),
      severity: toSeverity(l.severity),
      active: l.is_active === true,
    });
  }
  return rows;
}

// The windows the SDK's types declare: one key per window, no severity.
function rowsFromKeys(rl) {
  const rows = [];
  const push = (kind, win, name = null) => {
    const percent = toPercent(win?.utilization);
    if (percent === null) return;
    rows.push({
      kind, group: groupFor(kind), label: labelFor(kind, name),
      percent, resetsAt: toMs(win.resets_at), severity: null, active: false,
    });
  };
  push('session', rl.five_hour);
  push('weekly_all', rl.seven_day);
  const scopedNames = new Set();
  if (Array.isArray(rl.model_scoped)) {
    for (const m of rl.model_scoped) {
      if (!m) continue;
      push('weekly_scoped', m, m.display_name ?? null);
      if (m.display_name) scopedNames.add(String(m.display_name).toLowerCase());
    }
  }
  for (const [key, win] of Object.entries(rl)) {
    const m = /^seven_day_(.+)$/.exec(key);
    // OAuth apps is not a model; a model already listed in `model_scoped` is not twice.
    if (!m || m[1] === 'oauth_apps' || scopedNames.has(m[1].toLowerCase())) continue;
    push('weekly_scoped', win, capitalize(m[1]));
  }
  return rows;
}

/**
 * The CLI's usage answer → the rows the web draws. Accepts both shapes the
 * response carries: `limits[]` (with `severity`/`is_active`, not in the SDK's
 * types) when present, else the keyed windows the types declare.
 */
export function normalizeUsage(raw) {
  const rl = raw?.rate_limits ?? null;
  let rows = [];
  if (rl && Array.isArray(rl.limits) && rl.limits.length) rows = rowsFromLimits(rl.limits);
  else if (rl && typeof rl === 'object') rows = rowsFromKeys(rl);
  const x = rl?.extra_usage ?? raw?.extra_usage ?? null;
  const extra = x && typeof x === 'object'
    ? {
      enabled: x.is_enabled === true,
      usedCredits: x.used_credits ?? null,
      monthlyLimit: x.monthly_limit ?? null,
      utilization: x.utilization ?? null,
      currency: x.currency ?? null,
    }
    : null;
  return {
    subscription: raw?.subscription_type ?? null,
    available: raw?.rate_limits_available !== false && rl !== null,
    rows: markActive(rows),
    extra,
  };
}

// `rate_limit_event.rateLimitType` → a row kind.
function eventKind(type) {
  if (type === 'five_hour') return { kind: 'session', name: null };
  if (type === 'seven_day') return { kind: 'weekly_all', name: null };
  const m = /^seven_day_(.+)$/.exec(type ?? '');
  if (m && m[1] !== 'oauth_apps') return { kind: 'weekly_scoped', name: capitalize(m[1]) };
  return null;
}

// ---------------------------------------------------------------------------
// State

const fresh = () => ({
  probe: null, // { at /*ms*/, subscription, rows, extra, error }
  lastAttemptAt: 0,
  lastError: null,
  failures: 0,
  methodMissing: false,
  events: new Map(), // label → { row, at }
  inFlight: null,
  timer: null,
  started: false,
  published: null,
});
let s = fresh();

const PROBE_ERRORS = {
  missing: 'El SDK instalado no tiene el método de uso; se muestran los avisos de las sesiones',
  unavailable: 'La cuenta no expone límites de plan (clave de API o proveedor externo)',
};

/**
 * What the meter shows, or null when nothing is known yet. Computed on read so
 * `stale` ages without a timer.
 */
export function usageState() {
  const now = usageHooks.now();
  const probe = s.probe;
  const probeFresh = probe && !s.lastError && !s.methodMissing && now - probe.at <= STALE_AFTER_MS;
  const useEvents = !probeFresh && s.events.size > 0;
  if (!probe && !useEvents) {
    if (!s.lastError) return null;
    return {
      at: new Date(s.lastAttemptAt || now).toISOString(), source: 'usage', stale: true,
      error: s.lastError, subscription: null, rows: [], extra: null,
    };
  }
  let rows = probe ? probe.rows.map((r) => ({ ...r })) : [];
  let at = probe?.at ?? 0;
  if (useEvents) {
    // Newer event rows replace the probe's row of the same window.
    for (const { row, at: evAt } of s.events.values()) {
      if (probe && evAt <= probe.at) continue;
      const i = rows.findIndex((r) => r.label === row.label);
      if (i >= 0) rows[i] = { ...row, active: false };
      else rows.push({ ...row, active: false });
      at = Math.max(at, evAt);
    }
    rows.forEach((r) => { r.active = false; });
    rows = markActive(rows);
  }
  return {
    at: new Date(at || now).toISOString(),
    source: useEvents ? 'events' : 'usage',
    stale: !probeFresh,
    error: s.lastError ?? probe?.error ?? null,
    subscription: probe?.subscription ?? null,
    rows,
    extra: probe?.extra ?? null,
  };
}

function publish() {
  const next = usageState();
  const key = JSON.stringify(next);
  if (key === s.published) return;
  s.published = key;
  usageEvents.emit('state', next);
}

/**
 * One `rate_limit_event` a real session received (from `quotaFrom`). Kept per
 * window; shown only while the probe cannot answer. Never throws: it runs
 * inside every session's message loop.
 */
export function noteUsageEvent(info) {
  try {
    const ek = eventKind(info?.rateLimitType);
    if (!ek) return;
    let u = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : null;
    // The event may say 0.93 or 93. A genuine 1% reads as 100% here — the SDK
    // event carries no separate "this is already a percent" flag, so a fraction
    // that happens to equal 0.01-as-1 is indistinguishable from a full window.
    // Accepted ambiguity: real 1% utilization is rare enough, and the meter
    // erring toward "full" rather than silently showing 1% for a real 100% is
    // the safer direction.
    if (u !== null && u <= 1) u *= 100;
    if (u === null && info.status === 'rejected') u = 100;
    if (u === null) return;
    const severity = info.status === 'rejected' ? 'critical' : info.status === 'warning' ? 'warning' : null;
    const row = {
      kind: ek.kind, group: groupFor(ek.kind), label: labelFor(ek.kind, ek.name),
      percent: toPercent(u), resetsAt: toMs(info.resetsAt), severity, active: false,
    };
    s.events.set(row.label, { row, at: usageHooks.now() });
    publish();
  } catch { /* the meter is never worth breaking a session for */ }
}

// ---------------------------------------------------------------------------
// The probe

// A streaming prompt that never yields: the session opens, answers control
// requests, and never sends a turn. `release()` ends it so the CLI exits.
function idlePrompt() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  async function* never() { await gate; }
  return { prompt: never(), release };
}

function probeOptions() {
  const env = { ...process.env };
  // The plan's login is the only credential this reads: an API key would
  // answer «no plan limits» (and bill nothing, but show nothing either).
  delete env.ANTHROPIC_API_KEY;
  return { cwd: ROOT, settingSources: [], persistSession: false, settings: { fastMode: true }, env };
}

const METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

async function probeOnce() {
  const { prompt, release } = idlePrompt();
  let q = null;
  let timer = null;
  try {
    q = usageHooks.query({ prompt, options: probeOptions() });
    if (typeof q?.[METHOD] !== 'function') return { missing: true };
    const ask = Promise.resolve(q[METHOD]({ skipBehaviors: true }));
    ask.catch(() => {}); // after a timeout nobody awaits it any more
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No response from the CLI in ${Math.round(usageHooks.timeoutMs / 1000)} s`)), usageHooks.timeoutMs);
    });
    return { raw: await Promise.race([ask, timeout]), caps: await readCaps(q) };
  } finally {
    clearTimeout(timer);
    release();
    try { await q?.close?.(); } catch { /* already gone */ }
  }
}

async function runProbe() {
  s.lastAttemptAt = usageHooks.now();
  try {
    const result = await probeOnce();
    if (result.missing) {
      s.methodMissing = true;
      s.lastError = PROBE_ERRORS.missing;
      s.failures += 1;
    } else {
      const n = normalizeUsage(result.raw);
      s.methodMissing = false;
      s.lastError = null;
      s.failures = 0;
      s.probe = {
        at: usageHooks.now(), subscription: n.subscription, rows: n.rows, extra: n.extra,
        error: n.available ? null : PROBE_ERRORS.unavailable,
      };
    }
  } catch (e) {
    s.lastError = e?.message || String(e);
    s.failures += 1;
  }
  publish();
  return usageState();
}

/** The delay before the next scheduled probe: doubled per failure, capped. */
export function nextProbeDelay(failures = s.failures) {
  if (!failures) return PROBE_INTERVAL_MS;
  return Math.min(PROBE_MAX_INTERVAL_MS, PROBE_INTERVAL_MS * 2 ** failures);
}

/**
 * Probe now, one at a time. Without `force`, a call within 60 s of the last
 * attempt returns the current state; a probe already running is joined, never
 * doubled. While `usageHooks.paused()` nothing runs.
 */
export async function refreshUsage({ force = false } = {}) {
  if (s.inFlight) return s.inFlight;
  if (usageHooks.paused()) return usageState();
  if (!force && s.lastAttemptAt && usageHooks.now() - s.lastAttemptAt < REFRESH_THROTTLE_MS) return usageState();
  s.inFlight = runProbe().finally(() => { s.inFlight = null; });
  return s.inFlight;
}

function schedule(delay) {
  clearTimeout(s.timer);
  s.timer = setTimeout(async () => {
    try { await refreshUsage({ force: true }); } catch { /* runProbe never throws */ }
    if (s.started) schedule(nextProbeDelay());
  }, delay);
  s.timer.unref?.();
}

/** Starts the periodic probe (idempotent): once shortly after boot, then every 5 min. */
export function startUsageProbe({ firstDelayMs = 5_000 } = {}) {
  if (s.started) return;
  s.started = true;
  schedule(firstDelayMs);
}

/** Stops the periodic probe. */
export function stopUsageProbe() {
  s.started = false;
  clearTimeout(s.timer);
  s.timer = null;
}

/** `POST /api/usage/refresh` → `{ usage }`. Throttled; never an error for a failed probe. */
export function usageRouter() {
  const router = express.Router();
  router.post('/api/usage/refresh', async (_req, res) => {
    try {
      res.json({ usage: await refreshUsage() });
    } catch (e) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
  return router;
}

/** Forgets everything (tests). */
export function resetUsageForTests() {
  stopUsageProbe();
  s = fresh();
}

// ---------------------------------------------------------------------------
// Capability read (rides the same idle session as the usage probe; it sits
// down here so no line above shifts, ADR-0051 cites them)
import { recordCapabilities } from './capabilities.js';

/**
 * Reads the model catalog and the init result (fast mode) from the probe's
 * open session and records them. Own timeout and try/catch: a failure here
 * never fails the usage reading. Returns at once when the query lacks the
 * methods (older CLI, test fakes).
 */
async function readCaps(q) {
  if (typeof q?.supportedModels !== 'function' || typeof q?.initializationResult !== 'function') return null;
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('capabilities timeout')), usageHooks.timeoutMs);
    });
    const ask = Promise.all([q.supportedModels(), q.initializationResult()]);
    ask.catch(() => {}); // after a timeout nobody awaits it any more
    const [models, init] = await Promise.race([ask, timeout]);
    recordCapabilities({ models: Array.isArray(models) ? models : [], init: init ?? {}, at: usageHooks.now() });
    return true;
  } catch {
    return null; // the usage reading stands without it
  } finally {
    clearTimeout(timer);
  }
}
