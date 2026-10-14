import React, { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { countdown, quotaChip } from './QuotaChip.jsx';
import { ago } from '../time.js';
import { strings, fill, plural } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';
import './quotaMeter.css';

/** Below this width the popover switches to a fixed sheet under the header
 * instead of an absolutely-positioned box under the button — see the CSS
 * media query in `quotaMeter.css`. Kept in sync with it by hand. */
const MOBILE_BREAKPOINT = '(max-width: 780px)';

/**
 * The account's usage window, made hard to miss.
 *
 * `QuotaChip` is a `<span>` on purpose — there is nothing to click, the board
 * resumes on its own. This one is a `<button>` for a different reason: it
 * still does *nothing* to the quota (no click here starts, stops or spends
 * anything), but it now opens a detail panel, and a panel needs something to
 * open it. The distinction matters enough that it is worth restating: this
 * button acts on the *view*, never on the account.
 *
 * `quotaMeter` is the pure descriptor (mirrors `quotaChip`/`upgradeChip`): it
 * turns `usage` (package C's probe, `server/src/usage.js`) and `quota` (the
 * existing hold object) into what the button and the popover show, without
 * touching the DOM — so the tone table can be read, and eventually tested,
 * on its own.
 */

/** A utilisation given either as a fraction or a percentage, rounded to a whole percentage. */
function pct(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n <= 1 ? n * 100 : n);
}

/**
 * A usage row's colour: the server's own `severity` wins when it sent one
 * (that is Anthropic's own read of the window, not a guess from a bare
 * percentage); with no severity, Edson's thresholds from the plan apply.
 */
function rowTone(row) {
  if (row.severity === 'normal') return 'ok';
  if (row.severity === 'warning') return 'warn';
  if (row.severity === 'critical') return 'error';
  const p = row.percent;
  if (p === null || p === undefined) return 'idle';
  if (p > 85) return 'error';
  if (p >= 60) return 'warn';
  return 'ok';
}

/** The group's heading, read at call time so it follows the language. */
const groupLabel = (key) => strings().kpi.meter[key] ?? key;

/**
 * The header block for the quota, or the closest thing to "no news" it has:
 * always something to show, since — unlike `quotaChip` — this one is always
 * on screen.
 *
 * Priority, same idea as `quotaChip`: an active hold first (it overrides
 * everything, `quotaChip`'s own text and tone included — see the note below),
 * then the live usage probe, then the old `allowed_warning` fallback for the
 * gap before the first probe lands, then "no data yet".
 *
 * `percent` is the **weekly** window, not the active one: a five-hour window
 * refills by itself over lunch, the week does not, so the number the collapsed
 * button shows is the one that can actually end Edson's day. The session keeps
 * its own field (and, in the button, its own dot) instead of taking the bar.
 */
export function quotaMeter(usage, quota, now = Date.now()) {
  const t = strings().kpi.meter;
  const rows = (usage?.rows ?? []).map((r) => ({ ...r, tone: rowTone(r), countdown: countdown(r.resetsAt, now) }));
  const activeRow = rows.find((r) => r.active) ?? rows[0] ?? null;
  // The account-wide weekly window is what `weekly_all` means; a plan with only
  // scoped weekly rows (Opus, say) still deserves a bar, so the first weekly
  // row stands in rather than leaving the button blank.
  const weekly = rows.find((r) => r.kind === 'weekly_all') ?? rows.find((r) => r.group === 'weekly') ?? null;
  const session = rows.find((r) => r.group === 'session') ?? null;
  // Whatever the bar actually draws. Normally the week; but a partial probe
  // (the event-fed source can know the session and nothing else) would leave
  // the button as a bare dot in a 92px box, so the active row stands in rather
  // than showing nothing at all.
  const barRow = weekly ?? activeRow;
  const holding = quota && (quota.state === 'held' || quota.state === 'draining');
  const chip = holding ? quotaChip(quota, now) : null;

  let tone = 'idle';
  // No label at all when there is something to show: the button is a dot, a
  // bar and a number, and the word "Cuota" beside them said nothing the bar
  // didn't. Only the exceptions (a hold, no data) get words.
  let headline = null;
  let headlineIcon = null;
  let sub = null;
  let percent = barRow?.percent ?? null;
  let hold = null;

  if (chip) {
    // `quotaChip` calls a plain held window "warn" — right for a lone chip,
    // too quiet for a meter that owns its own space. Draining is real
    // progress, so it keeps "busy"; every other held state reads "error".
    tone = chip.tone === 'busy' ? 'busy' : 'error';
    headline = chip.label;
    headlineIcon = chip.icon ?? null;
    percent = barRow?.percent ?? 100;
    hold = {
      state: quota.state,
      certainty: quota.certainty ?? null,
      attempt: Number(quota.attempt) || 0,
      parked: Number(quota.parked) || 0,
      title: chip.title,
    };
  } else if (activeRow) {
    // The tone belongs to the row the bar draws, not to the active one: the
    // fill takes `currentColor` from the root, so reading the session's tone
    // here would paint a 30% weekly bar red because the 5h window is at 90%.
    // The session's own alarm is the dot, which carries its own tone.
    tone = barRow.tone;
    // Same order as the row-level countdown below: the reopening hour first,
    // the time left second — `reabre 14:30 · 2 h 14 min`, not the reverse.
    sub = activeRow.countdown ? fill(t.reopensIn, activeRow.countdown) : null;
  } else if (usage === null && quota?.warning) {
    // No probe yet, but the old rate-limit-event warning already knows the
    // account is close: better than nothing while `usage.js` catches up. There
    // are no `rows` here, so `weekly`/`session` are null and the button shows a
    // bare bar — no session dot to colour, and nothing to claim it is weekly.
    const p = pct(quota.warning.utilization);
    tone = p === null ? 'idle' : p > 85 ? 'error' : p >= 60 ? 'warn' : 'ok';
    percent = p;
    const cd = countdown(quota.warning.resetsAt, now);
    sub = cd ? fill(t.reopensIn, cd) : null;
  } else {
    headline = t.noData;
  }

  const extra = usage?.extra?.enabled ? { ...usage.extra, percent: pct(usage.extra.utilization) } : null;

  let footer = null;
  if (usage) {
    const source = usage.source === 'events' ? t.sourceEvents : '/usage';
    footer = [
      fill(t.updated, { ago: ago(usage.at) }),
      fill(t.source, { source }),
      usage.source === 'events' || usage.stale ? t.partial : null,
      usage.error || null,
    ].filter(Boolean).join(' · ');
  }

  // What the bar is *of*, in words — the button's accessible name is built from
  // it, and "Cuota" is the honest answer when no row backs the number.
  const barLabel = barRow?.label ?? t.quota;

  return { tone, percent, headline, headlineIcon, sub, rows, weekly, session, barLabel, hold, extra, footer };
}

/** Rows folded under their `group`, in the order they first appear. */
function groupRows(rows) {
  const groups = [];
  const byKey = new Map();
  for (const row of rows) {
    const key = row.group ?? '?';
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: groupLabel(key), rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(row);
  }
  return groups;
}

// A `<span>`, not a `<div>`: this renders inside `<button>` too (the main
// bar), and `<button>` only accepts phrasing content — CSS below gives it
// `display: block` so it still lays out like the bar it is.
function Bar({ percent, className = '', label }) {
  if (percent === null || percent === undefined) return null;
  const style = { '--pct': Math.max(0, Math.min(100, percent)) };
  return (
    <span className={`quota-meter-bar ${className}`} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <span className="quota-meter-bar-fill" style={style} />
    </span>
  );
}

function Row({ row }) {
  const t = useStrings();
  return (
    <div className={`quota-meter-row quota-meter-row-${row.tone}`} data-tone={row.tone}>
      <div className="quota-meter-row-head">
        <span className="quota-meter-row-label">{row.label}</span>
        {row.percent !== null && row.percent !== undefined && <span className="quota-meter-row-pct">{row.percent}%</span>}
      </div>
      <Bar percent={row.percent} label={row.label} />
      {row.countdown && (
        <span className="quota-meter-row-countdown" title={row.countdown.stamp}>{fill(t.kpi.meter.reopensIn, row.countdown)}</span>
      )}
    </div>
  );
}

/** Grace for the cursor to cross the gap from the button into the popover. */
const HOVER_GRACE_MS = 120;

export default function QuotaMeter({ usage = null, quota = null, now = null, onRefresh }) {
  const t = useStrings();
  const tm = t.kpi.meter;
  const [open, setOpen] = useState(false);
  // A pinned popover ignores `mouseleave`: hovering is for a glance, clicking
  // says "I want to read this", and reading the popover means moving the
  // cursor away to whatever the numbers are about.
  const [pinned, setPinned] = useState(false);
  // Measured only for the mobile, fixed-position popover (see `MOBILE_BREAKPOINT`
  // below and the media query in quotaMeter.css); null lets the CSS's own
  // `top: 56px` act as a fallback when there is nothing to measure yet (a
  // headless test DOM, matchMedia missing, or a desktop viewport that never
  // sets it at all).
  const [popTop, setPopTop] = useState(null);
  const rootRef = useRef(null);
  const btnRef = useRef(null);
  const leaveTimer = useRef(null);
  const popId = useId();
  const at = now ?? Date.now();
  const m = quotaMeter(usage, quota, at);

  const refresh = () => { try { onRefresh?.(); } catch (e) { console.warn(e); } };

  // Exactly one probe per opening — a click on an already-hovered popover must
  // not fire a second one. Rate is the server's problem anyway: `usage.js`
  // throttles the probe at 60 s, so a cursor crossing the header costs nothing.
  const openPop = () => {
    clearTimeout(leaveTimer.current);
    if (open) return;
    refresh();
    const mobile = typeof window !== 'undefined' && window.matchMedia?.(MOBILE_BREAKPOINT).matches;
    const bottom = mobile ? btnRef.current?.getBoundingClientRect().bottom : null;
    setPopTop(Number.isFinite(bottom) ? bottom + 6 : null);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(leaveTimer.current);
    if (pinned) return;
    leaveTimer.current = setTimeout(() => setOpen(false), HOVER_GRACE_MS);
  };
  const close = () => { clearTimeout(leaveTimer.current); setPinned(false); setOpen(false); };

  // Pointer events, and only a real mouse. A touch also raises enter/leave, and
  // opening the popover from one mutates the DOM under the finger: Safari iOS
  // then drops the `click` of that very tap, so the first tap would open
  // without pinning and closing would take three. Bailing out before any state
  // changes leaves the tap untouched — on a touchscreen the click below is the
  // whole interaction, which is also what the mobile popover layout assumes.
  const onEnter = (e) => { if (e.pointerType === 'mouse') openPop(); };
  const onLeave = (e) => { if (e.pointerType === 'mouse') hide(); };

  // The click pins, and un-pins what it pinned. One tap opens and pins, the
  // next closes.
  const toggle = () => {
    if (open && pinned) { close(); return; }
    openPop();
    setPinned(true);
  };

  // Outside click and Escape close it — the popover is not a modal, it just
  // shouldn't linger once the reader has looked elsewhere. Escape also gives
  // focus back to the button that opened it, so keyboard users don't lose
  // their place once the popover is gone.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) close(); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      close();
      btnRef.current?.focus();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, pinned]);

  // A pending grace timer outlives the component otherwise, and fires `setOpen`
  // on something that is no longer mounted.
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  const groups = groupRows(m.rows);
  const title = m.hold?.title ?? m.footer ?? undefined;
  const asPct = (p) => (p === null || p === undefined ? tm.noValue : `${p}%`);
  // The dot is the session *beside* the week. When there is no weekly row the
  // bar already is the session (see `barRow`), and a dot repeating it would
  // read as two different windows at the same number.
  const sessionText = m.session && m.weekly ? `${m.session.label}: ${asPct(m.session.percent)}` : null;
  // The bar's own `aria-label` never reaches the button's accessible name — a
  // screen reader would read the raw numbers and never say what they are of —
  // so the button spells the whole reading out itself.
  const btnLabel = [
    m.headline,
    m.percent === null ? null : `${m.barLabel} ${m.percent}%`,
    sessionText,
  ].filter(Boolean).join(', ') || tm.quota;

  return (
    <span
      className={`quota-meter quota-meter-${m.tone} ${open ? 'is-open' : ''}`}
      data-tone={m.tone}
      ref={rootRef}
      // On the root, not on the button: the popover is inside it, so the
      // cursor can walk from one to the other without ever leaving.
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <button type="button" className="quota-meter-btn" aria-expanded={open} aria-controls={popId} aria-label={btnLabel} title={title} onClick={toggle} ref={btnRef}>
        {sessionText && (
          <span className="quota-meter-dot" data-tone={m.session.tone} role="img" title={sessionText} aria-label={sessionText} />
        )}
        {m.headline && <span className="quota-meter-label">{m.headlineIcon && <><Icon name={m.headlineIcon} />{' '}</>}{m.headline}</span>}
        <Bar percent={m.percent} className="quota-meter-bar-main" label={m.barLabel} />
        {m.percent !== null && <span className="quota-meter-pct">{m.percent}%</span>}
      </button>
      {open && (
        <div className="quota-meter-pop" id={popId} role="region" aria-label={tm.popover}
          style={popTop != null ? { top: popTop } : undefined}>
          {m.hold && (
            <div className="quota-meter-hold">
              <p className="quota-meter-hold-title">{m.hold.title}</p>
              <ul className="quota-meter-hold-facts">
                {m.hold.attempt > 0 && <li>{fill(tm.attempt, { n: m.hold.attempt })}</li>}
                <li>{plural(m.hold.parked, tm.parked)}</li>
                {m.hold.certainty === 'blind' && <li>{tm.estimated}</li>}
              </ul>
            </div>
          )}
          {groups.length > 0 ? groups.map((g) => (
            <div className="quota-meter-group" key={g.key}>
              <h4 className="quota-meter-group-title">{g.label}</h4>
              {g.rows.map((r) => <Row key={r.label} row={r} />)}
            </div>
          )) : (
            !m.hold && <p className="quota-meter-empty">{tm.empty}</p>
          )}
          {m.extra && (
            <div className="quota-meter-extra">
              <span className="quota-meter-extra-label">{tm.extra}</span>
              <span className="quota-meter-extra-value">
                {m.extra.usedCredits ?? '—'} / {m.extra.monthlyLimit ?? '—'} {m.extra.currency ?? ''}
                {m.extra.percent !== null && m.extra.percent !== undefined ? ` · ${m.extra.percent}%` : ''}
              </span>
            </div>
          )}
          <div className="quota-meter-footer">
            <span className="quota-meter-footer-text">{m.footer ?? tm.footerNone}</span>
            <button type="button" className="quota-meter-refresh btn btn-ghost btn-icon btn-sm" onClick={refresh} title={tm.refresh} aria-label={tm.refresh}><Icon name="refresh" /></button>
          </div>
        </div>
      )}
    </span>
  );
}
