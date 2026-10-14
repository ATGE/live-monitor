import React, { useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import { api } from '../api.js';
import { fill } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';

/** GitHub's cap on a PR title, the same one the server's control enforces. */
export const PR_TITLE_MAX = 256;

/**
 * The PR that could not be published for what its title says. The run stopped
 * at the very last step with everything else already paid for — fix, tests and
 * Browser QA — so this asks for the one thing that was wrong: the text.
 *
 * The proposal the server refused comes prefilled and focused, with the
 * reasons above it, and the counter says how far over the cap it is. A refusal
 * from the server is shown here, next to the text that caused it, instead of
 * closing on a generic notice: the whole point is to fix it without leaving.
 */
export default function PrTitleDialog({ task, onClose }) {
  const t = useStrings().dialogs.prTitle;
  const park = task.prPark ?? {};
  const [title, setTitle] = useState(() => park.proposal ?? '');
  const [posting, setPosting] = useState(false);
  const [refused, setRefused] = useState(null);     // `problems` from a 400
  const [failure, setFailure] = useState(null);     // anything else
  const alive = useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  // What will actually be sent, and therefore the only text worth measuring:
  // the control counts what it receives. A proposal padded with spaces — or
  // with the newline the textarea takes from an Enter — must not read as over
  // the cap and lock the one dialog whose job is getting out of a dead end.
  const text = title.trim().replace(/\s+/g, ' ');
  const n = text.length;
  const over = n > PR_TITLE_MAX;
  const empty = n === 0;

  const submit = async () => {
    setPosting(true);
    setRefused(null);
    setFailure(null);
    try {
      await api.publishPr(task.project, task.issue, text);
      if (alive.current) onClose();
    } catch (e) {
      if (!alive.current) return;
      if (Array.isArray(e.data?.problems) && e.data.problems.length) setRefused(e.data.problems);
      else setFailure(e.message);
    } finally {
      if (alive.current) setPosting(false);
    }
  };

  const problems = park.problems ?? [];

  return (
    <Dialog
      title={fill(t.title, { issue: task.issue })} icon="note" className="pr-title-dialog"
      onDismiss={posting ? null : onClose}
      footer={(
        <>
          <span className="modal-caption">{t.caption}</span>
          <span className="modal-spacer" />
          <button className="btn btn-ghost btn-md" onClick={onClose} disabled={posting}>{t.leave}</button>
          <button className="btn btn-primary btn-md" disabled={empty || over || posting} onClick={submit}>
            {posting ? t.publishing : t.publish}
          </button>
        </>
      )}
    >
      {problems.length > 0 && (
        <section className="pr-title-why">
          <h4>{t.notPublished}</h4>
          <ul className="pr-title-problems">
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </section>
      )}

      <label className="pr-title-label" htmlFor={`pr-title-${task.issue}`}>{t.titleLabel}</label>
      <textarea
        id={`pr-title-${task.issue}`}
        className={`pr-title-input ${over ? 'is-over' : ''}`}
        autoFocus rows={4} spellCheck={false}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t.placeholder}
      />
      <p className={`pr-title-count ${over ? 'is-over' : ''}`} aria-live="polite">
        {over ? fill(t.counterOver, { n, max: PR_TITLE_MAX, extra: n - PR_TITLE_MAX }) : `${n}/${PR_TITLE_MAX}`}
      </p>

      {refused && (
        <section className="pr-title-why pr-title-refused">
          <h4>{t.refusedAgain}</h4>
          <ul className="pr-title-problems">
            {refused.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </section>
      )}
      {failure && <p className="pr-title-failure">{fill(t.failure, { error: failure })}</p>}
    </Dialog>
  );
}
