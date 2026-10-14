import React, { useEffect, useState } from 'react';
import Dialog from './Dialog.jsx';
import { api } from '../api.js';
import { aggregateRows, formatMs, formatShare, isEmptyAggregate, sealedLines, subagentRows } from '../metricsView.js';
import { fill, plural } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';
import './timings.css';

function Table({ title, rows }) {
  const t = useStrings().kpi.metrics;
  if (!rows.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <table>
        <thead><tr><th>{t.colType}</th><th>n</th><th>{t.colMedian}</th><th>p90</th><th>{t.colTotal}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}><td>{r.name}</td><td>{r.n}</td><td>{r.medianLabel}</td><td>{r.p90Label}{r.smallSample ? ' *' : ''}</td><td>{r.totalLabel}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SubagentTable({ rows }) {
  const t = useStrings().kpi.metrics;
  if (!rows.length) return null;
  return (
    <>
      <h4>{t.subagentsByPhase}</h4>
      <table>
        <thead><tr><th>{t.colPhase}</th><th>{t.colSessions}</th><th>{t.colCalls}</th><th>{t.colSubagents}</th><th>%</th><th>{t.colNudges}</th><th>{t.colNudgeTime}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}><td>{r.name}</td><td>{r.sessions}</td><td>{r.calls}</td><td>{r.subagents}</td><td>{r.shareLabel}</td><td>{r.nudges}</td><td>{r.nudgeLabel}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="modal-caption metrics-footnote">
        {t.subagentsNote}
      </p>
    </>
  );
}

/** Nothing measured yet: the message plus a dimmed ghost of the chart that will fill in. */
function EmptyMetrics() {
  const t = useStrings().kpi.metrics;
  return (
    <div className="dlg-c-empty">
      <svg className="dlg-c-empty-chart" viewBox="0 0 240 64" role="img" aria-label={t.emptyChart} focusable="false">
        {[34, 46, 28, 54, 40, 22, 48].map((h, i) => (
          <rect key={i} x={8 + i * 33} y={60 - h} width="20" height={h} rx="3" />
        ))}
      </svg>
      <p className="dlg-c-empty-text">{t.empty}</p>
    </div>
  );
}

/** Median and p90 per phase and per wait kind across tasks, and how much of the wall time was waiting. */
export default function MetricsDialog({ project, onClose }) {
  const t = useStrings();
  const tm = t.kpi.metrics;
  const [agg, setAgg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.metrics(project)
      .then((r) => { if (alive) setAgg(r?.aggregate ?? r); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [project]);

  return (
    <Dialog
      title={tm.title} icon="timer" className="metrics-dialog" onDismiss={onClose}
      footer={<><span className="modal-spacer" /><button type="button" className="btn btn-ghost btn-md" onClick={onClose}>{t.common.close}</button></>}
    >
      {error && <p className="modal-caption">{fill(tm.loadFailed, { error })}</p>}
      {!agg && !error && <p className="modal-caption">{t.common.loading}</p>}
      {agg && isEmptyAggregate(agg) && <EmptyMetrics />}
      {agg && !isEmptyAggregate(agg) && (
        <>
          <p className="modal-caption">
            {fill(tm.summary, {
              tasks: plural(agg.tasks, t.common.task), wall: formatMs(agg.wallMs), wait: formatMs(agg.waitMs), share: formatShare(agg.waitShare),
            })}
          </p>
          {sealedLines(agg).map((line) => <p key={line} className="modal-caption">{line}</p>)}
          <Table title={tm.phases} rows={aggregateRows(agg.phases)} />
          <Table title={tm.waits} rows={aggregateRows(agg.waits)} />
          <p className="modal-caption metrics-footnote">{tm.smallSample}</p>
          <SubagentTable rows={subagentRows(agg.subagents)} />
        </>
      )}
    </Dialog>
  );
}
