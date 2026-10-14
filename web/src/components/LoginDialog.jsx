import React, { Fragment, useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { jobFinished, safeLoginUrl } from '../loginChip.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, splitAround } from '../i18n/index.js';

/**
 * «Renovar login»: runs `claude auth login` on ONE machine and walks the person
 * through it. Modelled on the restart dialog: it names the machine, lists the
 * work that shares that machine's credentials and lets the person wait for it
 * or force.
 *
 * Secrets: the job ticket, the login URL and the pasted code live only in this
 * component's state. The ticket goes in a header, the code in a POST body, and
 * none of them is logged, stored or shown to anyone else.
 */

const POLL_MS = 2000;

// What `failure` holds when the board's own wording (not the server's) applies:
// the text is picked at render, so it follows the language.
const CANNOT_NOW = Symbol('cannot-renew-now');

/** Cuts a catalog sentence at its `{holes}` and puts an element where each one is. */
const rich = (template, els) => splitAround(template, els).map((p) => (
  <Fragment key={p.key}>{p.hole ? els[p.hole] : p.text}</Fragment>
));

function BusyList({ items }) {
  return (
    <ul className="restart-busy">
      {items.map((b, i) => (
        <li key={b.id ?? i}>
          {b.title ?? b.id}
          {b.kind && <span className="restart-busy-kind"> · {b.kind}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function LoginDialog({ machine, onClose, onFinished = null }) {
  const t = useStrings();
  // Everything about the running job is held in React state, nowhere else.
  const [ticket, setTicket] = useState(null);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState([]);
  const [failure, setFailure] = useState(null);
  const [posting, setPosting] = useState(false);
  const [code, setCode] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Before anything starts, ask for the machine's public state: it may already
  // say which work is busy there.
  useEffect(() => {
    api.loginJob(machine, null)
      .then((j) => { if (alive.current && Array.isArray(j?.busy)) setBusy(j.busy); })
      .catch(() => {});
  }, [machine]);

  // Follow the job until it reaches a final state.
  const finished = jobFinished(job);
  useEffect(() => {
    if (!ticket || finished) return undefined;
    let cancelled = false;
    const tick = () => api.loginJob(machine, ticket)
      .then((j) => { if (!cancelled) setJob(j); })
      .catch((e) => {
        if (cancelled) return;
        if (e.status === 404 || e.status === 410) setJob({ state: 'failed', error: null, gone: true });
      });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [machine, ticket, finished]);

  useEffect(() => {
    if (job?.state === 'done') onFinished?.();
  }, [job?.state]);

  const start = async (force) => {
    setPosting(true);
    setFailure(null);
    try {
      const r = await api.startLogin(machine, { force });
      if (!alive.current) return;
      setTicket(r.ticket);
      setJob({ state: 'starting' });
    } catch (e) {
      if (!alive.current) return;
      if (Array.isArray(e.data?.busy)) setBusy(e.data.busy);
      setFailure(e.status === 409 ? (e.message || CANNOT_NOW) : e.message);
    } finally {
      if (alive.current) setPosting(false);
    }
  };

  const sendCode = async () => {
    const text = code.trim();
    if (!text) return;
    setPosting(true);
    try {
      await api.sendLoginCode(machine, ticket, text);
      if (alive.current) setCode('');
    } catch (e) {
      if (alive.current) setFailure(e.message);
    } finally {
      if (alive.current) setPosting(false);
    }
  };

  const cancel = async () => {
    setPosting(true);
    try {
      if (ticket && !finished) await api.cancelLogin(machine, ticket);
    } catch { /* the job may already be gone */ }
    if (alive.current) onClose();
  };

  const running = Boolean(ticket) && !finished;
  const url = safeLoginUrl(job?.url);
  const idle = busy.length === 0;

  const footer = !ticket ? (
    <>
      <button className="btn btn-ghost btn-md" disabled={posting} onClick={onClose}>{t.common.cancel}</button>
      <span className="modal-spacer" />
      {idle ? (
        <button className="btn btn-primary btn-md" disabled={posting} onClick={() => start(false)}>
          {posting ? t.topbar.loginDialog.starting : t.topbar.login.renew}
        </button>
      ) : (
        <>
          <button className="btn btn-primary btn-md" disabled={posting} onClick={() => start(false)}>{t.topbar.loginDialog.waitButton}</button>
          <button className="btn btn-danger btn-md" disabled={posting} onClick={() => start(true)}>{t.topbar.loginDialog.forceButton}</button>
        </>
      )}
    </>
  ) : running ? (
    <>
      <button className="btn btn-ghost btn-md" disabled={posting} onClick={cancel}>{t.topbar.loginDialog.cancelLogin}</button>
      <span className="modal-spacer" />
    </>
  ) : (
    <>
      <span className="modal-spacer" />
      <button className="btn btn-primary btn-md" onClick={onClose}>{t.common.close}</button>
    </>
  );

  return (
    <Dialog
      title={fill(t.topbar.loginDialog.title, { machine })} icon="key" wide className="login-dialog"
      onDismiss={running || posting ? null : onClose}
      footer={footer}
    >
      <p className="modal-text">
        {rich(t.topbar.loginDialog.intro, {
          machine: <strong>{machine}</strong>,
          command: <code>claude auth login</code>, // i18n-ok: the command
        })}
      </p>

      {!ticket && (
        idle ? (
          <p className="modal-text restart-muted">{t.topbar.loginDialog.idleNote}</p>
        ) : (
          <>
            <p className="modal-text">
              {t.topbar.loginDialog.busyIntro}
            </p>
            <BusyList items={busy} />
            <p className="restart-muted">
              <strong>{t.topbar.loginDialog.waitLabel}</strong> {fill(t.topbar.loginDialog.waitDetail, { machine })}
            </p>
            <p className="restart-muted">
              <strong>{t.topbar.loginDialog.forceLabel}</strong> {t.topbar.loginDialog.forceDetail}
            </p>
          </>
        )
      )}

      {ticket && job && !finished && (
        <>
          <p className="modal-text">
            {job.state === 'starting' || job.state === 'verifying' ? <span className="spinner" /> : null}
            {' '}{t.topbar.loginDialog.steps[job.state] ?? t.topbar.loginDialog.steps.starting}
          </p>
          {job.state === 'waiting' && Array.isArray(job.busy) && job.busy.length > 0 && <BusyList items={job.busy} />}
          {url && (
            <p className="modal-text">
              <a className="login-link" href={url} target="_blank" rel="noopener noreferrer">{t.topbar.loginDialog.openLink}</a>
            </p>
          )}
          {job.needsCode && (
            <details className="login-code-fold">
              <summary>{t.topbar.loginDialog.codeFold}</summary>
              <div className="login-code">
              <input className="dlg-b-field"
                type="text" autoComplete="off" spellCheck={false} placeholder={t.topbar.loginDialog.codePlaceholder}
                value={code} onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' /* i18n-ok: a key name */) sendCode(); }}
              />
              <button className="btn btn-primary btn-md" disabled={posting || !code.trim()} onClick={sendCode}>{t.topbar.loginDialog.sendCode}</button>
              </div>
            </details>
          )}
        </>
      )}

      {job?.state === 'done' && <p className="modal-text"><Icon name="check-circle"/> {fill(t.topbar.loginDialog.done, { machine })}</p>}
      {job?.state === 'cancelled' && <p className="modal-text restart-muted">{t.topbar.loginDialog.cancelled}</p>}
      {job?.state === 'failed' && (
        <p className="restart-error">{job.gone ? t.topbar.loginDialog.gone : (job.error ?? t.topbar.loginDialog.failedDefault)}</p>
      )}
      {failure && <p className="restart-error">{failure === CANNOT_NOW ? t.topbar.loginDialog.cannotNow : failure}</p>}
    </Dialog>
  );
}
