import React, { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { splitAround } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';

/**
 * «📌 Crear tarea»: a one-off session drafts an issue (in English) from the
 * project conversation, the person edits it, and the board — not the session —
 * creates it on GitHub, assigned to the watched login so the poller picks it up.
 *
 * The draft is requested once on mount. The two states that matter: drafting
 * (spinner, nothing to edit) and ready (editable); a failed draft keeps the
 * dialog open with the reason and a retry, because a toast behind a modal is
 * not read by anyone.
 */
export default function CreateTaskDialog({ owner, chatId, onClose }) {
  const t = useStrings();
  const d = t.dialogs.createTask;
  const [phase, setPhase] = useState('drafting'); // drafting | ready | creating | done
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const alive = useRef(true);
  const run = useRef(0);

  const draft = () => {
    const mine = ++run.current;
    setPhase('drafting');
    setError(null);
    api.draftIssue(owner, chatId).then((d) => {
      if (!alive.current || mine !== run.current) return;
      setTitle(d?.title ?? '');
      setBody(d?.body ?? '');
      setPhase('ready');
    }).catch((e) => {
      if (!alive.current || mine !== run.current) return;
      setError(e?.message ?? String(e));
      setPhase('ready');
    });
  };

  useEffect(() => {
    alive.current = true;
    draft();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = async () => {
    setPhase('creating');
    setError(null);
    try {
      const r = await api.createIssue(owner, chatId, { title: title.trim(), body: body.trim() });
      if (!alive.current) return;
      setCreated(r);
      setPhase('done');
    } catch (e) {
      if (!alive.current) return;
      setError(e?.message ?? String(e));
      setPhase('ready');
    }
  };

  const busy = phase === 'drafting' || phase === 'creating';
  const canConfirm = phase === 'ready' && title.trim() && body.trim();

  const footer = phase === 'done' ? (
    <>
      <span className="modal-spacer" />
      <button type="button" className="btn btn-primary btn-md" onClick={onClose}>{t.common.close}</button>
    </>
  ) : (
    <>
      <span className="modal-spacer" />
      <button type="button" className="btn btn-ghost btn-md" onClick={onClose} disabled={phase === 'creating'}>{t.common.cancel}</button>
      {phase === 'ready' && !title && !body && error && <button type="button" className="btn btn-md" onClick={draft}>{t.common.retry}</button>}
      <button type="button" className="btn btn-primary btn-md" onClick={confirm} disabled={!canConfirm}>
        {phase === 'creating' ? d.creating : d.confirm}
      </button>
    </>
  );

  return (
    <Dialog
      title={d.title}
      icon="pin"
      wide
      className="create-task-dialog dlg-c-create"
      onDismiss={phase === 'creating' ? null : onClose}
      footer={footer}
    >
      {phase === 'drafting' && (
        <p className="dlg-c-note"><span className="spinner" aria-hidden="true" /> {d.drafting}</p>
      )}
      {phase === 'done' && created && (
        <p>
          {splitAround(d.created, { link: '' }).map((part) => (part.hole === 'link'
            ? <a key={part.key} href={created.url} target="_blank" rel="noreferrer">#{created.number}</a>
            : <React.Fragment key={part.key}>{part.text}</React.Fragment>))}
        </p>
      )}
      {(phase === 'ready' || phase === 'creating') && (
        <>
          <p className="dlg-c-note">{d.note}</p>
          <label htmlFor="create-task-title">{d.titleLabel}</label>
          <input
            id="create-task-title"
            type="text"
            value={title}
            maxLength={200}
            autoFocus
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
          <label htmlFor="create-task-body">{d.bodyLabel}</label>
          <textarea
            id="create-task-body"
            rows={14}
            value={body}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
          />
        </>
      )}
      {error && <p className="dlg-c-error" role="alert"><Icon name="alert-triangle" /> {error}</p>}
    </Dialog>
  );
}
