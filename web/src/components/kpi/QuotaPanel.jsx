import React from 'react';
import Icon from '../Icon.jsx';
import MiniBar from '../charts/MiniBar.jsx';
import { paceTrusted, quotaPace, weekdayStamp } from '../../kpiView.js';
import { hhmm } from '../../time.js';
import { fill, plural, splitAround } from '../../i18n/index.js';
import { formatNumber } from '../../i18n/format.js';
import { useStrings } from '../../i18n/useStrings.js';

/**
 * Detail panel of one usage window, mounted by `KpiStrip` inside a `Popover`
 * (which brings the surface and the shadow; this file brings the padding and
 * the width). It acts on the view only: the single button asks for a fresh
 * sample, nothing here starts, stops or spends anything.
 *
 * @param {object} props
 * @param {'weekly'|'session'} props.kind which window the panel shows
 * @param {object} props.meter result of `quotaMeter(usage, quota, now)`
 * @param {object|null} props.usage the account's usage probe
 * @param {number} props.now the board's shared quota clock
 * @param {() => void} props.onRefresh asks the server for a fresh usage sample (`onRefreshUsage`)
 */

// `rowTone` speaks ok/warn/error/idle; the icons and the chart tones do not.
const TONE = {
  ok: { icon: 'check-circle', chart: 'ok' },
  warn: { icon: 'alert-triangle', chart: 'warn' },
  error: { icon: 'x-circle', chart: 'danger' },
  idle: { icon: 'circle-minus', chart: 'neutral' },
};

/** «0,35» / «2.5» / «25»: two decimals under 1, one under 10, whole above, in the language now in use. */
function rate(n) {
  const digits = n < 1 ? 2 : n < 10 ? 1 : 0;
  return formatNumber(n, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** The far-out countdown comes with a «~»; the panel states it as a plain «in …». */
const within = (t, left) => fill(t.within, { left: String(left).replace(/^~\s*/, '') });

const isPct = (p) => p !== null && p !== undefined;

function SecondaryRow({ row, barWidth }) {
  const t = useStrings().kpi.panel;
  const tone = TONE[row.tone] ?? TONE.idle;
  const reopens = row.group === 'weekly' ? weekdayStamp(row.resetsAt) : row.countdown?.at;
  return (
    <div className="kp-row">
      <span className={`kp-row-icon kp-tone-${tone.chart}`}><Icon name={tone.icon} size={12} /></span>
      <span className="kp-row-label">{row.label}</span>
      {isPct(row.percent) && <MiniBar percent={row.percent} tone={tone.chart} width={barWidth} height={6} label={`${row.label}: ${row.percent} %`} />}
      <b className="kp-row-pct">{isPct(row.percent) ? `${row.percent} %` : '—'}</b>
      <span className="kp-row-reset" title={row.countdown ? fill(t.reopenedAt, { stamp: row.countdown.stamp }) : undefined}>{reopens ?? ''}</span>
    </div>
  );
}

export default function QuotaPanel({ kind, meter, usage, now, onRefresh }) {
  const t = useStrings().kpi.panel;
  const row = kind === 'session' ? meter?.session : meter?.weekly;
  const title = kind === 'session' ? t.session : t.weekly;
  const detail = kind === 'session' ? t.detailSession : t.detailWeekly;
  const hold = meter?.hold ?? null;
  const others = (meter?.rows ?? []).filter((r) => r !== row);
  const barWidth = kind === 'session' ? 48 : 56;

  const refresh = () => { try { onRefresh?.(); } catch (e) { console.warn(e); } };

  const footer = (
    <div className="kp-footer">
      <span className="kp-footer-text">{meter?.footer ?? t.footerNone}</span>
      <button type="button" className="kp-refresh btn btn-ghost btn-icon btn-xs" onClick={refresh} title={t.refresh} aria-label={t.refresh}>
        <Icon name="refresh" size={14} />
      </button>
    </div>
  );

  const holdBlock = hold && (
    <div className="kp-hold">
      <p className="kp-hold-title">{hold.title}</p>
      <ul className="kp-hold-facts">
        {hold.attempt > 0 && <li>{fill(t.attempt, { n: hold.attempt })}</li>}
        <li>{plural(hold.parked, t.parked)}</li>
        {hold.certainty === 'blind' && <li>{t.estimated}</li>}
      </ul>
      <p className="kp-hold-note">{t.nothingToPress}</p>
    </div>
  );

  if (!row) {
    return (
      <div className={`kp-panel kp-panel-${kind}`} role="region" aria-label={detail}>
        <h3 className="kp-title">{title}</h3>
        {holdBlock}
        {!hold && <p className="kp-muted">{t.noData}</p>}
        {footer}
      </div>
    );
  }

  const tone = TONE[row.tone] ?? TONE.idle;
  const pace = quotaPace(row, now);
  const trusted = paceTrusted(usage);
  const weekly = kind === 'weekly';
  const reopens = weekly ? weekdayStamp(row.resetsAt) : row.countdown?.at;

  // «Consumo por hora» is an estimate from the window's theoretical start: with
  // stale or event-fed figures it would claim more than the board knows.
  let paceValue = null;
  let paceNote = null;
  if (trusted && pace) {
    if (weekly && pace.budgetPerHour != null) {
      paceValue = `≤ ${rate(pace.budgetPerHour)} %`;
      paceNote = fill(t.paceWeekly, { at: weekdayStamp(row.resetsAt) });
    } else if (!weekly && pace.ratePerHour != null) {
      paceValue = `≈ ${rate(pace.ratePerHour)} %`;
      paceNote = fill(t.paceSession, { percent: row.percent, time: hhmm(pace.startAt) });
    }
  }
  const exhaust = trusted && !weekly && pace?.exhaustAt != null ? hhmm(pace.exhaustAt) : null;

  return (
    <div className={`kp-panel kp-panel-${kind}`} role="region" aria-label={detail}>
      <div className="kp-head">
        <h3 className="kp-title">{title}</h3>
        <span className={`kp-big kp-tone-${tone.chart}`}>
          <Icon name={tone.icon} size={16} />
          {isPct(row.percent) ? `${row.percent} %` : '—'}
        </span>
      </div>
      {isPct(row.percent) && <MiniBar percent={row.percent} tone={tone.chart} width={weekly ? 324 : 284} height={8} label={fill(t.usedLabel, { title, percent: row.percent })} />}
      {holdBlock}
      <div className="kp-facts">
        <div className="kp-fact">
          <span className="kp-fact-label">{t.reopens}</span>
          <b className="kp-fact-value">{reopens ?? '—'}</b>
          {row.countdown && <span className="kp-fact-note">{within(t, row.countdown.left)}</span>}
        </div>
        {paceValue && (
          <div className="kp-fact">
            <span className="kp-fact-label">{t.paceLabel}</span>
            <b className="kp-fact-value">{paceValue}</b>
            <span className="kp-fact-note">{paceNote}</span>
          </div>
        )}
      </div>
      {!trusted && <p className="kp-muted">{t.untrusted}</p>}
      {exhaust && (
        <p className="kp-alert">
          <Icon name="chart-line" size={14} />
          <span>
            {splitAround(t.exhaust, { time: exhaust }).map((part) => (part.hole
              ? <b key={part.key}>{part.text}</b> : <React.Fragment key={part.key}>{part.text}</React.Fragment>))}
            {' '}{t.nothingToPress}
          </span>
        </p>
      )}
      {others.length > 0 && (
        <div className="kp-rows">
          {others.map((r) => <SecondaryRow key={r.label} row={r} barWidth={barWidth} />)}
        </div>
      )}
      {meter?.extra && (
        <p className="kp-muted">
          {t.extra}: {meter.extra.usedCredits ?? '—'} / {meter.extra.monthlyLimit ?? '—'} {meter.extra.currency ?? ''}
          {isPct(meter.extra.percent) ? ` · ${meter.extra.percent} %` : ''}
        </p>
      )}
      {footer}
    </div>
  );
}
