import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { serviceUrl } from '../serviceUrl.js';
import EvidencePreview, { QaVideo, SpeedBar, useQaSpeed } from './EvidencePreview.jsx';
import { PREVIEW_ID, useHoverPreview } from './useHoverPreview.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural } from '../i18n/index.js';
import { formatDateTime } from '../i18n/format.js';

/**
 * Browser QA: the plan a tester would follow, what happened at each step, and
 * the evidence — screenshots and the condensed video of every step — served
 * from wherever the task ran. The same shape as the Demo panel, because it
 * answers the same question from the other side: Demo tells you how to check
 * by hand; this shows you that it was checked.
 */
const STATUS = { pass: 'check-circle', fail: 'x-circle', unverified: 'alert-triangle' };
const StatusIcon = ({ status }) => (STATUS[status] ? <Icon name={STATUS[status]} /> : '·');

// Mirror of `scenariosOf` in `server/src/qa.js`. Keep the two identical: the web
// does not import from `server/src`, and a grouping that differs from the one
// the server used for the verdicts would head a scenario with the wrong steps.
// `undefined` counts as '' because plans saved before the field existed lack it
// and must keep rendering as one group per step, with no header.
function scenariosOf(steps) {
  const groups = [];
  for (const step of steps ?? []) {
    const title = step.scenario ?? '';
    const last = groups[groups.length - 1];
    if (title && last && last.title === title) last.steps.push(step);
    else groups.push({ title, steps: [step] });
  }
  return groups;
}

// A scenario's status is the worst of its steps. Missing results are not a
// pass: a half-run scenario stays neutral rather than looking green.
function scenarioStatus(steps, byStep) {
  const rs = steps.map((s) => byStep.get(s.id));
  if (rs.some((r) => r?.status === 'fail')) return 'fail';
  if (rs.some((r) => r?.status === 'unverified')) return 'unverified';
  if (rs.every((r) => r?.status === 'pass')) return 'pass';
  return 'pending';
}

export default function BrowserQaPanel({ task, onClose, onStartStack }) {
  const t = useStrings();
  const [info, setInfo] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const load = () => api.qa(task.project, task.issue).then(setInfo).catch(() => {});
  useEffect(() => { load(); }, [task.issue]);
  // While it runs — from the pipeline or from the button — poll for results.
  const busy = Boolean(info?.busy) || running || task.state === 'browser_qa';
  useEffect(() => {
    if (!busy) return undefined;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [busy, task.issue]);

  const run = () => {
    setRunning(true);
    setError(null);
    api.runQa(task.project, task.issue).then(load).catch((e) => setError(e.message)).finally(() => setRunning(false));
  };

  const qa = info?.qa ?? null;
  const plan = qa?.plan ?? qa?.initial ?? null;
  const results = qa?.results ?? null;
  const byStep = new Map((results?.steps ?? []).map((s) => [s.id, s]));
  const evidence = qa?.evidence ?? [];
  // A scenario video names several steps, so it is listed under each of them.
  // Tolerates the old stored shape (`step`, no `steps`) still in tasks.json.
  const idsOf = (e) => e.steps ?? (e.step ? [e.step] : []);
  // One URL string per file, kept across polls. The panel re-renders every
  // four seconds with what the poll brings, and a `src` that changed on each
  // render would reload the player and throw the position away mid-playback.
  const urls = useRef(new Map());
  const url = useCallback((rel) => {
    const key = `${task.issue}/${rel}`;
    if (!urls.current.has(key)) urls.current.set(key, api.qaEvidenceUrl(task.project, task.issue, rel));
    return urls.current.get(key);
  }, [task.issue]);

  // The lens and the speed. The preview is fed the live list, so a re-run that
  // replaces the files closes it instead of showing a file that no longer exists.
  const [rate, setRate] = useQaSpeed();
  const preview = useHoverPreview(evidence, task.issue);

  // The small players, by path, so the big view can take their position and
  // give it back. A scenario video belongs to every step of its scenario, so
  // the same path is mounted more than once: the registry keeps a set per
  // path, and each mounting site gets its own registrar — a ref callback is
  // handed `null` on unmount and could not otherwise say which copy left.
  // The registrar of each site is made once: a new function on every render
  // would detach and reattach the ref for nothing.
  const players = useRef(new Map());
  const registrars = useRef(new Map());
  const register = useCallback((path, owner) => {
    const key = `${owner}::${path}`;
    if (!registrars.current.has(key)) {
      let mine = null;
      registrars.current.set(key, (el) => {
        const set = players.current.get(path) ?? new Set();
        if (mine) set.delete(mine);
        mine = el;
        if (el) set.add(el);
        if (set.size) players.current.set(path, set);
        else players.current.delete(path);
      });
    }
    return registrars.current.get(key);
  }, []);
  const handover = useMemo(() => ({
    take: (path) => {
      const set = players.current.get(path);
      if (!set?.size) return 0;
      let at = 0;
      for (const el of set) {
        el.pause();                     // two players sounding at once is a bug
        at = Math.max(at, el.currentTime || 0);
      }
      return at;
    },
    give: (path, time) => {
      // Also when the big one had already ended: it comes back at its last
      // frame, not at zero. Every copy of the path gets it, so the one the
      // person reopens is where they left off whichever step they used.
      if (!Number.isFinite(time)) return;
      for (const el of players.current.get(path) ?? []) el.currentTime = time;
    },
  }), []);

  const shot = (e) => (
    <a key={e.path} href={url(e.path)} target="_blank" rel="noreferrer" className="qa-shot" title={e.name} {...preview.bind(e)}>
      <img src={url(e.path)} alt={e.name} loading="lazy" />
    </a>
  );
  // Keyed by its path, so a poll that brings the same files reconciles onto
  // the same <video> element instead of mounting a new one at zero.
  const player = (e, caption = null, owner = 'loose') => (
    <figure key={e.path} className="qa-video">
      <div className="qa-video-frame">
        <QaVideo src={url(e.path)} rate={rate} onEl={register(e.path, owner)} controls playsInline preload="metadata" />
        {/* The hot zone stops 44 px short of the bottom: the native controls
            are still the video's own, not the lens's. */}
        <span className="qa-hot" {...preview.bind(e)} />
      </div>
      <div className="qa-video-bar">
        {/* Wide touch screens only (CSS): there the hot zone is click-through so
            the native play button works, and this is the way to the zoomed view.
            Outside the video, so it never clashes with iOS's own controls. */}
        <button type="button" className="qa-zoom" aria-label={t.card.qa.zoomAria} data-qa-anchor=""
          aria-describedby={preview.open?.path === e.path ? PREVIEW_ID : undefined}
          onClick={(ev) => {
            const frame = ev.currentTarget.closest('figure')?.querySelector('.qa-video-frame');
            preview.openAt(e, frame ?? ev.currentTarget, ev.currentTarget);
          }}><Icon name="maximize"/> {t.card.qa.zoom}</button>
        {/* Also here, not only in the big view: a video at 0,25× with no
            visible control is a mystery, and this copy is the one the keyboard
            can reach — the portal lives at the end of `body`. */}
        <SpeedBar rate={rate} onRate={setRate} />
      </div>
      {caption}
    </figure>
  );
  // «1 min from 0:12» / «30 s from 1:05»: a static stretch the video dropped.
  const cutText = (c) => {
    const long = c.seconds >= 90;
    return fill(long ? t.card.qa.cutMin : t.card.qa.cutSec, {
      n: Math.round(long ? c.seconds / 60 : c.seconds),
      from: `${Math.floor(c.from / 60)}:${String(Math.floor(c.from % 60)).padStart(2, '0')}`,
    });
  };
  const stepItem = (step) => {
    const r = byStep.get(step.id);
    const mine = evidence.filter((e) => idsOf(e).includes(step.id));
    return (
      <li key={step.id} className={`qa-step qa-${r?.status ?? 'pending'}`}>
        <div className="qa-step-head">
          <span className="qa-status"><StatusIcon status={r?.status} /></span>
          <code>{step.id}</code>
          <span className="qa-what">{step.what}</span>
          {step.longWait && <span className="tag">{t.card.qa.longWait}</span>}
        </div>
        <div className="qa-expect">{fill(t.card.qa.expect, { expect: step.expect })}</div>
        {r?.note && <div className="qa-note">{r.note}</div>}
        {mine.length > 0 && (
          <div className="qa-evidence">
            {mine.map((e) => (e.kind === 'video'
              ? player(e, (
                <figcaption>
                  {e.name}
                  {(qa.videos?.[e.path]?.cuts ?? []).length > 0 && (
                    <span className="qa-cuts"> · {fill(t.card.qa.staticCuts, { cuts: qa.videos[e.path].cuts.map(cutText).join(', ') })}</span>
                  )}
                </figcaption>
              ), step.id)
              : shot(e)))}
          </div>
        )}
      </li>
    );
  };
  const services = Object.values(task.stack?.services ?? {});
  const live = task.stack?.status === 'running' && services.some((s) => s.healthy);

  return (
    <section className="subpanel subpanel-qa">
      <header>
        <h3><Icon name="compass"/> Browser QA · #{task.issue}</h3>{/* i18n-ok: Browser QA is a product name */}
        <div className="sp-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={run} disabled={busy || !task.hasWorktree}
            title={live ? t.card.qa.runLive : t.card.qa.runCold}>
            {busy ? t.card.qa.running : results ? <><Icon name="refresh"/> {t.card.qa.rerun}</> : <><Icon name="play"/> {t.card.qa.run}</>}
          </button>
          <button type="button" className="btn btn-close" onClick={onClose} aria-label={t.common.close} title={t.common.close}><Icon name="x"/></button>
        </div>
      </header>

      <div className="subpanel-body">
        {info && !info.globalOn && (
          <p className="sp-note">{t.card.qa.offNote}</p>
        )}
        {!task.hasWorktree && (
          <p className="sp-note">{t.card.qa.noWorktree}</p>
        )}
        {task.hasWorktree && !live && (
          <div className="sp-note">
            <span>{t.card.qa.stackDown}</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onStartStack(task.issue)}><Icon name="play"/> {t.card.qa.startApp}</button>
          </div>
        )}
        {error && <p className="sp-error">{error}</p>}
        {busy && <p className="muted"><span className="spinner" /> {t.card.qa.walking}</p>}

        {qa?.ui === false && (
          <p className="muted">{t.card.qa.noUi}</p>
        )}
        {!plan && qa?.ui !== false && (
          <p className="muted">{t.card.qa.noPlan}</p>
        )}

        {results && (
          <p className={`qa-verdict qa-${results.verdict}`}>
            <StatusIcon status={results.verdict} /> {results.verdict === 'pass' ? t.card.qa.verdictPass : results.verdict === 'fail' ? plural(results.counts.failed, t.card.qa.verdictFail) : plural(results.counts.unverified, t.card.qa.verdictUnverified)}
            {qa.ranAt && <span className="muted"> · {formatDateTime(qa.ranAt)}</span>}
            {results.summary && <span className="qa-summary">{results.summary}</span>}
          </p>
        )}

        {plan && (
          <ol className="qa-steps">
            {scenariosOf(plan.steps).map((group) => {
              // Untitled groups render the bare step, exactly as before.
              if (!group.title) return stepItem(group.steps[0]);
              const status = scenarioStatus(group.steps, byStep);
              return (
                <li key={group.steps[0].id} className="qa-scenario">
                  <div className="qa-scenario-head">
                    <span className={`qa-scenario-status qa-${status}`}><StatusIcon status={status} /></span>
                    <span className="qa-scenario-title">{group.title}</span>
                  </div>
                  <ol className="qa-steps">{group.steps.map(stepItem)}</ol>
                </li>
              );
            })}
          </ol>
        )}

        {evidence.some((e) => !idsOf(e).length) && (
          <details className="qa-loose">
            <summary>{fill(t.card.qa.otherShots, { n: evidence.filter((e) => !idsOf(e).length).length })}</summary>
            <div className="qa-evidence">
              {evidence.filter((e) => !idsOf(e).length).map((e) => (e.kind === 'video'
                ? player(e, <figcaption>{e.name}</figcaption>)
                : shot(e)))}
            </div>
          </details>
        )}

        {live && (
          <p className="sp-hint">
            {t.card.qa.servers}{' '}
            {services.filter((s) => s.healthy).map((s) => (
              <a key={s.label} href={serviceUrl(s)} target="_blank" rel="noreferrer">{s.label} <Icon name="arrow-right"/> {serviceUrl(s)}</a>
            ))}
          </p>
        )}
      </div>

      {preview.open && preview.anchor && (
        <EvidencePreview
          item={preview.open}
          anchor={preview.anchor}
          src={url(preview.open.path)}
          rate={rate}
          onRate={setRate}
          onClose={preview.close}
          onEnter={preview.keep}
          onLeave={preview.leave}
          handover={handover}
        />
      )}
    </section>
  );
}
