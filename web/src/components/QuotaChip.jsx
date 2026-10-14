import React, { useEffect, useState } from 'react';
import { approx } from './BackgroundStrip.jsx';
import { hhmm, fullStamp, parseTs } from '../time.js';
import { strings, fill, plural } from '../i18n/index.js';

/**
 * The Claude account's usage window, as the header says it.
 *
 * The quota belongs to the account, not to a task: when it runs out the board
 * parks everything that needs Claude and starts it again by itself when the
 * window reopens. So this chip — like the parked cards — has **nothing to
 * click**. On this board every amber thing means «click me», which is exactly
 * why every label and every tooltip here writes the opposite out in full.
 *
 * `quotaChip` mirrors `upgradeChip` in `UpgradeDialog.jsx` — a plain
 * descriptor, so the tone table can be read (and tested) without a DOM.
 */

/** Under this much left, the board counts by seconds instead of by minutes. */
export const FAST_MS = 120_000;
const SLOW_TICK_MS = 30_000;
const FAST_TICK_MS = 1_000;

/** «~2 h 14 min» far out, «1 min 45 s» close in: the last two minutes move. */
function duration(ms) {
  if (ms > FAST_MS) return approx(ms);
  const s = Math.max(1, Math.ceil(ms / 1000));
  // i18n-ok: min and s are unit symbols
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}

/**
 * How long until the window reopens, and — always — at what hour. A board is
 * left open on a desk for hours: a bare «2 h 14 min» read at an unknown time
 * says nothing, so `text` never comes without the clock beside it.
 *
 * `null` when there is no readable instant: the caller then says that the
 * board waits, without inventing an hour. An instant already past is not an
 * error — the server releases the hold, not the browser — and reads as
 * «de un momento a otro».
 */
export function countdown(until, now = Date.now()) {
  const d = parseTs(until);
  if (!d) return null;
  const ms = d.getTime() - now;
  const at = hhmm(d);
  const left = ms > 0 ? duration(ms) : strings().kpi.chip.anyMoment;
  return { ms, at, left, text: `${left} · ${at}`, stamp: fullStamp(d), soon: ms > 0 && ms <= FAST_MS };
}

/**
 * The board's one and only countdown clock. Twenty parked cards must not mean
 * twenty timers, so this lives once in `App` and the value is passed down.
 *
 * Exactly one interval is alive at a time — 30 s normally, 1 s in the last
 * two minutes (the period is part of the effect's identity, so changing it
 * replaces the interval instead of adding one) — and **none at all** when
 * there is no instant to count to: a board with no hold keeps the timers it
 * has today, no more.
 */
export function useQuotaClock(until) {
  const [now, setNow] = useState(() => Date.now());
  const target = parseTs(until)?.getTime() ?? null;
  const live = target != null;
  const remaining = live ? target - now : null;
  const period = remaining != null && remaining > 0 && remaining <= FAST_MS ? FAST_TICK_MS : SLOW_TICK_MS;
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(id);
  }, [live, period]);
  return now;
}

/**
 * A utilisation given either as a fraction or as a percentage, as a percentage.
 * `null` when there is no number: the SDK leaves `utilization` out often
 * enough, and `Number(null)` is a perfectly finite `0` — a wrong figure reads
 * far worse than an absent one.
 */
function pct(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n <= 1 ? n * 100 : n);
}

/**
 * The header chip for a quota hold, or null when there is nothing to say.
 * In priority order: a window that keeps not reopening, the release in
 * progress, the hold itself, and — with no hold at all — a warning that the
 * account is close to its limit.
 *
 * The text is read at call time, so it follows the language now in use. Every
 * sentence is a whole catalog entry and the pieces are joined here.
 */
export function quotaChip(quota, now = Date.now()) {
  if (!quota) return null;
  const t = strings().kpi.chip;
  const state = quota.state ?? null;
  const holding = state === 'held' || state === 'draining';
  const left = countdown(quota.until, now);
  const parked = Number(quota.parked) || 0;
  const parkedText = parked > 0 ? fill(t.parkedShort, { n: parked }) : null;

  // `allowed_warning` with no hold: the account is close, nothing is parked.
  // Quiet on purpose — it is news, not a problem.
  if (!holding) {
    const warning = quota.warning ?? null;
    if (!warning) return null;
    const used = pct(warning.utilization);
    const resets = hhmm(warning.resetsAt);
    const vars = { percent: used, at: resets };
    const sentence = used != null
      ? (resets ? t.warnUsedReopens : t.warnUsed)
      : (resets ? t.warnNearReopens : t.warnNear);
    return {
      tone: 'quiet',
      spin: false,
      icon: 'hourglass',
      label: used != null ? fill(t.warnLabelUsed, vars) : t.warnLabelNear,
      title: [fill(sentence, vars), t.nothingParkedYet, t.nothing].join(' '),
    };
  }

  const attempt = Number(quota.attempt) || 0;
  const joinDot = (parts) => parts.filter(Boolean).join(' · ');
  const sure = quota.certainty === 'blind' ? t.estimate : null;
  const parkedPhrase = parked > 0 ? plural(parked, t.parkedPhrase) : t.parkedNone;

  // The window has failed to reopen again and again: still nothing to do, but
  // it should stop looking like routine waiting.
  if (attempt > 3) {
    return {
      tone: 'error',
      spin: false,
      icon: 'alert-triangle',
      label: joinDot([fill(t.stuckLabel, { attempt }), left?.text]),
      title: [
        fill(left ? t.stuckTitleNext : t.stuckTitle, { attempt, at: left?.at }),
        parkedPhrase, t.keepsWaiting, sure, t.nothing,
      ].filter(Boolean).join(' '),
    };
  }

  // Draining: the window reopened and the board is letting the parked work
  // through one at a time. This one really is moving, so it spins.
  if (state === 'draining') {
    return {
      tone: 'busy',
      spin: true,
      label: joinDot([t.drainLabel, parkedText]),
      title: [t.drainTitle, parked > 0 ? fill(t.drainLeft, { n: parked }) : null, t.nothing]
        .filter(Boolean).join(' '),
    };
  }

  return {
    tone: 'warn',
    spin: false,
    icon: 'hourglass',
    label: joinDot([t.exhaustedLabel, left?.text, parkedText]),
    title: [
      left ? fill(t.exhaustedReopens, { at: left.at, stamp: left.stamp }) : t.exhaustedUnknown,
      parkedPhrase, sure, t.nothing,
    ].filter(Boolean).join(' '),
  };
}
