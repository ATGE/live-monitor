import React, { useEffect, useMemo, useState } from 'react';
import Dialog from './Dialog.jsx';
import Markdown from './Markdown.jsx';
import MicButton from './MicButton.jsx';
import { useDictation, dictationSupport, useStopDictationOnEscape } from '../useDictation.js';
import { useAutoGrow } from '../useAutoGrow.js';
import Icon from './Icon.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural } from '../i18n/index.js';

const GLYPH = { pending: 'dot', skipped: 'ban', running: 'refresh', checking: 'refresh', done: 'check', failed: 'x', stopped: 'stop', asking: 'help-circle' };

const minutes = (a, b) => {
  if (!a) return null;
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  return Math.max(1, Math.round(ms / 60000));
};

/** Ancestors and dependents over the plan's tasks, for the checkboxes. */
function graph(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const up = (id, acc = new Set()) => { for (const d of byId.get(id)?.dependsOn ?? []) if (!acc.has(d)) { acc.add(d); up(d, acc); } return acc; };
  const down = (id, acc = new Set()) => { for (const t of tasks) if (t.dependsOn.includes(id) && !acc.has(t.id)) { acc.add(t.id); down(t.id, acc); } return acc; };
  return { byId, up, down };
}

/**
 * The waves as lanes, in one line: «3 zap → 2 → 1». The zap icon marks the peak of
 * parallelism — the widest wave, when it runs more than one task at a time —
 * the same «máx. N a la vez» the dialog's header gives.
 */
export function laneSummary(waves) {
  const list = waves ?? [];
  const widest = Math.max(0, ...list.map((w) => w.length));
  return list.map((w, i) => (
    <React.Fragment key={i}>
      {i > 0 && <> <Icon name="arrow-right" /> </>}
      {w.length > 1 && w.length === widest ? <>{w.length} <Icon name="zap" /></> : w.length}
    </React.Fragment>
  ));
}

/**
 * The plan, to approve or to watch. Before approval: the Markdown, the tasks
 * by wave — a lane per wave, its tasks side by side — with checkboxes (picking
 * one pulls its dependencies in, dropping one drops its dependents), «Pedir
 * cambios» with a comment, «Aprobar N».
 * Once running: each task with its state, attempt, time and last failure,
 * and Detener / Continuar.
 */
export default function PlanReview({
  plan, who = '', mode = 'review', feedback: askedFor = null, onApprove, onRevise, onStop = null, onContinue = null, onDismiss = null, busy = false,
}) {
  const t = useStrings();
  const tasks = plan.tasks ?? [];
  const waves = plan.waves ?? [tasks.map((t) => t.id)];
  const { byId, up, down } = useMemo(() => graph(tasks), [tasks]);
  const [selected, setSelected] = useState(() => new Set((plan.selected ?? tasks.map((t) => t.id)).filter((id) => byId.get(id)?.status !== 'done')));
  const [note, setNote] = useState(null);
  const [feedback, setFeedback] = useState('');
  const [revising, setRevising] = useState(false);
  const dictation = useDictation({ onText: setFeedback });
  const micSupport = dictationSupport();
  const feedbackRef = useAutoGrow({ value: feedback });
  // Dictating, the first Escape stops the microphone and keeps the draft; the
  // second one closes the dialog.
  useStopDictationOnEscape(dictation);

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) {
      const dropped = [...down(id)].filter((x) => next.has(x));
      next.delete(id);
      for (const x of dropped) next.delete(x);
      setNote(dropped.length ? fill(t.chat.plan.noteDropped, { id, dropped: dropped.join(', ') }) : null);
    } else {
      const added = [...up(id)].filter((x) => !next.has(x) && byId.get(x)?.status !== 'done');
      next.add(id);
      for (const x of added) next.add(x);
      setNote(added.length ? fill(t.chat.plan.noteAdded, { id, added: added.join(', ') }) : null);
    }
    return next;
  });

  const review = mode === 'review';
  const running = plan.status === 'running' || plan.status === 'asking';
  // The box goes away without the dialog unmounting — «Volver», and also the
  // plan starting to run while it is open — and a recogniser left writing
  // into a `setFeedback` nobody reads would hold the microphone for nothing.
  useEffect(() => { if (!(review && revising)) dictation.abort(); }, [review, revising]);
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const total = tasks.filter((t) => t.status !== 'skipped').length;
  // Plans from before versioning have no `version`: they are the first one.
  const version = plan.version ?? 1;
  const widest = Math.max(1, ...waves.map((w) => w.length));
  const shape = [plural(tasks.length, t.chat.plan.tasks), widest > 1 ? fill(t.chat.plan.maxParallel, { n: widest }) : null].filter(Boolean).join(' · ');
  const planV = `Plan v${version}`; // i18n-ok: «Plan» is the same word in es, en, fr and de
  // What was asked of the previous version: from App (`task.planning`) or the plan itself.
  const changes = version > 1 ? (askedFor ?? plan.feedback ?? null) : null;
  const title = review ? [planV, shape, who].filter(Boolean).join(' · ')
    : plan.status === 'done' ? [fill(t.chat.plan.titleDone, { version }), who].filter(Boolean).join(' · ')
      : [
        fill(running ? t.chat.plan.titleRunning : plan.status === 'stopped' ? t.chat.plan.titleStopped : t.chat.plan.titleFailed, { version }),
        fill(t.chat.plan.progress, { done: doneCount, total }),
        plan.startedAt ? plural(minutes(plan.startedAt, plan.endedAt), t.chat.plan.minutes) : null,
      ].filter(Boolean).join(' · ');

  return (
    <Dialog title={title} icon={review ? 'note' : 'clipboard'} onDismiss={onDismiss} wide className="plan-review"
      footer={review ? (
        revising ? (
          <>
            <button type="button" className="btn btn-ghost btn-md" onClick={() => { dictation.abort(); setRevising(false); }} disabled={busy}>{t.chat.plan.back}</button>
            <span className="modal-spacer" />
            <button type="button" className="btn btn-warn btn-md" disabled={!feedback.trim() || busy} onClick={() => onRevise(feedback.trim())}>{t.chat.plan.sendChanges}</button>
          </>
        ) : (
          <>
            <span className="modal-caption">{t.chat.plan.approveCaption}</span>
            <span className="modal-spacer" />
            <button type="button" className="btn btn-ghost btn-md" onClick={() => setRevising(true)} disabled={busy}>{t.chat.plan.askChanges}</button>
            <button type="button" className="btn btn-primary btn-md" disabled={!selected.size || busy} onClick={() => onApprove([...selected])}>
              <Icon name="check" /> {selected.size === tasks.length ? t.chat.plan.approveAll : fill(t.chat.plan.approveSome, { n: selected.size, total: tasks.length })}
            </button>
          </>
        )
      ) : (
        <>
          <span className="modal-caption">{plan.status === 'done' ? t.chat.plan.doneCaption : t.chat.plan.runningCaption}</span>
          <span className="modal-spacer" />
          {running && onStop && <button type="button" className="btn btn-danger btn-md" onClick={onStop} disabled={busy}><Icon name="stop" /> {t.chat.plan.stop}</button>}
          {!running && plan.status !== 'done' && onContinue && <button type="button" className="btn btn-primary btn-md" onClick={onContinue} disabled={busy}>{t.chat.plan.continue}</button>}
        </>
      )}>
      {changes && (
        <p className="plan-changes"><b>{t.chat.plan.changesAsked}</b> {changes}</p>
      )}
      {review && (
        <div className="plan-text"><Markdown text={plan.text ?? plan.plan ?? ''} /></div>
      )}
      {review && revising && (
        <>
          <div className="plan-feedback-row">
            <textarea
              className="plan-feedback" ref={feedbackRef} autoFocus rows={3}
              placeholder={dictation.listening ? t.chat.listening : t.chat.plan.feedbackPlaceholder}
              value={feedback} onChange={(e) => setFeedback(e.target.value)}
            />
            <MicButton
              className="mic-inline" listening={dictation.listening} support={micSupport}
              onToggle={() => dictation.toggle(feedback)}
            />
          </div>
          {/* A phone has no tooltips, so an unusable mic has to say why on screen. */}
          {!micSupport.ok && <p className="dictation-error"><Icon name="mic" /> {micSupport.reason}</p>}
          {dictation.error && <p className="dictation-error">{dictation.error}</p>}
        </>
      )}

      <div className="plan-tasks">
        <p className="plan-tasks-head">
          {review ? fill(t.chat.plan.tasksHead, { shape }) : `${planV} · ${shape}`}
        </p>
        <div className="plan-lanes">
          {waves.map((wave, i) => (
            <React.Fragment key={i}>
              {i > 0 && <div className="plan-lane-arrow" aria-hidden="true"><Icon name="chevron-down" /></div>}
              <section className="plan-lane">
                <h4 className="plan-lane-head">
                  {fill(t.chat.plan.wave, { n: i + 1 })}{wave.length > 1 && <span className="plan-lane-par"> · <Icon name="zap" /> {fill(t.chat.plan.parallelInWave, { n: wave.length })}</span>}
                </h4>
                <ul className="plan-lane-tasks">
                  {wave.map((id) => {
                    const step = byId.get(id);
                    if (!step) return null;
                    const deps = step.dependsOn.length ? `← ${step.dependsOn.join(', ')}` : '';
                    const files = `${step.files?.slice(0, 2).join(', ') ?? ''}${step.files?.length > 2 ? ` +${step.files.length - 2}` : ''}`;
                    return (
                      <li key={id} className={`plan-task plan-lane-card status-${step.status}`}>
                        {review ? (
                          <label>
                            <span className="plan-lane-top">
                              <input type="checkbox" checked={selected.has(id)} disabled={step.status === 'done'} onChange={() => toggle(id)} />
                              <b>{id}</b>
                              {deps && <span className="plan-lane-deps">{deps}</span>}
                            </span>
                            <span className="plan-lane-what">{step.what}</span>
                            {(files || step.check) && (
                              <span className="plan-task-meta">{files}{step.check ? `${files ? ' · ' : ''}check: ${step.check}` : ''}{/* i18n-ok: «check» is the plan's own field name */}</span>
                            )}
                          </label>
                        ) : (
                          <>
                            <span className="plan-lane-top">
                              <span className={`plan-glyph g-${step.status}`} aria-hidden="true"><Icon name={GLYPH[step.status] ?? 'help-circle'} /></span>
                              <b>{id}</b>
                              {deps && <span className="plan-lane-deps">{deps}</span>}
                            </span>
                            <span className="plan-lane-what">{step.what}</span>
                            <span className="plan-task-meta">
                              {t.chat.plan.status[step.status]}
                              {step.attempts > 1 && ` · ${fill(t.chat.plan.attempt, { n: step.attempts, max: (plan.maxRetries ?? 3) + 1 + (step.extraRetries ?? 0) })}`}
                              {step.startedAt && ['running', 'checking', 'done'].includes(step.status) && ` · ${plural(minutes(step.startedAt, step.endedAt), t.chat.plan.minutes)}`}
                              {step.check && step.status === 'done' && <> · check <Icon name="check" /></>}{/* i18n-ok: «check» is the plan's own field name */}
                              {step.status === 'pending' && deps && ` · ${fill(t.chat.plan.waitsFor, { deps: step.dependsOn.join(', ') })}`}
                            </span>
                            {step.lastFailure && step.status !== 'done' && (
                              <pre className="plan-failure">{step.lastFailure.kind === 'check' ? `${step.check}\n` : ''}{step.lastFailure.output}</pre>
                            )}
                            {step.status === 'failed' && step.attempts > 0 && running && <span className="plan-retrying">{t.chat.plan.retrying}</span>}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            </React.Fragment>
          ))}
        </div>
        {review && note && <p className="plan-note">{note}</p>}
      </div>
    </Dialog>
  );
}
