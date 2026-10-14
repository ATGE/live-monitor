// Pure helpers for the «Claude login about to expire» chips and their dialog.
// No React, no JSX, no logging: the login URL and code pass through the dialog
// and must never be written anywhere.

import { fill, plural, strings } from './i18n/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A login is warned about when it expires in this much time or less. */
export const LOGIN_WARN_MS = 5 * DAY;

/** Window event the chips listen to: «open the renew dialog for this machine». */
export const LOGIN_RENEW_EVENT = 'login-renew';

/**
 * The warning for one machine's entry of the login state
 * (`{ state, expiresAt }`), or null when nothing should be shown.
 * The timestamp wins over the label, so a chip appears (or not) the moment the
 * limit is crossed without waiting for the server's next daily read. `unknown`
 * never warns: an unreachable machine is not an expired one.
 */
export function loginWarning(entry, now = Date.now()) {
  if (!entry || entry.state === 'unknown') return null;
  const w = strings().shared.login;
  if (entry.state === 'expired') return { tone: 'expired', label: w.expired, msLeft: 0 };
  const at = Number(entry.expiresAt);
  if (Number.isFinite(at) && at > 0) {
    const left = at - now;
    if (left <= 0) return { tone: 'expired', label: w.expired, msLeft: 0 };
    if (left > LOGIN_WARN_MS) return null;
    return { tone: 'expiring', label: fill(w.expiresIn, { span: spanLabel(left) }), msLeft: left };
  }
  if (entry.state === 'expiring') return { tone: 'expiring', label: w.aboutToExpire, msLeft: null };
  return null;
}

function spanLabel(ms) {
  const days = Math.floor(ms / DAY);
  const w = strings().shared.login;
  if (days >= 1) return plural(days, w.spanDays);
  return plural(Math.max(1, Math.ceil(ms / HOUR)), w.spanHours);
}

/** Every machine with a warning, laptop included, sorted by name. */
export function loginChips(state, now = Date.now()) {
  return Object.entries(state ?? {})
    .map(([machine, entry]) => {
      const warning = loginWarning(entry, now);
      return warning && { machine, ...warning, expiresAt: entry.expiresAt ?? null };
    })
    .filter(Boolean)
    .sort((a, b) => a.machine.localeCompare(b.machine));
}

/**
 * The per-machine map out of whatever carries it: the bare map, the broadcast
 * `{ type: 'login', state }` or a `{ login }` body.
 */
export function readLogin(body) {
  if (!body || typeof body !== 'object') return {};
  const inner = body.login ?? body.state;
  if (inner && typeof inner === 'object' && typeof inner.state !== 'string') return inner;
  if (body.type === 'login' || 'login' in body) return {};
  return body;
}

/** A renew job in a state that will not change any more. */
export const jobFinished = (job) => ['done', 'failed', 'cancelled'].includes(job?.state);

/** The login URL as a link target, only if it is an https URL. */
export function safeLoginUrl(url) {
  return typeof url === 'string' && /^https:\/\/\S+$/.test(url) ? url : null;
}

/** Ask the chips to open the renew dialog for a machine (used by the cards). */
export function requestLoginRenew(machine) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(LOGIN_RENEW_EVENT, { detail: machine }));
}
