import React, { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import { fill, splitAround } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';
import { AUTHOR_NOTE, currentState, isAuthorOf, statusLine } from '../reviewerRules.js';

/**
 * Who reviews this PR, when the project declares nobody (or the person wants
 * another one). Pure UI: the search goes through the `search(q)` prop, which
 * answers `[{ login, name?, isAuthor? }]`, and the choice leaves through `onPick`.
 *
 * - `suggested`: the project's last reviewer, one click away.
 * - `excludeLogin`: the PR's author. Not hidden: GitHub may refuse the request
 *   and its answer decides, so the author is annotated instead.
 * - `onPick(login | null, { remember })`: `null` means «Sin revisor»; `remember`
 *   (the checkbox) applies to both.
 * - `mode='settings'`: the project's reviewer, no PR involved. Picks change the
 *   registry only; `onClear` is «Preguntar cada vez».
 *
 * The list shows when the dialog opens (empty query). No fixed widths: it has
 * to fit a 360 px phone.
 */
const DEBOUNCE_MS = 250;

export default function ReviewerDialog({
  project, mode = 'ready', suggested = null, excludeLogin = null, search, onPick, onClear, onCancel,
}) {
  const t = useStrings();
  const d = t.dialogs.reviewer;
  const settings = mode === 'settings';
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [known, setKnown] = useState([]);       // the unfiltered list, from the empty query
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [remember, setRemember] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const found = (await search(q.trim())) ?? [];
        if (mine !== seq.current) return;   // a newer query is on its way
        setResults(found);
        if (!q.trim()) setKnown(found);
        setError(null);
      } catch (e) {
        if (mine === seq.current) setError(e?.message ?? String(e));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, q ? DEBOUNCE_MS : 0);   // opening shows the list at once; typing waits
    return () => clearTimeout(timer);
  }, [q, search]);

  // The ready dialog closes on its first pick; this latch covers the events
  // that land before it unmounts (double click, key repeat). Settings stays open
  // after a failure, so it is not latched.
  const picked = useRef(false);
  const pick = (login) => {
    if (!settings) {
      if (picked.current) return;
      picked.current = true;
    }
    onPick(login, { remember: settings ? false : remember });
  };
  const name = project?.name ?? project?.id ?? d.thisProject;

  return (
    <Dialog
      title={settings ? d.settingsTitle : d.pickTitle} icon="user" className="reviewer-dialog" onDismiss={onCancel}
      footer={(
        <>
          {!settings && (
            <label className="modal-caption">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              {' '}{d.rememberAlways}
            </label>
          )}
          <span className="modal-spacer" />
          <button className="btn btn-ghost btn-md" onClick={onCancel}>{settings ? t.common.close : t.common.cancel}</button>
          {settings && (
            <button className="btn btn-ghost btn-md" onClick={onClear}
              title={d.clearTitle}>
              {d.clear}
            </button>
          )}
          <button className="btn btn-ghost btn-md" onClick={() => pick(null)}>{d.noReviewer}</button>
        </>
      )}
    >
      {settings
        ? (
          <p>
            {splitAround(fill(d.settingsIntro, { name }), { state: '' }).map((part) => (part.hole === 'state'
              ? <strong key={part.key}>{currentState(project)}</strong>
              : <React.Fragment key={part.key}>{part.text}</React.Fragment>))}
          </p>
        )
        : <p>{fill(d.ask, { name })}</p>}
      {!settings && suggested && (
        <p>
          <button className="btn btn-primary btn-md" onClick={() => pick(suggested)}>{fill(d.askSuggested, { login: suggested })}</button>
        </p>
      )}
      <input
        className="option-input dlg-b-field" type="text" value={q} autoFocus
        placeholder={d.searchPlaceholder} aria-label={d.searchAria}
        onChange={(e) => setQ(e.target.value)}
      />
      {/* One status line, always in the page, so a screen reader hears it change. */}
      <p className="modal-caption" aria-live="polite">
        {statusLine({ error, busy, shown: results, known })}
      </p>
      <ul className="dlg-b-results">
        {results.map((u) => (
          <li key={u.login}>
            <button className="btn btn-md dlg-b-pick" onClick={() => pick(u.login)}>
              <strong>{u.login}</strong>{u.name ? ` · ${u.name}` : ''}
              {!settings && isAuthorOf(u, excludeLogin) ? <span className="modal-caption"> ({AUTHOR_NOTE})</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
