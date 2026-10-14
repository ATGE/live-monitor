import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import Markdown from './Markdown.jsx';
import { serviceUrl } from '../serviceUrl.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';

/** Manual-validation steps, shown under the chat so both are visible at once. */
export default function DemoPanel({ task, onClose, onStartStack }) {
  const t = useStrings();
  const [steps, setSteps] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.demo(task.project, task.issue).then((r) => { setSteps(r.demoSteps); setBusy(r.busy); });
  }, [task.issue]);

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      api.demo(task.project, task.issue).then((r) => {
        if (r.demoSteps) setSteps(r.demoSteps);
        setBusy(r.busy);
      });
    }, 3000);
    return () => clearInterval(id);
  }, [busy, task.issue]);

  const generate = () => {
    setBusy(true);
    setError(null);
    api.generateDemo(task.project, task.issue)
      .then((r) => setSteps(r.demoSteps))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  // The demo phase is off for this task: the run ends at the PR and nothing
  // is written by itself. «Generar» stays live — a click is explicit. The
  // server resolves it (own choice, else the project's); the raw mode only
  // covers a payload that predates `demoWanted`.
  const demoOff = task.demoWanted === false || (task.demoWanted === undefined && task.demo === 'off');

  const services = Object.values(task.stack?.services ?? {});
  const live = task.stack?.status === 'running' && services.some((s) => s.healthy);
  const starting = task.stack?.status === 'starting';

  // The model is told to write absolute URLs when the servers are up, but a
  // leftover placeholder from an earlier run still resolves to the live port.
  const resolved = live
    ? services.reduce(
      (text, s) => text.replaceAll(`<${s.label}_URL>`, serviceUrl(s)).replaceAll(`{${s.label}}`, serviceUrl(s)),
      steps ?? '',
    )
    : steps;

  return (
    <section className="subpanel">
      <header>
        <h3><Icon name="film"/> {fill(t.card.demo.title, { issue: task.issue })}</h3>
        <div className="sp-actions">
          <button type="button" className="btn btn-sm" onClick={generate} disabled={busy || !task.hasWorktree}>
            {steps ? <><Icon name="refresh"/> {t.card.demo.regenerate}</> : t.card.demo.generate}
          </button>
          <button type="button" className="btn btn-close" onClick={onClose} aria-label={t.common.close} title={t.common.close}><Icon name="x"/></button>
        </div>
      </header>

      <div className="subpanel-body">
        {!task.hasWorktree && (
          <p className="sp-note">{t.card.demo.noWorktree}</p>
        )}

        {demoOff && (
          <p className="sp-note">{t.card.demo.off}</p>
        )}

        {live ? (
          <p className="sp-hint">
            {t.card.demo.servers}{' '}
            {services.filter((s) => s.healthy).map((s) => (
              <a key={s.label} href={serviceUrl(s)} target="_blank" rel="noreferrer">{s.label} <Icon name="arrow-right"/> {serviceUrl(s)}</a>
            ))}
          </p>
        ) : task.hasWorktree && (
          <div className="sp-note">
            <span>
              {starting ? t.card.demo.starting : t.card.demo.noServers}
            </span>
            {!starting && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onStartStack(task.issue)}><Icon name="play"/> {t.card.demo.startApp}</button>
            )}
          </div>
        )}

        {error && <p className="sp-error">{error}</p>}
        {busy && <p className="muted">{t.card.demo.generating}</p>}
        {!busy && !steps && task.hasWorktree && (
          <p className="muted">
            {demoOff ? t.card.demo.noStepsOff : t.card.demo.noSteps}
          </p>
        )}
        {resolved && <Markdown text={resolved} />}
      </div>
    </section>
  );
}
