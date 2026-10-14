import React, { useEffect } from 'react';
import Icon from '../Icon.jsx';
import LiveDot from '../ui/LiveDot.jsx';
import Popover, { usePopover } from '../ui/Popover.jsx';
import Ring from '../charts/Ring.jsx';
import SlotRing from '../charts/SlotRing.jsx';
import UnitBar from '../charts/UnitBar.jsx';
import Sparkline from '../charts/Sparkline.jsx';
import QuotaPanel from './QuotaPanel.jsx';
import MedianPanel from './MedianPanel.jsx';
import { quotaMeter } from '../QuotaMeter.jsx';
import { OPEN_META, agentsSummary, openByState, recentDurations } from '../../kpiView.js';
import { formatMs } from '../../metricsView.js';
import { strings, fill, plural } from '../../i18n/index.js';
import { useStrings } from '../../i18n/useStrings.js';

/** What the server's `awaitingYou` reasons are called on the strip: the codes stay the server's, the words follow the language. */
const REASON_LABEL = (code) => strings().kpi.reason[code] ?? code ?? '';
const AWAITING_SHOWN = 3;

/** `quotaMeter` tones → chart tones. */
const RING_TONE = { ok: 'ok', warn: 'warn', error: 'danger', busy: 'live', idle: 'neutral' };
const TONE_ICON = { ok: 'check-circle', warn: 'alert-triangle', error: 'x-circle', busy: 'loader', idle: 'circle' };

/** Open-by-state legend: icon colour per bucket (running draws a LiveDot instead). */
const LEGEND_TONE = { waiting: 'amber', queued: 'muted', review: 'green', error: 'red' };

/** «#1885 plan, #1876 pregunta»: the first few waiting tasks and why, one reason each. */
function awaitingLine(awaiting) {
  const shown = awaiting.slice(0, AWAITING_SHOWN)
    .map((a) => `#${a.issue} ${REASON_LABEL(a.awaitingYou?.[0])}`.trim());
  const more = awaiting.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` ${fill(strings().kpi.awaitingMore, { n: more })}` : '');
}

/** The cell's big number: «42» + a small unit. */
function Figure({ value, unit = null }) {
  return <b className="kpi-fig">{value}{unit && <small>{unit}</small>}</b>;
}

function AwaitingCell({ awaiting, activeProject, projectName, onJumpAwaiting }) {
  const t = useStrings().kpi;
  if (awaiting.length === 0) {
    return (
      <div className="kpi-cell kpi-calm">
        <Icon name="check-circle" />
        <span>{t.awaitingNone}</span>
      </div>
    );
  }
  // The full list stays in the tooltip: the line under the count is cut at three.
  const title = awaiting
    .map((a) => `#${a.issue}: ${a.awaitingYou.map(REASON_LABEL).join(', ')}`
      + (a.project === activeProject ? '' : ` (${projectName(a.project)})`))
    .join('\n');
  return (
    <button type="button" className="kpi-await" title={title} onClick={onJumpAwaiting}>
      <span className="kpi-await-icon" aria-hidden="true"><Icon name="help-circle" size={20} /></span>
      <span className="kpi-await-main">
        <b className="kpi-await-n">{awaiting.length}</b>
        <span>{awaiting.length === 1 ? t.awaitingSingle : t.awaitingMulti}</span>
      </span>
      <Icon name="chevron-right" size={16} className="kpi-await-go" />
      <span className="kpi-await-sub">{awaitingLine(awaiting)}</span>
    </button>
  );
}

function SlotsCell({ activeCount, maxActive, ceiling, onSetMax }) {
  const t = useStrings().kpi;
  const canLower = maxActive > 1;
  const canRaise = maxActive < ceiling;
  return (
    <div className="kpi-cell kpi-slots">
      <SlotRing used={activeCount} total={maxActive} label={fill(t.slotsAria, { used: activeCount, total: maxActive })} />
      <span className="kpi-col">
        <span className="kpi-label">{t.slotsLabel}</span>
        <Figure value={activeCount} unit={`/${maxActive}`} />
        <span className="kpi-limit">
          {t.slotsLimit}
          <span className="kpi-stepper">
            <button type="button" className="btn btn-icon kpi-step" aria-label={t.limitLower} title={t.limitLower}
              disabled={!canLower} onClick={() => onSetMax(Math.max(1, maxActive - 1))}>
              <Icon name="minus" size={14} />
            </button>
            <b className="kpi-limit-n">{maxActive}</b>
            <button type="button" className="btn btn-icon kpi-step" aria-label={t.limitRaise} title={t.limitRaise}
              disabled={!canRaise} onClick={() => onSetMax(Math.min(ceiling, maxActive + 1))}>
              <Icon name="plus" size={14} />
            </button>
          </span>
        </span>
      </span>
    </div>
  );
}

function AgentsCell({ allTasks }) {
  const t = useStrings().kpi;
  const s = agentsSummary(allTasks);
  const idle = s.running === 0 && s.total === 0;
  return (
    <div className="kpi-cell kpi-agents">
      <span className="kpi-label">{t.agentsLabel}</span>
      {idle ? (
        <span className="kpi-none">{t.agentsNone}</span>
      ) : (
        <>
          <span className="kpi-line">
            <Figure value={s.running} />
            <span className="kpi-unit">{t.agentsUnit}</span>
            <span className="kpi-aside">{fill(t.agentsDone, { done: s.done, total: s.total })}</span>
          </span>
          <UnitBar done={s.done} running={s.running} total={s.total} width={176} height={8}
            label={fill(t.agentsDone, { done: s.done, total: s.total })} />
        </>
      )}
      {(s.commands > 0 || s.servers > 0) && (
        <span className="kpi-meta">
          <Icon name="terminal" size={12} />{plural(s.commands, t.agentsCommands)}
          <Icon name="server" size={12} className="kpi-meta-ok" />{fill(t.agentsServing, { n: s.servers })}
        </span>
      )}
    </div>
  );
}

function OpenCell({ projectTasks }) {
  const t = useStrings().kpi;
  const open = openByState(projectTasks);
  if (open.total === 0) {
    return (
      <div className="kpi-cell kpi-open">
        <span className="kpi-label">{t.openLabel}</span>
        <span className="kpi-none">{t.openNone}</span>
      </div>
    );
  }
  // One grid column per non-empty bucket, sized by its count, with the legend
  // in the same column as its stretch so each label sits under its own colour.
  const columns = open.segments.map((s) => `minmax(max-content, ${s.n}fr)`).join(' '); // i18n-ok: CSS grid track
  return (
    <div className="kpi-cell kpi-open">
      <span className="kpi-label">{t.openLabel}</span>
      <span className="kpi-line">
        <Figure value={open.total} />
        <span className="kpi-unit">{open.total === 1 ? t.openUnitSingle : t.openUnitMulti}</span>
      </span>
      <div className="kpi-segs" style={{ gridTemplateColumns: columns }}>
        {open.segments.map((s) => <span key={`bar-${s.key}`} className={`kpi-seg kpi-seg-${s.key}`} aria-hidden="true" />)}
        {open.segments.map((s) => (
          <span key={`key-${s.key}`} className="kpi-legend">
            <span className="kpi-legend-n">
              {s.key === 'running'
                ? <span className="kpi-legend-dot"><LiveDot /></span>
                : <Icon name={s.icon} size={13} className={`kpi-ico-${LEGEND_TONE[s.key]}`} />}
              {s.n}
            </span>
            <span className="kpi-legend-label">{s.label}</span>
          </span>
        ))}
      </div>
      {/* An empty bucket draws nothing, but a screen reader still gets the zero. */}
      {open.zero.map((k) => <span key={k} className="kpi-sr">{`0 ${OPEN_META[k].label}`}</span>)}
    </div>
  );
}

/**
 * One quota trigger plus its hover/click panel. Asking for a fresh sample when
 * it opens keeps the old meter's behaviour; the server throttles the probe.
 */
function QuotaTrigger({ kind, className, label, title, placement, meter, usage, now, onRefresh, children }) {
  const t = useStrings().kpi;
  const pop = usePopover({ hover: true });
  useEffect(() => {
    if (!pop.open) return;
    try { onRefresh?.(); } catch (e) { console.warn(e); }
    // Only the opening matters: a new `onRefresh` identity must not re-probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop.open]);
  return (
    <>
      <button type="button" className={`${className}${pop.open ? ' is-open' : ''}`} aria-label={label} title={title}
        {...pop.triggerProps}>
        {children}
      </button>
      <Popover pop={pop} placement={placement} arrow label={kind === 'weekly' ? t.popoverWeekly : t.popoverSession}>
        <QuotaPanel kind={kind} meter={meter} usage={usage} now={now} onRefresh={onRefresh} />
      </Popover>
    </>
  );
}

function QuotaCell({ usage, quota, now, onRefresh }) {
  const t = useStrings().kpi;
  const pctText = (p) => (p == null ? t.noValue : fill(t.pct, { n: p }));
  const meter = quotaMeter(usage, quota, now);
  const main = meter.weekly ?? meter.session;
  if (!usage || !main) {
    return (
      <div className="kpi-cell kpi-quota">
        {meter.hold ? (
          <>
            <span className="kpi-label">{t.quotaLabel}</span>
            <span className="kpi-hold" title={meter.hold.title}>{meter.headline}</span>
            <span className="kpi-sub">{t.quotaResumes}</span>
          </>
        ) : <span className="kpi-none">{t.quotaNoData}</span>}
      </div>
    );
  }
  const mainKind = meter.weekly ? 'weekly' : 'session';
  const mainName = meter.weekly ? t.quotaWeekly : t.quotaSession;
  const mainTone = meter.hold ? meter.tone : main.tone;
  const pct = main.percent;
  const session = meter.weekly ? meter.session : null;
  return (
    <div className="kpi-cell kpi-quota">
      <QuotaTrigger kind={mainKind} className="kpi-qbtn" placement="bottom"
        meter={meter} usage={usage} now={now} onRefresh={onRefresh}
        label={fill(t.quotaAria, { name: mainName, value: pctText(pct) })}
        title={meter.hold?.title ?? meter.footer ?? undefined}>
        <Ring percent={pct ?? 0} tone={RING_TONE[mainTone] ?? 'neutral'} label={`${mainName} ${pct ?? t.noValue}`} />
        <span className="kpi-col">
          <span className="kpi-label">{mainName}</span>
          <Figure value={pct ?? '—'} unit={pct == null ? null : fill(t.pct, { n: '' })} />
        </span>
      </QuotaTrigger>
      {meter.hold ? (
        <span className="kpi-hold-note">
          <span className="kpi-hold">{meter.headline}</span>
          <span className="kpi-sub">{t.quotaResumes}</span>
        </span>
      ) : session && (
        <QuotaTrigger kind="session" className="kpi-sbtn" placement="bottom-start"
          meter={meter} usage={usage} now={now} onRefresh={onRefresh}
          label={fill(session.countdown ? t.sessionAriaReopens : t.sessionAria,
            { value: pctText(session.percent), at: session.countdown?.at })}
          title={t.popoverSession}>
          <span className={`kpi-sline kpi-tone-${session.tone}`}>
            <Icon name={TONE_ICON[session.tone] ?? 'circle'} size={12} />
            <span className="kpi-sline-text">{fill(t.sessionLine, { value: session.percent == null ? '—' : fill(t.pct, { n: session.percent }) })}</span>
          </span>
          {session.countdown && <span>{fill(t.reopensAt, { at: session.countdown.at })}</span>}
        </QuotaTrigger>
      )}
    </div>
  );
}

function MedianCell({ projectTasks }) {
  const t = useStrings().kpi;
  const stats = recentDurations(projectTasks);
  const pop = usePopover({ hover: true });
  if (stats.n === 0) {
    return (
      <div className="kpi-cell kpi-median">
        <span className="kpi-none">{t.median.none}</span>
      </div>
    );
  }
  const median = formatMs(stats.median);
  const text = fill(t.median.text, { n: stats.n, median });
  return (
    <div className="kpi-cell kpi-median">
      <button type="button" className={`kpi-mbtn${pop.open ? ' is-open' : ''}`} aria-label={fill(t.median.aria, { median })}
        {...pop.triggerProps}>
        <span className="kpi-label">{t.median.label}</span>
        <Figure value={median} />
        <Sparkline values={stats.values} width={150} height={28} label={text} />
        <span className="kpi-meta">{fill(t.median.meta, { p90: formatMs(stats.p90), n: stats.n })}</span>
      </button>
      <Popover pop={pop} placement="bottom-end" arrow label={t.median.detail}>
        <MedianPanel stats={stats} />
      </Popover>
    </div>
  );
}

/**
 * The strip under the bar: what waits on you, the parallel slots, the running
 * agents, the open tasks by state, the account's quota and the median task.
 * Every chart has its number written next to it. It paints its own root, so it
 * needs nothing from `.topbar`.
 *
 * Scope (plan §2.4): agents, slots and «esperan» count every project; the open
 * breakdown and the median count the active one.
 *
 * @param {object} props
 * @param {object[]} props.awaiting tasks waiting on a decision, the active project's first
 * @param {string|null} props.activeProject
 * @param {(id: string) => string} props.projectName
 * @param {() => void} props.onJumpAwaiting opens the first waiting task
 * @param {number} props.activeCount tasks in a busy state
 * @param {number} props.maxActive the parallel limit
 * @param {number} props.ceiling the highest limit that can be set
 * @param {(n: number) => void} props.onSetMax
 * @param {object[]} props.allTasks every task on the board, unassigned-and-settled ones left out
 * @param {object[]} props.projectTasks the active project's tasks
 * @param {object|null} props.usage
 * @param {object|null} props.quota
 * @param {number} props.now the board's shared quota clock
 * @param {() => void} props.onRefreshUsage
 */
export default function KpiStrip({
  awaiting, activeProject, projectName, onJumpAwaiting, activeCount, maxActive, ceiling, onSetMax,
  allTasks, projectTasks, usage, quota, now, onRefreshUsage,
}) {
  const t = useStrings().kpi;
  return (
    <section className="kpi" aria-label={t.stripLabel}>
      <AwaitingCell awaiting={awaiting} activeProject={activeProject} projectName={projectName}
        onJumpAwaiting={onJumpAwaiting} />
      <SlotsCell activeCount={activeCount} maxActive={maxActive} ceiling={ceiling ?? maxActive} onSetMax={onSetMax} />
      <AgentsCell allTasks={allTasks} />
      <OpenCell projectTasks={projectTasks} />
      <QuotaCell usage={usage} quota={quota} now={now} onRefresh={onRefreshUsage} />
      <MedianCell projectTasks={projectTasks} />
    </section>
  );
}
