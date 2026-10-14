import React from 'react';
import Sparkline from '../charts/Sparkline.jsx';
import { formatMs } from '../../metricsView.js';
import { fill, plural } from '../../i18n/index.js';
import { useStrings } from '../../i18n/useStrings.js';

/**
 * Median-duration panel of the strip, mounted inside a `Popover`. The surface
 * is the quota panels' own; the lienzo draws no median panel, so this follows
 * direction C's.
 *
 * @param {object} props
 * @param {object} props.stats result of `recentDurations(projectTasks)`:
 *   `{ values (old→new, ms), n, considered, median, p90 }`
 */
// Same cap as `recentDurations(tasks, n = 20)` in kpiView.js (it exports no constant):
// `n` never exceeds it, so «n de considered» must compare against the smaller of the two.
const RECENT = 20;

export default function MedianPanel({ stats }) {
  const t = useStrings().kpi.median;
  const { values = [], n = 0, considered = 0, median = null, p90 = null } = stats ?? {};
  const small = n > 0 && n <= 2;
  return (
    <div className="kp-panel kp-panel-median" role="region" aria-label={t.detail}>
      <div className="kp-head">
        <h3 className="kp-title">{t.label}</h3>
        <b className="kp-big">{formatMs(median)}</b>
      </div>
      {n === 0 ? (
        <p className="kp-muted">{t.empty}</p>
      ) : (
        <>
          <div className="kp-facts">
            <div className="kp-fact">
              <span className="kp-fact-label">p90</span>
              <b className="kp-fact-value">{formatMs(p90)}</b>
            </div>
            {n < Math.min(considered, RECENT) && (
              <div className="kp-fact">
                <span className="kp-fact-label">{t.tasks}</span>
                <b className="kp-fact-value">{fill(t.ofConsidered, { n, considered })}</b>
                <span className="kp-fact-note">{t.withData}</span>
              </div>
            )}
          </div>
          <Sparkline values={values} width={284} height={40} label={fill(t.sparkLabel, { n, median: formatMs(median) })} />
          {small && (
            <p className="kp-alert kp-small-sample">
              <span>{plural(n, t.small)}</span>
            </p>
          )}
        </>
      )}
      <p className="kp-muted">{t.reopened}</p>
    </div>
  );
}
