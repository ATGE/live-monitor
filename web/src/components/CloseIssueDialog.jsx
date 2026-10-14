import React, { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { fill, plural, strings } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';

/** What the server's English filter accepts for one closing comment. */
export const CLOSE_COMMENT_MAX = 20000;

/**
 * GitHub's own `state_reason` vocabulary, with the description the board shows
 * next to each one. Radios and not a `<select>`: three options that each need
 * a line of explanation are what `useDialog`'s own ask already does, and the
 * duplicate's number field hangs off its own option instead of floating.
 */
const REASONS = [
  { value: 'completed', label: 'Completed', get description() { return strings().dialogs.closeIssue.reasonCompleted; } }, // i18n-ok: GitHub's own state_reason name
  { value: 'not_planned', label: 'Not planned', get description() { return strings().dialogs.closeIssue.reasonNotPlanned; } }, // i18n-ok: GitHub's own state_reason name
  { value: 'duplicate', label: 'Duplicate', get description() { return strings().dialogs.closeIssue.reasonDuplicate; } }, // i18n-ok: GitHub's own state_reason name
];

/** `Not planned`, `not-planned`, `NOT_PLANNED` — all the same reason. */
function normalizeReason(raw) {
  const v = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return REASONS.some((r) => r.value === v) ? v : '';
}

const reasonLabel = (v) => REASONS.find((r) => r.value === v)?.label ?? v;

/** A count that survives a number, a boolean or a list of files. */
const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);

/**
 * What would be left behind on the branch, in one line — or null when
 * there is nothing pending, so the warning never paints empty.
 */
function pendingLine(pending) {
  if (!pending) return null;
  const t = strings().dialogs.closeIssue;
  const parts = [];
  // `commits` viaja como booleano, no como número: contarlo diría «1 commit(s)»
  // para una rama con cinco. Sin cifra es verdad; con cifra, mentira.
  if (pending.commits) parts.push(t.pendingOwn);
  if (count(pending.unpushed)) parts.push(plural(count(pending.unpushed), t.pendingUnpushed));
  if (count(pending.dirty)) parts.push(plural(count(pending.dirty), t.pendingDirty));
  if (!parts.length) return null;
  return fill(t.pendingLine, { parts: parts.join(t.pendingAnd) });
}

/**
 * Closing a GitHub issue with no PR, because the analysis concluded no change
 * is needed. An agent writes the proposal from the task's chat; this window is
 * the only place a person can stop it, and nothing reaches GitHub until the
 * button is pressed.
 *
 * The server proposes, you edit, you publish — the same deal as
 * `PrTitleDialog`, including where a refusal is painted: inside the window,
 * next to what caused it, instead of closing on a generic notice.
 *
 * Everything editable is seeded once, with lazy initializers, and never
 * resynced from the task: the task prop is live (a park landing over the
 * WebSocket repaints this window with no polling), and a broadcast mid-edit
 * must not overwrite what the person is writing. A genuinely new draft remounts
 * the whole dialog instead — `App.jsx` keys it by `draftedAt`.
 */
export default function CloseIssueDialog({ task, onClose }) {
  const t = useStrings().dialogs.closeIssue;
  const closing = task.closing ?? {};
  const unclear = closing.draftVerdict === 'unclear';

  // Seeded once. `unclear` means the agent did not reach a conclusion, so
  // neither the comment nor the reason is preselected: with no text and no
  // reason the button is already disabled, which is what «no inventes una
  // conclusión» buys — no special case needed to block it.
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState(() => (unclear ? '' : normalizeReason(closing.draftReason)));
  const [dupRef, setDupRef] = useState(() => (unclear ? '' : String(closing.draftDuplicateOf ?? '')));
  const [labels, setLabels] = useState(() => (Array.isArray(closing.draftLabels) ? closing.draftLabels : []));

  const [options, setOptions] = useState(null);       // { labels, pending }
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [dup, setDup] = useState({ kind: 'idle' });   // the duplicate's check
  const [publishing, setPublishing] = useState(false);
  const [refused, setRefused] = useState(null);       // { status, data, message }

  const typed = useRef(false);   // the person already edited the comment
  const alive = useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  // The draft's body lives only behind the GET — the task's park carries every
  // other field but not this one — and the repo's labels and the branch's
  // pending work come from a second call. Both at once, on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [draft, opts] = await Promise.allSettled([
        api.closeDraft(task.project, task.issue),
        api.closeOptions(task.project, task.issue),
      ]);
      if (cancelled || !alive.current) return;
      if (draft.status === 'fulfilled') {
        const body = draft.value?.closing?.draftBody;
        if (body && !typed.current && draft.value?.closing?.draftVerdict !== 'unclear') setComment(body);
      } else {
        setLoadError(draft.reason?.message ?? String(draft.reason));
      }
      if (opts.status === 'fulfilled') {
        // `labels: null` desde el servidor es «no se pudieron traer», no «este
        // repositorio no tiene ninguna»: la ruta contesta con `allSettled` para
        // que un GitHub inalcanzable no se lleve por delante el aviso de
        // trabajo pendiente, que es el que habla de perder trabajo.
        const known = Array.isArray(opts.value?.labels) ? opts.value.labels : [];
        setOptions({
          labels: known,
          pending: opts.value?.pending ?? null,
          error: opts.value?.labelsError ?? null,
        });
        // «Nunca crear etiquetas nuevas» is guaranteed by there being no way to
        // write one; a proposed label the repo does not have is dropped here
        // too, so it cannot ride along invisibly and earn a 400.
        const names = new Set(known.map((l) => l.name));
        setLabels((cur) => cur.filter((n) => names.has(n)));
      } else {
        // No labels is not «this repo has none»: say which of the two it is.
        setOptions({ labels: [], pending: null, error: opts.reason?.message ?? String(opts.reason) });
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [task.project, task.issue]);

  // The duplicate's number, checked against the repo while it is typed. The
  // server revalidates the same thing on publish: this is a courtesy, not the
  // gate.
  useEffect(() => {
    if (reason !== 'duplicate') { setDup({ kind: 'idle' }); return undefined; }
    const raw = dupRef.trim().replace(/^#/, '');
    if (!raw) { setDup({ kind: 'idle' }); return undefined; }
    if (!/^\d+$/.test(raw)) { setDup({ kind: 'shape' }); return undefined; }
    setDup({ kind: 'checking' });
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await api.verifyRef(task.project, task.issue, raw);
        if (!cancelled && alive.current) setDup({ kind: 'ok', ref: found });
      } catch (e) {
        if (cancelled || !alive.current) return;
        if (e.status === 404) setDup({ kind: 'missing', n: raw });
        else setDup({ kind: 'error', message: e.message });
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [reason, dupRef, task.project, task.issue]);

  const text = comment.trim();
  const n = text.length;
  const over = n > CLOSE_COMMENT_MAX;
  const drafting = closing.status === 'drafting';
  const done = closing.status === 'closed';
  const dupOk = reason !== 'duplicate' || dup.kind === 'ok';
  const blocked = !n || over || !reason || !dupOk || publishing || drafting;

  const submit = async (force = false) => {
    setPublishing(true);
    setRefused(null);
    try {
      await api.closeIssue(task.project, task.issue, {
        comment: text,
        reason,
        duplicateOf: reason === 'duplicate' ? Number(dupRef.trim().replace(/^#/, '')) : null,
        labels,
        force,
      });
      if (alive.current) onClose();
    } catch (e) {
      if (!alive.current) return;
      setRefused({ status: e.status, data: e.data ?? {}, message: e.message });
    } finally {
      if (alive.current) setPublishing(false);
    }
  };

  const redraft = () => {
    setRefused(null);
    api.draftClose(task.project, task.issue).catch((e) => {
      if (alive.current) setRefused({ status: e.status, data: e.data ?? {}, message: e.message });
    });
  };

  const toggleLabel = (name) => setLabels((cur) => (
    cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]
  ));

  const pending = pendingLine(options?.pending);
  const why = closing.draftWhy;

  return (
    <Dialog
      title={fill(t.title, { issue: task.issue })} icon="lock" className="close-issue-dialog"
      onDismiss={publishing ? null : onClose}
      footer={(
        <>
          <span className="modal-caption">{t.caption}</span>
          <span className="modal-spacer" />
          <button className="btn btn-ghost btn-md" onClick={redraft} disabled={publishing || drafting}
            title={t.redraftTitle}><Icon name="refresh"/> {t.redraft}</button>
          <button className="btn btn-ghost btn-md" onClick={onClose} disabled={publishing}>{t.leave}</button>
          {/* `warn`, not `danger`: red is for irreversible local destruction,
              and a closed issue reopens with one click. */}
          <button className="btn btn-warn btn-md" disabled={blocked} onClick={() => submit(false)}>
            {publishing ? t.closing : <><Icon name="lock"/> {t.closeBtn}</>}
          </button>
        </>
      )}
    >
      {drafting && <p className="close-drafting"><Icon name="hourglass"/> {t.drafting}</p>}

      {!drafting && (
        <>
          {done && (
            <section className="close-note is-done">
              <h4><Icon name="check-circle"/> {t.alreadyClosed}</h4>
              {closing.commentUrl && (
                <p className="close-note-text">
                  <a href={closing.commentUrl} target="_blank" rel="noreferrer">{t.viewComment}</a>
                </p>
              )}
            </section>
          )}

          {/* First of all, because it is the only thing here that says work
              would be lost. It never blocks the button: it warns, and the
              person decides. */}
          {pending && (
            <section className="close-note is-warn">
              <h4><Icon name="alert-triangle"/> {pending}</h4>
              <p className="close-note-text">{t.worktreeKept}</p>
            </section>
          )}

          {unclear && (
            <section className="close-note is-unclear">
              <h4><Icon name="help-circle"/> {t.unclearTitle}</h4>
              {closing.draftMissing && <p className="close-note-text">«{closing.draftMissing}»</p>}
              <p className="close-note-text">{t.unclearHint}</p>
            </section>
          )}

          {closing.error && !refused && (
            <section className="close-note is-refused">
              <h4><Icon name="x-circle"/> {t.lastDraftFailed}</h4>
              <p className="close-note-text">{closing.error}</p>
            </section>
          )}

          {refused && <Refusal refused={refused} publishing={publishing} onForce={() => submit(true)} />}

          {loadError && <p className="close-failure">{fill(t.loadFailed, { error: loadError })}</p>}

          <label className="close-label" htmlFor={`close-comment-${task.issue}`}>
            {t.commentLabel} <span className="close-hint">{t.publishedInEnglish}</span>
          </label>
          <textarea
            id={`close-comment-${task.issue}`}
            className={`close-comment ${over ? 'is-over' : ''}`}
            autoFocus rows={8} spellCheck={false}
            value={comment}
            onChange={(e) => { typed.current = true; setComment(e.target.value); }}
            placeholder={loading ? t.loadingProposal : t.commentPlaceholder}
          />
          <p className={`close-count ${over ? 'is-over' : ''}`} aria-live="polite">
            {over ? fill(t.counterOver, { n, max: CLOSE_COMMENT_MAX, extra: n - CLOSE_COMMENT_MAX }) : `${n}/${CLOSE_COMMENT_MAX}`}
          </p>

          <p className="close-label">{t.reasonHeading}</p>
          <div className="close-reasons" role="radiogroup" aria-label={t.reasonGroup}>
            {REASONS.map((r) => (
              <label key={r.value} className={`close-reason ${reason === r.value ? 'is-on' : ''}`}>
                <input
                  type="radio" name={`close-reason-${task.issue}`}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                />
                <span className="close-reason-name">{r.label}</span>
                <span className="close-reason-desc">{r.description}</span>
              </label>
            ))}
            {reason === 'duplicate' && (
              <div className="close-dup">
                <span className="close-dup-hash">#</span>
                <input
                  className="close-dup-input" autoFocus inputMode="numeric"
                  value={dupRef} onChange={(e) => setDupRef(e.target.value)}
                  placeholder="1180" aria-label={t.dupAria}
                />
                <DupState dup={dup} />
              </div>
            )}
          </div>

          {/* The agent's reasoning about its own preselection, not part of what
              gets published: read-only, and it stays on screen even after the
              reason changes — that contrast is the useful part. */}
          {why && (
            <p className="close-why">
              <Icon name="lightbulb"/> {fill(t.proposed, { text: `${closing.draftReason ? `${reasonLabel(normalizeReason(closing.draftReason))} — ` : ''}${why}` })}
            </p>
          )}

          <p className="close-label">
            {t.labelsHeading} <span className="close-hint">{t.labelsHint}</span>
          </p>
          {options?.labels?.length ? (
            <div className="close-labels">
              {options.labels.map((l) => {
                const on = labels.includes(l.name);
                const dot = /^[0-9a-fA-F]{6}$/.test(l.color ?? '') ? `#${l.color}` : 'var(--card-border)';
                return (
                  <button
                    key={l.name} type="button" title={l.description ?? ''}
                    className={`btn btn-sm dlg-a-chip ${on ? 'is-on' : ''}`}
                    aria-pressed={on}
                    onClick={() => toggleLabel(l.name)}
                  >
                    <span className="dlg-a-chip-dot" style={{ background: dot }} aria-hidden="true" />
                    {on ? <><Icon name="check"/> </> : ''}{l.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="close-hint">
              {loading ? t.loadingLabels
                : options?.error ? fill(t.labelsFailed, { error: options.error })
                  : t.noLabels}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}

/** How the duplicate's number reads while it is being checked. */
function DupState({ dup }) {
  const t = useStrings().dialogs.closeIssue;
  if (dup.kind === 'idle') return <span className="close-dup-state">{t.dupIdle}</span>;
  if (dup.kind === 'shape') return <span className="close-dup-state is-bad"><Icon name="x-circle"/> {t.dupShape}</span>;
  if (dup.kind === 'checking') return <span className="close-dup-state is-checking"><Icon name="hourglass"/> {t.dupChecking}</span>;
  if (dup.kind === 'missing') return <span className="close-dup-state is-bad"><Icon name="x-circle"/> {fill(t.dupMissing, { n: dup.n })}</span>;
  if (dup.kind === 'error') return <span className="close-dup-state is-bad"><Icon name="x-circle"/> {fill(t.dupError, { message: dup.message })}</span>;
  const r = dup.ref ?? {};
  const what = r.isPr ? 'PR' : 'issue'; // i18n-ok: GitHub's own names
  // `issueOrPrRef` devuelve el estado en MAYÚSCULAS a propósito, para que se
  // lea como el de `getIssue`/`prView`. Comparar en minúsculas anunciaba
  // «abierto» un issue ya cerrado, justo en la línea que se mira para decidir
  // si ese número es el correcto.
  const state = String(r.state ?? '').toUpperCase() === 'CLOSED' ? t.stateClosed : t.stateOpen;
  return (
    <span className={`close-dup-state is-ok ${r.isPr ? 'is-pr' : ''}`}>
      <Icon name="check"/> {what} #{r.number} «{r.title}» ({state})
      {r.isPr && t.dupPrNote}
    </span>
  );
}

/**
 * The server's refusal, painted here and not on the way out: the window stays
 * open so the very thing that was refused can be fixed without leaving.
 */
function Refusal({ refused, publishing, onForce }) {
  const t = useStrings().dialogs.closeIssue;
  const d = refused.data ?? {};
  const problems = Array.isArray(d.problems) ? d.problems : null;
  const unknown = Array.isArray(d.unknownLabels) ? d.unknownLabels : null;
  const pending = refused.status === 409 && d.pending ? pendingLine(d.pending) : null;

  return (
    <section className="close-note is-refused">
      {problems && (
        <>
          <h4><Icon name="x-circle"/> {t.filterRejected}</h4>
          <ul className="close-problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </>
      )}
      {unknown && (
        <>
          <h4><Icon name="x-circle"/> {t.unknownLabels}</h4>
          <ul className="close-problems">{unknown.map((l) => <li key={l}>{l}</li>)}</ul>
        </>
      )}
      {d.ref != null && !problems && (
        <>
          <h4><Icon name="x-circle"/> {t.dupRejected}</h4>
          <p className="close-note-text">#{String(d.ref)} — {refused.message}</p>
        </>
      )}
      {d.foreignComment && (
        <>
          <h4><Icon name="x-circle"/> {t.foreignTitle}</h4>
          <p className="close-note-text">
            {t.foreignBody}
            {d.commentUrl && <> <a href={d.commentUrl} target="_blank" rel="noreferrer">{t.foreignLink}</a>.</>}
          </p>
        </>
      )}
      {d.commentGone && (
        <>
          <h4><Icon name="x-circle"/> {t.goneTitle}</h4>
          <p className="close-note-text">{t.goneBody}</p>
        </>
      )}
      {pending && (
        <>
          <h4><Icon name="alert-triangle"/> {pending}</h4>
          <p className="close-note-text">{t.forceNote}</p>
          <button className="btn btn-warn btn-md dlg-a-force" type="button" disabled={publishing} onClick={onForce}>
            {t.forceBtn}
          </button>
        </>
      )}
      {!problems && !unknown && d.ref == null && !d.foreignComment && !d.commentGone && !pending && (
        <>
          <h4><Icon name="x-circle"/> {t.failed}</h4>
          <p className="close-note-text">{refused.message}</p>
        </>
      )}
    </section>
  );
}
