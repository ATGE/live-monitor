import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { hasOpenSpans, summaryLine, timelineRows, timingsKey } from '../metricsView.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';
import './timings.css';

/**
 * Where a task's time went: one bar per span (phases, sessions, waits...).
 * Fetched when opened and again when the span count or the task state changes
 * (the broadcast carries only a small `timing` summary, never the spans). A task without
 * timings shows an empty note.
 */
export default function TimelinePanel({ task, onClose }) {
  const t = useStrings();
  const [timings, setTimings] = useState([]);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  // Not `updatedAt`: it moves on every log line, one request each.
  const key = timingsKey(task.timing);

  useEffect(() => {
    let alive = true;
    api.timings(task.project, task.issue)
      .then((r) => { if (alive) { setTimings(Array.isArray(r) ? r : r?.timings ?? []); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [task.project, task.issue, key, task.state]);

  // Open spans grow between requests: tick locally while any is open.
  const anyOpen = hasOpenSpans(timings);
  useEffect(() => {
    if (!anyOpen) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyOpen]);

  const rows = timelineRows(timings, now);

  return (
    <section className="subpanel subpanel-timeline">
      <header>
        <h3><Icon name="timer"/> #{task.issue} · {task.state}</h3>
        <button type="button" className="btn btn-close" onClick={onClose} aria-label={t.common.close} title={t.common.close}><Icon name="x"/></button>
      </header>
      {task.timing && <div className="timeline-summary sp-timeline-summary">{summaryLine(task.timing)}</div>}
      <div className="timeline sp-timeline">
        {error && <p className="timeline-empty">{fill(t.card.timeline.loadFailed, { error })}</p>}
        {!error && rows.length === 0 && <p className="timeline-empty">{t.card.timeline.empty}</p>}
        {rows.map((r, i) => (
          <div key={i} className="timeline-row" title={`${r.kindLabel} · ${r.startLabel}${r.outcome ? ` · ${r.outcome}` : ''}`}>
            <span className="tl-name">
              <strong>{r.name}</strong>
              <span className="tl-detail">{r.kindLabel}{r.detail ? ` · ${r.detail}` : ''}</span>
            </span>
            <span className="timeline-track">
              <span
                className={`timeline-bar kind-${r.kind}${r.outcome === 'error' ? ' outcome-error' : ''}${r.open ? ' open' : ''}`}
                style={{ left: `${r.left}%`, width: `${Math.min(r.width, 100 - r.left)}%` }}
              />
              <span className="tl-len">{r.label}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
