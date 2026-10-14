import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';
import Dialog from './Dialog.jsx';
import { api } from '../api.js';
import { restartOutcome, failureMessage } from '../restartOutcome.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural, splitAround, strings } from '../i18n/index.js';

/**
 * «Reiniciar tablero»: the topbar button, its confirmation, and what the board
 * shows while a restart waits for busy work or the board is coming back.
 *
 * The button is never disabled: a restart has to be askable at any moment,
 * including while an upgrade or a waiting restart is already running.
 */

const WAIT_POLL_MS = 5000;
const RESTART_POLL_MS = 2000;
const GIVE_UP_MS = 3 * 60 * 1000;
// The old board can keep answering for a moment after the POST, before it
// dies. Normally the process start time (`startedAt`) tells a new board from the
// old one; only a board that does not report it falls back to «it never stopped
// answering for this long», so a restart too quick for the poll to see it down
// still reloads.
const BACK_WITHOUT_DOWN_MS = 20 * 1000;

const countBusy = (n) => plural(n, strings().ops.restart.busy);

// What a notice or a dialog failure says, kept as data in state and put into
// words at render, so a language switch reaches it. `raw` is text from the server.
const sayOf = (t, n) => {
  if (!n) return null;
  if (n.raw !== undefined) return n.raw;
  if (n.failure) return failureMessage(n.failure);
  return fill(t[n.key], n.vars);
};
const said = (raw) => ({ raw });

/** A sentence that opens with a bold lead: `{lead}` is the hole the <strong> goes in. */
const leadSentence = (template, lead) => splitAround(template, { lead }).map((p) => (
  p.hole ? <strong key={p.key}>{p.text}</strong> : <React.Fragment key={p.key}>{p.text}</React.Fragment>));

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

function RestartingDialog({ stuck }) {
  const t = useStrings().ops.restart;
  return (
    <Dialog title={t.restartingTitle} icon="refresh" className="restart-dialog">
      <p className="modal-text"><span className="spinner" /> {t.restartingBody}</p>
      {stuck && <p className="restart-error">{t.stuck}</p>}
      {stuck && (
        <div className="restart-stuck-actions">
          <button type="button" className="btn btn-primary btn-md" onClick={() => window.location.reload()}>{t.reload}</button>
        </div>
      )}
    </Dialog>
  );
}

/**
 * `variant="chip"` is the old standalone button. `variant="menu"` is for the
 * topbar's «···» menu: the trigger becomes a row painted into `slot` (a DOM
 * element inside the open menu), while this component stays mounted outside
 * the menu, because the menu unmounts its panel on close and the waiting poll
 * and the dialogs must outlive that. `onPicked` lets the menu close itself;
 * `onEngagedChange(true)` tells it a restart is pending (dialog or wait).
 */
export default function RestartControl({ variant = 'chip', slot = null, onPicked, onEngagedChange }) {
  const all = useStrings();
  const t = all.ops.restart;
  // idle | waiting (asked, busy work still running) | restarting (the board is going down or back)
  const [phase, setPhase] = useState('idle');
  const [busy, setBusy] = useState([]);
  // null when closed; otherwise the busy list shown and any failure of the last POST.
  const [dialog, setDialog] = useState(null);
  const [posting, setPosting] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [notice, setNotice] = useState(null);
  const alive = useRef(true);
  // The last GET /api/restart seen from the running board: its startedAt is what
  // a restarted board must differ from.
  const bootRef = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // A reload of the page while a restart waits: pick the waiting state up again.
  useEffect(() => {
    let cancelled = false;
    api.restartState()
      .then((s) => {
        if (cancelled) return;
        bootRef.current = s ?? null;
        if (s?.state === 'restarting') setPhase('restarting');
        else if (s?.state === 'waiting') {
          setBusy(s.busy ?? []);
          setPhase('waiting');
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // While waiting, poll the state every 5 s. Silence means the board went down
  // to restart, so this turns into the restarting view. A 409 means an upgrade
  // took over, which restarts the board too.
  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    let cancelled = false;
    const tick = () => api.restartState()
      .then((s) => {
        if (cancelled) return;
        setBusy(s.busy ?? []);
        bootRef.current = s;
        // The server reports 'restarting' once it has launched the restart.
        if (s.state === 'restarting') setPhase('restarting');
        else if (s.state !== 'waiting') {
          setPhase('idle');
          // The wait ended in a restart that failed to launch: nobody answered that POST.
          if (s.lastFailure) setNotice({ failure: s.lastFailure });
        }
      })
      .catch(() => {
        if (!cancelled) setPhase('restarting');
      });
    const id = setInterval(tick, WAIT_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [phase]);

  // While restarting, poll until a NEW board answers, then reload. Any failure
  // in between means the old board stopped answering. A 409 (upgrade) keeps
  // polling too. An answer from the same process (same startedAt) is not a
  // restart: if it reports a lastFailure the restart did not happen, and the
  // control says so and goes back to idle, usable for a retry.
  useEffect(() => {
    if (phase !== 'restarting') return undefined;
    let cancelled = false;
    let sawDown = false;
    const started = Date.now();
    const before = bootRef.current;
    setStuck(false);
    const tick = () => api.restartState()
      .then((s) => {
        if (cancelled) return;
        const outcome = restartOutcome({
          before, now: s, sawDown, elapsedMs: Date.now() - started, fallbackMs: BACK_WITHOUT_DOWN_MS,
        });
        if (outcome === 'restarted') window.location.reload();
        else if (outcome === 'not-restarting') {
          // A fetch error sent us here but the same board never restarted: no failure text.
          bootRef.current = s;
          setBusy(s.busy ?? []);
          setPhase(s.state === 'waiting' ? 'waiting' : 'idle');
        }
        else if (outcome === 'failed') {
          bootRef.current = s;
          setNotice({ failure: s.lastFailure });
          setPhase('idle');
        }
      })
      .catch(() => { sawDown = true; });
    const id = setInterval(tick, RESTART_POLL_MS);
    const giveUp = setTimeout(() => { if (!cancelled) setStuck(true); }, GIVE_UP_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearTimeout(giveUp);
    };
  }, [phase]);

  const openDialog = async () => {
    setNotice(null);
    let s;
    try {
      s = await api.restartState();
    } catch (e) {
      if (!alive.current) return;
      // No answer at all: the board is already going down, so follow it back.
      if (e.status === undefined) setPhase('restarting');
      else setNotice(said(e.message));
      return;
    }
    if (!alive.current) return;
    bootRef.current = s;
    if (s.supported === false) {
      setNotice({ key: 'notSupported' });
      return;
    }
    setDialog({ busy: s.busy ?? [], failure: null });
  };

  const request = async (force) => {
    setPosting(true);
    setDialog((d) => d && { ...d, failure: null });
    try {
      const r = await api.requestRestart({ force });
      if (!alive.current) return;
      setDialog(null);
      if (r?.state === 'waiting') {
        setBusy(dialog?.busy ?? []);
        setPhase('waiting');
      } else {
        setPhase('restarting');
      }
    } catch (e) {
      if (!alive.current) return;
      if (e.status === 409 && Array.isArray(e.data?.busy)) {
        // The work changed under the dialog: show what is busy now.
        setDialog({ busy: e.data.busy, failure: { key: 'workChanged' } });
      } else if (e.status === undefined) {
        // No answer to the POST: the board may have accepted it and be going down.
        setDialog(null);
        setPhase('restarting');
      } else {
        const failure = e.status === 501 ? { key: 'notSupported' } : said(e.message);
        setDialog((d) => ({ busy: d?.busy ?? [], failure }));
      }
    } finally {
      if (alive.current) setPosting(false);
    }
  };

  const cancelWait = async () => {
    setPosting(true);
    setNotice(null);
    try {
      await api.cancelRestart();
      if (alive.current) {
        setBusy([]);
        setPhase('idle');
      }
    } catch (e) {
      if (alive.current) setNotice({ key: 'cancelWaitFailed', vars: { message: e.message } });
    } finally {
      if (alive.current) setPosting(false);
    }
  };

  const renderDialog = () => {
    const idle = dialog.busy.length === 0;
    const close = () => setDialog(null);
    return (
      <Dialog
        title={t.dialogTitle} icon="refresh" wide
        onDismiss={posting ? null : close}
        footer={(
          <>
            <button type="button" className="btn btn-ghost btn-md" disabled={posting} onClick={close}>{all.common.cancel}</button>
            <span className="modal-spacer" />
            {idle ? (
              <button type="button" className="btn btn-primary btn-md" disabled={posting} onClick={() => request(true)}>
                {posting ? t.restarting : t.restart}
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-primary btn-md" disabled={posting} onClick={() => request(false)}>{t.waitForThem}</button>
                <button type="button" className="btn btn-danger btn-md" disabled={posting} onClick={() => request(true)}>{t.forceNow}</button>
              </>
            )}
          </>
        )}
      >
        <p className="modal-text">{t.intro}</p>
        {idle ? (
          <p className="modal-text restart-muted">{t.noWork}</p>
        ) : (
          <>
            <p className="modal-text">{t.busyIntro}</p>
            <BusyList items={dialog.busy} />
            <p className="restart-muted">{leadSentence(t.waitHint, t.waitLead)}</p>
            <p className="restart-muted">{leadSentence(t.forceHint, t.forceLead)}</p>
          </>
        )}
        {dialog.failure && <p className="restart-error">{sayOf(t, dialog.failure)}</p>}
      </Dialog>
    );
  };

  const cancelButtonShown = phase === 'waiting';
  const engaged = phase !== 'idle' || dialog !== null || Boolean(notice);
  useEffect(() => { onEngagedChange?.(engaged); }, [engaged, onEngagedChange]);

  if (variant === 'menu') {
    const subtitle = sayOf(t, notice)
      ?? (cancelButtonShown ? fill(t.waitingFor, { count: countBusy(busy.length) }) : null);
    const row = (
      <>
        <button type="button" className="mm-item"
          onClick={() => { onPicked?.(); openDialog(); }}>
          <span className="mm-icon" aria-hidden="true"><Icon name={cancelButtonShown ? 'reset' : 'refresh'} /></span>
          <span className="mm-text">
            {t.menuRow}
            {subtitle && <span className={`mm-sub ${notice ? 'mm-sub-error' : 'mm-sub-warn'}`}>{subtitle}</span>}
          </span>
        </button>
        {cancelButtonShown && (
          <button type="button" className="mm-item" disabled={posting} onClick={cancelWait}>
            <span className="mm-icon" aria-hidden="true"><Icon name="undo" /></span>
            <span className="mm-text">{t.cancelWait}</span>
          </button>
        )}
      </>
    );
    return (
      <>
        {slot ? createPortal(row, slot) : null}
        {dialog && renderDialog()}
        {phase === 'restarting' && <RestartingDialog stuck={stuck} />}
      </>
    );
  }

  return (
    <>
      <span className="restart-control">
        {cancelButtonShown && (
          <>
            <span className="restart-waiting">{fill(t.waitingFor, { count: countBusy(busy.length) })}</span>
            <button type="button" className="restart-cancel btn btn-ghost btn-md" disabled={posting} onClick={cancelWait}>{t.cancelWait}</button>
          </>
        )}
        <button type="button" className="machine restart-chip" title={t.chipTitle} aria-label={t.chipTitle} onClick={openDialog}>
          <Icon name="refresh" />
        </button>
        {notice && <span className="restart-error restart-notice">{sayOf(t, notice)}</span>}
      </span>
      {dialog && renderDialog()}
      {phase === 'restarting' && <RestartingDialog stuck={stuck} />}
    </>
  );
}
